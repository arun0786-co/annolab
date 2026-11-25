import { describe, expect, it } from "vitest";
import { detectOnsets, fft, peaks, spectrogram } from "./dsp";

describe("fft", () => {
  it("puts a pure tone in its bin", () => {
    const n = 64;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 5 * i) / n);
    fft(re, im);
    const mags = Array.from(re, (r, i) => Math.hypot(r, im[i]));
    expect(mags[5]).toBeCloseTo(n / 2, 6);
    expect(mags[6]).toBeLessThan(1e-6);
  });
});

describe("spectrogram", () => {
  it("peaks at the tone frequency", () => {
    const sr = 4000;
    const s = new Float32Array(sr);
    for (let i = 0; i < s.length; i++) s[i] = Math.sin((2 * Math.PI * 500 * i) / sr);
    const sp = spectrogram(s, 256, 128);
    const f = 3;
    let best = 0;
    for (let b = 1; b < sp.bins; b++) if (sp.db[f * sp.bins + b] > sp.db[f * sp.bins + best]) best = b;
    expect(best).toBe(Math.round((500 * 256) / sr));
  });
});

describe("peaks", () => {
  it("reports min and max per bucket", () => {
    const p = peaks(Float32Array.from([0, 1, -1, 0.5, 0.2, -0.3]), 2);
    expect(Array.from(p.max)).toEqual([1, 0.5]);
    expect(Array.from(p.min)).toEqual([-1, -0.30000001192092896]);
  });
});

describe("detectOnsets", () => {
  it("finds synthetic bursts", () => {
    const sr = 2000;
    const s = new Float32Array(sr * 2);
    for (let i = 0; i < s.length; i++) s[i] = 0.01 * Math.sin(i * 0.3);
    const bursts = [
      [0.2, 0.3],
      [0.9, 1.0],
      [1.5, 1.62],
    ];
    for (const [a, b] of bursts)
      for (let i = Math.floor(a * sr); i < b * sr; i++) s[i] = Math.sin((2 * Math.PI * 60 * i) / sr);
    const ev = detectOnsets(s, sr, { win: 0.01 });
    expect(ev).toHaveLength(3);
    ev.forEach((e, i) => {
      expect(Math.abs(e.start - bursts[i][0])).toBeLessThan(0.02);
      expect(Math.abs(e.end - bursts[i][1])).toBeLessThan(0.02);
    });
  });
});
