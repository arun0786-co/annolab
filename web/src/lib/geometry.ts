// Pure 2D geometry used by the image, video and review canvases. Units are source pixels.

export interface Pt {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Poly = [number, number][];

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export function normRect(a: Pt, b: Pt): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** Keep a rect inside [0,W]x[0,H] without changing its size where possible. */
export function clampRect(r: Rect, W: number, H: number): Rect {
  const w = Math.min(r.w, W);
  const h = Math.min(r.h, H);
  return { x: clamp(r.x, 0, W - w), y: clamp(r.y, 0, H - h), w, h };
}

export function rectContains(r: Rect, p: Pt, tol = 0): boolean {
  return p.x >= r.x - tol && p.x <= r.x + r.w + tol && p.y >= r.y - tol && p.y <= r.y + r.h + tol;
}

export function rectArea(r: Rect) {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

/** Intersection over union of two axis-aligned boxes. 0 when either is empty. */
export function iou(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = rectArea(a) + rectArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** Temporal IoU of two [start, end] ranges. */
export function segmentIoU(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
  const la = a.end - a.start;
  const lb = b.end - b.start;
  if (la <= 0 || lb <= 0 || union <= 0) return 0;
  return inter / (la + lb - inter);
}

export function dist(a: Pt, b: Pt) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Even-odd ray casting. Points exactly on an edge may go either way; callers add edge tolerance. */
export function pointInPolygon(poly: Poly, p: Pt): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly: Poly): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a) / 2;
}

export function polygonBounds(poly: Poly): Rect {
  if (!poly.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  for (const [x, y] of poly) {
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x);
    y2 = Math.max(y2, y);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function distToPolygonEdge(poly: Poly, p: Pt): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    best = Math.min(best, distToSegment(p, { x: poly[j][0], y: poly[j][1] }, { x: poly[i][0], y: poly[i][1] }));
  }
  return best;
}

export function handlePoint(r: Rect, h: Handle): Pt {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const x = h.includes("w") ? r.x : h.includes("e") ? r.x + r.w : cx;
  const y = h.startsWith("n") ? r.y : h.startsWith("s") ? r.y + r.h : cy;
  return { x, y };
}

export function hitHandle(r: Rect, p: Pt, tol: number): Handle | null {
  for (const h of HANDLES) if (dist(handlePoint(r, h), p) <= tol) return h;
  return null;
}

/** Move one handle of `r` to `p`. The result is normalised, so dragging past the opposite edge flips. */
export function resizeRect(r: Rect, h: Handle, p: Pt): Rect {
  let x1 = r.x,
    y1 = r.y,
    x2 = r.x + r.w,
    y2 = r.y + r.h;
  if (h.includes("w")) x1 = p.x;
  if (h.includes("e")) x2 = p.x;
  if (h.startsWith("n")) y1 = p.y;
  if (h.startsWith("s")) y2 = p.y;
  return normRect({ x: x1, y: y1 }, { x: x2, y: y2 });
}

export type Shape =
  | { id: string; kind: "bbox"; rect: Rect }
  | { id: string; kind: "polygon"; points: Poly }
  | { id: string; kind: "point"; pt: Pt };

export interface Hit {
  id: string;
  part: "body" | "edge" | "vertex" | Handle;
  vertex?: number;
}

/**
 * Find the shape under `p`. Vertices, handles and points win over edges, edges win over
 * interiors, and among interiors the smallest shape wins so nested boxes stay selectable.
 * `tol` is the pick radius in source pixels (screen radius / zoom).
 */
export function hitTest(shapes: Shape[], p: Pt, tol: number, selectedId?: string | null): Hit | null {
  const sel = shapes.find((s) => s.id === selectedId);
  if (sel?.kind === "bbox") {
    const h = hitHandle(sel.rect, p, tol);
    if (h) return { id: sel.id, part: h };
  }
  if (sel?.kind === "polygon") {
    const vi = sel.points.findIndex(([x, y]) => dist({ x, y }, p) <= tol);
    if (vi >= 0) return { id: sel.id, part: "vertex", vertex: vi };
  }
  let pointHit: { id: string; d: number } | null = null;
  for (const s of shapes) {
    if (s.kind !== "point") continue;
    const d = dist(s.pt, p);
    if (d <= tol && (!pointHit || d < pointHit.d)) pointHit = { id: s.id, d };
  }
  if (pointHit) return { id: pointHit.id, part: "body" };

  let edge: { id: string; d: number } | null = null;
  let body: { id: string; area: number } | null = null;
  for (const s of shapes) {
    if (s.kind === "bbox") {
      const r = s.rect;
      const onEdge =
        rectContains(r, p, tol) &&
        (Math.abs(p.x - r.x) <= tol ||
          Math.abs(p.x - (r.x + r.w)) <= tol ||
          Math.abs(p.y - r.y) <= tol ||
          Math.abs(p.y - (r.y + r.h)) <= tol);
      if (onEdge) {
        const d = Math.min(
          Math.abs(p.x - r.x),
          Math.abs(p.x - (r.x + r.w)),
          Math.abs(p.y - r.y),
          Math.abs(p.y - (r.y + r.h)),
        );
        if (!edge || d < edge.d) edge = { id: s.id, d };
      } else if (rectContains(r, p)) {
        const area = rectArea(r);
        if (!body || area < body.area) body = { id: s.id, area };
      }
    } else if (s.kind === "polygon") {
      const d = distToPolygonEdge(s.points, p);
      if (d <= tol) {
        if (!edge || d < edge.d) edge = { id: s.id, d };
      } else if (pointInPolygon(s.points, p)) {
        const area = polygonArea(s.points);
        if (!body || area < body.area) body = { id: s.id, area };
      }
    }
  }
  if (edge) return { id: edge.id, part: "edge" };
  if (body) return { id: body.id, part: "body" };
  return null;
}

/** View transform: screen = source * k + (tx, ty). */
export interface View {
  k: number;
  tx: number;
  ty: number;
}

export function toSource(v: View, sx: number, sy: number): Pt {
  return { x: (sx - v.tx) / v.k, y: (sy - v.ty) / v.k };
}

/** Zoom by `factor` keeping the source point under (sx, sy) fixed. */
export function zoomAt(v: View, sx: number, sy: number, factor: number, min = 0.05, max = 40): View {
  const k = clamp(v.k * factor, min, max);
  const f = k / v.k;
  return { k, tx: sx - (sx - v.tx) * f, ty: sy - (sy - v.ty) * f };
}

export function fitView(W: number, H: number, vw: number, vh: number, pad = 24): View {
  if (W <= 0 || H <= 0 || vw <= 0 || vh <= 0) return { k: 1, tx: 0, ty: 0 };
  const k = Math.min((vw - pad * 2) / W, (vh - pad * 2) / H);
  return { k, tx: (vw - W * k) / 2, ty: (vh - H * k) / 2 };
}
