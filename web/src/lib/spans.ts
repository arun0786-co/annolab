// Text spans: lane assignment for overlapping spans and splitting text into render pieces.

export interface SpanLike {
  id: string;
  start: number;
  end: number;
}

/**
 * Greedy interval colouring. Spans sorted by start (longer first on ties) take the lowest lane
 * whose previous span has ended. Overlapping spans never share a lane, and the number of lanes
 * equals the maximum overlap depth.
 */
export function assignLanes(spans: SpanLike[]): Map<string, number> {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const laneEnd: number[] = [];
  const out = new Map<string, number>();
  for (const s of sorted) {
    let lane = laneEnd.findIndex((e) => e <= s.start);
    if (lane < 0) {
      lane = laneEnd.length;
      laneEnd.push(s.end);
    } else laneEnd[lane] = s.end;
    out.set(s.id, lane);
  }
  return out;
}

export interface Piece {
  start: number;
  end: number;
  ids: string[];
}

/** Cut [0, length) at every span boundary; each piece lists the spans covering it. */
export function pieces(length: number, spans: SpanLike[]): Piece[] {
  const cuts = new Set<number>([0, length]);
  for (const s of spans) {
    cuts.add(Math.max(0, Math.min(length, s.start)));
    cuts.add(Math.max(0, Math.min(length, s.end)));
  }
  const xs = [...cuts].sort((a, b) => a - b);
  const out: Piece[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i];
    const b = xs[i + 1];
    if (b <= a) continue;
    out.push({ start: a, end: b, ids: spans.filter((s) => s.start <= a && s.end >= b).map((s) => s.id) });
  }
  return out;
}

/** Expand a character range outward to word boundaries and trim surrounding whitespace. */
export function snapToWords(text: string, start: number, end: number): { start: number; end: number } {
  let s = Math.max(0, Math.min(start, end));
  let e = Math.min(text.length, Math.max(start, end));
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  while (s > 0 && /\w/.test(text[s - 1]) && /\w/.test(text[s])) s--;
  while (e < text.length && /\w/.test(text[e]) && /\w/.test(text[e - 1])) e++;
  return { start: s, end: e };
}
