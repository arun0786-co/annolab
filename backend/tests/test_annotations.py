from conftest import make_project, upload_images


def _task(client, auth, who="ann1", **kw):
    p = make_project(client, auth("admin"), **kw)
    upload_images(client, auth("admin"), p["id"], 2)
    return p, client.get(f"/api/projects/{p['id']}/queue/next", headers=auth(who)).json()


BOX = {"schema_key": "box", "label": "cat", "geometry": {"x": 1, "y": 2, "w": 10, "h": 8}}
POLY = {"schema_key": "outline", "label": "dog", "geometry": {"points": [[0, 0], [5, 0], [5, 5]]}}
Q = {"schema_key": "quality", "label": "good"}


def test_autosave_replaces_full_set_and_keeps_ids(client, auth):
    _, t = _task(client, auth)
    url = f"/api/tasks/{t['id']}/annotations"
    r = client.put(url, json={"annotations": [BOX, POLY, Q], "time_spent_ms": 4000}, headers=auth("ann1"))
    assert r.status_code == 200, r.text
    saved = r.json()
    assert [a["schema_key"] for a in saved] == ["box", "outline", "quality"]
    box_id = saved[0]["id"]
    # second save: keep the box (moved), drop the polygon, keep the classification
    moved = {**BOX, "id": box_id, "geometry": {"x": 3, "y": 2, "w": 10, "h": 8}}
    r = client.put(url, json={"annotations": [moved, {**Q, "id": saved[2]["id"]}], "time_spent_ms": 2000}, headers=auth("ann1"))
    again = r.json()
    assert [a["id"] for a in again] == [box_id, saved[2]["id"]]
    assert again[0]["geometry"]["x"] == 3
    detail = client.get(f"/api/tasks/{t['id']}", headers=auth("ann1")).json()
    assert len(detail["annotations"]) == 2
    assert detail["status"] == "in_progress"
    assert detail["time_spent_ms"] == 4000  # cumulative: keeps the max reported


def test_autosave_is_idempotent(client, auth):
    _, t = _task(client, auth)
    url = f"/api/tasks/{t['id']}/annotations"
    first = client.put(url, json={"annotations": [BOX]}, headers=auth("ann1")).json()
    second = client.put(url, json={"annotations": [{**BOX, "id": first[0]["id"]}]}, headers=auth("ann1")).json()
    assert first[0]["id"] == second[0]["id"]
    assert first[0]["updated_at"] == second[0]["updated_at"]


def test_unknown_id_creates_new_annotation(client, auth):
    _, t = _task(client, auth)
    r = client.put(f"/api/tasks/{t['id']}/annotations", json={"annotations": [{**BOX, "id": 999999}]}, headers=auth("ann1"))
    assert r.json()[0]["id"] != 999999


def test_invalid_annotation_rejected_and_nothing_saved(client, auth):
    _, t = _task(client, auth)
    url = f"/api/tasks/{t['id']}/annotations"
    client.put(url, json={"annotations": [BOX]}, headers=auth("ann1"))
    bad = {"schema_key": "box", "label": "zebra", "geometry": {"x": 0, "y": 0, "w": 1, "h": 1}}
    r = client.put(url, json={"annotations": [BOX, bad]}, headers=auth("ann1"))
    assert r.status_code == 422
    assert "annotation 1" in r.json()["detail"]
    assert len(client.get(f"/api/tasks/{t['id']}", headers=auth("ann1")).json()["annotations"]) == 1


def test_only_assignee_can_save_or_submit(client, auth):
    _, t = _task(client, auth)
    url = f"/api/tasks/{t['id']}/annotations"
    assert client.put(url, json={"annotations": [BOX]}, headers=auth("ann2")).status_code == 403
    assert client.post(f"/api/tasks/{t['id']}/submit", headers=auth("ann2")).status_code == 403
    assert client.get(f"/api/tasks/{t['id']}", headers=auth("ann2")).status_code == 403
    # admins and reviewers can read it but not change it
    assert client.get(f"/api/tasks/{t['id']}", headers=auth("rev")).status_code == 200
    assert client.put(url, json={"annotations": [BOX]}, headers=auth("admin")).status_code == 403


def test_submitted_task_is_frozen(client, auth):
    _, t = _task(client, auth)
    r = client.post(f"/api/tasks/{t['id']}/submit", json={"annotations": [BOX], "time_spent_ms": 1500}, headers=auth("ann1"))
    assert r.status_code == 200 and r.json()["status"] == "submitted" and r.json()["time_spent_ms"] == 1500
    assert client.put(f"/api/tasks/{t['id']}/annotations", json={"annotations": []}, headers=auth("ann1")).status_code == 409
    assert client.post(f"/api/tasks/{t['id']}/submit", headers=auth("ann1")).status_code == 409


def test_annotation_visibility(client, auth):
    p, t1 = _task(client, auth, annotators_per_item=2)
    client.post(f"/api/tasks/{t1['id']}/submit", json={"annotations": [BOX]}, headers=auth("ann1"))
    t2 = client.get(f"/api/projects/{p['id']}/queue/next", headers=auth("ann2")).json()
    assert t2["item_id"] == t1["item_id"]
    client.put(f"/api/tasks/{t2['id']}/annotations", json={"annotations": [POLY]}, headers=auth("ann2"))
    item = t1["item_id"]
    own = client.get(f"/api/items/{item}/annotations", headers=auth("ann2")).json()
    assert [a["schema_key"] for a in own] == ["outline"]
    uid1 = auth.user_id("ann1")
    assert client.get(f"/api/items/{item}/annotations", params={"user_id": uid1}, headers=auth("ann2")).status_code == 403
    rev = client.get(f"/api/items/{item}/annotations", headers=auth("rev")).json()
    assert [a["schema_key"] for a in rev] == ["box"]  # submitted work only
    rev_all = client.get(f"/api/items/{item}/annotations", params={"include_open": True}, headers=auth("rev")).json()
    assert len(rev_all) == 2


def test_model_source_round_trips(client, auth):
    _, t = _task(client, auth)
    r = client.put(f"/api/tasks/{t['id']}/annotations", json={"annotations": [{**BOX, "source": "model"}]}, headers=auth("ann1"))
    assert r.json()[0]["source"] == "model"
