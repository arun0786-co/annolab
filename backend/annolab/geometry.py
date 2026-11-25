"""Similarity measures between two annotations of the same tool type.

All functions return a value in [0, 1]; 1 means identical.
"""

from __future__ import annotations

import math
from typing import Any

from shapely.geometry import Polygon
from shapely.validation import make_valid


def bbox_iou(a: dict[str, float], b: dict[str, float]) -> float:
    ix = max(0.0, min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"]))
    iy = max(0.0, min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"]))
    inter = ix * iy
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union > 0 else 0.0


def _poly(points: list[list[float]]):
    p = Polygon(points)
    return p if p.is_valid else make_valid(p)


def polygon_iou(a: dict[str, Any], b: dict[str, Any]) -> float:
    pa, pb = _poly(a["points"]), _poly(b["points"])
    union = pa.union(pb).area
    return pa.intersection(pb).area / union if union > 0 else 0.0


def interval_iou(a: dict[str, float], b: dict[str, float]) -> float:
    """1-D IoU, used for audio/video segments (seconds) and text spans (characters)."""
    inter = max(0.0, min(a["end"], b["end"]) - max(a["start"], b["start"]))
    union = (a["end"] - a["start"]) + (b["end"] - b["start"]) - inter
    return inter / union if union > 0 else 0.0


def point_similarity(a: dict[str, float], b: dict[str, float], sigma: float = 10.0) -> float:
    """Gaussian of the pixel distance, 0.5 at about 1.18 sigma."""
    d2 = (a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2
    return math.exp(-d2 / (2 * sigma * sigma))


def track_box_at(keyframes: list[dict[str, float]], t: float) -> dict[str, float] | None:
    """Box at time t with linear interpolation; None outside the track's extent."""
    if not keyframes or t < keyframes[0]["t"] or t > keyframes[-1]["t"]:
        return None
    for k0, k1 in zip(keyframes, keyframes[1:]):
        if k0["t"] <= t <= k1["t"]:
            span = k1["t"] - k0["t"]
            r = 0.0 if span == 0 else (t - k0["t"]) / span
            return {k: k0[k] + r * (k1[k] - k0[k]) for k in ("x", "y", "w", "h")}
    k = keyframes[-1]
    return {"x": k["x"], "y": k["y"], "w": k["w"], "h": k["h"]}


def track_iou(a: dict[str, Any], b: dict[str, Any], step: float = 0.1) -> float:
    """Spatio-temporal IoU: mean box IoU over the union of the two time extents.

    Time is sampled every `step` seconds; at samples where only one track exists
    the IoU counts as 0, so the temporal IoU is an upper bound of this score.
    """
    ka, kb = a["keyframes"], b["keyframes"]
    t0 = min(ka[0]["t"], kb[0]["t"])
    t1 = max(ka[-1]["t"], kb[-1]["t"])
    n = max(1, int(round((t1 - t0) / step)) + 1)
    total = 0.0
    for i in range(n):
        t = t0 + i * step if n > 1 else t0
        ba, bb = track_box_at(ka, t), track_box_at(kb, t)
        if ba is not None and bb is not None:
            total += bbox_iou(ba, bb)
    return total / n


def similarity(kind: str, a: dict[str, Any], b: dict[str, Any], **kw) -> float:
    if kind == "bbox":
        return bbox_iou(a, b)
    if kind == "polygon":
        return polygon_iou(a, b)
    if kind in ("segment", "span"):
        return interval_iou(a, b)
    if kind == "point":
        return point_similarity(a, b, **kw)
    if kind == "track":
        return track_iou(a, b)
    raise ValueError(kind)


def bounds(kind: str, g: dict[str, Any]) -> tuple[float, float, float, float] | None:
    """Axis-aligned box (x, y, w, h) for spatial geometries."""
    if kind == "bbox":
        return g["x"], g["y"], g["w"], g["h"]
    if kind == "polygon":
        xs = [p[0] for p in g["points"]]
        ys = [p[1] for p in g["points"]]
        return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)
    return None


def polygon_area(points: list[list[float]]) -> float:
    s = 0.0
    for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1]):
        s += x0 * y1 - x1 * y0
    return abs(s) / 2
