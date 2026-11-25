import { describe, expect, it } from "vitest";
import type { Schema } from "../api/types";
import { slug, validateSchema } from "./schema";

const ok: Schema = {
  tools: [
    {
      key: "heart",
      type: "segment",
      name: "Heart sounds",
      classes: [
        { value: "S1", name: "S1", color: "#257de0", hotkey: "1" },
        { value: "S2", name: "S2", color: "#f47230", hotkey: "2" },
      ],
      attributes: [{ key: "confidence", type: "select", options: ["low", "high"] }],
    },
  ],
  classifications: [{ key: "quality", name: "Quality", type: "radio", options: ["good", "noisy"] }],
};

describe("validateSchema", () => {
  it("accepts a well-formed schema", () => {
    expect(validateSchema(ok, "audio")).toEqual([]);
  });
  it("rejects tools that do not fit the modality", () => {
    const issues = validateSchema(ok, "image");
    expect(issues.some((i) => i.level === "error" && i.msg.includes("segment tools do not apply"))).toBe(true);
  });
  it("flags duplicate keys, values and hotkeys", () => {
    const bad: Schema = {
      tools: [{ ...ok.tools[0], classes: [ok.tools[0].classes[0], { ...ok.tools[0].classes[0], color: "#00b894" }] }],
      classifications: [{ ...ok.classifications[0], key: "heart" }],
    };
    const msgs = validateSchema(bad, "audio").map((i) => i.msg);
    expect(msgs).toContain('Heart sounds: class value "S1" repeats');
    expect(msgs).toContain("Heart sounds: hotkey 1 repeats");
    expect(msgs).toContain('Key "heart" is used twice');
  });
  it("warns about custom colours with low contrast", () => {
    const pale: Schema = { tools: [{ ...ok.tools[0], classes: [{ value: "x", name: "X", color: "#f4f4f4" }] }], classifications: [] };
    expect(validateSchema(pale, "audio").some((i) => i.level === "warn" && i.msg.includes("hard to see"))).toBe(true);
  });
});

describe("slug", () => {
  it("makes keys", () => {
    expect(slug("Heart sounds (PCG)")).toBe("heart_sounds_pcg");
  });
});
