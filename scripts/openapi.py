"""Write the API schema to backend/openapi.json.

Run from backend/:  uv run python ../scripts/openapi.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from annolab.config import Settings  # noqa: E402
from annolab.main import create_app  # noqa: E402


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        app = create_app(Settings(data_dir=Path(tmp), secret=os.urandom(32).hex()))
        spec = app.openapi()
        app.state.db.engine.dispose()
    out = ROOT / "backend" / "openapi.json"
    out.write_text(json.dumps(spec, indent=2, sort_keys=False) + "\n")
    print(f"wrote {out.relative_to(ROOT)} ({len(spec['paths'])} paths)")


if __name__ == "__main__":
    main()
