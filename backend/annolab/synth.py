"""Generators for synthetic demo data with known ground truth."""

from __future__ import annotations

import math
import shutil
import subprocess
import wave
from pathlib import Path
from typing import Any

import numpy as np

# ---------------------------------------------------------------- audio


def _burst(rng: np.random.Generator, sr: int, dur: float, freqs: list[float]) -> np.ndarray:
    n = int(dur * sr)
    t = np.arange(n) / sr
    env = np.hanning(n) ** 0.7
    sig = sum(
        rng.uniform(0.6, 1.0) * np.sin(2 * np.pi * f * t + rng.uniform(0, 2 * np.pi)) for f in freqs
    )
    return env * sig / len(freqs)


def phonocardiogram(
    rng: np.random.Generator,
    sr: int = 4000,
    duration: float = 8.0,
    heart_rate: float = 72.0,
    murmur: bool = False,
    snr_db: float = 25.0,
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    """Synthetic heart recording. Returns (signal in [-1, 1], truth segments)."""
    n = int(duration * sr)
    x = np.zeros(n)
    truth: list[dict[str, Any]] = []
    rr = 60.0 / heart_rate
    systole = 0.34 - 0.0012 * (heart_rate - 60)
    t = rng.uniform(0.1, 0.4)
    while True:
        beat_rr = rr * rng.uniform(0.97, 1.03)
        s1_dur = rng.uniform(0.10, 0.14)
        s2_dur = rng.uniform(0.08, 0.11)
        s2_at = t + systole * rng.uniform(0.97, 1.03)
        if s2_at + s2_dur >= duration - 0.05:
            break
        for at, dur, label, freqs, amp in (
            (t, s1_dur, "S1", [35, 55, 80], rng.uniform(0.85, 1.0)),
            (s2_at, s2_dur, "S2", [50, 75, 110], rng.uniform(0.55, 0.75)),
        ):
            i0 = int(at * sr)
            b = _burst(rng, sr, dur, freqs) * amp
            x[i0 : i0 + len(b)] += b
            truth.append({"label": label, "start": round(at, 4), "end": round(at + dur, 4)})
        if murmur:
            m0, m1 = t + s1_dur + 0.02, s2_at - 0.02
            if m1 > m0:
                i0, i1 = int(m0 * sr), int(m1 * sr)
                noise = rng.normal(0, 1, i1 - i0)
                spec = np.fft.rfft(noise)
                freqs = np.fft.rfftfreq(len(noise), 1 / sr)
                spec[(freqs < 180) | (freqs > 450)] = 0
                band = np.fft.irfft(spec, n=len(noise))
                band /= np.max(np.abs(band)) or 1
                env = np.sin(np.linspace(0, np.pi, len(band)))  # crescendo-decrescendo
                x[i0:i1] += 0.22 * env * band
        t += beat_rr
    power = np.mean(x**2)
    noise_power = power / (10 ** (snr_db / 10))
    x += rng.normal(0, math.sqrt(noise_power), n)
    x += 0.03 * np.sin(2 * np.pi * 0.3 * np.arange(n) / sr)  # breathing / baseline wander
    x /= np.max(np.abs(x)) * 1.05
    return x, truth


def write_wav(path: Path, x: np.ndarray, sr: int) -> None:
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def peaks(x: np.ndarray, bins: int = 200) -> list[float]:
    """Max |amplitude| per bin, for small waveform previews."""
    chunks = np.array_split(np.abs(x), bins)
    return [round(float(c.max()) if len(c) else 0.0, 3) for c in chunks]


# ---------------------------------------------------------------- images

SHAPE_COLORS = [(214, 69, 65), (46, 134, 171), (39, 174, 96), (243, 156, 18), (142, 68, 173), (52, 73, 94)]


def shape_scene(rng: np.random.Generator, w: int = 640, h: int = 480, count: int | None = None) -> tuple[np.ndarray, list[dict[str, Any]]]:
    """Flat background with circles, rectangles and triangles that do not overlap."""
    from skimage.draw import disk, polygon as draw_polygon

    bg = np.array([rng.integers(225, 245)] * 3) - np.array([0, rng.integers(0, 8), rng.integers(0, 12)])
    img = np.ones((h, w, 3)) * bg
    count = count or int(rng.integers(3, 7))
    placed: list[tuple[float, float, float, float]] = []
    truth = []
    tries = 0
    while len(truth) < count and tries < 500:
        tries += 1
        kind = ["circle", "rectangle", "triangle"][int(rng.integers(0, 3))]
        size = float(rng.uniform(50, 130))
        cx, cy = float(rng.uniform(size, w - size)), float(rng.uniform(size, h - size))
        if kind == "circle":
            r = size / 2
            pts = [[cx + r * math.cos(a), cy + r * math.sin(a)] for a in np.linspace(0, 2 * math.pi, 24, endpoint=False)]
            box = (cx - r, cy - r, 2 * r, 2 * r)
        elif kind == "rectangle":
            bw, bh = size, size * float(rng.uniform(0.5, 1.0))
            pts = [[cx - bw / 2, cy - bh / 2], [cx + bw / 2, cy - bh / 2], [cx + bw / 2, cy + bh / 2], [cx - bw / 2, cy + bh / 2]]
            box = (cx - bw / 2, cy - bh / 2, bw, bh)
        else:
            pts = [[cx, cy - size / 2], [cx + size / 2, cy + size / 2], [cx - size / 2, cy + size / 2]]
            box = (cx - size / 2, cy - size / 2, size, size)
        x0, y0, bw, bh = box
        if any(not (x0 + bw + 8 < px or px + pw + 8 < x0 or y0 + bh + 8 < py or py + ph + 8 < y0) for px, py, pw, ph in placed):
            continue
        placed.append(box)
        color = np.array(SHAPE_COLORS[int(rng.integers(0, len(SHAPE_COLORS)))])
        if kind == "circle":
            rr, cc = disk((cy, cx), size / 2, shape=(h, w))
        else:
            rr, cc = draw_polygon([p[1] for p in pts], [p[0] for p in pts], shape=(h, w))
        img[rr, cc] = color
        truth.append({
            "label": kind,
            "bbox": {"x": round(x0, 1), "y": round(y0, 1), "w": round(bw, 1), "h": round(bh, 1)},
            "points": [[round(px, 1), round(py, 1)] for px, py in pts],
        })
    img += rng.normal(0, 3, img.shape)
    return np.clip(img, 0, 255).astype(np.uint8), truth


# ---------------------------------------------------------------- video


def gait_frames(rng: np.random.Generator, w: int = 320, h: int = 240, fps: int = 15, duration: float = 6.0, limp: bool = False):
    """Frames of a walking figure (body box and two feet) plus keyframed truth tracks."""
    n = int(fps * duration)
    speed = float(rng.uniform(30, 45))  # px per second
    x_start = float(rng.uniform(10, 30))
    stride_hz = float(rng.uniform(0.9, 1.2))
    body_w, body_h = 34.0, 90.0
    ground = h - 40.0
    amp_l, amp_r = 18.0, (9.0 if limp else 18.0)
    frames = []
    states = []
    for i in range(n):
        t = i / fps
        bx = x_start + speed * t
        by = ground - body_h - 20 + 2 * math.sin(2 * math.pi * 2 * stride_hz * t)
        phase = 2 * math.pi * stride_hz * t
        lf = (bx + body_w / 2 - 7 + amp_l * math.sin(phase), ground - 14)
        rf = (bx + body_w / 2 - 7 + amp_r * math.sin(phase + math.pi), ground - 14)
        img = np.full((h, w, 3), (236, 238, 241), np.uint8)
        img[int(ground):, :] = (200, 204, 210)
        boxes = {
            "walker": (bx, by, body_w, body_h),
            "left_foot": (lf[0], lf[1], 14.0, 14.0),
            "right_foot": (rf[0], rf[1], 14.0, 14.0),
        }
        colors = {"walker": (52, 73, 94), "left_foot": (214, 69, 65), "right_foot": (46, 134, 171)}
        for key, (x0, y0, bw, bh) in boxes.items():
            img[max(0, int(y0)) : int(y0 + bh), max(0, int(x0)) : min(w, int(x0 + bw))] = colors[key]
        frames.append(img)
        states.append((t, boxes))
    truth = []
    for key in ("walker", "left_foot", "right_foot"):
        step = 1.0 if key == "walker" else 0.2
        kfs = []
        for t, boxes in states:
            if abs((t / step) - round(t / step)) < 1e-6 or t == states[-1][0]:
                x0, y0, bw, bh = boxes[key]
                kfs.append({"t": round(t, 3), "x": round(x0, 1), "y": round(y0, 1), "w": bw, "h": bh})
        truth.append({"label": key, "keyframes": kfs})
    return frames, truth, fps


def write_mp4(path: Path, frames: list[np.ndarray], fps: int) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to build the video demo")
    h, w = frames[0].shape[:2]
    cmd = [
        ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}",
        "-r", str(fps), "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(path),
    ]
    subprocess.run(cmd, input=b"".join(f.tobytes() for f in frames), check=True)


# ---------------------------------------------------------------- text

SYMPTOMS = ["chest pain", "shortness of breath", "palpitations", "dizziness", "persistent cough",
            "fatigue", "ankle swelling", "headache", "nausea", "fever", "wheezing", "sore throat"]
MEDICATIONS = ["metoprolol", "amlodipine", "aspirin", "atorvastatin", "salbutamol", "amoxicillin",
               "furosemide", "paracetamol", "lisinopril", "omeprazole"]
DOSAGES = ["25 mg", "5 mg", "75 mg", "20 mg", "100 mcg", "500 mg", "40 mg", "1 g", "10 mg"]
FREQUENCIES = ["once daily", "twice daily", "every 8 hours", "at night", "as needed"]
DURATIONS = ["two days", "a week", "three weeks", "since yesterday", "about a month"]
SITES = ["left lower lobe", "right ankle", "both lungs", "mitral area", "left arm", "throat"]


def clinical_note(rng: np.random.Generator) -> tuple[str, list[dict[str, Any]], str]:
    """Return (text, spans, urgency). Spans are character offsets with labels."""
    parts: list[tuple[str, str | None]] = []
    pick = lambda xs: xs[int(rng.integers(0, len(xs)))]  # noqa: E731
    age = int(rng.integers(24, 86))
    sex = pick(["M", "F"])
    s1, s2 = rng.choice(len(SYMPTOMS), 2, replace=False)
    parts += [(f"{age}{sex} presents with ", None), (SYMPTOMS[s1], "symptom"), (" and ", None),
              (SYMPTOMS[s2], "symptom"), (f" for {pick(DURATIONS)}. ", None)]
    if rng.random() < 0.6:
        parts += [("Exam notable for crackles over the ", None), (pick(SITES), "body_site"), (". ", None)]
    else:
        parts += [("Murmur best heard at the ", None), (pick(SITES), "body_site"), (". ", None)]
    m1 = pick(MEDICATIONS)
    parts += [("Started ", None), (m1, "medication"), (" ", None), (pick(DOSAGES), "dosage"), (f" {pick(FREQUENCIES)}", None)]
    if rng.random() < 0.5:
        m2 = pick([m for m in MEDICATIONS if m != m1])
        parts += [(", continue ", None), (m2, "medication"), (" ", None), (pick(DOSAGES), "dosage")]
    parts += [(". ", None)]
    urgent = SYMPTOMS[s1] in ("chest pain", "shortness of breath") or SYMPTOMS[s2] in ("chest pain", "shortness of breath")
    parts += [("Review in clinic in two weeks." if not urgent else "Same-day cardiology review requested.", None)]
    text, spans, pos = "", [], 0
    for chunk, label in parts:
        if label:
            spans.append({"label": label, "start": pos, "end": pos + len(chunk)})
        text += chunk
        pos += len(chunk)
    return text, spans, ("urgent" if urgent else "routine")
