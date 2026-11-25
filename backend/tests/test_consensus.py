"""Consensus math checked against values worked out by hand."""

import math

import pytest

from annolab.consensus import best_annotator, cohen_kappa, fleiss_kappa, item_consensus, match, project_agreement
from annolab.geometry import bbox_iou, interval_iou, point_similarity, polygon_iou, track_box_at, track_iou


def test_bbox_iou_partial_overlap():
    # 10x10 boxes offset by (5, 5): intersection 5*5 = 25, union 100 + 100 - 25 = 175
    assert bbox_iou({"x": 0, "y": 0, "w": 10, "h": 10}, {"x": 5, "y": 5, "w": 10, "h": 10}) == pytest.approx(25 / 175)


def test_bbox_iou_disjoint_and_identical():
    a = {"x": 0, "y": 0, "w": 4, "h": 4}
    assert bbox_iou(a, {"x": 10, "y": 10, "w": 4, "h": 4}) == 0
    assert bbox_iou(a, a) == 1


def test_bbox_iou_contained():
    # 2x2 inside 4x4: 4 / 16
    assert bbox_iou({"x": 0, "y": 0, "w": 4, "h": 4}, {"x": 1, "y": 1, "w": 2, "h": 2}) == pytest.approx(0.25)


def test_polygon_iou_triangle_in_square():
    square = {"points": [[0, 0], [2, 0], [2, 2], [0, 2]]}
    tri = {"points": [[0, 0], [2, 0], [0, 2]]}  # area 2, inside the square of area 4
    assert polygon_iou(square, tri) == pytest.approx(0.5)


def test_polygon_iou_nonconvex():
    # L shape (area 3) vs the full 2x2 square (area 4): IoU = 3/4
    ell = {"points": [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]]}
    square = {"points": [[0, 0], [2, 0], [2, 2], [0, 2]]}
    assert polygon_iou(ell, square) == pytest.approx(0.75)


def test_polygon_self_intersecting_is_repaired():
    bowtie = {"points": [[0, 0], [2, 2], [2, 0], [0, 2]]}
    square = {"points": [[0, 0], [2, 0], [2, 2], [0, 2]]}
    # the bow tie covers two triangles of area 1 each
    assert polygon_iou(bowtie, square) == pytest.approx(0.5)


def test_interval_iou():
    assert interval_iou({"start": 0, "end": 2}, {"start": 1, "end": 3}) == pytest.approx(1 / 3)
    assert interval_iou({"start": 0, "end": 1}, {"start": 1, "end": 2}) == 0
    assert interval_iou({"start": 0.10, "end": 0.20}, {"start": 0.12, "end": 0.20}) == pytest.approx(0.8)


def test_point_similarity():
    assert point_similarity({"x": 0, "y": 0}, {"x": 0, "y": 0}) == 1
    # d = 10 = sigma -> exp(-1/2)
    assert point_similarity({"x": 0, "y": 0}, {"x": 6, "y": 8}, sigma=10) == pytest.approx(math.exp(-0.5))


def test_track_interpolation():
    kfs = [{"t": 0, "x": 0, "y": 0, "w": 10, "h": 10}, {"t": 2, "x": 20, "y": 10, "w": 30, "h": 10}]
    assert track_box_at(kfs, 1.0) == {"x": 10, "y": 5, "w": 20, "h": 10}
    assert track_box_at(kfs, 2.5) is None
    assert track_box_at(kfs, -0.1) is None


def test_track_iou_partial_time_overlap():
    box = {"x": 0, "y": 0, "w": 10, "h": 10}
    a = {"keyframes": [{"t": 0.0, **box}, {"t": 1.0, **box}]}
    b = {"keyframes": [{"t": 0.5, **box}, {"t": 1.0, **box}]}
    # samples at 0.0, 0.1, ..., 1.0 (11); b exists at 0.5..1.0 (6) with IoU 1
    assert track_iou(a, b) == pytest.approx(6 / 11)


def test_track_iou_spatial_offset():
    a = {"keyframes": [{"t": 0, "x": 0, "y": 0, "w": 10, "h": 10}, {"t": 1, "x": 0, "y": 0, "w": 10, "h": 10}]}
    b = {"keyframes": [{"t": 0, "x": 5, "y": 5, "w": 10, "h": 10}, {"t": 1, "x": 5, "y": 5, "w": 10, "h": 10}]}
    assert track_iou(a, b) == pytest.approx(25 / 175)


def _box(i, label, x, y=0, w=10, h=10, user=1):
    return {"id": i, "user_id": user, "schema_key": "box", "label": label,
            "geometry": {"x": x, "y": y, "w": w, "h": h}, "attributes": {}, "source": "human"}


def test_greedy_matching_prefers_highest_iou():
    a = [_box(1, "cat", 0), _box(2, "cat", 100)]
    b = [_box(3, "cat", 2), _box(4, "cat", 0)]  # b[1] is identical to a[0]
    pairs, ua, ub = match("bbox", a, b, 0.5)
    assert [(i, j) for i, j, _ in pairs] == [(0, 1)]
    assert ua == [1] and ub == [0]


SCHEMA = {
    "tools": [{"key": "box", "type": "bbox", "classes": [{"value": "cat"}, {"value": "dog"}]}],
    "classifications": [{"key": "quality", "type": "radio", "options": ["good", "bad"]},
                        {"key": "tags", "type": "checklist", "options": ["a", "b", "c"]}],
}


def test_item_consensus_by_hand():
    # user 1: cat@0, dog@50, cat@200 ; user 2: cat@0 (same), cat@51 (label differs), nothing at 200
    u1 = [_box(1, "cat", 0), _box(2, "dog", 50), _box(3, "cat", 200),
          {"id": 4, "schema_key": "quality", "label": "good", "geometry": None, "attributes": {}},
          {"id": 5, "schema_key": "tags", "label": "a", "geometry": None, "attributes": {}},
          {"id": 6, "schema_key": "tags", "label": "b", "geometry": None, "attributes": {}}]
    u2 = [_box(7, "cat", 0, user=2), _box(8, "cat", 51, user=2),
          {"id": 9, "schema_key": "quality", "label": "good", "geometry": None, "attributes": {}},
          {"id": 10, "schema_key": "tags", "label": "b", "geometry": None, "attributes": {}}]
    r = item_consensus(SCHEMA, {1: u1, 2: u2})
    tool = r["tools"][0]
    pair = tool["pairs"][0]
    # two matches, one with the same label: F1 = 2*1 / (3 + 2) = 0.4
    assert pair["agreement"] == pytest.approx(0.4)
    assert {(m["a_id"], m["b_id"]) for m in pair["matches"]} == {(1, 7), (2, 8)}
    assert pair["unmatched_a"] == [3]
    # IoUs: 1.0 and 9*10/(200-90) = 90/110
    assert pair["mean_iou"] == pytest.approx((1 + 90 / 110) / 2, abs=1e-4)
    quality, tags = r["classifications"]
    assert quality["agreement"] == 1.0 and quality["majority"] == "good"
    assert tags["agreement"] == pytest.approx(0.5)  # {a,b} vs {b}
    assert r["score"] == pytest.approx((0.4 + 1.0 + 0.5) / 3)


def test_item_consensus_three_annotators_and_best():
    a = [_box(1, "cat", 0)]
    b = [_box(2, "cat", 1, user=2)]
    c = [_box(3, "dog", 60, user=3)]
    r = item_consensus(SCHEMA, {1: a, 2: b, 3: c})
    # pairs (1,2)=1, (1,3)=0, (2,3)=0
    assert r["tools"][0]["agreement"] == pytest.approx(1 / 3)
    assert best_annotator(r) == 1


def test_item_consensus_empty_sets_skip():
    r = item_consensus(SCHEMA, {1: [], 2: []})
    assert r["tools"][0]["pairs"] == [] and r["score"] is None


def test_cohen_kappa_textbook():
    # 50 items: yes/yes 20, yes/no 5, no/yes 10, no/no 15 -> po 0.7, pe 0.5, kappa 0.4
    a = ["y"] * 20 + ["y"] * 5 + ["n"] * 10 + ["n"] * 15
    b = ["y"] * 20 + ["n"] * 5 + ["y"] * 10 + ["n"] * 15
    assert cohen_kappa(a, b) == pytest.approx(0.4)


def test_cohen_kappa_perfect_and_degenerate():
    assert cohen_kappa(["a", "b", "a"], ["a", "b", "a"]) == pytest.approx(1.0)
    assert cohen_kappa(["a", "a"], ["a", "a"]) is None  # pe = 1


def test_fleiss_kappa_textbook():
    # Fleiss (1971) style example: 10 items, 14 raters, 5 categories; kappa = 0.210
    table = [
        [0, 0, 0, 0, 14], [0, 2, 6, 4, 2], [0, 0, 3, 5, 6], [0, 3, 9, 2, 0], [2, 2, 8, 1, 1],
        [7, 7, 0, 0, 0], [3, 2, 6, 3, 0], [2, 5, 3, 2, 2], [6, 5, 2, 1, 0], [0, 2, 2, 3, 7],
    ]
    ratings = [[cat for cat, n in enumerate(row) for _ in range(n)] for row in table]
    assert fleiss_kappa(ratings) == pytest.approx(0.20993, abs=1e-4)


def test_fleiss_small_by_hand():
    # 3 items, 2 raters: (a,a), (a,b), (b,b)
    # P_i = 1, 0, 1 -> P_bar = 2/3; p_a = p_b = 1/2 -> Pe = 1/2; kappa = (2/3 - 1/2)/(1/2) = 1/3
    assert fleiss_kappa([["a", "a"], ["a", "b"], ["b", "b"]]) == pytest.approx(1 / 3)


def test_project_agreement_kappas():
    def q(label, uid):
        return [{"id": None, "user_id": uid, "schema_key": "quality", "label": label, "geometry": None, "attributes": {}}]

    items = [{1: q("good", 1), 2: q("good", 2)}, {1: q("good", 1), 2: q("bad", 2)}, {1: q("bad", 1), 2: q("bad", 2)}]
    r = project_agreement(SCHEMA, items)
    c = r["classifications"][0]
    assert c["items"] == 3
    assert c["fleiss_kappa"] == pytest.approx(1 / 3)
    # Cohen: po = 2/3, pe = (2/3*1/3) + (1/3*2/3) = 4/9 -> (2/3-4/9)/(5/9) = 0.4
    assert c["cohen_pairs"][0]["kappa"] == pytest.approx(0.4)
