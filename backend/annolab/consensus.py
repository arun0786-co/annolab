"""Agreement between annotators.

Geometric tools: annotations of two annotators are matched greedily by
similarity (IoU, temporal IoU, span overlap, point distance), highest first,
keeping pairs at or above a threshold. A pair of annotators then scores

    agreement = 2 * (matches with the same label) / (|A| + |B|)

which is the F1 score of one set against the other. Classifications score
1 or 0 per pair (Jaccard of the chosen options for checklists). Across items,
classifications also get Cohen's kappa per annotator pair and Fleiss' kappa.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from itertools import combinations
from statistics import fmean
from typing import Any

from .geometry import similarity

DEFAULT_THRESHOLDS = {"bbox": 0.5, "polygon": 0.5, "segment": 0.5, "track": 0.5, "span": 0.5, "point": 0.5}


def match(kind: str, a: list[dict], b: list[dict], threshold: float) -> tuple[list[tuple[int, int, float]], list[int], list[int]]:
    """Greedy one-to-one matching. Returns (pairs as (i, j, sim), unmatched i, unmatched j)."""
    cands = []
    for i, x in enumerate(a):
        for j, y in enumerate(b):
            s = similarity(kind, x["geometry"], y["geometry"])
            if s >= threshold:
                cands.append((s, i, j))
    cands.sort(key=lambda c: (-c[0], c[1], c[2]))
    used_a, used_b, pairs = set(), set(), []
    for s, i, j in cands:
        if i in used_a or j in used_b:
            continue
        used_a.add(i)
        used_b.add(j)
        pairs.append((i, j, s))
    return pairs, [i for i in range(len(a)) if i not in used_a], [j for j in range(len(b)) if j not in used_b]


def pair_agreement(kind: str, a: list[dict], b: list[dict], threshold: float) -> dict[str, Any] | None:
    if not a and not b:
        return None
    pairs, ua, ub = match(kind, a, b, threshold)
    same = sum(1 for i, j, _ in pairs if a[i]["label"] == b[j]["label"])
    return {
        "matches": [
            {
                "a_id": a[i].get("id"),
                "b_id": b[j].get("id"),
                "iou": round(s, 4),
                "label_match": a[i]["label"] == b[j]["label"],
            }
            for i, j, s in pairs
        ],
        "unmatched_a": [a[i].get("id") for i in ua],
        "unmatched_b": [b[j].get("id") for j in ub],
        "agreement": 2 * same / (len(a) + len(b)),
        "mean_iou": fmean(s for *_, s in pairs) if pairs else None,
    }


def _class_value(kind: str, anns: list[dict]) -> Any:
    if not anns:
        return None
    if kind == "checklist":
        return frozenset(a["label"] for a in anns)
    return anns[0]["label"]


def class_pair_agreement(kind: str, va: Any, vb: Any) -> float | None:
    if va is None or vb is None:
        return None
    if kind == "checklist":
        union = va | vb
        return len(va & vb) / len(union) if union else 1.0
    return 1.0 if va == vb else 0.0


def item_consensus(
    schema: dict[str, Any],
    sets: dict[int, list[dict]],
    thresholds: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Consensus for one item. `sets` maps annotator id -> list of annotation dicts."""
    thr = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    users = sorted(sets)
    by_user_key: dict[int, dict[str, list[dict]]] = {
        u: defaultdict(list) for u in users
    }
    for u in users:
        for ann in sets[u]:
            by_user_key[u][ann["schema_key"]].append(ann)

    tools_out, class_out, all_scores = [], [], []
    pair_scores: dict[tuple[int, int], list[float]] = defaultdict(list)

    for tool in schema.get("tools", []):
        key, kind = tool["key"], tool["type"]
        pairs_out = []
        for u, v in combinations(users, 2):
            res = pair_agreement(kind, by_user_key[u][key], by_user_key[v][key], thr[kind])
            if res is None:
                continue
            pairs_out.append({"a": u, "b": v, **res})
            pair_scores[(u, v)].append(res["agreement"])
        scores = [p["agreement"] for p in pairs_out]
        all_scores.extend(scores)
        ious = [p["mean_iou"] for p in pairs_out if p["mean_iou"] is not None]
        tools_out.append({
            "schema_key": key,
            "type": kind,
            "threshold": thr[kind],
            "counts": {str(u): len(by_user_key[u][key]) for u in users},
            "pairs": pairs_out,
            "agreement": fmean(scores) if scores else None,
            "mean_iou": fmean(ious) if ious else None,
        })

    for c in schema.get("classifications", []):
        key, kind = c["key"], c["type"]
        if kind == "text":
            continue
        votes = {u: _class_value(kind, by_user_key[u][key]) for u in users}
        pairs_out = []
        for u, v in combinations(users, 2):
            s = class_pair_agreement(kind, votes[u], votes[v])
            if s is None:
                continue
            pairs_out.append({"a": u, "b": v, "agreement": s})
            pair_scores[(u, v)].append(s)
        scores = [p["agreement"] for p in pairs_out]
        all_scores.extend(scores)
        majority = None
        if kind == "radio":
            counted = Counter(v for v in votes.values() if v is not None)
            if counted:
                top = counted.most_common()
                if len(top) == 1 or top[0][1] > top[1][1]:
                    majority = top[0][0]
        class_out.append({
            "schema_key": key,
            "type": kind,
            "votes": {str(u): (sorted(v) if isinstance(v, frozenset) else v) for u, v in votes.items()},
            "pairs": pairs_out,
            "agreement": fmean(scores) if scores else None,
            "majority": majority,
        })

    per_user = {}
    for u in users:
        mine = [fmean(s) for (a, b), s in pair_scores.items() if u in (a, b) and s]
        per_user[str(u)] = fmean(mine) if mine else None

    return {
        "annotator_ids": users,
        "tools": tools_out,
        "classifications": class_out,
        "per_annotator": per_user,
        "score": fmean(all_scores) if all_scores else None,
    }


def best_annotator(consensus: dict[str, Any]) -> int | None:
    """Annotator whose set agrees most with the others (ties: lowest id)."""
    users = consensus["annotator_ids"]
    if not users:
        return None
    scored = [(consensus["per_annotator"].get(str(u)) or 0.0, -u) for u in users]
    return -max(scored)[1]


def cohen_kappa(a: list[Any], b: list[Any]) -> float | None:
    """Cohen's kappa for two raters over the same items (paired lists)."""
    if len(a) != len(b) or not a:
        return None
    n = len(a)
    po = sum(x == y for x, y in zip(a, b)) / n
    ca, cb = Counter(a), Counter(b)
    pe = sum(ca[k] * cb[k] for k in set(ca) | set(cb)) / (n * n)
    if pe == 1:
        return None
    return (po - pe) / (1 - pe)


def fleiss_kappa(ratings: list[list[Any]]) -> float | None:
    """Fleiss' kappa. `ratings` holds, per item, the labels given by its raters.

    Items may have different numbers of raters (each needs at least two);
    p_j is then the share of all ratings that went to category j.
    """
    rows = [r for r in ratings if len(r) >= 2]
    if not rows:
        return None
    p_items = []
    totals: Counter = Counter()
    n_total = 0
    for r in rows:
        counts = Counter(r)
        n = len(r)
        p_items.append(sum(c * (c - 1) for c in counts.values()) / (n * (n - 1)))
        totals.update(counts)
        n_total += n
    p_bar = fmean(p_items)
    pe = sum((c / n_total) ** 2 for c in totals.values())
    if pe == 1:
        return None
    return (p_bar - pe) / (1 - pe)


def project_agreement(schema: dict[str, Any], items: list[dict[int, list[dict]]]) -> dict[str, Any]:
    """Agreement summary over many items, each given as annotator id -> annotations."""
    results = [item_consensus(schema, sets) for sets in items if len(sets) >= 2]
    tool_scores: dict[str, list[float]] = defaultdict(list)
    tool_ious: dict[str, list[float]] = defaultdict(list)
    for r in results:
        for t in r["tools"]:
            if t["agreement"] is not None:
                tool_scores[t["schema_key"]].append(t["agreement"])
            if t["mean_iou"] is not None:
                tool_ious[t["schema_key"]].append(t["mean_iou"])

    classifications = []
    for c in schema.get("classifications", []):
        if c["type"] != "radio":
            continue
        key = c["key"]
        per_item: list[dict[int, Any]] = []
        for sets in items:
            votes = {}
            for u, anns in sets.items():
                lab = next((a["label"] for a in anns if a["schema_key"] == key), None)
                if lab is not None:
                    votes[u] = lab
            if len(votes) >= 2:
                per_item.append(votes)
        pairwise = []
        raters = sorted({u for v in per_item for u in v})
        for u, v in combinations(raters, 2):
            common = [d for d in per_item if u in d and v in d]
            if len(common) >= 2:
                k = cohen_kappa([d[u] for d in common], [d[v] for d in common])
                pairwise.append({"a": u, "b": v, "n": len(common), "kappa": k})
        ks = [p["kappa"] for p in pairwise if p["kappa"] is not None]
        classifications.append({
            "schema_key": key,
            "items": len(per_item),
            "fleiss_kappa": fleiss_kappa([list(d.values()) for d in per_item]),
            "cohen_pairs": pairwise,
            "mean_cohen_kappa": fmean(ks) if ks else None,
        })

    scores = [r["score"] for r in results if r["score"] is not None]
    return {
        "items_compared": len(results),
        "mean_item_agreement": fmean(scores) if scores else None,
        "tools": [
            {
                "schema_key": t["key"],
                "type": t["type"],
                "items": len(tool_scores[t["key"]]),
                "mean_agreement": fmean(tool_scores[t["key"]]) if tool_scores[t["key"]] else None,
                "mean_iou": fmean(tool_ious[t["key"]]) if tool_ious[t["key"]] else None,
            }
            for t in schema.get("tools", [])
        ],
        "classifications": classifications,
    }
