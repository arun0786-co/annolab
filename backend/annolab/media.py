"""Media storage, metadata extraction, thumbnails and HTTP Range responses."""

from __future__ import annotations

import json
import mimetypes
import re
import shutil
import subprocess
import uuid
import wave
from pathlib import Path
from typing import Any

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse

EXTENSIONS = {
    "image": {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"},
    "audio": {".wav", ".mp3", ".ogg", ".flac", ".m4a"},
    "video": {".mp4", ".webm", ".mov", ".m4v"},
    "text": {".txt", ".md", ".jsonl"},
}

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_name(name: str) -> str:
    base = Path(name).name or "file"
    return _SAFE.sub("_", base)[:200]


def store_bytes(media_dir: Path, project_id: int, filename: str, data: bytes) -> Path:
    folder = media_dir / str(project_id)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{uuid.uuid4().hex[:10]}_{safe_name(filename)}"
    path.write_bytes(data)
    return path


def ffprobe(path: Path) -> dict[str, Any]:
    exe = shutil.which("ffprobe")
    if not exe:
        return {}
    try:
        out = subprocess.run(
            [exe, "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
            capture_output=True, check=True, timeout=30,
        ).stdout
        info = json.loads(out)
    except (subprocess.SubprocessError, json.JSONDecodeError):
        return {}
    meta: dict[str, Any] = {}
    if dur := info.get("format", {}).get("duration"):
        meta["duration"] = round(float(dur), 3)
    for s in info.get("streams", []):
        if s.get("codec_type") == "video" and "width" not in meta:
            meta["width"], meta["height"] = s.get("width"), s.get("height")
            rate = s.get("avg_frame_rate") or s.get("r_frame_rate") or "0/1"
            num, _, den = rate.partition("/")
            if float(den or 1):
                meta["fps"] = round(float(num) / float(den or 1), 3)
            if s.get("nb_frames"):
                meta["frames"] = int(s["nb_frames"])
        if s.get("codec_type") == "audio" and "sample_rate" not in meta:
            meta["sample_rate"] = int(s.get("sample_rate", 0))
    return meta


def audio_meta(path: Path) -> dict[str, Any]:
    if path.suffix.lower() == ".wav":
        try:
            import numpy as np

            from .prelabel import read_wav
            from .synth import peaks

            with wave.open(str(path), "rb") as w:
                meta = {"sample_rate": w.getframerate(), "channels": w.getnchannels(),
                        "duration": round(w.getnframes() / w.getframerate(), 3)}
            try:
                x, _ = read_wav(path)
                meta["peaks"] = peaks(x / (np.max(np.abs(x)) or 1))
            except ValueError:
                pass
            return meta
        except wave.Error:
            pass
    return ffprobe(path)


def image_meta(path: Path) -> dict[str, Any]:
    from PIL import Image

    with Image.open(path) as im:
        return {"width": im.width, "height": im.height}


def make_thumbnail(src: Path, kind: str, size: int = 320) -> Path | None:
    """Small JPEG next to the media file. Images via Pillow, video via ffmpeg."""
    from PIL import Image

    dest = src.with_name(src.stem + ".thumb.jpg")
    try:
        if kind == "image":
            with Image.open(src) as im:
                im = im.convert("RGB")
                im.thumbnail((size, size))
                im.save(dest, "JPEG", quality=82)
            return dest
        if kind == "video" and shutil.which("ffmpeg"):
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-ss", "0.5", "-i", str(src), "-frames:v", "1",
                 "-vf", f"scale={size}:-2", str(dest)], check=True, timeout=60,
            )
            return dest if dest.exists() else None
    except Exception:  # thumbnail is best effort
        return None
    return None


def describe(path: Path, kind: str) -> dict[str, Any]:
    if kind == "image":
        return image_meta(path)
    if kind == "audio":
        return audio_meta(path)
    if kind == "video":
        return ffprobe(path)
    return {}


_RANGE = re.compile(r"bytes=(\d*)-(\d*)$")


def range_response(request: Request, path: Path, media_type: str | None = None):
    if not path.exists():
        raise HTTPException(404, "media file missing")
    media_type = media_type or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    size = path.stat().st_size
    header = request.headers.get("range")
    if not header:
        return FileResponse(path, media_type=media_type, headers={"Accept-Ranges": "bytes"})
    m = _RANGE.match(header.strip())
    if not m or (not m.group(1) and not m.group(2)):
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
    if m.group(1):
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) else size - 1
    else:  # suffix range: last N bytes
        n = int(m.group(2))
        start, end = max(0, size - n), size - 1
    end = min(end, size - 1)
    if start > end or start >= size:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
    length = end - start + 1

    def chunks():
        with path.open("rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                block = f.read(min(65536, left))
                if not block:
                    break
                left -= len(block)
                yield block

    return StreamingResponse(
        chunks(), status_code=206, media_type=media_type,
        headers={"Content-Range": f"bytes {start}-{end}/{size}", "Accept-Ranges": "bytes", "Content-Length": str(length)},
    )
