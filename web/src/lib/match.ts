// Client-side matching of two annotators' sets, used for the review diff when the server
// consensus endpoint is unavailable, and to explain which shapes disagree.
import type { Annotation, Keyframe } from "../api/types";
import { iou, polygonBounds, segmentIoU, type Poly, type Rect } from "./geometry";
import { interpolate, trackExtent } from "./track";

export function similarity(a: Annotation, b: Annotation): number {
  const ga = a.geometry as Record<string, unknown> | null;
  const gb = b.geometry as Record<string, unknown> | null;
  if (!ga || !gb) return a.schema_key === b.schema_key && a.label === b.label ? 1 : 0;
  if ("keyframes" in ga && "keyframes" in gb) return trackIoU(ga.keyframes as Keyframe[], gb.keyframes as Keyframe[]);
  if ("start" in ga && "start" in gb) return segmentIoU(ga as { start: number; end: number }, gb as { start: number; end: number });
  if ("points" in ga && "points" in gb) return iou(polygonBounds(ga.points as Poly), polygonBounds(gb.points as Poly));
  if ("w" in ga && "w" in gb) return iou(ga as unknown as Rect, gb as unknown as Rect);
  if ("x" in ga && "x" in gb) {
    const d = Math.hypot((ga.x as number) - (gb.x as number), (ga.y as number) - (gb.y as number));
    return Math.max(0, 1 - d / 20);
  }
  return 0;
}

/** Mean per-frame IoU over the union of both tracks' extents, sampled at `step` seconds. */
export function trackIoU(a: Keyframe[], b: Keyframe[], step = 0.1): number {
  const ea = trackExtent(a);
  const eb = trackExtent(b);
  if (!ea || !eb) return 0;
  const s = Math.min(ea.start, eb.start);
  const e = Math.max(ea.end, eb.end);
  let sum = 0;
  let n = 0;
  for (let t = s; t <= e + 1e-9; t += step) {
    const ba = interpolate(a, t);
    const bb = interpolate(b, t);
    sum += ba && bb ? iou(ba, bb) : 0;
    n++;
  }
  return n ? sum / n : 0;
}

export interface Match {
  i: number;
  j: number;
  score: number;
  sameLabel: boolean;
}

/** Greedy one-to-one matching by descending similarity, within the same schema key. */
export function matchSets(A: Annotation[], B: Annotation[], threshold = 0.5): { pairs: Match[]; onlyA: number[]; onlyB: number[] } {
  const cands: Match[] = [];
  A.forEach((a, i) =>
    B.forEach((b, j) => {
      if (a.schema_key !== b.schema_key) return;
      const s = similarity(a, b);
      if (s >= threshold) cands.push({ i, j, score: s, sameLabel: a.label === b.label });
    }),
  );
  cands.sort((x, y) => y.score - x.score);
  const ua = new Set<number>();
  const ub = new Set<number>();
  const pairs: Match[] = [];
  for (const c of cands) {
    if (ua.has(c.i) || ub.has(c.j)) continue;
    ua.add(c.i);
    ub.add(c.j);
    pairs.push(c);
  }
  return {
    pairs,
    onlyA: A.map((_, i) => i).filter((i) => !ua.has(i)),
    onlyB: B.map((_, j) => j).filter((j) => !ub.has(j)),
  };
}
