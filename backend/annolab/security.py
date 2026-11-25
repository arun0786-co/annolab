"""Password hashing (stdlib scrypt) and JWT tokens."""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
from datetime import UTC, datetime, timedelta

import jwt

_N, _R, _P = 2**14, 8, 1


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=32)
    b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
    return f"scrypt${_N}${_R}${_P}${b64(salt)}${b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, digest = stored.split("$")
    except ValueError:
        return False
    if algo != "scrypt":
        return False
    expected = base64.b64decode(digest)
    got = hashlib.scrypt(
        password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=len(expected)
    )
    return hmac.compare_digest(got, expected)


def create_token(user_id: int, secret: str, ttl_minutes: int) -> str:
    now = datetime.now(UTC)
    payload = {"sub": str(user_id), "iat": now, "exp": now + timedelta(minutes=ttl_minutes)}
    return jwt.encode(payload, secret, algorithm="HS256")


def decode_token(token: str, secret: str) -> int | None:
    try:
        payload = jwt.decode(token, secret, algorithms=["HS256"])
        return int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        return None
