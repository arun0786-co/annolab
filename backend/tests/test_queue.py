import threading
from collections import Counter

from fastapi.testclient import TestClient

from annolab.models import User
from annolab.security import hash_password
from conftest import PASSWORD, make_project, upload_images


def _next(client, headers, pid):
    return client.get(f"/api/projects/{pid}/queue/next", headers=headers)


def test_queue_resumes_open_task(client, auth):
    p = make_project(client, auth("admin"))
    upload_images(client, auth("admin"), p["id"], 2)
    t1 = _next(client, auth("ann1"), p["id"]).json()
    t2 = _next(client, auth("ann1"), p["id"]).json()
    assert t1["id"] == t2["id"]
    assert t1["status"] == "assigned" and t1["item"]["status"] == "in_progress"


def test_queue_respects_annotators_per_item_and_never_repeats(client, auth):
    p = make_project(client, auth("admin"), annotators_per_item=2)
    items = upload_images(client, auth("admin"), p["id"], 2)
    seen = {"ann1": [], "ann2": [], "ann3": []}
    for _ in range(3):
        for who in seen:
            r = _next(client, auth(who), p["id"])
            if r.status_code == 204:
                continue
            task = r.json()
            seen[who].append(task["item_id"])
            assert client.post(f"/api/tasks/{task['id']}/submit", headers=auth(who)).status_code == 200
    for who, got in seen.items():
        assert len(got) == len(set(got)), f"{who} got an item twice"
    per_item = Counter(i for got in seen.values() for i in got)
    assert per_item == {items[0]["id"]: 2, items[1]["id"]: 2}
    # everything is labelled now
    for who in seen:
        assert _next(client, auth(who), p["id"]).status_code == 204
    statuses = {i["status"] for i in client.get(f"/api/projects/{p['id']}/items", headers=auth("admin")).json()["items"]}
    assert statuses == {"labeled"}


def test_queue_fills_started_items_first(client, auth):
    p = make_project(client, auth("admin"), annotators_per_item=2)
    items = upload_images(client, auth("admin"), p["id"], 3)
    a = _next(client, auth("ann1"), p["id"]).json()
    b = _next(client, auth("ann2"), p["id"]).json()
    assert a["item_id"] == b["item_id"] == items[0]["id"]


def test_skip_frees_slot_and_is_not_served_again(client, auth):
    p = make_project(client, auth("admin"), annotators_per_item=1)
    items = upload_images(client, auth("admin"), p["id"], 2)
    t = _next(client, auth("ann1"), p["id"]).json()
    r = client.post(f"/api/tasks/{t['id']}/skip", json={"reason": "blurry"}, headers=auth("ann1"))
    assert r.status_code == 200 and r.json()["status"] == "skipped"
    t2 = _next(client, auth("ann1"), p["id"]).json()
    assert t2["item_id"] == items[1]["id"]
    # the skipped item goes to someone else
    t3 = _next(client, auth("ann2"), p["id"]).json()
    assert t3["item_id"] == items[0]["id"]
    assert client.post(f"/api/tasks/{t['id']}/skip", headers=auth("ann1")).status_code == 409


def test_reviewer_cannot_take_labeling_tasks(client, auth):
    p = make_project(client, auth("admin"))
    upload_images(client, auth("admin"), p["id"], 1)
    assert _next(client, auth("rev"), p["id"]).status_code == 403


def test_concurrent_users_never_share_an_item(app, auth):
    """12 annotators race for 6 single-annotator items: each item goes out exactly once."""
    client = TestClient(app)
    admin = auth("admin")
    p = make_project(client, admin, annotators_per_item=1)
    upload_images(client, admin, p["id"], 6)
    with app.state.db.sessionmaker() as db:
        for i in range(12):
            db.add(User(email=f"race{i}@x.dev", name=f"Race {i}", role="annotator", password_hash=hash_password(PASSWORD)))
        db.commit()
    tokens = []
    for i in range(12):
        r = client.post("/api/auth/login", json={"email": f"race{i}@x.dev", "password": PASSWORD})
        tokens.append({"Authorization": f"Bearer {r.json()['token']}"})

    results: list = [None] * 12
    barrier = threading.Barrier(12)

    def worker(i):
        c = TestClient(app)
        barrier.wait()
        r = c.get(f"/api/projects/{p['id']}/queue/next", headers=tokens[i])
        results[i] = (r.status_code, r.json()["item_id"] if r.status_code == 200 else None)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    served = [item for code, item in results if code == 200]
    assert sorted(code for code, _ in results) == [200] * 6 + [204] * 6
    assert len(served) == len(set(served)) == 6


def test_concurrent_requests_from_one_user_create_one_task(app, auth):
    client = TestClient(app)
    p = make_project(client, auth("admin"), annotators_per_item=3)
    upload_images(client, auth("admin"), p["id"], 4)
    headers = auth("ann1")
    ids: list = []
    barrier = threading.Barrier(8)

    def worker():
        c = TestClient(app)
        barrier.wait()
        r = c.get(f"/api/projects/{p['id']}/queue/next", headers=headers)
        ids.append(r.json()["id"])

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(set(ids)) == 1
    tasks = client.get("/api/tasks", params={"project_id": p["id"]}, headers=headers).json()
    assert len(tasks) == 1


def test_concurrent_mixed_capacity(app, auth):
    """annotators_per_item=2, 3 items, 9 users at once: every item gets exactly two distinct users."""
    client = TestClient(app)
    p = make_project(client, auth("admin"), annotators_per_item=2)
    upload_images(client, auth("admin"), p["id"], 3)
    with app.state.db.sessionmaker() as db:
        for i in range(9):
            db.add(User(email=f"mix{i}@x.dev", name=f"Mix {i}", role="annotator", password_hash=hash_password(PASSWORD)))
        db.commit()
    heads = []
    for i in range(9):
        r = client.post("/api/auth/login", json={"email": f"mix{i}@x.dev", "password": PASSWORD})
        heads.append({"Authorization": f"Bearer {r.json()['token']}"})
    out: list = []
    barrier = threading.Barrier(9)

    def worker(h):
        c = TestClient(app)
        barrier.wait()
        r = c.get(f"/api/projects/{p['id']}/queue/next", headers=h)
        if r.status_code == 200:
            out.append(r.json()["item_id"])

    threads = [threading.Thread(target=worker, args=(h,)) for h in heads]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(Counter(out).values()) == [2, 2, 2]
