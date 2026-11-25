import io
import json
import zipfile

import pytest

from conftest import AUDIO_SCHEMA, make_project, upload_images

BOX = {"schema_key": "box", "label": "cat", "geometry": {"x": 10, "y": 8, "w": 20, "h": 16}}
POLY = {"schema_key": "outline", "label": "dog", "geometry": {"points": [[0, 0], [40, 0], [40, 30], [0, 30]]}}
Q = {"schema_key": "quality", "label": "good"}


@pytest.fixture
def labelled(client, auth):
    p = make_project(client, auth("admin"), annotators_per_item=2)
    upload_images(client, auth("admin"), p["id"], 2, w=64, h=48)
    # item 1: ann1 and ann2 agree on the box, ann2 adds a polygon; ann3 never works on it
    for who, anns in (("ann1", [BOX, Q]), ("ann2", [BOX, POLY, Q])):
        t = client.get(f"/api/projects/{p['id']}/queue/next", headers=auth(who)).json()
        client.post(f"/api/tasks/{t['id']}/submit", json={"annotations": anns}, headers=auth(who))
    return p


def test_coco_export_loads_in_pycocotools(client, auth, labelled, tmp_path):
    r = client.get(f"/api/projects/{labelled['id']}/export", params={"format": "coco", "annotator": "all"}, headers=auth("rev"))
    assert r.status_code == 200
    assert "attachment" in r.headers["content-disposition"]
    coco = r.json()
    assert [c["name"] for c in coco["categories"]] == ["cat", "dog"]
    assert len(coco["images"]) == 1 and coco["images"][0]["width"] == 64
    assert len(coco["annotations"]) == 3
    box = next(a for a in coco["annotations"] if a["category_id"] == 1)
    assert box["bbox"] == [10, 8, 20, 16] and box["area"] == 320
    poly = next(a for a in coco["annotations"] if a["category_id"] == 2)
    assert poly["bbox"] == [0, 0, 40, 30] and poly["area"] == 1200
    assert poly["segmentation"] == [[0, 0, 40, 0, 40, 30, 0, 30]]

    pycocotools = pytest.importorskip("pycocotools.coco")
    path = tmp_path / "coco.json"
    path.write_text(json.dumps(coco))
    api = pycocotools.COCO(str(path))
    assert len(api.getAnnIds()) == 3
    assert api.loadCats(api.getCatIds())[0]["name"] == "cat"
    # mask decoding works for both boxes and polygons
    for a in api.loadAnns(api.getAnnIds()):
        mask = api.annToMask(a)
        assert mask.shape == (48, 64) and mask.sum() > 0


def test_coco_best_annotator_picks_one_set(client, auth, labelled):
    coco = client.get(f"/api/projects/{labelled['id']}/export", params={"format": "coco"}, headers=auth("rev")).json()
    users = {a["attributes"]["annotator_id"] for a in coco["annotations"]}
    assert len(users) == 1


def test_yolo_export(client, auth, labelled):
    r = client.get(f"/api/projects/{labelled['id']}/export", params={"format": "yolo", "annotator": "all"}, headers=auth("admin"))
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = z.namelist()
    assert "data.yaml" in names
    labels = [n for n in names if n.startswith("labels/")]
    images = [n for n in names if n.startswith("images/")]
    assert len(labels) == 1 and len(images) == 1
    assert labels[0][len("labels/"):-4] == images[0][len("images/"):-4]
    rows = [line.split() for line in z.read(labels[0]).decode().splitlines()]
    assert len(rows) == 3
    for row in rows:
        assert len(row) == 5 and row[0] in ("0", "1")
        assert all(0 <= float(v) <= 1 for v in row[1:])
    # box (10,8,20,16) in 64x48: centre (20/64, 16/48), size (20/64, 16/48)
    assert ["0", "0.312500", "0.333333", "0.312500", "0.333333"] in rows
    yaml = z.read("data.yaml").decode()
    assert "nc: 2" in yaml and "0: cat" in yaml


def test_jsonl_export(client, auth, labelled):
    r = client.get(f"/api/projects/{labelled['id']}/export", params={"format": "jsonl", "annotator": "all"}, headers=auth("rev"))
    lines = [json.loads(line) for line in r.text.splitlines()]
    assert len(lines) == 1
    rec = lines[0]
    assert len(rec["annotators"]) == 2
    assert rec["consensus_score"] is not None
    assert {a["schema_key"] for ann in rec["annotators"] for a in ann["annotations"]} == {"box", "outline", "quality"}
    all_items = client.get(f"/api/projects/{labelled['id']}/export", params={"format": "jsonl", "status": "all"}, headers=auth("rev"))
    assert len(all_items.text.splitlines()) == 2


def test_approved_filter(client, auth, labelled):
    r = client.get(f"/api/projects/{labelled['id']}/export", params={"format": "coco", "status": "approved"}, headers=auth("rev"))
    assert r.json()["images"] == []


def test_coco_rejected_for_audio(client, auth):
    p = make_project(client, auth("admin"), modality="audio", schema=AUDIO_SCHEMA)
    r = client.get(f"/api/projects/{p['id']}/export", params={"format": "coco"}, headers=auth("admin"))
    assert r.status_code == 422
    assert client.get(f"/api/projects/{p['id']}/export", params={"format": "yolo"}, headers=auth("admin")).status_code == 422
    assert client.get(f"/api/projects/{p['id']}/export", params={"format": "xml"}, headers=auth("admin")).status_code == 422


def test_export_is_audited(client, auth, labelled):
    client.get(f"/api/projects/{labelled['id']}/export", params={"format": "jsonl"}, headers=auth("rev"))
    feed = client.get(f"/api/projects/{labelled['id']}/activity", params={"action": "project.export"}, headers=auth("admin")).json()
    assert feed["total"] == 1 and feed["items"][0]["payload"]["format"] == "jsonl"
