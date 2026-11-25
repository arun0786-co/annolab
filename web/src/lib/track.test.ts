import { describe, expect, it } from "vitest";
import { interpolate, isKeyframe, removeKeyframe, snapToFrame, trackExtent, upsertKeyframe } from "./track";

const kfs = [
  { t: 2, x: 100, y: 100, w: 40, h: 40 },
  { t: 0, x: 0, y: 0, w: 20, h: 20 },
];

describe("interpolate", () => {
  it("returns keyframes exactly", () => {
    expect(interpolate(kfs, 0)).toEqual({ t: 0, x: 0, y: 0, w: 20, h: 20 });
    expect(interpolate(kfs, 2)).toEqual({ t: 2, x: 100, y: 100, w: 40, h: 40 });
  });
  it("is linear between keyframes (unsorted input)", () => {
    expect(interpolate(kfs, 0.5)).toEqual({ t: 0.5, x: 25, y: 25, w: 25, h: 25 });
    expect(interpolate(kfs, 1)).toEqual({ t: 1, x: 50, y: 50, w: 30, h: 30 });
  });
  it("is null outside the track extent", () => {
    expect(interpolate(kfs, -0.1)).toBeNull();
    expect(interpolate(kfs, 2.1)).toBeNull();
    expect(interpolate([], 1)).toBeNull();
  });
  it("uses the right pair with three keyframes", () => {
    const three = [...kfs, { t: 4, x: 100, y: 0, w: 40, h: 40 }];
    expect(interpolate(three, 3)).toEqual({ t: 3, x: 100, y: 50, w: 40, h: 40 });
  });
});

describe("keyframe edits", () => {
  it("upserts in time order and replaces near-equal times", () => {
    const a = upsertKeyframe(kfs, { t: 1, x: 9, y: 9, w: 9, h: 9 });
    expect(a.map((k) => k.t)).toEqual([0, 1, 2]);
    const b = upsertKeyframe(a, { t: 1.0004, x: 1, y: 1, w: 1, h: 1 });
    expect(b).toHaveLength(3);
    expect(b[1].x).toBe(1);
  });
  it("removes and reports keyframes", () => {
    expect(isKeyframe(kfs, 2)).toBe(true);
    expect(removeKeyframe(kfs, 2)).toHaveLength(1);
  });
  it("reports extent and snaps to frames", () => {
    expect(trackExtent(kfs)).toEqual({ start: 0, end: 2 });
    expect(snapToFrame(1.01, 25)).toBeCloseTo(1.0, 9);
    expect(snapToFrame(1.03, 25)).toBeCloseTo(1.04, 9);
  });
});
