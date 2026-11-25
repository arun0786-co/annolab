"""The demo seed builds, and every API view works on it."""

import shutil

import pytest
from fastapi.testclient import TestClient

from annolab.config import Settings
from annolab.main import create_app
from annolab.seed import PASSWORD, build


@pytest.fixture(scope="module")
def seeded(tmp_path_factory):
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not installed")
    data = tmp_path_factory.mktemp("seed")
    settings = Settings(data_dir=data, secret="s" * 40)
    summary = build(settings, small=True)
    app = create_app(settings)
    client = TestClient(app)
    tokens = {}
    for who in ("admin", "annotator1", "reviewer1"):
        r = client.post("/api/auth/login", json={"email": f"{who}@annolab.dev", "password": PASSWORD})
        tokens[who] = {"Authorization": f"Bearer {r.json()['token']}"}
    return summary, client, tokens


def test_seed_summary(seeded):
    summary, _, _ = seeded
    assert summary["users"] == 5
    assert [p["modality"] for p in summary["projects"]] == ["audio", "image", "video", "text"]
    for p in summary["projects"]:
        assert p["tasks"] > 0 and p["annotations"] > 0 and p["reviews"] > 0


def test_seed_is_repeatable(tmp_path):
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not installed")
    s = Settings(data_dir=tmp_path, secret="s" * 40)
    a = build(s, small=True)
    b = build(s, small=True)  # rebuild from scratch in the same folder
    assert a["projects"] == b["projects"]


def test_every_view_works_on_seed(seeded):
    _, client, tok = seeded
    projects = client.get("/api/projects", headers=tok["annotator1"]).json()
    assert len(projects) == 4
    for p in projects:
        stats = client.get(f"/api/projects/{p['id']}/stats", headers=tok["admin"])
        assert stats.status_code == 200
        assert stats.json()["agreement"]["items_compared"] >= 1
        items = client.get(f"/api/projects/{p['id']}/items", headers=tok["annotator1"]).json()["items"]
        for it in items:
            assert "truth" not in it["meta"]
            if it["annotator_count"] >= 2:
                c = client.get(f"/api/items/{it['id']}/consensus", headers=tok["reviewer1"])
                assert c.status_code == 200 and c.json()["score"] is not None
        media = client.get(items[0]["media_url"], headers={**tok["annotator1"], "Range": "bytes=0-99"})
        assert media.status_code == 206 and len(media.content) == min(100, int(media.headers["content-range"].split("/")[1]))
        assert client.get(f"/api/projects/{p['id']}/export", params={"format": "jsonl"}, headers=tok["reviewer1"]).status_code == 200
        assert client.get(f"/api/projects/{p['id']}/activity", headers=tok["reviewer1"]).json()["total"] > 0
        if p["modality"] == "image":
            assert client.get(f"/api/projects/{p['id']}/export", params={"format": "coco"}, headers=tok["reviewer1"]).status_code == 200


def test_seed_queue_still_serves(seeded):
    _, client, tok = seeded
    projects = client.get("/api/projects", headers=tok["annotator1"]).json()
    served = [client.get(f"/api/projects/{p['id']}/queue/next", headers=tok["annotator1"]).status_code for p in projects]
    assert 200 in served


def test_seed_thumbnails(seeded):
    _, client, tok = seeded
    projects = {p["modality"]: p for p in client.get("/api/projects", headers=tok["admin"]).json()}
    for modality in ("image", "video"):
        items = client.get(f"/api/projects/{projects[modality]['id']}/items", headers=tok["admin"]).json()["items"]
        assert all(i["thumbnail_url"] for i in items)
        assert client.get(items[0]["thumbnail_url"], headers=tok["admin"]).status_code == 200
    audio = client.get(f"/api/projects/{projects['audio']['id']}/items", headers=tok["admin"]).json()["items"]
    assert all(len(i["meta"]["peaks"]) == 200 for i in audio)
