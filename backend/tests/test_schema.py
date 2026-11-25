import pytest

from annolab.labelschema import DEFAULT_PALETTE, normalize_schema, validate_annotation
from conftest import IMAGE_SCHEMA


def test_normalize_fills_names_and_colors():
    s = normalize_schema(IMAGE_SCHEMA, "image")
    box = s["tools"][0]
    assert box["classes"][0]["color"] == DEFAULT_PALETTE[0]
    assert box["classes"][1]["name"] == "dog"


@pytest.mark.parametrize("schema,modality,msg", [
    ({"tools": [{"key": "s", "type": "segment", "classes": [{"value": "a"}]}]}, "image", "not available"),
    ({"tools": [{"key": "b", "type": "bbox", "classes": [{"value": "a"}, {"value": "a"}]}]}, "image", "duplicate"),
    ({"tools": [{"key": "b", "type": "bbox", "classes": [{"value": "a", "hotkey": "1"}, {"value": "b", "hotkey": "1"}]}]}, "image", "hotkey"),
    ({"tools": [{"key": "b", "type": "bbox", "classes": [{"value": "a", "color": "red"}]}]}, "image", "color"),
    ({"tools": [{"key": "b", "type": "bbox", "classes": []}]}, "image", "classes"),
    ({"tools": [{"key": "x", "type": "bbox", "classes": [{"value": "a"}]}],
      "classifications": [{"key": "x", "type": "radio", "options": ["a", "b"]}]}, "image", "unique"),
    ({"classifications": [{"key": "q", "type": "radio", "options": ["only"]}]}, "text", "two options"),
])
def test_invalid_schemas(schema, modality, msg):
    with pytest.raises(ValueError, match=msg):
        normalize_schema(schema, modality)


S = normalize_schema(IMAGE_SCHEMA, "image")


@pytest.mark.parametrize("ann,msg", [
    ({"schema_key": "nope", "label": "cat"}, "unknown schema key"),
    ({"schema_key": "box", "label": "cow", "geometry": {"x": 0, "y": 0, "w": 1, "h": 1}}, "not a class"),
    ({"schema_key": "box", "label": "cat", "geometry": {"x": 0, "y": 0, "w": 0, "h": 1}}, "positive"),
    ({"schema_key": "box", "label": "cat", "geometry": {"x": 0, "y": 0}}, "numeric"),
    ({"schema_key": "outline", "label": "cat", "geometry": {"points": [[0, 0], [1, 1]]}}, "3 points"),
    ({"schema_key": "box", "label": "cat", "geometry": {"x": 0, "y": 0, "w": 1, "h": 1}, "attributes": {"occluded": "maybe"}}, "not an option"),
    ({"schema_key": "box", "label": "cat", "geometry": {"x": 0, "y": 0, "w": 1, "h": 1}, "attributes": {"zzz": 1}}, "unknown attribute"),
    ({"schema_key": "quality", "label": "great"}, "not an option"),
])
def test_invalid_annotations(ann, msg):
    with pytest.raises(ValueError, match=msg):
        validate_annotation(S, ann)


def test_valid_annotations_are_cleaned():
    out = validate_annotation(S, {"schema_key": "box", "label": "cat", "geometry": {"x": 1, "y": 2, "w": 3, "h": 4, "junk": 9}})
    assert out["geometry"] == {"x": 1.0, "y": 2.0, "w": 3.0, "h": 4.0}
    q = validate_annotation(S, {"schema_key": "quality", "label": "good", "geometry": {"x": 1}})
    assert q["geometry"] is None


def test_track_and_span_geometry():
    vs = normalize_schema({"tools": [{"key": "t", "type": "track", "classes": [{"value": "p"}]}]}, "video")
    out = validate_annotation(vs, {"schema_key": "t", "label": "p", "geometry": {"keyframes": [
        {"t": 1, "x": 0, "y": 0, "w": 2, "h": 2}, {"t": 0, "x": 0, "y": 0, "w": 2, "h": 2}]}})
    assert [k["t"] for k in out["geometry"]["keyframes"]] == [0, 1]
    with pytest.raises(ValueError, match="unique"):
        validate_annotation(vs, {"schema_key": "t", "label": "p", "geometry": {"keyframes": [
            {"t": 1, "x": 0, "y": 0, "w": 2, "h": 2}, {"t": 1, "x": 0, "y": 0, "w": 2, "h": 2}]}})
    ts = normalize_schema({"tools": [{"key": "ner", "type": "span", "classes": [{"value": "drug"}]}]}, "text")
    with pytest.raises(ValueError, match="integers"):
        validate_annotation(ts, {"schema_key": "ner", "label": "drug", "geometry": {"start": 0.5, "end": 3}})
    with pytest.raises(ValueError, match="start < end"):
        validate_annotation(ts, {"schema_key": "ner", "label": "drug", "geometry": {"start": 3, "end": 3}})


def test_default_colors_follow_the_class_across_tools():
    schema = normalize_schema({"tools": [
        {"key": "box", "type": "bbox", "classes": [{"value": "car"}, {"value": "dog", "color": DEFAULT_PALETTE[1]}]},
        {"key": "outline", "type": "polygon", "classes": [{"value": "dog"}, {"value": "cat"}]},
    ]}, "image")
    box, outline = schema["tools"]
    assert [c["color"] for c in box["classes"]] == [DEFAULT_PALETTE[0], DEFAULT_PALETTE[1]]
    # dog keeps its colour, cat takes the next free slot instead of repeating box's first class
    assert [c["color"] for c in outline["classes"]] == [DEFAULT_PALETTE[1], DEFAULT_PALETTE[2]]
