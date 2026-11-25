from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from annolab.config import Settings
from annolab.main import create_app
from annolab.models import User
from annolab.security import hash_password

PASSWORD = "secret-pass"

IMAGE_SCHEMA = {
    "tools": [
        {"key": "box", "type": "bbox", "name": "Box", "classes": [
            {"value": "cat", "hotkey": "1"}, {"value": "dog", "hotkey": "2"}],
         "attributes": [{"key": "occluded", "type": "select", "options": ["yes", "no"]}]},
        {"key": "outline", "type": "polygon", "classes": [{"value": "cat"}, {"value": "dog"}]},
        {"key": "kp", "type": "point", "classes": [{"value": "nose"}]},
    ],
    "classifications": [{"key": "quality", "type": "radio", "options": ["good", "bad"]}],
}

AUDIO_SCHEMA = {
    "tools": [{"key": "heart", "type": "segment", "classes": [{"value": "S1", "hotkey": "1"}, {"value": "S2", "hotkey": "2"}]}],
    "classifications": [{"key": "quality", "type": "radio", "options": ["good", "noisy", "unusable"]}],
}


@pytest.fixture
def app(tmp_path):
    data = tmp_path / "data"
    (data / "media").mkdir(parents=True)
    application = create_app(Settings(data_dir=data, secret="test-secret-" + "x" * 32))
    with application.state.db.sessionmaker() as db:
        for email, name, role in [
            ("admin@x.dev", "Admin", "admin"),
            ("ann1@x.dev", "Ann One", "annotator"),
            ("ann2@x.dev", "Ann Two", "annotator"),
            ("ann3@x.dev", "Ann Three", "annotator"),
            ("rev@x.dev", "Rev", "reviewer"),
        ]:
            db.add(User(email=email, name=name, role=role, password_hash=hash_password(PASSWORD)))
        db.commit()
    return application


@pytest.fixture
def client(app):
    return TestClient(app)


class Auth:
    def __init__(self, client: TestClient):
        self.client = client
        self._cache: dict[str, dict] = {}

    def __call__(self, who: str) -> dict:
        if who not in self._cache:
            r = self.client.post("/api/auth/login", json={"email": f"{who}@x.dev", "password": PASSWORD})
            assert r.status_code == 200, r.text
            self._cache[who] = {"Authorization": f"Bearer {r.json()['token']}"}
        return self._cache[who]

    def user_id(self, who: str) -> int:
        return self.client.get("/api/auth/me", headers=self(who)).json()["id"]


@pytest.fixture
def auth(client):
    return Auth(client)


def make_project(client, headers, modality="image", schema=None, **kw):
    body = {"name": kw.pop("name", f"{modality} project"), "modality": modality,
            "schema": schema if schema is not None else (IMAGE_SCHEMA if modality == "image" else AUDIO_SCHEMA), **kw}
    r = client.post("/api/projects", json=body, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


def png_bytes(w=64, h=48, color=(200, 30, 30)):
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "PNG")
    return buf.getvalue()


def upload_images(client, headers, project_id, n=3, w=64, h=48):
    files = [("files", (f"img{i}.png", png_bytes(w, h), "image/png")) for i in range(n)]
    r = client.post(f"/api/projects/{project_id}/items", files=files, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()["created"]
