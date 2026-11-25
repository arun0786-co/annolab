import { describe, expect, it } from "vitest";
import type { Annotation } from "../api/types";
import { matchSets, similarity, trackIoU } from "./match";

const box = (x: number, y: number, w: number, h: number, label = "a"): Annotation => ({
  schema_key: "obj",
  label,
  geometry: { x, y, w, h },
  attributes: {},
  source: "human",
});

describe("matchSets", () => {
  it("pairs boxes one-to-one by best IoU and reports leftovers", () => {
    const A = [box(0, 0, 10, 10), box(100, 100, 10, 10), box(300, 300, 5, 5)];
    const B = [box(101, 100, 10, 10, "b"), box(1, 0, 10, 10)];
    const r = matchSets(A, B);
    const byI = [...r.pairs].sort((p, q) => p.i - q.i);
    expect(byI.map((p) => [p.i, p.j])).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(byI[1].sameLabel).toBe(false);
    expect(byI[1].score).toBeCloseTo(90 / 110, 10);
    expect(r.onlyA).toEqual([2]);
    expect(r.onlyB).toEqual([]);
  });
  it("does not match across schema keys", () => {
    const a = box(0, 0, 10, 10);
    const b = { ...box(0, 0, 10, 10), schema_key: "other" };
    expect(matchSets([a], [b]).pairs).toHaveLength(0);
  });
});

describe("similarity", () => {
  it("uses temporal IoU for segments", () => {
    const s = (start: number, end: number): Annotation => ({ schema_key: "h", label: "S1", geometry: { start, end }, attributes: {}, source: "human" });
    expect(similarity(s(0, 1), s(0.5, 1.5))).toBeCloseTo(1 / 3, 10);
  });
  it("is 1 for identical tracks and lower when one drifts", () => {
    const k = [
      { t: 0, x: 0, y: 0, w: 10, h: 10 },
      { t: 1, x: 10, y: 0, w: 10, h: 10 },
    ];
    expect(trackIoU(k, k)).toBeCloseTo(1, 10);
    const drift = [
      { t: 0, x: 0, y: 0, w: 10, h: 10 },
      { t: 1, x: 20, y: 0, w: 10, h: 10 },
    ];
    expect(trackIoU(k, drift)).toBeLessThan(1);
    expect(trackIoU(k, drift)).toBeGreaterThan(0.3);
  });
});
