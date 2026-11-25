"""Local model-assisted pre-labels. No network, no learned weights.

Audio: heart-sound segments from a Shannon-energy envelope.
Image: object boxes from background subtraction and connected components.
"""

from __future__ import annotations

import wave
from pathlib import Path
from typing import Any

import numpy as np

from .consensus import match


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        n = w.getnframes()
        width = w.getsampwidth()
        channels = w.getnchannels()
        raw = w.readframes(n)
    if width != 2:
        raise ValueError("only 16-bit PCM WAV is supported")
    x = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    if channels > 1:
        x = x.reshape(-1, channels).mean(axis=1)
    return x, sr


def _bandpass(x: np.ndarray, sr: int, lo: float, hi: float) -> np.ndarray:
    spec = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(len(x), 1 / sr)
    spec[(freqs < lo) | (freqs > hi)] = 0
    return np.fft.irfft(spec, n=len(x))


def _smooth(x: np.ndarray, n: int) -> np.ndarray:
    if n <= 1:
        return x
    return np.convolve(x, np.ones(n) / n, mode="same")


def heart_segments(
    x: np.ndarray,
    sr: int,
    band: tuple[float, float] = (25.0, 150.0),
    window_s: float = 0.02,
    threshold: float = 0.25,
    min_len_s: float = 0.04,
    merge_gap_s: float = 0.05,
) -> list[dict[str, Any]]:
    """Find S1/S2 candidates. Returns [{start, end, label, score}] in seconds.

    1. Band-pass to the range where S1/S2 energy sits, which drops most
       murmur energy (higher) and baseline wander (lower).
    2. Shannon energy -x^2 log x^2 of the normalised signal, smoothed over 20 ms.
    3. Threshold the envelope at `threshold` of its 99th percentile, merge
       regions closer than 50 ms, drop regions shorter than 40 ms.
    4. Label: a beat is S1 when the gap that follows it (systole) is shorter
       than the gap before it (diastole); this holds for heart rates under
       roughly 120 bpm.
    """
    y = _bandpass(x, sr, *band)
    peak = np.max(np.abs(y)) or 1.0
    y = y / peak
    e = y * y
    shannon = -e * np.log(e + 1e-12)
    env = _smooth(shannon, max(1, int(window_s * sr)))
    ref = np.percentile(env, 99) or 1.0
    env = env / ref
    above = env > threshold

    edges = np.diff(above.astype(np.int8), prepend=0, append=0)
    starts = np.flatnonzero(edges == 1)
    ends = np.flatnonzero(edges == -1)
    regions: list[list[int]] = []
    for s, e_ in zip(starts, ends):
        if regions and (s - regions[-1][1]) < merge_gap_s * sr:
            regions[-1][1] = e_
        else:
            regions.append([int(s), int(e_)])
    regions = [r for r in regions if (r[1] - r[0]) >= min_len_s * sr]
    if not regions:
        return []

    onsets = [r[0] / sr for r in regions]
    gaps = np.diff(onsets)
    out = []
    for i, (s, e_) in enumerate(regions):
        before = gaps[i - 1] if i > 0 else None
        after = gaps[i] if i < len(gaps) else None
        if before is not None and after is not None:
            is_s1 = after < before
        elif after is not None:
            # first beat: compare with the gap after next
            is_s1 = len(gaps) < 2 or after < gaps[1]
        elif before is not None:
            # last beat: S1 follows a long (diastolic) gap
            is_s1 = len(gaps) < 2 or before > gaps[-2]
        else:
            is_s1 = True
        score = float(np.clip(env[s:e_].mean(), 0, 1))
        out.append({"start": round(s / sr, 4), "end": round(e_ / sr, 4), "label": "S1" if is_s1 else "S2", "score": round(score, 3)})
    return out


def image_boxes(rgb: np.ndarray, max_boxes: int = 12, tol: float = 40.0) -> list[dict[str, Any]]:
    """Boxes for objects that differ from the background colour.

    The background colour is the median of the border pixels. Works well on
    flat backgrounds (scans, synthetic scenes); on photos it gives rough
    proposals that an annotator corrects.
    """
    from skimage import measure, morphology

    if rgb.ndim == 2:
        rgb = np.stack([rgb] * 3, axis=-1)
    img = rgb[..., :3].astype(np.float64)
    h, w = img.shape[:2]
    border = np.concatenate([img[0], img[-1], img[:, 0], img[:, -1]])
    bg = np.median(border, axis=0)
    mask = np.linalg.norm(img - bg, axis=-1) > tol
    mask = morphology.opening(mask, morphology.disk(2))
    labels = measure.label(mask)
    min_area = 0.002 * h * w
    props = [p for p in measure.regionprops(labels) if p.area >= min_area]
    props.sort(key=lambda p: -p.area)
    out = []
    for p in props[:max_boxes]:
        r0, c0, r1, c1 = p.bbox
        extent = p.area / ((r1 - r0) * (c1 - c0))
        if extent > 0.9:
            shape = "rectangle"
        elif extent > 0.65:
            shape = "circle"
        else:
            shape = "triangle"
        out.append({
            "x": float(c0), "y": float(r0), "w": float(c1 - c0), "h": float(r1 - r0),
            "shape": shape, "extent": round(float(extent), 3), "score": round(min(1.0, p.area / (h * w) * 20), 3),
        })
    return out


def precision_recall(kind: str, proposals: list[dict], truth: list[dict], threshold: float = 0.5, use_labels: bool = True) -> dict[str, Any]:
    """Match proposals to ground truth at an IoU threshold and count hits."""
    wrap = lambda xs: [{"label": x["label"], "geometry": x.get("geometry", x)} for x in xs]  # noqa: E731
    proposals, truth = wrap(proposals), wrap(truth)
    pairs, _, _ = match(kind, proposals, truth, threshold)
    tp = sum(1 for i, j, _ in pairs if not use_labels or proposals[i]["label"] == truth[j]["label"])
    p = tp / len(proposals) if proposals else 0.0
    r = tp / len(truth) if truth else 0.0
    return {"tp": tp, "proposals": len(proposals), "truth": len(truth), "precision": p, "recall": r}
