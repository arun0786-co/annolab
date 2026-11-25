import { describe, expect, it } from "vitest";
import { fmtSeconds } from "./format";

describe("fmtSeconds", () => {
  it("never shows 60 seconds", () => {
    expect(fmtSeconds(659.6)).toBe("11m 00s");
    expect(fmtSeconds(59.7)).toBe("1m 00s");
    expect(fmtSeconds(9.97)).toBe("10s");
  });
  it("keeps one decimal under ten seconds", () => {
    expect(fmtSeconds(4.25)).toBe("4.3s");
    expect(fmtSeconds(42.4)).toBe("42s");
    expect(fmtSeconds(125)).toBe("2m 05s");
    expect(fmtSeconds(null)).toBe("–");
  });
});
