"""Role x endpoint matrix. Each row lists the expected status for admin, annotator, reviewer."""

import pytest

from conftest import make_project, upload_images

BOX = {"schema_key": "box", "label": "cat", "geometry": {"x": 1, "y": 2, "w": 10, "h": 8}}


@pytest.fixture
def world(client, auth):
    """One image project with a labelled item (in review) and a fresh item."""
    p = make_project(client, auth("admin"), annotators_per_item=1, review_required=True)
    items = upload_images(client, auth("admin"), p["id"], 3)
    t = client.get(f"/api/projects/{p['id']}/queue/next", headers=auth("ann1")).json()
    client.post(f"/api/tasks/{t['id']}/submit", json={"annotations": [BOX]}, headers=auth("ann1"))
    return {"p": p["id"], "item": t["item_id"], "task": t["id"], "items": [i["id"] for i in items]}


NEW_PROJECT = {"name": "x", "modality": "image", "schema": {"tools": [{"key": "b", "type": "bbox", "classes": [{"value": "a"}]}]}}

# method, path template, json body, expected (admin, annotator, reviewer)
MATRIX = [
    ("GET", "/api/users", None, (200, 403, 403)),
    ("POST", "/api/users", {"email": "z{who}@x.dev", "name": "Z", "role": "annotator", "password": "longpass"}, (201, 403, 403)),
    ("GET", "/api/projects", None, (200, 200, 200)),
    ("POST", "/api/projects", NEW_PROJECT, (201, 403, 403)),
    ("GET", "/api/projects/{p}", None, (200, 200, 200)),
    ("PATCH", "/api/projects/{p}", {"description": "d"}, (200, 403, 403)),
    ("GET", "/api/projects/{p}/stats", None, (200, 200, 200)),
    ("GET", "/api/projects/{p}/activity", None, (200, 403, 200)),
    ("GET", "/api/projects/{p}/items", None, (200, 200, 200)),
    ("POST", "/api/projects/{p}/items/import", {"path": "/nonexistent"}, (422, 403, 403)),
    ("GET", "/api/items/{item}", None, (200, 200, 200)),
    ("GET", "/api/items/{item}/media", None, (200, 200, 200)),
    ("GET", "/api/items/{item}/annotations", None, (200, 200, 200)),
    ("GET", "/api/items/{item}/consensus", None, (200, 403, 200)),
    ("GET", "/api/items/{item}/review", None, (200, 403, 200)),
    ("POST", "/api/items/{item}/prelabel", None, (200, 200, 200)),
    ("GET", "/api/projects/{p}/queue/next", None, (200, 200, 403)),
    ("GET", "/api/projects/{p}/review/queue/next", None, (200, 403, 200)),
    ("GET", "/api/projects/{p}/export?format=jsonl", None, (200, 403, 200)),
    ("GET", "/api/tasks/{task}", None, (200, 200, 200)),
    ("PUT", "/api/tasks/{task}/annotations", {"annotations": []}, (403, 409, 403)),
    ("DELETE", "/api/projects/{p}", None, (204, 403, 403)),
]


@pytest.mark.parametrize("method,path,body,expected", MATRIX, ids=[f"{m} {p}" for m, p, _, _ in MATRIX])
def test_role_matrix(client, auth, world, method, path, body, expected):
    for who, want in zip(("ann1", "rev", "admin"), (expected[1], expected[2], expected[0])):
        url = path.format(**world)
        payload = None
        if body is not None:
            payload = {k: (v.format(who=who) if isinstance(v, str) else v) for k, v in body.items()}
        r = client.request(method, url, json=payload, headers=auth(who))
        assert r.status_code == want, f"{who} {method} {url}: {r.status_code} {r.text[:200]}"


def test_unauthenticated_is_401_everywhere(client, world):
    for path in ["/api/projects", "/api/users", f"/api/projects/{world['p']}/stats", f"/api/items/{world['item']}",
                 f"/api/projects/{world['p']}/queue/next", f"/api/projects/{world['p']}/export"]:
        assert client.get(path).status_code == 401, path


def test_annotator_reviews_only_for_own_items(client, auth, world):
    # ann1 worked on world["item"]; ann2 did not
    assert client.get(f"/api/items/{world['item']}/reviews", headers=auth("ann1")).status_code == 200
    assert client.get(f"/api/items/{world['item']}/reviews", headers=auth("ann2")).status_code == 403


def test_review_post_roles(client, auth, world):
    url = f"/api/items/{world['item']}/reviews"
    assert client.post(url, json={"decision": "approve"}, headers=auth("ann1")).status_code == 403
    assert client.post(url, json={"decision": "approve"}, headers=auth("rev")).status_code == 201


def test_upload_requires_admin(client, auth, world):
    from conftest import png_bytes

    files = [("files", ("a.png", png_bytes(), "image/png"))]
    assert client.post(f"/api/projects/{world['p']}/items", files=files, headers=auth("ann1")).status_code == 403
    assert client.post(f"/api/projects/{world['p']}/items", files=files, headers=auth("rev")).status_code == 403
    assert client.post(f"/api/projects/{world['p']}/items", files=files, headers=auth("admin")).status_code == 201
