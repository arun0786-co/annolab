from conftest import PASSWORD


def test_login_and_me(client, auth):
    r = client.post("/api/auth/login", json={"email": "ADMIN@x.dev", "password": PASSWORD})
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["role"] == "admin" and body["token"]
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.json()["email"] == "admin@x.dev"


def test_login_wrong_password(client):
    r = client.post("/api/auth/login", json={"email": "admin@x.dev", "password": "nope"})
    assert r.status_code == 401
    assert r.json()["detail"] == "wrong email or password"


def test_missing_and_bad_token(client):
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer garbage"}).status_code == 401


def test_admin_creates_user_and_duplicate_rejected(client, auth):
    body = {"email": "new@x.dev", "name": "New", "role": "annotator", "password": "longpass"}
    r = client.post("/api/users", json=body, headers=auth("admin"))
    assert r.status_code == 201
    assert client.post("/api/users", json=body, headers=auth("admin")).status_code == 409
    r = client.post("/api/auth/login", json={"email": "new@x.dev", "password": "longpass"})
    assert r.status_code == 200


def test_user_can_rename_self_but_not_change_role(client, auth):
    uid = auth.user_id("ann1")
    r = client.patch(f"/api/users/{uid}", json={"name": "Renamed"}, headers=auth("ann1"))
    assert r.status_code == 200 and r.json()["name"] == "Renamed"
    assert client.patch(f"/api/users/{uid}", json={"role": "admin"}, headers=auth("ann1")).status_code == 403
    other = auth.user_id("ann2")
    assert client.patch(f"/api/users/{other}", json={"name": "x"}, headers=auth("ann1")).status_code == 403


def test_deactivated_user_cannot_use_token(client, auth):
    headers = auth("ann2")
    uid = auth.user_id("ann2")
    assert client.patch(f"/api/users/{uid}", json={"active": False}, headers=auth("admin")).status_code == 200
    assert client.get("/api/auth/me", headers=headers).status_code == 401
    r = client.post("/api/auth/login", json={"email": "ann2@x.dev", "password": PASSWORD})
    assert r.status_code == 403


def test_admin_cannot_demote_self(client, auth):
    uid = auth.user_id("admin")
    assert client.patch(f"/api/users/{uid}", json={"role": "annotator"}, headers=auth("admin")).status_code == 409


def test_password_change(client, auth):
    uid = auth.user_id("ann3")
    assert client.patch(f"/api/users/{uid}", json={"password": "another1"}, headers=auth("ann3")).status_code == 200
    assert client.post("/api/auth/login", json={"email": "ann3@x.dev", "password": "another1"}).status_code == 200
