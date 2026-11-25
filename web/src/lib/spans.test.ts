import { describe, expect, it } from "vitest";
import { assignLanes, pieces, snapToWords } from "./spans";

describe("assignLanes", () => {
  it("gives overlapping spans distinct lanes and reuses freed lanes", () => {
    const lanes = assignLanes([
      { id: "a", start: 0, end: 10 },
      { id: "b", start: 5, end: 15 },
      { id: "c", start: 12, end: 20 },
      { id: "d", start: 6, end: 8 },
    ]);
    expect(lanes.get("a")).toBe(0);
    expect(lanes.get("b")).toBe(1);
    expect(lanes.get("d")).toBe(2);
    expect(lanes.get("c")).toBe(0);
  });
});

describe("pieces", () => {
  it("cuts at boundaries and lists covering spans", () => {
    const p = pieces(10, [
      { id: "a", start: 0, end: 6 },
      { id: "b", start: 4, end: 8 },
    ]);
    expect(p).toEqual([
      { start: 0, end: 4, ids: ["a"] },
      { start: 4, end: 6, ids: ["a", "b"] },
      { start: 6, end: 8, ids: ["b"] },
      { start: 8, end: 10, ids: [] },
    ]);
  });
});

describe("snapToWords", () => {
  it("expands partial words and trims spaces", () => {
    const t = "took ibuprofen 400 mg daily";
    expect(snapToWords(t, 7, 12)).toEqual({ start: 5, end: 14 });
    expect(snapToWords(t, 4, 19)).toEqual({ start: 5, end: 18 });
  });
});
