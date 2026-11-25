import io
import json
import wave

import numpy as np

from conftest import AUDIO_SCHEMA, make_project, png_bytes


def wav_bytes(seconds=1.0, sr=4000):
    x = (np.sin(2 * np.pi * 60 * np.arange(int(seconds * sr)) / sr) * 8000).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(x.tobytes())
    return buf.getvalue()


def test_image_upload_meta_and_thumbnail(client, auth):
    p = make_project(client, auth("admin"))
    files = [("files", ("a.png", png_bytes(120, 80), "image/png")), ("files", ("notes.txt", b"hi", "text/plain"))]
    r = client.post(f"/api/projects/{p['id']}/items", files=files, headers=auth("admin"))
    assert r.status_code == 201
    body = r.json()
    assert len(body["created"]) == 1 and body["errors"][0]["filename"] == "notes.txt"
    item = body["created"][0]
    assert item["meta"]["width"] == 120 and item["meta"]["height"] == 80
    assert item["thumbnail_url"]
    thumb = client.get(item["thumbnail_url"], headers=auth("ann1"))
    assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/jpeg"


def test_audio_upload_and_range_requests(client, auth):
    p = make_project(client, auth("admin"), modality="audio", schema=AUDIO_SCHEMA)
    data = wav_bytes()
    r = client.post(f"/api/projects/{p['id']}/items", files=[("files", ("beat.wav", data, "audio/wav"))], headers=auth("admin"))
    item = r.json()["created"][0]
    assert item["meta"]["sample_rate"] == 4000 and item["meta"]["duration"] == 1.0
    assert len(item["meta"]["peaks"]) == 200
    url = item["media_url"]
    full = client.get(url, headers=auth("ann1"))
    assert full.status_code == 200 and full.content == data and full.headers["accept-ranges"] == "bytes"

    part = client.get(url, headers={**auth("ann1"), "Range": "bytes=10-19"})
    assert part.status_code == 206
    assert part.content == data[10:20]
    assert part.headers["content-range"] == f"bytes 10-19/{len(data)}"

    tail = client.get(url, headers={**auth("ann1"), "Range": "bytes=-16"})
    assert tail.status_code == 206 and tail.content == data[-16:]

    open_end = client.get(url, headers={**auth("ann1"), "Range": "bytes=100-"})
    assert open_end.content == data[100:]

    bad = client.get(url, headers={**auth("ann1"), "Range": f"bytes={len(data) + 5}-"})
    assert bad.status_code == 416 and bad.headers["content-range"] == f"bytes */{len(data)}"


def test_media_token_in_query(client, auth):
    p = make_project(client, auth("admin"), modality="audio", schema=AUDIO_SCHEMA)
    item = client.post(f"/api/projects/{p['id']}/items", files=[("files", ("b.wav", wav_bytes(), "audio/wav"))],
                       headers=auth("admin")).json()["created"][0]
    token = auth("ann1")["Authorization"].split()[1]
    assert client.get(item["media_url"]).status_code == 401
    assert client.get(item["media_url"], params={"token": token}).status_code == 200
    assert client.get(item["media_url"], params={"token": "bad"}).status_code == 401


def test_text_upload_txt_and_jsonl(client, auth):
    schema = {"tools": [{"key": "ner", "type": "span", "classes": [{"value": "drug"}]}]}
    p = make_project(client, auth("admin"), modality="text", schema=schema)
    lines = "\n".join(json.dumps({"id": f"n{i}", "text": f"note {i} aspirin"}) for i in range(3))
    files = [("files", ("one.txt", b"plain note", "text/plain")), ("files", ("batch.jsonl", lines.encode(), "application/jsonl")),
             ("files", ("broken.jsonl", b"{not json", "application/jsonl"))]
    r = client.post(f"/api/projects/{p['id']}/items", files=files, headers=auth("admin")).json()
    assert [i["filename"] for i in r["created"]] == ["one.txt", "n0", "n1", "n2"]
    assert r["created"][1]["meta"]["text"] == "note 0 aspirin"
    assert r["errors"][0]["filename"] == "broken.jsonl"
    found = client.get(f"/api/projects/{p['id']}/items", params={"q": "ASPIRIN"}, headers=auth("ann1")).json()
    assert found["total"] == 3


def test_folder_import(client, auth, tmp_path):
    folder = tmp_path / "incoming"
    folder.mkdir()
    (folder / "x.png").write_bytes(png_bytes())
    (folder / "y.png").write_bytes(png_bytes())
    (folder / "skip.csv").write_text("a,b")
    p = make_project(client, auth("admin"))
    r = client.post(f"/api/projects/{p['id']}/items/import", json={"path": str(folder)}, headers=auth("admin"))
    assert r.status_code == 201 and len(r.json()["created"]) == 2
    assert client.post(f"/api/projects/{p['id']}/items/import", json={"path": str(folder / "nope")}, headers=auth("admin")).status_code == 422


def test_items_list_filters_and_pagination(client, auth):
    p = make_project(client, auth("admin"))
    files = [("files", (f"im{i}.png", png_bytes(), "image/png")) for i in range(5)]
    client.post(f"/api/projects/{p['id']}/items", files=files, headers=auth("admin"))
    client.get(f"/api/projects/{p['id']}/queue/next", headers=auth("ann1"))
    page = client.get(f"/api/projects/{p['id']}/items", params={"page": 2, "page_size": 2}, headers=auth("ann1")).json()
    assert page["total"] == 5 and page["page"] == 2 and len(page["items"]) == 2
    by_status = client.get(f"/api/projects/{p['id']}/items", params={"status": "in_progress"}, headers=auth("ann1")).json()
    assert by_status["total"] == 1
    both = client.get(f"/api/projects/{p['id']}/items", params={"status": "in_progress,unlabeled"}, headers=auth("ann1")).json()
    assert both["total"] == 5
    assert client.get(f"/api/projects/{p['id']}/items", params={"q": "im3"}, headers=auth("ann1")).json()["total"] == 1


def test_truth_meta_hidden_from_non_admins(app, client, auth):
    p = make_project(client, auth("admin"))
    item = client.post(f"/api/projects/{p['id']}/items", files=[("files", ("a.png", png_bytes(), "image/png"))],
                       headers=auth("admin")).json()["created"][0]
    from annolab.models import Item

    with app.state.db.sessionmaker() as db:
        it = db.get(Item, item["id"])
        it.meta = {**it.meta, "truth": [{"label": "cat"}]}
        db.commit()
    assert "truth" in client.get(f"/api/items/{item['id']}", headers=auth("admin")).json()["meta"]
    assert "truth" not in client.get(f"/api/items/{item['id']}", headers=auth("ann1")).json()["meta"]


def test_delete_project_removes_media(app, client, auth):
    p = make_project(client, auth("admin"))
    client.post(f"/api/projects/{p['id']}/items", files=[("files", ("a.png", png_bytes(), "image/png"))], headers=auth("admin"))
    folder = app.state.settings.media_dir / str(p["id"])
    assert folder.exists()
    assert client.delete(f"/api/projects/{p['id']}", headers=auth("admin")).status_code == 204
    assert not folder.exists()
    assert client.get(f"/api/projects/{p['id']}", headers=auth("admin")).status_code == 404
