"""Build the demo database and media from scratch. Everything is generated locally.

    uv run python -m annolab.seed            # uses ANNOLAB_DATA_DIR or ../data
    uv run python -m annolab.seed --small    # fewer items, for tests
"""

from __future__ import annotations

import argparse
import math
import shutil
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np

from . import audit, services
from .config import Settings, get_settings
from .db import Database
from .labelschema import normalize_schema
from .media import describe, make_thumbnail
from .models import Item, Project, Task, User
from .security import hash_password
from .synth import clinical_note, gait_frames, phonocardiogram, shape_scene, write_mp4, write_wav

PASSWORD = "annolab"

USERS = [
    ("admin@annolab.dev", "Lab Admin", "admin"),
    ("annotator1@annolab.dev", "Asha Nair", "annotator"),
    ("annotator2@annolab.dev", "Ben Ortiz", "annotator"),
    ("annotator3@annolab.dev", "Chen Wei", "annotator"),
    ("reviewer1@annolab.dev", "Dana Kim", "reviewer"),
]


@dataclass
class Style:
    """How one simulated annotator works."""

    jitter: float  # relative boundary noise
    miss: float  # chance to miss an object
    confuse: float  # chance to pick a wrong class
    extra: float  # chance to add a spurious object per item
    speed: float  # multiplier on time spent


STYLES = {
    "annotator1@annolab.dev": Style(jitter=0.02, miss=0.03, confuse=0.02, extra=0.05, speed=1.25),
    "annotator2@annolab.dev": Style(jitter=0.06, miss=0.08, confuse=0.06, extra=0.25, speed=0.75),
    "annotator3@annolab.dev": Style(jitter=0.04, miss=0.05, confuse=0.04, extra=0.12, speed=1.0),
}

HEART_SCHEMA = {
    "tools": [{
        "key": "heart", "type": "segment", "name": "Heart sounds",
        "classes": [
            {"value": "S1", "name": "S1", "color": "#ec4647", "hotkey": "1"},
            {"value": "S2", "name": "S2", "color": "#257de0", "hotkey": "2"},
        ],
        "attributes": [{"key": "confidence", "type": "select", "options": ["low", "medium", "high"]}],
    }],
    "classifications": [
        {"key": "quality", "name": "Recording quality", "type": "radio", "options": ["good", "noisy", "unusable"]},
        {"key": "murmur", "name": "Systolic murmur", "type": "radio", "options": ["absent", "present"]},
    ],
}

IMAGE_CLASSES = ["person", "animal", "cup", "vehicle", "coin", "circle", "rectangle", "triangle"]
IMAGE_SCHEMA = {
    "tools": [
        {"key": "box", "type": "bbox", "name": "Box",
         "classes": [{"value": c, "hotkey": str(i + 1)} for i, c in enumerate(IMAGE_CLASSES)],
         "attributes": [{"key": "truncated", "type": "select", "options": ["no", "yes"]}]},
        {"key": "outline", "type": "polygon", "name": "Outline",
         "classes": [{"value": c} for c in ("circle", "rectangle", "triangle", "cup")]},
        {"key": "center", "type": "point", "name": "Centre point", "classes": [{"value": "center", "color": "#7f7f7f"}]},
    ],
    "classifications": [
        {"key": "scene", "name": "Scene type", "type": "radio", "options": ["photo", "synthetic"]},
        {"key": "difficulty", "name": "Difficulty", "type": "radio", "options": ["easy", "medium", "hard"]},
    ],
}

VIDEO_SCHEMA = {
    "tools": [
        {"key": "body", "type": "track", "name": "Body parts",
         "classes": [{"value": "walker", "hotkey": "1"}, {"value": "left_foot", "hotkey": "2"}, {"value": "right_foot", "hotkey": "3"}]},
        {"key": "phase", "type": "segment", "name": "Gait phase",
         "classes": [{"value": "steady", "hotkey": "4"}, {"value": "turning", "hotkey": "5"}]},
    ],
    "classifications": [{"key": "gait", "name": "Gait", "type": "radio", "options": ["normal", "limping"]}],
}

TEXT_SCHEMA = {
    "tools": [{
        "key": "entity", "type": "span", "name": "Entities",
        "classes": [{"value": "symptom", "hotkey": "1"}, {"value": "medication", "hotkey": "2"},
                    {"value": "dosage", "hotkey": "3"}, {"value": "body_site", "hotkey": "4"}],
    }],
    "classifications": [{"key": "urgency", "name": "Urgency", "type": "radio", "options": ["routine", "urgent"]}],
}

# Approximate object boxes for the scikit-image sample photos (x, y, w, h), drawn by hand.
PHOTO_TRUTH = {
    "astronaut": [("person", (20, 15, 345, 497)), ("vehicle", (350, 0, 125, 285))],
    "camera": [("person", (0, 62, 330, 450))],
    "chelsea": [("animal", (10, 0, 430, 300))],
    "coffee": [("cup", (172, 18, 240, 285))],
    "rocket": [("vehicle", (303, 125, 42, 285))],
    "coins": [("coin", b) for b in [
        (22, 35, 42, 38), (80, 38, 40, 36), (126, 28, 53, 46), (192, 30, 49, 43), (255, 34, 42, 38), (305, 16, 60, 56),
        (25, 104, 42, 42), (84, 107, 38, 38), (134, 110, 40, 35), (185, 105, 42, 39), (245, 96, 51, 48), (317, 105, 39, 40),
        (25, 178, 38, 39), (80, 175, 44, 42), (135, 179, 39, 38), (189, 170, 48, 46), (251, 172, 46, 44), (315, 156, 65, 62),
        (18, 233, 57, 55), (92, 245, 44, 42), (144, 236, 57, 52), (220, 241, 49, 47), (276, 240, 50, 48), (336, 248, 48, 41),
    ]],
}


class Clock:
    """Monotonic fake time. `gap` spreads work sessions over several days."""

    def __init__(self, start: datetime, end: datetime, rng: np.random.Generator | None = None, gap: float = 0.0):
        self.t = start
        self.end = end
        self.rng = rng
        self.gap = gap

    def tick(self, seconds: float) -> datetime:
        self.t = min(self.t + timedelta(seconds=seconds), self.end)
        return self.t

    def pause(self) -> None:
        if self.rng is not None and self.gap:
            self.tick(float(self.rng.exponential(self.gap)))


def _store(media_root: Path, project_id: int, name: str) -> Path:
    folder = media_root / str(project_id)
    folder.mkdir(parents=True, exist_ok=True)
    return folder / name


def _add_item(db, project: Project, media_root: Path, path: Path, kind: str, extra_meta: dict[str, Any], created: datetime) -> Item:
    meta = describe(path, kind) if kind != "text" else {}
    thumb = make_thumbnail(path, kind)
    if thumb:
        meta["thumbnail"] = str(thumb.relative_to(media_root))
    meta.update(extra_meta)
    item = Item(project_id=project.id, kind=kind, filename=path.name,
                media_path=str(path.relative_to(media_root)), meta=meta, created_at=created)
    db.add(item)
    db.flush()
    return item


def _work(db, item: Item, user: User, anns: list[dict], clock: Clock, seconds: float, submit: bool = True) -> Task:
    """Assign, annotate and (optionally) submit through the same services the API uses."""
    clock.pause()
    started = clock.tick(30 + seconds * 0.1)
    task = Task(item_id=item.id, user_id=user.id, status="assigned", started_at=started)
    db.add(task)
    db.flush()
    services.refresh_item_status(db, item)
    audit.record(db, user.id, "task.assign", "task", task.id, item.project_id, {"item_id": item.id}, at=started)
    services.replace_annotations(db, task, anns, int(seconds * 1000), now=clock.tick(seconds * 0.6))
    if submit:
        services.submit_task(db, task, now=clock.tick(seconds * 0.4))
    return task


# ---------------------------------------------------------------- simulated annotators


def sim_segments(rng, truth: list[dict], style: Style, key: str = "heart") -> list[dict]:
    out = []
    for t in truth:
        if rng.random() < style.miss:
            continue
        dur = t["end"] - t["start"]
        s = t["start"] + rng.normal(0, style.jitter * 0.4) + rng.normal(0, dur * style.jitter * 2)
        e = t["end"] + rng.normal(0, style.jitter * 0.4) + rng.normal(0, dur * style.jitter * 2)
        s, e = max(0.0, s), max(s + 0.02, e)
        label = t["label"]
        if rng.random() < style.confuse:
            label = "S2" if label == "S1" else "S1"
        conf = ["high", "medium", "low"][int(rng.choice(3, p=[0.6, 0.3, 0.1]))]
        out.append({"schema_key": key, "label": label, "geometry": {"start": round(s, 3), "end": round(e, 3)},
                    "attributes": {"confidence": conf}})
    if truth and rng.random() < style.extra:
        last = truth[-1]["end"]
        at = float(rng.uniform(0.2, max(0.3, last - 0.2)))
        out.append({"schema_key": key, "label": "S1", "geometry": {"start": round(at, 3), "end": round(at + 0.09, 3)},
                    "attributes": {"confidence": "low"}})
    return out


def sim_boxes(rng, truth: list[dict], style: Style, w: int, h: int, classes: list[str], miss_boost: float = 0.0) -> list[dict]:
    out = []
    for t in truth:
        if rng.random() < style.miss + miss_boost:
            continue
        x, y, bw, bh = t["bbox"]
        j = style.jitter
        x0 = x + rng.normal(0, j * bw)
        y0 = y + rng.normal(0, j * bh)
        x1 = x + bw + rng.normal(0, j * bw)
        y1 = y + bh + rng.normal(0, j * bh)
        x0, y0 = max(0.0, x0), max(0.0, y0)
        x1, y1 = min(float(w), x1), min(float(h), y1)
        if x1 - x0 < 2 or y1 - y0 < 2:
            continue
        label = t["label"]
        if rng.random() < style.confuse:
            label = str(rng.choice([c for c in classes if c != label]))
        truncated = "yes" if (x <= 1 or y <= 1 or x + bw >= w - 1 or y + bh >= h - 1) else "no"
        out.append({"schema_key": "box", "label": label,
                    "geometry": {"x": round(x0, 1), "y": round(y0, 1), "w": round(x1 - x0, 1), "h": round(y1 - y0, 1)},
                    "attributes": {"truncated": truncated}})
    if rng.random() < style.extra:
        bw, bh = float(rng.uniform(20, 60)), float(rng.uniform(20, 60))
        out.append({"schema_key": "box", "label": str(rng.choice(classes)),
                    "geometry": {"x": round(float(rng.uniform(0, w - bw)), 1), "y": round(float(rng.uniform(0, h - bh)), 1),
                                 "w": round(bw, 1), "h": round(bh, 1)}, "attributes": {"truncated": "no"}})
    return out


def sim_polygons(rng, truth: list[dict], style: Style) -> list[dict]:
    out = []
    for t in truth:
        if "points" not in t or rng.random() < 0.4 + style.miss:
            continue
        pts = t["points"][::2] if len(t["points"]) > 8 else t["points"]
        size = max(t["bbox"][2], t["bbox"][3])
        noisy = [[round(px + rng.normal(0, style.jitter * size * 0.5), 1), round(py + rng.normal(0, style.jitter * size * 0.5), 1)]
                 for px, py in pts]
        out.append({"schema_key": "outline", "label": t["label"], "geometry": {"points": noisy}})
    return out


def sim_tracks(rng, truth: list[dict], style: Style, duration: float) -> list[dict]:
    from .geometry import track_box_at

    out = []
    for tr in truth:
        if rng.random() < style.miss * 0.5:
            continue
        step = 1.0 if tr["label"] == "walker" else float(rng.choice([0.2, 0.25, 0.3]))
        times = list(np.arange(0, duration, step)) + [tr["keyframes"][-1]["t"]]
        kfs, seen = [], set()
        for t in times:
            t = round(float(min(t, tr["keyframes"][-1]["t"])), 2)
            if t in seen:
                continue
            seen.add(t)
            b = track_box_at(tr["keyframes"], t)
            j = style.jitter * 40
            kfs.append({"t": t, "x": round(b["x"] + rng.normal(0, j), 1), "y": round(b["y"] + rng.normal(0, j), 1),
                        "w": round(max(4, b["w"] + rng.normal(0, j)), 1), "h": round(max(4, b["h"] + rng.normal(0, j)), 1)})
        out.append({"schema_key": "body", "label": tr["label"], "geometry": {"keyframes": kfs}})
    return out


def sim_spans(rng, text: str, truth: list[dict], style: Style, classes: list[str]) -> list[dict]:
    out = []
    for t in truth:
        if rng.random() < style.miss:
            continue
        s, e = t["start"], t["end"]
        r = rng.random()
        if r < style.jitter * 4:
            # shrink to the last word ("persistent cough" -> "cough")
            sp = text.rfind(" ", s, e)
            if sp != -1:
                s = sp + 1
        elif r < style.jitter * 8:
            # extend over the next word
            nxt = text.find(" ", e + 1)
            e = nxt if nxt != -1 else len(text)
            e = e - 1 if text[e - 1] in ".," else e
        label = t["label"]
        if rng.random() < style.confuse:
            label = str(rng.choice([c for c in classes if c != label]))
        out.append({"schema_key": "entity", "label": label, "geometry": {"start": int(s), "end": int(e)}})
    return out


def _radio(rng, key: str, truth_value: str, options: list[str], p_wrong: float) -> dict:
    v = truth_value if rng.random() >= p_wrong else str(rng.choice([o for o in options if o != truth_value]))
    return {"schema_key": key, "label": v}


# ---------------------------------------------------------------- projects


def seed_audio(db, rng, media_root, users, clock, created, n_items, rev) -> Project:
    p = Project(
        name="Heart sound segmentation", modality="audio", annotators_per_item=2, review_required=True,
        description="Mark S1 and S2 in phonocardiogram recordings and rate recording quality.",
        instructions=(
            "## Task\nMark every **S1** (first heart sound, start of systole) and **S2** (second heart sound) as a time segment.\n\n"
            "- Start the segment where the sound rises above the background, end it where it falls back.\n"
            "- S1 follows the long pause (diastole); S2 follows the short one (systole).\n"
            "- Use *Pre-label* to get proposals, then fix the boundaries.\n"
            "- Rate quality: *noisy* if the beats are still visible but the background is loud.\n"
        ),
        schema=normalize_schema(HEART_SCHEMA, "audio"), created_at=created,
    )
    db.add(p)
    db.flush()
    audit.record(db, users["admin@annolab.dev"].id, "project.create", "project", p.id, p.id, {"name": p.name}, at=created)
    items = []
    for i in range(n_items):
        hr = float(rng.uniform(58, 96))
        murmur = i % 4 == 1
        snr = float(rng.choice([float(rng.uniform(22, 30)), float(rng.uniform(10, 18))], p=[0.65, 0.35]))
        x, truth = phonocardiogram(rng, heart_rate=hr, murmur=murmur, snr_db=snr)
        path = _store(media_root, p.id, f"pcg_{i + 1:02d}.wav")
        write_wav(path, x, 4000)
        items.append(_add_item(db, p, media_root, path, "audio", {
            "truth": {"segments": truth, "heart_rate": round(hr, 1), "murmur": murmur, "snr_db": round(snr, 1)},
            "source": "synthetic (numpy)",
        }, created))
    audit.record(db, users["admin@annolab.dev"].id, "items.upload", "project", p.id, p.id, {"created": len(items)}, at=created)

    from .prelabel import heart_segments, read_wav

    pairs = [("annotator1@annolab.dev", "annotator2@annolab.dev"), ("annotator1@annolab.dev", "annotator3@annolab.dev"),
             ("annotator2@annolab.dev", "annotator3@annolab.dev")]
    done = max(1, int(n_items * 0.75))
    for i, item in enumerate(items):
        truth = item.meta["truth"]
        if i >= done + 2:
            break  # leave the rest unlabelled
        who = pairs[i % 3] if i < done else pairs[i % 3][:1]
        for email in who:
            st = STYLES[email]
            anns = sim_segments(rng, truth["segments"], st)
            if email == "annotator1@annolab.dev" and i % 2 == 0:
                # accepted model proposals, boundaries kept
                x, sr = read_wav(media_root / item.media_path)
                anns = [{"schema_key": "heart", "label": s["label"], "geometry": {"start": s["start"], "end": s["end"]},
                         "attributes": {"confidence": "medium"}, "source": "model"} for s in heart_segments(x, sr)]
            q = "good" if truth["snr_db"] >= 20 else "noisy"
            anns.append(_radio(rng, "quality", q, ["good", "noisy", "unusable"], 0.15 + st.confuse))
            anns.append(_radio(rng, "murmur", "present" if truth["murmur"] else "absent", ["absent", "present"], 0.08 + st.confuse))
            secs = float(rng.lognormal(math.log(95), 0.3)) * st.speed
            _work(db, item, users[email], anns, clock, secs)
    # an unfinished task: annotator2 is halfway through the next item
    if done + 2 < len(items):
        item = items[done + 2]
        part = sim_segments(rng, item.meta["truth"]["segments"][:6], STYLES["annotator2@annolab.dev"])
        _work(db, item, users["annotator2@annolab.dev"], part, clock, 40, submit=False)

    # reviews: approve most, reject one with a pinned comment
    in_review = [it for it in items if it.status == "in_review"]
    for k, item in enumerate(in_review[: max(1, int(len(in_review) * 0.7))]):
        if k == 1:
            sets = services.annotation_sets(db, item.id)
            uid, anns = max(sets.items(), key=lambda kv: len(kv[1]))
            seg = next(a for a in anns if a.schema_key == "heart")
            services.create_review(db, item, rev, "reject", "Boundaries drift late on several beats.", [
                {"annotation_id": seg.id, "body": "This S1 starts about 30 ms after the visible onset.", "t": seg.geometry["start"]},
            ], now=clock.tick(600))
        else:
            services.create_review(db, item, rev, "approve", "", [], now=clock.tick(300))
    return p


def seed_images(db, rng, media_root, users, clock, created, n_synthetic, rev) -> Project:
    from PIL import Image
    from skimage import data as skdata

    p = Project(
        name="Objects and shapes", modality="image", annotators_per_item=3, review_required=False,
        description="Boxes, outlines and centre points on public-domain photos and generated shape scenes.",
        instructions=(
            "## Task\nDraw a tight **box** around every object. Outline circles, rectangles and triangles with the "
            "**polygon** tool when you have time.\n\n- Mark *truncated* when the object touches the image border.\n"
            "- Coins: box each coin separately.\n- Pick *difficulty* by how long the image took you.\n"
        ),
        schema=normalize_schema(IMAGE_SCHEMA, "image"), created_at=created,
    )
    db.add(p)
    db.flush()
    audit.record(db, users["admin@annolab.dev"].id, "project.create", "project", p.id, p.id, {"name": p.name}, at=created)
    items = []
    for name, objs in PHOTO_TRUTH.items():
        arr = getattr(skdata, name)()
        path = _store(media_root, p.id, f"{name}.jpg" if arr.ndim == 3 else f"{name}.png")
        img = Image.fromarray(arr)
        if path.suffix == ".jpg":
            img.save(path, "JPEG", quality=90)
        else:
            img.save(path, "PNG")
        truth = [{"label": lab, "bbox": list(b)} for lab, b in objs]
        items.append(_add_item(db, p, media_root, path, "image", {
            "truth": {"objects": truth, "scene": "photo"}, "source": f"scikit-image data.{name}()",
        }, created))
    for i in range(n_synthetic):
        arr, truth = shape_scene(rng)
        path = _store(media_root, p.id, f"shapes_{i + 1:02d}.png")
        Image.fromarray(arr).save(path, "PNG")
        objs = [{"label": t["label"], "bbox": [t["bbox"][k] for k in "xywh"], "points": t["points"]} for t in truth]
        items.append(_add_item(db, p, media_root, path, "image", {
            "truth": {"objects": objs, "scene": "synthetic"}, "source": "synthetic (numpy + scikit-image draw)",
        }, created))
    audit.record(db, users["admin@annolab.dev"].id, "items.upload", "project", p.id, p.id, {"created": len(items)}, at=created)

    annotators = ["annotator1@annolab.dev", "annotator2@annolab.dev", "annotator3@annolab.dev"]
    n = len(items)
    for i, item in enumerate(items):
        if i >= n - 2:
            break
        who = annotators if i < n - 4 else annotators[: 1 + (i % 2)]
        truth = item.meta["truth"]
        W, H = item.meta["width"], item.meta["height"]
        for email in who:
            st = STYLES[email]
            boost = 0.12 if len(truth["objects"]) > 10 else 0.0
            anns = sim_boxes(rng, truth["objects"], st, W, H, IMAGE_CLASSES, boost)
            if truth["scene"] == "synthetic":
                anns += sim_polygons(rng, truth["objects"], st)
                for o in truth["objects"][:2]:
                    if rng.random() >= st.miss * 2:
                        x, y, bw, bh = o["bbox"]
                        sd = 2 + 40 * st.jitter
                        anns.append({"schema_key": "center", "label": "center",
                                     "geometry": {"x": round(x + bw / 2 + rng.normal(0, sd), 1), "y": round(y + bh / 2 + rng.normal(0, sd), 1)}})
            anns.append(_radio(rng, "scene", truth["scene"], ["photo", "synthetic"], 0.02))
            k = len(truth["objects"])
            diff = "easy" if k <= 3 else ("medium" if k <= 6 else "hard")
            anns.append(_radio(rng, "difficulty", diff, ["easy", "medium", "hard"], 0.25 + st.confuse))
            secs = float(rng.lognormal(math.log(25 + 6 * k), 0.3)) * st.speed
            _work(db, item, users[email], anns, clock, secs)
    labeled = [it for it in items if it.status == "labeled"]
    for k, item in enumerate(labeled[:4]):
        if k == 2:
            sets = services.annotation_sets(db, item.id)
            uid, anns = min(sets.items(), key=lambda kv: len(kv[1]))
            box = next((a for a in anns if a.schema_key == "box"), None)
            comments = []
            if box is not None:
                g = box.geometry
                comments.append({"annotation_id": box.id, "body": "Box is loose, tighten to the object edge.",
                                 "x": g["x"] + g["w"], "y": g["y"]})
            services.create_review(db, item, rev, "reject", "Missing objects in this image.", comments,
                                   reopen_user_ids=[uid], now=clock.tick(500))
        else:
            services.create_review(db, item, rev, "approve", "Spot check ok.", [], now=clock.tick(240))
    return p


def seed_video(db, rng, media_root, users, clock, created, n_items, rev) -> Project:
    from PIL import Image

    p = Project(
        name="Gait clips", modality="video", annotators_per_item=2, review_required=True,
        description="Track the walker and both feet through short walking clips.",
        instructions=(
            "## Task\nAdd a **track** for the walker and for each foot. Set a keyframe whenever the box drifts; "
            "boxes are interpolated between keyframes.\n\n- Feet need a keyframe at least every half second.\n"
            "- Rate the gait as *limping* when one foot moves noticeably less than the other.\n"
        ),
        schema=normalize_schema(VIDEO_SCHEMA, "video"), created_at=created,
    )
    db.add(p)
    db.flush()
    audit.record(db, users["admin@annolab.dev"].id, "project.create", "project", p.id, p.id, {"name": p.name}, at=created)
    items = []
    for i in range(n_items):
        limp = i % 3 == 2
        frames, truth, fps = gait_frames(rng, limp=limp)
        path = _store(media_root, p.id, f"gait_{i + 1:02d}.mp4")
        write_mp4(path, frames, fps)
        item = _add_item(db, p, media_root, path, "video", {
            "truth": {"tracks": truth, "gait": "limping" if limp else "normal"}, "source": "synthetic (numpy + ffmpeg)",
        }, created)
        if "thumbnail" not in item.meta:  # no ffmpeg thumbnail: use the first frame
            thumb = path.with_name(path.stem + ".thumb.jpg")
            Image.fromarray(frames[len(frames) // 3]).save(thumb, "JPEG", quality=85)
            item.meta = {**item.meta, "thumbnail": str(thumb.relative_to(media_root))}
        items.append(item)
    audit.record(db, users["admin@annolab.dev"].id, "items.upload", "project", p.id, p.id, {"created": len(items)}, at=created)
    pairs = [("annotator1@annolab.dev", "annotator3@annolab.dev"), ("annotator2@annolab.dev", "annotator3@annolab.dev")]
    for i, item in enumerate(items):
        if i >= len(items) - 1:
            break
        who = pairs[i % 2] if i < len(items) - 2 else pairs[i % 2][:1]
        truth = item.meta["truth"]
        dur = item.meta.get("duration", 6.0)
        for email in who:
            st = STYLES[email]
            anns = sim_tracks(rng, truth["tracks"], st, dur)
            anns.append({"schema_key": "phase", "label": "steady",
                         "geometry": {"start": round(float(rng.uniform(0, 0.4)), 2), "end": round(dur - float(rng.uniform(0, 0.4)), 2)}})
            anns.append(_radio(rng, "gait", truth["gait"], ["normal", "limping"], 0.1 + st.confuse))
            secs = float(rng.lognormal(math.log(150), 0.25)) * st.speed
            _work(db, item, users[email], anns, clock, secs)
    for item in [it for it in items if it.status == "in_review"][:2]:
        services.create_review(db, item, rev, "approve", "Tracks follow the feet well.", [], now=clock.tick(400))
    return p


def seed_text(db, rng, media_root, users, clock, created, n_items, rev) -> Project:
    p = Project(
        name="Clinical notes NER", modality="text", annotators_per_item=2, review_required=False,
        description="Tag symptoms, medications, dosages and body sites in short synthetic clinic notes.",
        instructions=(
            "## Task\nSelect text to tag entities.\n\n- **symptom**: the complaint, including modifiers (\"persistent cough\").\n"
            "- **medication**: drug name only.\n- **dosage**: amount and unit (\"25 mg\"), not the frequency.\n"
            "- **body_site**: anatomical location.\n- Mark *urgent* when the note asks for same-day review.\n"
        ),
        schema=normalize_schema(TEXT_SCHEMA, "text"), created_at=created,
    )
    db.add(p)
    db.flush()
    audit.record(db, users["admin@annolab.dev"].id, "project.create", "project", p.id, p.id, {"name": p.name}, at=created)
    items = []
    for i in range(n_items):
        text, spans, urgency = clinical_note(rng)
        path = _store(media_root, p.id, f"note_{i + 1:02d}.txt")
        path.write_text(text)
        items.append(_add_item(db, p, media_root, path, "text", {
            "text": text, "chars": len(text), "truth": {"spans": spans, "urgency": urgency}, "source": "synthetic (templates)",
        }, created))
    audit.record(db, users["admin@annolab.dev"].id, "items.upload", "project", p.id, p.id, {"created": len(items)}, at=created)
    classes = ["symptom", "medication", "dosage", "body_site"]
    pairs = [("annotator1@annolab.dev", "annotator2@annolab.dev"), ("annotator2@annolab.dev", "annotator3@annolab.dev"),
             ("annotator3@annolab.dev", "annotator1@annolab.dev")]
    full = int(n_items * 0.7)
    for i, item in enumerate(items):
        if i >= n_items - max(1, n_items // 7):
            break
        who = pairs[i % 3] if i < full else pairs[i % 3][:1]
        truth = item.meta["truth"]
        for email in who:
            st = STYLES[email]
            anns = sim_spans(rng, item.meta["text"], truth["spans"], st, classes)
            anns.append(_radio(rng, "urgency", truth["urgency"], ["routine", "urgent"], 0.05 + st.confuse))
            secs = float(rng.lognormal(math.log(45), 0.3)) * st.speed
            _work(db, item, users[email], anns, clock, secs)
    for item in [it for it in items if it.status == "labeled"][:3]:
        services.create_review(db, item, rev, "approve", "", [], now=clock.tick(200))
    return p


def build(settings: Settings, small: bool = False, seed: int = 20260415) -> dict[str, Any]:
    """Wipe the data dir's database and media, then generate everything again."""
    t0 = time.perf_counter()
    for f in ("annolab.db", "annolab.db-wal", "annolab.db-shm"):
        (settings.data_dir / f).unlink(missing_ok=True)
    shutil.rmtree(settings.media_dir, ignore_errors=True)
    settings.media_dir.mkdir(parents=True, exist_ok=True)

    database = Database(settings.db_path)
    database.create_all()
    rng = np.random.default_rng(seed)
    now = datetime.now(UTC).replace(microsecond=0)
    created = now - timedelta(days=7)
    end = now - timedelta(minutes=5)

    def clock(tasks: int) -> Clock:
        return Clock(now - timedelta(days=6), end, rng, gap=5 * 86400 / max(1, tasks))
    with database.sessionmaker() as db:
        users = {}
        for email, name, role in USERS:
            u = User(email=email, name=name, role=role, password_hash=hash_password(PASSWORD), created_at=created)
            db.add(u)
            users[email] = u
        db.flush()
        rev = users["reviewer1@annolab.dev"]
        n = (4, 4, 3, 6) if small else (12, 10, 6, 20)
        projects = [
            seed_audio(db, rng, settings.media_dir, users, clock(2 * n[0]), created, n[0], rev),
            seed_images(db, rng, settings.media_dir, users, clock(3 * (n[1] + 6)), created, n[1], rev),
            seed_video(db, rng, settings.media_dir, users, clock(2 * n[2]), created, n[2], rev),
            seed_text(db, rng, settings.media_dir, users, clock(2 * n[3]), created, n[3], rev),
        ]
        db.commit()
        summary = {"users": len(users), "projects": []}
        from sqlalchemy import func, select

        from .models import Annotation, Review

        for p in projects:
            counts = dict(db.execute(select(Item.status, func.count()).where(Item.project_id == p.id).group_by(Item.status)).all())
            n_tasks = db.scalar(select(func.count()).select_from(Task).join(Item).where(Item.project_id == p.id))
            n_anns = db.scalar(select(func.count()).select_from(Annotation).join(Item).where(Item.project_id == p.id))
            n_rev = db.scalar(select(func.count()).select_from(Review).join(Item).where(Item.project_id == p.id))
            summary["projects"].append({"id": p.id, "name": p.name, "modality": p.modality, "items": sum(counts.values()),
                                        "status": counts, "tasks": n_tasks, "annotations": n_anns, "reviews": n_rev})
    database.engine.dispose()
    summary["seconds"] = round(time.perf_counter() - t0, 1)
    return summary


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--small", action="store_true", help="fewer items per project")
    ap.add_argument("--seed", type=int, default=20260415)
    args = ap.parse_args()
    settings = get_settings()
    s = build(settings, small=args.small, seed=args.seed)
    print(f"seeded {settings.data_dir} in {s['seconds']} s")
    for p in s["projects"]:
        status = ", ".join(f"{k} {v}" for k, v in sorted(p["status"].items()))
        print(f"  [{p['modality']}] {p['name']}: {p['items']} items ({status}); "
              f"{p['tasks']} tasks, {p['annotations']} annotations, {p['reviews']} reviews")
    print(f"  users: {', '.join(e for e, _, _ in USERS)} (password: {PASSWORD})")


if __name__ == "__main__":
    main()
