"""Project label schema: validation of the schema itself and of annotations against it."""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

TOOL_TYPES = ("bbox", "polygon", "point", "segment", "track", "span")

TOOLS_BY_MODALITY: dict[str, set[str]] = {
    "image": {"bbox", "polygon", "point"},
    "audio": {"segment"},
    "video": {"track", "segment"},
    "text": {"span"},
}

# Default class colours: the same eight light-theme steps as web/src/lib/palette.ts,
# which swaps in a matching dark step at display time. Keep the two lists in sync.
DEFAULT_PALETTE = [
    "#257de0", "#f47230", "#00b894", "#f2a600",
    "#ee7fac", "#008a17", "#6a4ce2", "#ec4647",
]

_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
_KEY = re.compile(r"^[a-z0-9_][a-z0-9_\-]*$")


class SchemaClass(BaseModel):
    value: str = Field(min_length=1, max_length=64)
    name: str = ""
    color: str | None = None
    hotkey: str | None = None

    @field_validator("color")
    @classmethod
    def _color(cls, v):
        if v is not None and not _HEX.match(v):
            raise ValueError("color must be #rrggbb")
        return v

    @field_validator("hotkey")
    @classmethod
    def _hotkey(cls, v):
        if v is not None and (len(v) != 1 or not v.isdigit() or v == "0"):
            raise ValueError("hotkey must be a single digit 1-9")
        return v


class SchemaAttribute(BaseModel):
    key: str
    type: Literal["select", "text", "number", "checkbox"] = "select"
    name: str = ""
    options: list[str] = []

    @model_validator(mode="after")
    def _opts(self):
        if self.type == "select" and not self.options:
            raise ValueError(f"attribute {self.key!r}: select needs options")
        return self


class SchemaTool(BaseModel):
    key: str
    type: Literal["bbox", "polygon", "point", "segment", "track", "span"]
    name: str = ""
    classes: list[SchemaClass] = Field(min_length=1)
    attributes: list[SchemaAttribute] = []

    @field_validator("key")
    @classmethod
    def _key(cls, v):
        if not _KEY.match(v):
            raise ValueError("key must be lowercase letters, digits, _ or -")
        return v

    @model_validator(mode="after")
    def _unique(self):
        values = [c.value for c in self.classes]
        if len(set(values)) != len(values):
            raise ValueError(f"tool {self.key!r}: duplicate class values")
        return self


class SchemaClassification(BaseModel):
    key: str
    name: str = ""
    type: Literal["radio", "checklist", "text"] = "radio"
    options: list[str] = []

    @field_validator("key")
    @classmethod
    def _key(cls, v):
        if not _KEY.match(v):
            raise ValueError("key must be lowercase letters, digits, _ or -")
        return v

    @model_validator(mode="after")
    def _opts(self):
        if self.type != "text" and len(self.options) < 2:
            raise ValueError(f"classification {self.key!r}: needs at least two options")
        return self


class LabelSchema(BaseModel):
    tools: list[SchemaTool] = []
    classifications: list[SchemaClassification] = []

    @model_validator(mode="after")
    def _unique_keys(self):
        keys = [t.key for t in self.tools] + [c.key for c in self.classifications]
        if len(set(keys)) != len(keys):
            raise ValueError("tool and classification keys must be unique")
        return self


def normalize_schema(raw: dict[str, Any], modality: str) -> dict[str, Any]:
    """Validate a schema for a modality and fill default colours. Raises ValueError."""
    schema = LabelSchema.model_validate(raw or {})
    allowed = TOOLS_BY_MODALITY[modality]
    # Colours are assigned across the whole schema: a class value keeps one colour in every
    # tool, and different values get the next unused palette slot.
    by_value = {c.value: c.color for t in schema.tools for c in t.classes if c.color}
    used = {c.lower() for c in by_value.values()}
    n_default = 0
    for tool in schema.tools:
        if tool.type not in allowed:
            raise ValueError(f"tool type {tool.type!r} is not available for {modality} projects")
        seen: set[str] = set()
        for cls in tool.classes:
            if not cls.name:
                cls.name = cls.value
            if not cls.color:
                cls.color = by_value.get(cls.value) or next(
                    (c for c in DEFAULT_PALETTE if c not in used), DEFAULT_PALETTE[n_default % len(DEFAULT_PALETTE)])
                n_default += 1
                by_value.setdefault(cls.value, cls.color)
                used.add(cls.color)
            if cls.hotkey:
                if cls.hotkey in seen:
                    raise ValueError(f"tool {tool.key!r}: hotkey {cls.hotkey} used twice")
                seen.add(cls.hotkey)
        if not tool.name:
            tool.name = tool.key
    for c in schema.classifications:
        if not c.name:
            c.name = c.key
    return schema.model_dump()


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _check_geometry(kind: str, g: Any) -> dict[str, Any]:
    if not isinstance(g, dict):
        raise ValueError(f"{kind} geometry must be an object")
    if kind == "bbox":
        if not all(_num(g.get(k)) for k in "xywh"):
            raise ValueError("bbox needs numeric x, y, w, h")
        if g["w"] <= 0 or g["h"] <= 0:
            raise ValueError("bbox w and h must be positive")
        return {k: float(g[k]) for k in "xywh"}
    if kind == "polygon":
        pts = g.get("points")
        if not isinstance(pts, list) or len(pts) < 3:
            raise ValueError("polygon needs at least 3 points")
        if not all(isinstance(p, (list, tuple)) and len(p) == 2 and all(_num(c) for c in p) for p in pts):
            raise ValueError("polygon points must be [x, y] pairs")
        return {"points": [[float(x), float(y)] for x, y in pts]}
    if kind == "point":
        if not (_num(g.get("x")) and _num(g.get("y"))):
            raise ValueError("point needs numeric x, y")
        return {"x": float(g["x"]), "y": float(g["y"])}
    if kind in ("segment", "span"):
        s, e = g.get("start"), g.get("end")
        if not (_num(s) and _num(e)) or s < 0 or e <= s:
            raise ValueError(f"{kind} needs 0 <= start < end")
        if kind == "span":
            if int(s) != s or int(e) != e:
                raise ValueError("span offsets must be integers")
            return {"start": int(s), "end": int(e)}
        return {"start": float(s), "end": float(e)}
    if kind == "track":
        kfs = g.get("keyframes")
        if not isinstance(kfs, list) or not kfs:
            raise ValueError("track needs at least one keyframe")
        out = []
        for kf in kfs:
            if not isinstance(kf, dict) or not all(_num(kf.get(k)) for k in ("t", "x", "y", "w", "h")):
                raise ValueError("track keyframes need numeric t, x, y, w, h")
            if kf["w"] <= 0 or kf["h"] <= 0:
                raise ValueError("track keyframe w and h must be positive")
            out.append({k: float(kf[k]) for k in ("t", "x", "y", "w", "h")})
        out.sort(key=lambda k: k["t"])
        if len({k["t"] for k in out}) != len(out):
            raise ValueError("track keyframe times must be unique")
        return {"keyframes": out}
    raise ValueError(f"unknown tool type {kind}")


def validate_annotation(schema: dict[str, Any], ann: dict[str, Any]) -> dict[str, Any]:
    """Check one annotation dict against a normalized schema. Returns cleaned fields."""
    key = ann.get("schema_key")
    tools = {t["key"]: t for t in schema.get("tools", [])}
    classifications = {c["key"]: c for c in schema.get("classifications", [])}
    attrs = ann.get("attributes") or {}
    if not isinstance(attrs, dict):
        raise ValueError("attributes must be an object")
    if key in tools:
        tool = tools[key]
        values = {c["value"] for c in tool["classes"]}
        if ann.get("label") not in values:
            raise ValueError(f"label {ann.get('label')!r} is not a class of tool {key!r}")
        geometry = _check_geometry(tool["type"], ann.get("geometry"))
        known = {a["key"]: a for a in tool.get("attributes", [])}
        for k, v in attrs.items():
            spec = known.get(k)
            if spec is None:
                raise ValueError(f"unknown attribute {k!r} for tool {key!r}")
            if spec["type"] == "select" and v is not None and v not in spec["options"]:
                raise ValueError(f"attribute {k!r}: {v!r} is not an option")
        return {"schema_key": key, "label": ann["label"], "geometry": geometry, "attributes": attrs}
    if key in classifications:
        c = classifications[key]
        if c["type"] == "text":
            if not isinstance(attrs.get("text"), str):
                raise ValueError(f"classification {key!r} needs attributes.text")
            return {"schema_key": key, "label": None, "geometry": None, "attributes": attrs}
        if ann.get("label") not in c["options"]:
            raise ValueError(f"{ann.get('label')!r} is not an option of {key!r}")
        return {"schema_key": key, "label": ann["label"], "geometry": None, "attributes": attrs}
    raise ValueError(f"unknown schema key {key!r}")


def tool_types(schema: dict[str, Any]) -> dict[str, str]:
    """Map schema_key -> tool type ('classification' for classifications)."""
    out = {t["key"]: t["type"] for t in schema.get("tools", [])}
    for c in schema.get("classifications", []):
        out[c["key"]] = "classification"
    return out
