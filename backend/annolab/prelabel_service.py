"""Turn raw detector output into proposals that fit a project's schema."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from .models import Item
from .prelabel import heart_segments, image_boxes, read_wav


def _tool(schema: dict[str, Any], kind: str) -> dict[str, Any] | None:
    return next((t for t in schema.get("tools", []) if t["type"] == kind), None)


def propose(item: Item, media_root: Path) -> tuple[str, list[dict[str, Any]]]:
    schema = item.project.schema
    path = media_root / item.media_path
    if item.kind == "audio":
        tool = _tool(schema, "segment")
        if tool is None:
            raise ValueError("project has no segment tool")
        if path.suffix.lower() != ".wav":
            raise ValueError("pre-labels need a 16-bit WAV file")
        x, sr = read_wav(path)
        values = [c["value"] for c in tool["classes"]]
        heart = "S1" in values and "S2" in values
        out = []
        for s in heart_segments(x, sr):
            label = s["label"] if heart else values[0]
            out.append({"schema_key": tool["key"], "label": label,
                        "geometry": {"start": s["start"], "end": s["end"]}, "score": s["score"]})
        return "shannon-energy-envelope", out
    if item.kind == "image":
        from PIL import Image

        tool = _tool(schema, "bbox")
        if tool is None:
            raise ValueError("project has no bbox tool")
        with Image.open(path) as im:
            rgb = np.asarray(im.convert("RGB"))
        values = [c["value"] for c in tool["classes"]]
        out = []
        for b in image_boxes(rgb):
            label = b["shape"] if b["shape"] in values else values[0]
            out.append({"schema_key": tool["key"], "label": label,
                        "geometry": {k: b[k] for k in "xywh"}, "score": b["score"]})
        return "background-difference-components", out
    raise ValueError(f"no pre-labeller for {item.kind} items")
