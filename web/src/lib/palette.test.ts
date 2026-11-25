import { describe, expect, it } from "vitest";
import {
  contrast,
  displayColor,
  inkOn,
  nextColor,
  PALETTE_DARK,
  PALETTE_LIGHT,
  SURFACE_DARK,
  SURFACE_LIGHT,
} from "./palette";

// Measured contrast of each slot against the light surface, so a palette change shows up in review.
describe("categorical palette", () => {
  it("has eight distinct slots per theme", () => {
    expect(new Set(PALETTE_LIGHT).size).toBe(8);
    expect(new Set(PALETTE_DARK).size).toBe(8);
  });
  it("dark steps clear 3:1 against the dark surface", () => {
    for (const c of PALETTE_DARK) expect(contrast(c, SURFACE_DARK)).toBeGreaterThanOrEqual(3);
  });
  it("light steps below 3:1 on white are the four known ones (class names are always shown as text)", () => {
    const low = PALETTE_LIGHT.filter((c) => contrast(c, SURFACE_LIGHT) < 3);
    expect(low).toEqual(["#f47230", "#00b894", "#f2a600", "#ee7fac"]);
    for (const c of PALETTE_LIGHT) expect(contrast(c, SURFACE_LIGHT)).toBeGreaterThanOrEqual(2);
  });
  it("chip text ink reaches AA (4.5:1) on every slot in both themes", () => {
    for (const c of [...PALETTE_LIGHT, ...PALETTE_DARK]) expect(contrast(c, inkOn(c))).toBeGreaterThanOrEqual(4.5);
  });
  it("maps stored light colours to dark steps and passes custom colours through", () => {
    expect(displayColor("#257DE0", "dark")).toBe("#338ced");
    expect(displayColor("#123456", "dark")).toBe("#123456");
  });
  it("hands out unused slots in fixed order", () => {
    expect(nextColor([])).toBe(PALETTE_LIGHT[0]);
    expect(nextColor([PALETTE_LIGHT[0], PALETTE_LIGHT[2]])).toBe(PALETTE_LIGHT[1]);
  });
  it("contrast is 21 for black on white", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 6);
  });
});
