from conftest import make_project, upload_images

BOX = {"schema_key": "box", "label": "cat", "geometry": {"x": 1, "y": 2, "w": 10, "h": 8}}


def test_project_crud_and_schema_rules(client, auth):
    p = make_project(client, auth("admin"), name="Pets", description="d", instructions="# Rules")
    assert p["schema"]["tools"][0]["classes"][0]["color"].startswith("#")
    r = client.patch(f"/api/projects/{p['id']}", json={"name": "Pets 2", "annotators_per_item": 2}, headers=auth("admin"))
    assert r.json()["name"] == "Pets 2" and r.json()["annotators_per_item"] == 2
    bad = client.post("/api/projects", json={"name": "x", "modality": "audio",
                                             "schema": {"tools": [{"key": "b", "type": "bbox", "classes": [{"value": "a"}]}]}},
                      headers=auth("admin"))
    assert bad.status_code == 422 and "not available" in bad.json()["detail"]
    assert client.get("/api/projects/9999", headers=auth("admin")).status_code == 404


def test_schema_change_cannot_orphan_labels(client, auth):
    p = make_project(client, auth("admin"))
    upload_images(client, auth("admin"), p["id"], 1)
    schema = p["schema"]
    t = client.get(f"/api/projects/{p['id']}/queue/next", headers=auth("ann1")).json()
    client.post(f"/api/tasks/{t['id']}/submit", json={"annotations": [BOX]}, headers=auth("ann1"))
    shrunk = {**schema, "tools": [{**schema["tools"][0], "classes": schema["tools"][0]["classes"][:1]}] + schema["tools"][1:]}
    r = client.patch(f"/api/projects/{p['id']}", json={"schema": shrunk}, headers=auth("admin"))
    assert r.status_code == 409 and "box/dog" in r.json()["detail"]
    grown = {**schema, "tools": [{**schema["tools"][0], "classes": schema["tools"][0]["classes"] + [{"value": "bird"}]}] + schema["tools"][1:]}
    r = client.patch(f"/api/projects/{p['id']}", json={"schema": grown}, headers=auth("admin"))
    assert r.status_code == 200
    assert [c["value"] for c in r.json()["schema"]["tools"][0]["classes"]] == ["cat", "dog", "bird"]


def test_stats_counts_throughput_and_agreement(client, auth):
    p = make_project(client, auth("admin"), annotators_per_item=2)
    upload_images(client, auth("admin"), p["id"], 3)
    times = {"ann1": [10_000, 30_000], "ann2": [20_000, 40_000]}
    for i in range(2):
        for who in ("ann1", "ann2"):
            t = client.get(f"/api/projects/{p['id']}/queue/next", headers=auth(who)).json()
            q = {"schema_key": "quality", "label": "good" if (who == "ann1" or i == 0) else "bad"}
            client.post(f"/api/tasks/{t['id']}/submit", json={"annotations": [BOX, q], "time_spent_ms": times[who][i]}, headers=auth(who))
    t = client.get(f"/api/projects/{p['id']}/queue/next", headers=auth("ann3")).json()
    client.post(f"/api/tasks/{t['id']}/skip", headers=auth("ann3"))

    s = client.get(f"/api/projects/{p['id']}/stats", headers=auth("ann1")).json()
    assert s["item_count"] == 3
    assert s["status_counts"] == {"labeled": 2, "unlabeled": 1}
    assert s["task_counts"] == {"submitted": 4, "skipped": 1}
    rows = {r["user"]["email"]: r for r in s["throughput"]}
    assert rows["ann1@x.dev"]["submitted"] == 2 and rows["ann1@x.dev"]["median_seconds"] == 20.0
    assert rows["ann2@x.dev"]["median_seconds"] == 30.0 and rows["ann2@x.dev"]["total_seconds"] == 60.0
    assert rows["ann3@x.dev"]["skipped"] == 1 and rows["ann3@x.dev"]["median_seconds"] is None
    ag = s["agreement"]
    assert ag["items_compared"] == 2
    box = next(t for t in ag["tools"] if t["schema_key"] == "box")
    assert box["mean_agreement"] == 1.0 and box["mean_iou"] == 1.0
    q = ag["classifications"][0]
    assert q["items"] == 2
    # item 1 both good (1.0), item 2 good vs bad (0.0); box 1.0 on both -> mean of (1,1) and (1,0) = 0.75
    assert ag["mean_item_agreement"] == 0.75
    dist = {(d["schema_key"], d["label"]): d["count"] for d in s["label_distribution"]}
    assert dist == {("box", "cat"): 4, ("quality", "good"): 3, ("quality", "bad"): 1}
    assert sum(d["submitted"] for d in s["daily"]) == 4

    listed = client.get("/api/projects", headers=auth("ann1")).json()[0]
    assert listed["item_count"] == 3 and listed["progress"] == 2 / 3 and listed["agreement"] == 0.75


def test_activity_feed(client, auth):
    p = make_project(client, auth("admin"))
    upload_images(client, auth("admin"), p["id"], 1)
    t = client.get(f"/api/projects/{p['id']}/queue/next", headers=auth("ann1")).json()
    client.post(f"/api/tasks/{t['id']}/submit", json={"annotations": [BOX]}, headers=auth("ann1"))
    feed = client.get(f"/api/projects/{p['id']}/activity", headers=auth("rev")).json()
    actions = [e["action"] for e in feed["items"]]
    assert actions == ["task.submit", "task.assign", "items.upload", "project.create"]
    assert feed["items"][0]["user"]["email"] == "ann1@x.dev"
    assert feed["items"][0]["payload"]["annotations"] == 1
    page = client.get(f"/api/projects/{p['id']}/activity", params={"page_size": 2, "page": 2}, headers=auth("rev")).json()
    assert [e["action"] for e in page["items"]] == ["items.upload", "project.create"]


def test_error_shape(client, auth):
    r = client.post("/api/projects", json={"name": ""}, headers=auth("admin"))
    assert r.status_code == 422 and isinstance(r.json()["detail"], str)
