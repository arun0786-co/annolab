"""Edge cases in the review flow, schema edits, bounds and user deactivation."""

import pytest

from annolab.geometry import track_iou
from conftest import make_project, upload_images

BOX = {"schema_key": "box", "label": "cat", "geometry": {"x": 1, "y": 2, "w": 10, "h": 8}}


def _next(client, auth, p, who):
    return client.get(f"/api/projects/{p['id']}/queue/next", headers=auth(who))


def _submit(client, auth, p, who, anns=(BOX,)):
    t = _next(client, auth, p, who).json()
    r = client.post(f"/api/tasks/{t['id']}/submit", json={"annotations": list(anns)}, headers=auth(who))
    assert r.status_code == 200, r.text
    return t


def _status(client, auth, item_id):
    return client.get(f"/api/items/{item_id}", headers=auth("admin")).json()["status"]


def test_reject_with_unknown_reopen_ids_is_refused(client, auth):
    p = make_project(client, auth("admin"), annotators_per_item=1, review_required=True)
    upload_images(client, auth("admin"), p["id"], 1)
    t = _submit(client, auth, p, "ann1")
    r = client.post(f"/api/items/{t['item_id']}/reviews", json={"decision": "reject", "reopen_user_ids": [9999]},
                    headers=auth("rev"))
    assert r.status_code == 422
    assert _status(client, auth, t["item_id"]) == "in_review"
    assert client.get(f"/api/projects/{p['id']}/review/queue/next", headers=auth("rev")).status_code == 200


def test_skipping_a_reopened_task_frees_the_slot(client, auth):
    p = make_project(client, auth("admin"), annotators_per_item=2, review_required=True)
    upload_images(client, auth("admin"), p["id"], 1)
    t1 = _submit(client, auth, p, "ann1")
    _submit(client, auth, p, "ann2")
    item_id = t1["item_id"]
    r = client.post(f"/api/items/{item_id}/reviews",
                    json={"decision": "reject", "reopen_user_ids": [auth.user_id("ann1")]}, headers=auth("rev"))
    assert r.status_code == 201
    assert _status(client, auth, item_id) == "rejected"
    back = _next(client, auth, p, "ann1").json()
    assert client.post(f"/api/tasks/{back['id']}/skip", json={}, headers=auth("ann1")).status_code == 200
    assert _status(client, auth, item_id) == "in_progress"
    # a third annotator can take the free slot, and the item reaches review again
    _submit(client, auth, p, "ann3")
    assert _status(client, auth, item_id) == "in_review"


def test_review_needs_enough_submissions(client, auth):
    p = make_project(client, auth("admin"), annotators_per_item=3, review_required=True)
    upload_images(client, auth("admin"), p["id"], 1)
    t = _submit(client, auth, p, "ann1")
    r = client.post(f"/api/items/{t['item_id']}/reviews", json={"decision": "approve"}, headers=auth("rev"))
    assert r.status_code == 409
    assert _status(client, auth, t["item_id"]) == "in_progress"
    assert _next(client, auth, p, "ann2").status_code == 200


def test_lowering_annotators_per_item_refreshes_status(client, auth):
    p = make_project(client, auth("admin"), annotators_per_item=2, review_required=True)
    upload_images(client, auth("admin"), p["id"], 1)
    t = _submit(client, auth, p, "ann1")
    assert _status(client, auth, t["item_id"]) == "in_progress"
    r = client.patch(f"/api/projects/{p['id']}", json={"annotators_per_item": 1}, headers=auth("admin"))
    assert r.status_code == 200
    assert _status(client, auth, t["item_id"]) == "in_review"
    assert client.get(f"/api/projects/{p['id']}/review/queue/next", headers=auth("rev")).status_code == 200


def test_removing_used_attribute_option_is_refused(client, auth):
    p = make_project(client, auth("admin"))
    upload_images(client, auth("admin"), p["id"], 1)
    t = _next(client, auth, p, "ann1").json()
    ann = {**BOX, "attributes": {"occluded": "yes"}}
    assert client.put(f"/api/tasks/{t['id']}/annotations", json={"annotations": [ann]},
                      headers=auth("ann1")).status_code == 200
    schema = client.get(f"/api/projects/{p['id']}", headers=auth("admin")).json()["schema"]
    schema["tools"][0]["attributes"][0]["options"] = ["no", "partly"]
    r = client.patch(f"/api/projects/{p['id']}", json={"schema": schema}, headers=auth("admin"))
    assert r.status_code == 409 and "box.occluded=yes" in r.json()["detail"]
    schema["tools"][0]["attributes"] = []
    r = client.patch(f"/api/projects/{p['id']}", json={"schema": schema}, headers=auth("admin"))
    assert r.status_code == 409 and "box.occluded:select" in r.json()["detail"]
    # adding an option is fine
    schema["tools"][0]["attributes"] = [{"key": "occluded", "type": "select", "options": ["yes", "no", "partly"]}]
    assert client.patch(f"/api/projects/{p['id']}", json={"schema": schema}, headers=auth("admin")).status_code == 200


def test_deactivating_a_user_releases_open_tasks(client, auth):
    p = make_project(client, auth("admin"), annotators_per_item=1)
    upload_images(client, auth("admin"), p["id"], 1)
    t = _next(client, auth, p, "ann1").json()
    client.put(f"/api/tasks/{t['id']}/annotations", json={"annotations": [BOX]}, headers=auth("ann1"))
    uid = auth.user_id("ann1")
    r = client.patch(f"/api/users/{uid}", json={"active": False}, headers=auth("admin"))
    assert r.status_code == 200
    got = _next(client, auth, p, "ann2")
    assert got.status_code == 200 and got.json()["item_id"] == t["item_id"]
    # the released annotations are kept for the record
    anns = client.get(f"/api/items/{t['item_id']}/annotations?user_id={uid}&include_open=true", headers=auth("admin")).json()
    assert any(a["user_id"] == uid for a in anns)


def test_span_past_text_and_duplicate_radio_are_refused(client, auth):
    schema = {"tools": [{"key": "ent", "type": "span", "classes": [{"value": "x"}]}],
              "classifications": [{"key": "q", "type": "radio", "options": ["a", "b"]}]}
    p = make_project(client, auth("admin"), modality="text", schema=schema)
    files = [("files", ("n.txt", b"hello", "text/plain"))]
    assert client.post(f"/api/projects/{p['id']}/items", files=files, headers=auth("admin")).status_code == 201
    t = _next(client, auth, p, "ann1").json()
    url = f"/api/tasks/{t['id']}/annotations"
    span = {"schema_key": "ent", "label": "x", "geometry": {"start": 3, "end": 5000}}
    r = client.put(url, json={"annotations": [span]}, headers=auth("ann1"))
    assert r.status_code == 422 and "text length 5" in r.json()["detail"]
    ok = {**span, "geometry": {"start": 3, "end": 5}}
    qa, qb = {"schema_key": "q", "label": "a"}, {"schema_key": "q", "label": "b"}
    assert client.put(url, json={"annotations": [ok, qa, qb]}, headers=auth("ann1")).status_code == 422
    assert client.put(url, json={"annotations": [ok, qa]}, headers=auth("ann1")).status_code == 200


def test_coco_clips_to_image(client, auth):
    p = make_project(client, auth("admin"))
    upload_images(client, auth("admin"), p["id"], 1, w=64, h=48)
    poly = {"schema_key": "outline", "label": "dog", "geometry": {"points": [[50, 0], [80, 0], [80, 20], [50, 20]]}}
    _submit(client, auth, p, "ann1", [{**BOX, "geometry": {"x": -20, "y": 40, "w": 200, "h": 30}}, poly])
    coco = client.get(f"/api/projects/{p['id']}/export?format=coco&status=all", headers=auth("admin")).json()
    box, outline = coco["annotations"]
    assert box["bbox"] == [0.0, 40.0, 64.0, 8.0] and box["area"] == 512.0
    assert outline["bbox"] == [50.0, 0.0, 14.0, 20.0] and outline["area"] == pytest.approx(280.0)
    xs = outline["segmentation"][0][0::2]
    assert max(xs) == 64.0


@pytest.mark.parametrize("end", [0.3, 0.7, 1.3, 2.9])
def test_identical_tracks_score_one(end):
    tr = {"keyframes": [{"t": 0.0, "x": 0, "y": 0, "w": 10, "h": 10}, {"t": end, "x": 5, "y": 5, "w": 10, "h": 10}]}
    assert track_iou(tr, tr) == pytest.approx(1.0)
