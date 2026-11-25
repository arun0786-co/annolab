import { describe, expect, it } from "vitest";
import {
  clampRect,
  fitView,
  hitTest,
  iou,
  normRect,
  pointInPolygon,
  polygonArea,
  resizeRect,
  segmentIoU,
  toSource,
  zoomAt,
  type Shape,
} from "./geometry";

describe("iou", () => {
  it("is 1 for identical boxes", () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(1);
  });
  it("is 0 for disjoint and touching boxes", () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 })).toBe(0);
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(0);
  });
  it("matches a hand-computed partial overlap", () => {
    // overlap 5x10 = 50, union 100 + 100 - 50 = 150
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 })).toBeCloseTo(1 / 3, 10);
  });
  it("handles containment", () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 2, y: 2, w: 5, h: 5 })).toBeCloseTo(25 / 100, 10);
  });
  it("is 0 for empty boxes", () => {
    expect(iou({ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 0, h: 0 })).toBe(0);
  });
});

describe("segmentIoU", () => {
  it("matches hand-computed values", () => {
    expect(segmentIoU({ start: 0, end: 1 }, { start: 0.5, end: 1.5 })).toBeCloseTo(0.5 / 1.5, 10);
    expect(segmentIoU({ start: 0, end: 1 }, { start: 2, end: 3 })).toBe(0);
    expect(segmentIoU({ start: 1, end: 2 }, { start: 1, end: 2 })).toBe(1);
  });
  it("is symmetric", () => {
    const a = { start: 0.2, end: 0.9 };
    const b = { start: 0.4, end: 1.3 };
    expect(segmentIoU(a, b)).toBeCloseTo(segmentIoU(b, a), 12);
  });
});

describe("rects", () => {
  it("normalises drag direction", () => {
    expect(normRect({ x: 10, y: 10 }, { x: 2, y: 4 })).toEqual({ x: 2, y: 4, w: 8, h: 6 });
  });
  it("resizes from a corner and flips past the opposite edge", () => {
    const r = { x: 10, y: 10, w: 20, h: 20 };
    expect(resizeRect(r, "se", { x: 40, y: 35 })).toEqual({ x: 10, y: 10, w: 30, h: 25 });
    expect(resizeRect(r, "e", { x: 0, y: 99 })).toEqual({ x: 0, y: 10, w: 10, h: 20 });
  });
  it("clamps inside the image", () => {
    expect(clampRect({ x: -5, y: 95, w: 10, h: 10 }, 100, 100)).toEqual({ x: 0, y: 90, w: 10, h: 10 });
  });
});

describe("polygons", () => {
  const sq: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  it("tests containment", () => {
    expect(pointInPolygon(sq, { x: 5, y: 5 })).toBe(true);
    expect(pointInPolygon(sq, { x: 15, y: 5 })).toBe(false);
  });
  it("handles a concave shape", () => {
    const u: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [7, 10],
      [7, 3],
      [3, 3],
      [3, 10],
      [0, 10],
    ];
    expect(pointInPolygon(u, { x: 5, y: 6 })).toBe(false);
    expect(pointInPolygon(u, { x: 1, y: 6 })).toBe(true);
  });
  it("computes area with the shoelace formula", () => {
    expect(polygonArea(sq)).toBe(100);
  });
});

describe("hitTest", () => {
  const shapes: Shape[] = [
    { id: "big", kind: "bbox", rect: { x: 0, y: 0, w: 100, h: 100 } },
    { id: "small", kind: "bbox", rect: { x: 40, y: 40, w: 20, h: 20 } },
    { id: "pt", kind: "point", pt: { x: 80, y: 80 } },
    {
      id: "tri",
      kind: "polygon",
      points: [
        [200, 0],
        [300, 0],
        [250, 100],
      ],
    },
  ];
  it("prefers the smallest containing box", () => {
    expect(hitTest(shapes, { x: 50, y: 50 }, 2)).toEqual({ id: "small", part: "body" });
    expect(hitTest(shapes, { x: 20, y: 20 }, 2)).toEqual({ id: "big", part: "body" });
  });
  it("picks points before boxes", () => {
    expect(hitTest(shapes, { x: 81, y: 79 }, 3)).toEqual({ id: "pt", part: "body" });
  });
  it("picks edges within tolerance", () => {
    expect(hitTest(shapes, { x: 1, y: 50 }, 2)).toEqual({ id: "big", part: "edge" });
  });
  it("returns resize handles only for the selected box", () => {
    expect(hitTest(shapes, { x: 60, y: 60 }, 3, "small")).toEqual({ id: "small", part: "se" });
    expect(hitTest(shapes, { x: 60, y: 60 }, 3, null)?.part).toBe("edge");
  });
  it("returns polygon vertices for the selected polygon", () => {
    expect(hitTest(shapes, { x: 251, y: 99 }, 3, "tri")).toEqual({ id: "tri", part: "vertex", vertex: 2 });
    expect(hitTest(shapes, { x: 250, y: 30 }, 2)).toEqual({ id: "tri", part: "body" });
  });
  it("misses empty space", () => {
    expect(hitTest(shapes, { x: 500, y: 500 }, 2)).toBeNull();
  });
});

describe("view", () => {
  it("keeps the point under the cursor fixed when zooming", () => {
    const v = { k: 1, tx: 10, ty: 20 };
    const before = toSource(v, 200, 150);
    const after = toSource(zoomAt(v, 200, 150, 2.5), 200, 150);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });
  it("fits and centres", () => {
    const v = fitView(1000, 500, 548, 548, 24);
    expect(v.k).toBeCloseTo(0.5, 9);
    expect(v.tx).toBeCloseTo(24, 9);
    expect(v.ty).toBeCloseTo((548 - 250) / 2, 9);
  });
});
