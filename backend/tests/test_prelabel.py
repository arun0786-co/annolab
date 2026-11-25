"""Pre-label accuracy on synthetic data with known ground truth."""

import io

import numpy as np
import pytest
from PIL import Image

from annolab.prelabel import heart_segments, image_boxes, precision_recall
from annolab.synth import phonocardiogram, shape_scene, write_wav
from conftest import AUDIO_SCHEMA, make_project


def test_heart_segments_precision_recall_on_synthetic_set():
    rng = np.random.default_rng(1234)
    tp = props = truth_n = 0
    for i in range(8):
        x, truth = phonocardiogram(rng, heart_rate=float(rng.uniform(58, 96)), murmur=i % 3 == 1, snr_db=float(rng.uniform(12, 28)))
        r = precision_recall("segment", heart_segments(x, 4000), truth, threshold=0.5)
        tp, props, truth_n = tp + r["tp"], props + r["proposals"], truth_n + r["truth"]
    assert tp / props >= 0.85
    assert tp / truth_n >= 0.85


def test_heart_segments_label_order():
    rng = np.random.default_rng(5)
    x, truth = phonocardiogram(rng, heart_rate=70, snr_db=30)
    segs = heart_segments(x, 4000)
    labels = [s["label"] for s in segs]
    # S1 and S2 alternate
    assert all(a != b for a, b in zip(labels, labels[1:]))
    assert labels[0] == truth[0]["label"]


def test_silence_gives_no_segments():
    assert heart_segments(np.zeros(8000), 4000) == []


def test_image_boxes_on_shape_scenes():
    rng = np.random.default_rng(99)
    tp = props = truth_n = 0
    for _ in range(5):
        img, truth = shape_scene(rng)
        boxes = image_boxes(img)
        pred = [{"label": b["shape"], "geometry": {k: b[k] for k in "xywh"}} for b in boxes]
        gt = [{"label": t["label"], "geometry": t["bbox"]} for t in truth]
        r = precision_recall("bbox", pred, gt, threshold=0.7)
        tp, props, truth_n = tp + r["tp"], props + r["proposals"], truth_n + r["truth"]
    assert tp / props >= 0.9 and tp / truth_n >= 0.9


def test_prelabel_endpoint_audio(client, auth, tmp_path):
    rng = np.random.default_rng(3)
    x, truth = phonocardiogram(rng, heart_rate=72, snr_db=25)
    path = tmp_path / "pcg.wav"
    write_wav(path, x, 4000)
    p = make_project(client, auth("admin"), modality="audio", schema=AUDIO_SCHEMA)
    item = client.post(f"/api/projects/{p['id']}/items", files=[("files", ("pcg.wav", path.read_bytes(), "audio/wav"))],
                       headers=auth("admin")).json()["created"][0]
    r = client.post(f"/api/items/{item['id']}/prelabel", headers=auth("ann1"))
    assert r.status_code == 200
    body = r.json()
    assert body["method"] == "shannon-energy-envelope"
    props = body["proposals"]
    assert {p_["label"] for p_ in props} == {"S1", "S2"}
    assert all(p_["source"] == "model" and p_["schema_key"] == "heart" for p_ in props)
    assert abs(len(props) - len(truth)) <= 2
    # proposals are valid annotations: they can be saved as-is
    t = client.get(f"/api/projects/{p['id']}/queue/next", headers=auth("ann1")).json()
    save = [{k: v for k, v in p_.items() if k != "score"} for p_ in props]
    assert client.put(f"/api/tasks/{t['id']}/annotations", json={"annotations": save}, headers=auth("ann1")).status_code == 200


def test_prelabel_endpoint_image(client, auth):
    rng = np.random.default_rng(8)
    img, truth = shape_scene(rng)
    buf = io.BytesIO()
    Image.fromarray(img).save(buf, "PNG")
    schema = {"tools": [{"key": "box", "type": "bbox", "classes": [{"value": "circle"}, {"value": "rectangle"}, {"value": "triangle"}]}]}
    p = make_project(client, auth("admin"), schema=schema)
    item = client.post(f"/api/projects/{p['id']}/items", files=[("files", ("s.png", buf.getvalue(), "image/png"))],
                       headers=auth("admin")).json()["created"][0]
    body = client.post(f"/api/items/{item['id']}/prelabel", headers=auth("ann1")).json()
    assert len(body["proposals"]) == len(truth)


def test_prelabel_unsupported(client, auth):
    schema = {"tools": [{"key": "ner", "type": "span", "classes": [{"value": "drug"}]}]}
    p = make_project(client, auth("admin"), modality="text", schema=schema)
    item = client.post(f"/api/projects/{p['id']}/items", files=[("files", ("a.txt", b"aspirin", "text/plain"))],
                       headers=auth("admin")).json()["created"][0]
    assert client.post(f"/api/items/{item['id']}/prelabel", headers=auth("ann1")).status_code == 422


@pytest.mark.parametrize("hr", [55, 75, 95])
def test_synthetic_truth_is_consistent(hr):
    rng = np.random.default_rng(hr)
    x, truth = phonocardiogram(rng, heart_rate=hr)
    assert np.max(np.abs(x)) <= 1
    labels = [t["label"] for t in truth]
    assert labels[::2] == ["S1"] * len(labels[::2]) and labels[1::2] == ["S2"] * len(labels[1::2])
    assert all(t["end"] > t["start"] for t in truth)
