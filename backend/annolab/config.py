"""Runtime settings, read from environment variables."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    secret: str
    token_ttl_minutes: int = 60 * 12

    @property
    def db_path(self) -> Path:
        return self.data_dir / "annolab.db"

    @property
    def media_dir(self) -> Path:
        return self.data_dir / "media"


def _load_secret(data_dir: Path) -> str:
    env = os.environ.get("ANNOLAB_SECRET")
    if env:
        return env
    # Dev default: one random secret per data dir, kept next to the database.
    path = data_dir / ".secret"
    if path.exists():
        return path.read_text().strip()
    data_dir.mkdir(parents=True, exist_ok=True)
    value = secrets.token_hex(32)
    path.write_text(value)
    return value


@lru_cache
def get_settings() -> Settings:
    data_dir = Path(os.environ.get("ANNOLAB_DATA_DIR", REPO_ROOT / "data")).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "media").mkdir(exist_ok=True)
    return Settings(data_dir=data_dir, secret=_load_secret(data_dir))
