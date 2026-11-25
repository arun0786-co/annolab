from conftest import make_project, upload_images

BOX = {"schema_key": "box", "label": "cat", "geometry": {"x": 1, "y": 2, "w": 10, "h": 8}}
BOX2 = {"schema_key": "box", "label": "dog", "geometry": {"x": 30, "y": 20, "w": 10, "h": 8}}


def _label_item(client, auth, p, who, anns):
    t = client.get(f"/api/projects/{p['id']}/queue/next", headers=auth(who)).json()
    r = client.post(f"/api/tasks/{t['id']}/submit", json={"annotations": anns, "time_spent_ms": 3000}, headers=auth(who))
    assert r.status_code == 200
    return t


def test_full_review_cycle_with_pinned_comment(client, auth):
    p = make_project(client, auth("admin"), annotators_per_item=2, review_required=True)
    upload_images(client, auth("admin"), p["id"], 1)
    t1 = _label_item(client, auth, p, "ann1", [BOX])
    item_id = t1["item_id"]
    assert client.get(f"/api/items/{item_id}", headers=auth("rev")).json()["status"] == "in_progress"
    _label_item(client, auth, p, "ann2", [BOX, BOX2])
    assert client.get(f"/api/items/{item_id}", headers=auth("rev")).json()["status"] == "in_review"

    nxt = client.get(f"/api/projects/{p['id']}/review/queue/next", headers=auth("rev"))
    assert nxt.status_code == 200
    body = nxt.json()
    assert body["item"]["id"] == item_id and len(body["annotators"]) == 2
    assert body["consensus_score"] is not None
    ann2 = next(a for a in body["annotators"] if a["user"]["email"] == "ann2@x.dev")
    extra = next(a for a in ann2["annotations"] if a["label"] == "dog")

    r = client.post(f"/api/items/{item_id}/reviews", json={
        "decision": "reject", "comment": "one box is not an animal",
        "comments": [{"annotation_id": extra["id"], "body": "background, remove", "x": 35, "y": 24}],
    }, headers=auth("rev"))
    assert r.status_code == 201, r.text
    review = r.json()
    assert review["comments"][0]["annotation_id"] == extra["id"]
    assert client.get(f"/api/items/{item_id}", headers=auth("rev")).json()["status"] == "rejected"
    # nothing left for review while the item is reopened
    assert client.get(f"/api/projects/{p['id']}/review/queue/next", headers=auth("rev")).status_code == 204

    # only ann2 (author of the pinned annotation) gets the task back, with the review attached
    assert client.get(f"/api/projects/{p['id']}/queue/next", headers=auth("ann1")).status_code == 204
    back = client.get(f"/api/projects/{p['id']}/queue/next", headers=auth("ann2")).json()
    assert back["item_id"] == item_id and back["status"] == "in_progress"
    assert back["reviews"][0]["decision"] == "reject"
    assert back["reviews"][0]["comments"][0]["body"] == "background, remove"

    keep = [{**BOX, "id": a["id"]} for a in back["annotations"] if a["label"] == "cat"]
    r = client.post(f"/api/tasks/{back['id']}/submit", json={"annotations": keep}, headers=auth("ann2"))
    assert r.status_code == 200
    assert client.get(f"/api/items/{item_id}", headers=auth("rev")).json()["status"] == "in_review"

    r = client.post(f"/api/items/{item_id}/reviews", json={"decision": "approve"}, headers=auth("rev"))
    assert r.status_code == 201
    assert client.get(f"/api/items/{item_id}", headers=auth("rev")).json()["status"] == "approved"
    history = client.get(f"/api/items/{item_id}/reviews", headers=auth("ann1")).json()
    assert [h["decision"] for h in history] == ["approve", "reject"]
    # pinned comment survives; its annotation was deleted by the resubmit, so the pin is cleared
    assert history[1]["comments"][0]["annotation_id"] is None


def test_reject_without_pins_reopens_everyone(client, auth):
    p = make_project(client, auth("admin"), annotators_per_item=2, review_required=True)
    upload_images(client, auth("admin"), p["id"], 1)
    t1 = _label_item(client, auth, p, "ann1", [BOX])
    _label_item(client, auth, p, "ann2", [BOX])
    r = client.post(f"/api/items/{t1['item_id']}/reviews", json={"decision": "reject", "comment": "redo"}, headers=auth("rev"))
    assert r.status_code == 201
    for who in ("ann1", "ann2"):
        assert client.get(f"/api/projects/{p['id']}/queue/next", headers=auth(who)).json()["item_id"] == t1["item_id"]


def test_reject_with_explicit_reopen_list(client, auth):
    p = make_project(client, auth("admin"), annotators_per_item=2, review_required=True)
    upload_images(client, auth("admin"), p["id"], 1)
    t1 = _label_item(client, auth, p, "ann1", [BOX])
    _label_item(client, auth, p, "ann2", [BOX])
    uid = auth.user_id("ann1")
    client.post(f"/api/items/{t1['item_id']}/reviews", json={"decision": "reject", "reopen_user_ids": [uid]}, headers=auth("rev"))
    assert client.get(f"/api/projects/{p['id']}/queue/next", headers=auth("ann2")).status_code == 204
    assert client.get(f"/api/projects/{p['id']}/queue/next", headers=auth("ann1")).status_code == 200


def test_review_guards(client, auth):
    p = make_project(client, auth("admin"), annotators_per_item=2, review_required=True)
    items = upload_images(client, auth("admin"), p["id"], 1)
    item_id = items[0]["id"]
    assert client.post(f"/api/items/{item_id}/reviews", json={"decision": "approve"}, headers=auth("rev")).status_code == 409
    _label_item(client, auth, p, "ann1", [BOX])
    client.get(f"/api/projects/{p['id']}/queue/next", headers=auth("ann2"))  # open task
    assert client.post(f"/api/items/{item_id}/reviews", json={"decision": "approve"}, headers=auth("rev")).status_code == 409
    assert client.post(f"/api/items/{item_id}/reviews", json={"decision": "maybe"}, headers=auth("rev")).status_code == 422
    assert client.post(f"/api/items/{item_id}/reviews", json={"decision": "approve"}, headers=auth("ann1")).status_code == 403


def test_pin_must_belong_to_item(client, auth):
    p = make_project(client, auth("admin"), annotators_per_item=1, review_required=True)
    upload_images(client, auth("admin"), p["id"], 2)
    t1 = _label_item(client, auth, p, "ann1", [BOX])
    t2 = _label_item(client, auth, p, "ann1", [BOX])
    other = client.get(f"/api/tasks/{t2['id']}", headers=auth("ann1")).json()["annotations"][0]["id"]
    r = client.post(f"/api/items/{t1['item_id']}/reviews", json={"decision": "reject", "comments": [{"annotation_id": other, "body": "x"}]}, headers=auth("rev"))
    assert r.status_code == 422


def test_optional_review_spot_check(client, auth):
    p = make_project(client, auth("admin"), annotators_per_item=1, review_required=False)
    upload_images(client, auth("admin"), p["id"], 1)
    t = _label_item(client, auth, p, "ann1", [BOX])
    assert client.get(f"/api/items/{t['item_id']}", headers=auth("rev")).json()["status"] == "labeled"
    nxt = client.get(f"/api/projects/{p['id']}/review/queue/next", headers=auth("rev"))
    assert nxt.status_code == 200
    client.post(f"/api/items/{t['item_id']}/reviews", json={"decision": "approve"}, headers=auth("rev"))
    assert client.get(f"/api/items/{t['item_id']}", headers=auth("rev")).json()["status"] == "approved"


def test_consensus_endpoint(client, auth):
    p = make_project(client, auth("admin"), annotators_per_item=2)
    upload_images(client, auth("admin"), p["id"], 1)
    t1 = _label_item(client, auth, p, "ann1", [BOX, {"schema_key": "quality", "label": "good"}])
    shifted = {**BOX, "geometry": {"x": 2, "y": 2, "w": 10, "h": 8}}  # IoU = 9*8 / (160 - 72) = 72/88
    _label_item(client, auth, p, "ann2", [shifted, {"schema_key": "quality", "label": "bad"}])
    r = client.get(f"/api/items/{t1['item_id']}/consensus", headers=auth("rev"))
    assert r.status_code == 200
    c = r.json()
    box = next(t for t in c["tools"] if t["schema_key"] == "box")
    assert box["pairs"][0]["matches"][0]["iou"] == round(72 / 88, 4)
    assert box["agreement"] == 1.0
    q = c["classifications"][0]
    assert q["agreement"] == 0.0 and q["majority"] is None
    assert c["score"] == 0.5
    # stricter threshold: IoU 0.818 < 0.9 so the boxes no longer match
    strict = client.get(f"/api/items/{t1['item_id']}/consensus", params={"threshold": 0.9}, headers=auth("rev")).json()
    assert next(t for t in strict["tools"] if t["schema_key"] == "box")["agreement"] == 0.0
    assert client.get(f"/api/items/{t1['item_id']}/consensus", headers=auth("ann1")).status_code == 403
