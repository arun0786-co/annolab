"""Measure pre-label precision and recall on the seeded data against its synthetic ground truth.

Run from backend/ after `make seed`:  uv run python ../scripts/eval_prelabel.py
"""

from __future__ import annotations

import sys
from pathlib import Path
from statistics import fmean

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
from sqlalchemy import select  # noqa: E402

from annolab.config import get_settings  # noqa: E402
from annolab.consensus import match  # noqa: E402
from annolab.db import Database  # noqa: E402
from annolab.models import Item  # noqa: E402
from annolab.prelabel import heart_segments, image_boxes, read_wav  # noqa: E402


def score(kind, props, truth, thr):
    wrap = lambda xs: [{"label": x["label"], "geometry": x["geometry"]} for x in xs]  # noqa: E731
    p, t = wrap(props), wrap(truth)
    pairs, _, _ = match(kind, p, t, thr)
    hits = [(i, j, s) for i, j, s in pairs if p[i]["label"] == t[j]["label"]]
    return {"n_prop": len(p), "n_truth": len(t), "tp_any": len(pairs), "tp_label": len(hits),
            "ious": [s for *_, s in pairs],
            "onset_err": [abs(p[i]["geometry"].get("start", 0) - t[j]["geometry"].get("start", 0)) for i, j, _ in pairs]}


def report(name, rows, unit=None):
    P = sum(r["n_prop"] for r in rows)
    T = sum(r["n_truth"] for r in rows)
    a = sum(r["tp_any"] for r in rows)
    lab = sum(r["tp_label"] for r in rows)
    ious = [x for r in rows for x in r["ious"]]
    print(f"{name}: {len(rows)} items, {T} true objects, {P} proposals")
    print(f"  with labels:    precision {lab / P:.3f}  recall {lab / T:.3f}")
    print(f"  ignoring label: precision {a / P:.3f}  recall {a / T:.3f}")
    print(f"  mean IoU of matched pairs: {fmean(ious):.3f}")
    if unit:
        errs = [x for r in rows for x in r["onset_err"]]
        print(f"  median onset error: {np.median(errs) * 1000:.1f} ms")


def main() -> None:
    settings = get_settings()
    db = Database(settings.db_path)
    with db.sessionmaker() as s:
        items = s.scalars(select(Item).order_by(Item.id)).all()
        audio, images = [], []
        for it in items:
            truth = it.meta.get("truth")
            if not truth:
                continue
            path = settings.media_dir / it.media_path
            if it.kind == "audio":
                x, sr = read_wav(path)
                props = [{"label": p["label"], "geometry": {"start": p["start"], "end": p["end"]}} for p in heart_segments(x, sr)]
                gt = [{"label": t["label"], "geometry": {"start": t["start"], "end": t["end"]}} for t in truth["segments"]]
                audio.append(score("segment", props, gt, 0.5))
            elif it.kind == "image" and truth.get("scene") == "synthetic":
                rgb = np.asarray(Image.open(path).convert("RGB"))
                props = [{"label": b["shape"], "geometry": {k: b[k] for k in "xywh"}} for b in image_boxes(rgb)]
                gt = [{"label": o["label"], "geometry": dict(zip("xywh", o["bbox"]))} for o in truth["objects"]]
                images.append(score("bbox", props, gt, 0.5))
    if audio:
        report("heart sounds (segment IoU >= 0.5)", audio, unit="s")
    if images:
        report("shape scenes (box IoU >= 0.5)", images)


if __name__ == "__main__":
    main()
