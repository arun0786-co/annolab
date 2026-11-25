import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { Annotation } from "../api/types";
import { useElementSize } from "../hooks/useElementSize";
import { classColor, className, uid } from "../lib/format";
import {
  clampRect,
  dist,
  fitView,
  handlePoint,
  HANDLES,
  hitTest,
  normRect,
  resizeRect,
  toSource,
  zoomAt,
  type Handle,
  type Poly,
  type Pt,
  type Rect,
  type Shape,
  type View,
} from "../lib/geometry";
import { inkOn } from "../lib/palette";
import { geomOf, ghostColor, toolFor, type Ann, type EditorProps } from "./types";

const PICK_PX = 6;
const CURSORS: Record<Handle, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };

type Drag =
  | { kind: "pan"; sx: number; sy: number; v: View }
  | { kind: "create"; from: Pt; to: Pt }
  | { kind: "move"; cid: string; from: Pt; orig: Ann }
  | { kind: "resize"; cid: string; handle: Handle }
  | { kind: "vertex"; cid: string; index: number };

function shapeOf(a: Ann | Annotation, id: string): Shape | null {
  const t = a.geometry as Record<string, unknown> | null;
  if (!t) return null;
  if ("points" in t) return { id, kind: "polygon", points: t.points as Poly };
  if ("w" in t) return { id, kind: "bbox", rect: t as unknown as Rect };
  if ("x" in t) return { id, kind: "point", pt: t as unknown as Pt };
  return null;
}

export function useImageSize(src: string | null, meta: { width?: number; height?: number }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(meta.width && meta.height ? { w: meta.width, h: meta.height } : null);
  useEffect(() => {
    if (!src) return;
    const img = new Image();
    img.onload = () => setSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = src;
  }, [src]);
  return size;
}

export function ImageEditor(p: EditorProps) {
  const { item, media, schema, anns, selected, select, mode, tool, activeClass, hidden, locked, edit, theme, readOnly } = p;
  const wrap = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(wrap);
  const size = useImageSize(media, item.meta);
  const [view, setView] = useState<View>({ k: 1, tx: 0, ty: 0 });
  const fitted = useRef(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [poly, setPoly] = useState<Poly | null>(null);
  const [hover, setHover] = useState<Pt | null>(null);
  const [cursor, setCursor] = useState("default");
  const [spaceDown, setSpaceDown] = useState(false);

  const W = size?.w ?? 0;
  const H = size?.h ?? 0;
  const fit = () => size && width && setView(fitView(W, H, width, height));
  useEffect(() => {
    if (!fitted.current && size && width && height) {
      setView(fitView(W, H, width, height));
      fitted.current = true;
    }
  }, [size, width, height, W, H]);
  useEffect(() => {
    fitted.current = false;
  }, [item.id]);
  useEffect(() => setPoly(null), [mode, item.id]);

  const visible = anns.filter((a) => !hidden.has(a.cid));
  const pickable = useMemo(
    () => visible.filter((a) => !locked.has(a.cid)).map((a) => shapeOf(a, a.cid)).filter((s): s is Shape => !!s),
    [visible, locked],
  );
  const S = (x: number, y: number) => ({ x: x * view.k + view.tx, y: y * view.k + view.ty });
  const local = (e: { clientX: number; clientY: number }) => {
    const b = wrap.current!.getBoundingClientRect();
    return { sx: e.clientX - b.left, sy: e.clientY - b.top };
  };
  const src = (e: { clientX: number; clientY: number }) => {
    const { sx, sy } = local(e);
    return toSource(view, sx, sy);
  };
  const clampPt = (q: Pt) => ({ x: Math.max(0, Math.min(W, q.x)), y: Math.max(0, Math.min(H, q.y)) });

  // Keyboard: zoom, nudge, polygon finishing. Capture phase so Enter/Escape close a polygon before the shell sees them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
      if (e.key === " " && !e.repeat) setSpaceDown(true);
      if (poly) {
        if (e.key === "Enter") {
          finishPoly(poly);
          e.preventDefault();
          e.stopImmediatePropagation();
        } else if (e.key === "Escape") {
          setPoly(null);
          e.preventDefault();
          e.stopImmediatePropagation();
        } else if (e.key === "Backspace" || e.key === "Delete") {
          setPoly(poly.length > 1 ? poly.slice(0, -1) : null);
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      const cx = width / 2;
      const cy = height / 2;
      if (e.key === "=" || e.key === "+") setView((v) => zoomAt(v, cx, cy, 1.25));
      else if (e.key === "-") setView((v) => zoomAt(v, cx, cy, 0.8));
      else if (e.key === "0" || e.key === "f") fit();
      else if (selected && !readOnly && e.key.startsWith("Arrow") && !locked.has(selected)) {
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
        const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
        edit.patch(selected, (a) => translate(a, dx, dy));
        e.preventDefault();
        e.stopImmediatePropagation();
      } else return;
      e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => e.key === " " && setSpaceDown(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onUp);
    };
  });

  function finishPoly(pts: Poly) {
    if (pts.length >= 3 && tool && activeClass) {
      const cid = uid();
      edit.add({ cid, schema_key: tool.key, label: activeClass.value, geometry: { points: pts }, attributes: {}, source: "human" });
      select(cid);
    }
    setPoly(null);
  }

  function onWheel(e: React.WheelEvent) {
    const { sx, sy } = local(e);
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) setView((v) => zoomAt(v, sx, sy, Math.exp(-e.deltaY * 0.0015)));
    else setView((v) => ({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }));
  }

  function onDown(e: RPointerEvent) {
    if (!size) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    wrap.current?.focus();
    const { sx, sy } = local(e);
    const q = src(e);
    if (e.button === 1 || e.button === 2 || mode === "pan" || spaceDown) {
      setDrag({ kind: "pan", sx, sy, v: view });
      return;
    }
    const tol = PICK_PX / view.k;
    if (mode === "comment") {
      const gh = ghostHit(q, tol);
      if (gh && p.onPickGhost) p.onPickGhost(gh);
      else p.onPin?.({ x: Math.round(q.x), y: Math.round(q.y) });
      return;
    }
    if (readOnly) {
      const gh = ghostHit(q, tol);
      if (gh) p.onPickGhost?.(gh);
      return;
    }
    if (mode === "select" || !tool) {
      const hit = hitTest(pickable, q, tol, selected);
      if (!hit) {
        select(null);
        setDrag({ kind: "pan", sx, sy, v: view });
        return;
      }
      select(hit.id);
      const a = anns.find((x) => x.cid === hit.id)!;
      edit.begin();
      if (hit.part === "vertex") setDrag({ kind: "vertex", cid: hit.id, index: hit.vertex! });
      else if (hit.part === "body" || hit.part === "edge") setDrag({ kind: "move", cid: hit.id, from: q, orig: a });
      else setDrag({ kind: "resize", cid: hit.id, handle: hit.part });
      return;
    }
    if (!activeClass) return;
    const cq = clampPt(q);
    if (tool.type === "bbox") setDrag({ kind: "create", from: cq, to: cq });
    else if (tool.type === "point") {
      const cid = uid();
      edit.add({ cid, schema_key: tool.key, label: activeClass.value, geometry: { x: cq.x, y: cq.y }, attributes: {}, source: "human" });
      select(cid);
    } else if (tool.type === "polygon") {
      if (!poly) setPoly([[cq.x, cq.y]]);
      else if (poly.length >= 3 && dist({ x: poly[0][0], y: poly[0][1] }, cq) <= tol * 1.5) finishPoly(poly);
      else setPoly([...poly, [cq.x, cq.y]]);
    }
  }

  function ghostHit(q: Pt, tol: number): Annotation | null {
    const all: { a: Annotation; s: Shape }[] = [];
    (p.ghosts ?? []).forEach((g, gi) =>
      g.anns.forEach((a, ai) => {
        const s = shapeOf(a, `${gi}:${ai}`);
        if (s) all.push({ a, s });
      }),
    );
    const hit = hitTest(all.map((x) => x.s), q, tol);
    return hit ? all.find((x) => x.s.id === hit.id)!.a : null;
  }

  function onMove(e: RPointerEvent) {
    const q = src(e);
    setHover(q);
    if (!drag) {
      if (mode === "select" && !readOnly) {
        const hit = hitTest(pickable, q, PICK_PX / view.k, selected);
        setCursor(!hit ? "default" : hit.part === "body" || hit.part === "edge" ? "move" : hit.part === "vertex" ? "pointer" : CURSORS[hit.part as Handle]);
      } else setCursor(mode === "pan" || spaceDown ? "grab" : mode === "comment" ? "copy" : "crosshair");
      return;
    }
    if (drag.kind === "pan") {
      const { sx, sy } = local(e);
      setView({ ...drag.v, tx: drag.v.tx + sx - drag.sx, ty: drag.v.ty + sy - drag.sy });
    } else if (drag.kind === "create") setDrag({ ...drag, to: clampPt(q) });
    else if (drag.kind === "move") {
      const dx = q.x - drag.from.x;
      const dy = q.y - drag.from.y;
      edit.patch(drag.cid, () => clampAnn(translate(drag.orig, dx, dy), W, H));
    } else if (drag.kind === "resize") {
      edit.patch(drag.cid, (a) => ({ ...a, geometry: resizeRect(geomOf<Rect>(a), drag.handle, clampPt(q)) }));
    } else if (drag.kind === "vertex") {
      const cq = clampPt(q);
      edit.patch(drag.cid, (a) => {
        const pts = [...geomOf<{ points: Poly }>(a).points];
        pts[drag.index] = [cq.x, cq.y];
        return { ...a, geometry: { points: pts } };
      });
    }
  }

  function onUp() {
    if (!drag) return;
    if (drag.kind === "create" && tool && activeClass) {
      const r = normRect(drag.from, drag.to);
      if (r.w * view.k >= 4 && r.h * view.k >= 4) {
        const cid = uid();
        edit.add({ cid, schema_key: tool.key, label: activeClass.value, geometry: round(r), attributes: {}, source: "human" });
        select(cid);
      }
    } else if (drag.kind === "move" || drag.kind === "resize" || drag.kind === "vertex") {
      edit.patch(drag.cid, (a) => ({ ...a, geometry: roundGeom(a.geometry) }));
      edit.commit();
    }
    setDrag(null);
  }

  const k = view.k;
  return (
    <div
      ref={wrap}
      className="stage"
      tabIndex={0}
      aria-label={`Image canvas, ${item.filename}. ${anns.length} annotations.`}
      style={{ cursor: drag?.kind === "pan" ? "grabbing" : cursor, height: "100%" }}
      onWheel={onWheel}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={() => poly && finishPoly(poly)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {width > 0 && (
        <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
          {media && size && (
            <image href={media} x={view.tx} y={view.ty} width={W * k} height={H * k} preserveAspectRatio="none" style={{ imageRendering: k > 3 ? "pixelated" : "auto" }} />
          )}
          {size && <rect x={view.tx} y={view.ty} width={W * k} height={H * k} fill="none" stroke="var(--border-strong)" />}
          {(p.ghosts ?? []).map((g) =>
            g.anns.map((a, i) => (
              <ShapeView key={`${g.key}:${i}`} a={a} S={S} k={k} color={ghostColor(g, a, schema, theme, p.ghostColorBy)} label={className(schema, a.schema_key, a.label)} ghost picked={a.id != null && a.id === p.pickedGhostId} />
            )),
          )}
          {visible.map((a) => {
            const c = classColor(schema, a.schema_key, a.label, theme);
            const toolName = toolFor(schema, a.schema_key)?.name;
            return (
              <ShapeView
                key={a.cid}
                a={a}
                S={S}
                k={k}
                color={c}
                label={className(schema, a.schema_key, a.label)}
                title={toolName}
                selected={a.cid === selected}
                proposal={a.source === "model"}
              />
            );
          })}
          {drag?.kind === "create" && activeClass && (
            <DraftRect r={normRect(drag.from, drag.to)} S={S} k={k} color={classColor(schema, tool!.key, activeClass.value, theme)} />
          )}
          {poly && activeClass && (
            <g pointerEvents="none">
              <polyline
                points={[...poly, ...(hover ? [[hover.x, hover.y] as [number, number]] : [])].map(([x, y]) => `${S(x, y).x},${S(x, y).y}`).join(" ")}
                fill="none"
                stroke={classColor(schema, tool!.key, activeClass.value, theme)}
                strokeWidth={2}
                strokeDasharray="4 3"
              />
              {poly.map(([x, y], i) => (
                <circle key={i} cx={S(x, y).x} cy={S(x, y).y} r={i === 0 ? 5 : 3.5} fill="var(--bg)" stroke={classColor(schema, tool!.key, activeClass.value, theme)} strokeWidth={2} />
              ))}
            </g>
          )}
          {(p.pins ?? []).filter((pin) => pin.x != null && pin.y != null).map((pin) => {
            const s = S(pin.x!, pin.y!);
            return (
              <g key={pin.id} pointerEvents="none">
                <circle cx={s.x} cy={s.y - 12} r={9} fill="var(--accent-fill)" stroke="var(--bg)" strokeWidth={2} />
                <text x={s.x} y={s.y - 8} textAnchor="middle" fontSize={11} fontWeight={600} fill="#fff">
                  {pin.index}
                </text>
                <line x1={s.x} y1={s.y - 3} x2={s.x} y2={s.y} stroke="var(--accent)" strokeWidth={2} />
              </g>
            );
          })}
        </svg>
      )}
      {!media && <div className="state" style={{ position: "absolute", inset: 0 }}>Loading image</div>}
      <div className="stage-hud num" aria-hidden="true">
        <span>{Math.round(k * 100)}%</span>
        {hover && size && (
          <span>
            {Math.round(hover.x)}, {Math.round(hover.y)}
          </span>
        )}
        {size && (
          <span className="faint">
            {W}x{H}
          </span>
        )}
        {poly && <span>{poly.length} points · Enter or click first point to close · Esc cancels</span>}
      </div>
      <div className="stage-hud" style={{ left: "auto", right: 8 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setView((v) => zoomAt(v, width / 2, height / 2, 0.8))} aria-label="Zoom out">
          -
        </button>
        <button className="btn btn-ghost btn-sm" onClick={fit} aria-label="Fit to screen">
          Fit
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setView((v) => zoomAt(v, width / 2, height / 2, 1.25))} aria-label="Zoom in">
          +
        </button>
      </div>
    </div>
  );
}

function round(r: Rect): Rect {
  return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.w.toFixed(1), h: +r.h.toFixed(1) };
}

function roundGeom(g: Ann["geometry"]): Ann["geometry"] {
  if (!g) return g;
  if ("points" in g) return { points: g.points.map(([x, y]) => [+x.toFixed(1), +y.toFixed(1)] as [number, number]) };
  if ("w" in g) return round(g);
  if ("x" in g) return { x: +g.x.toFixed(1), y: +g.y.toFixed(1) };
  return g;
}

function translate(a: Ann, dx: number, dy: number): Ann {
  const g = a.geometry;
  if (!g) return a;
  if ("points" in g) return { ...a, geometry: { points: g.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) } };
  if ("w" in g) return { ...a, geometry: { ...g, x: g.x + dx, y: g.y + dy } };
  if ("x" in g) return { ...a, geometry: { x: g.x + dx, y: g.y + dy } };
  return a;
}

function clampAnn(a: Ann, W: number, H: number): Ann {
  const g = a.geometry;
  if (!g) return a;
  if ("w" in g) return { ...a, geometry: clampRect(g, W, H) };
  if ("points" in g) {
    const xs = g.points.map((p) => p[0]);
    const ys = g.points.map((p) => p[1]);
    const dx = Math.max(0, -Math.min(...xs)) - Math.max(0, Math.max(...xs) - W);
    const dy = Math.max(0, -Math.min(...ys)) - Math.max(0, Math.max(...ys) - H);
    return dx || dy ? translate(a, dx, dy) : a;
  }
  if ("x" in g) return { ...a, geometry: { x: Math.max(0, Math.min(W, g.x)), y: Math.max(0, Math.min(H, g.y)) } };
  return a;
}

function DraftRect({ r, S, color }: { r: Rect; S: (x: number, y: number) => Pt; k: number; color: string }) {
  const a = S(r.x, r.y);
  const b = S(r.x + r.w, r.y + r.h);
  return <rect x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y} fill={color} fillOpacity={0.12} stroke={color} strokeWidth={2} strokeDasharray="5 3" pointerEvents="none" />;
}

function ShapeView({
  a,
  S,
  color,
  label,
  title,
  selected,
  proposal,
  ghost,
  picked,
}: {
  a: Annotation;
  S: (x: number, y: number) => Pt;
  k: number;
  color: string;
  label: string;
  title?: string;
  selected?: boolean;
  proposal?: boolean;
  ghost?: boolean;
  picked?: boolean;
}) {
  const g = a.geometry as Record<string, unknown> | null;
  if (!g) return null;
  const sw = selected || picked ? 2.5 : 1.75;
  const dash = proposal || ghost ? "6 4" : undefined;
  const fillOp = selected ? 0.18 : ghost ? 0.04 : 0.1;
  let body: JSX.Element | null = null;
  let tag: Pt | null = null;
  if ("points" in g) {
    const pts = (g.points as Poly).map(([x, y]) => S(x, y));
    body = (
      <>
        <polygon points={pts.map((q) => `${q.x},${q.y}`).join(" ")} fill={color} fillOpacity={fillOp} stroke={color} strokeWidth={sw} strokeDasharray={dash} />
        {selected && pts.map((q, i) => <rect key={i} x={q.x - 4} y={q.y - 4} width={8} height={8} rx={1} fill="var(--bg)" stroke={color} strokeWidth={1.5} />)}
      </>
    );
    tag = pts.reduce((m, q) => (q.y < m.y ? q : m), pts[0]);
  } else if ("w" in g) {
    const r = g as unknown as Rect;
    const p1 = S(r.x, r.y);
    const p2 = S(r.x + r.w, r.y + r.h);
    body = (
      <>
        <rect x={p1.x} y={p1.y} width={p2.x - p1.x} height={p2.y - p1.y} fill={color} fillOpacity={fillOp} stroke={color} strokeWidth={sw} strokeDasharray={dash} />
        {selected &&
          HANDLES.map((h) => {
            const hp = handlePoint(r, h);
            const q = S(hp.x, hp.y);
            return <rect key={h} x={q.x - 4} y={q.y - 4} width={8} height={8} rx={1} fill="var(--bg)" stroke={color} strokeWidth={1.5} />;
          })}
      </>
    );
    tag = p1;
  } else if ("x" in g) {
    const q = S(g.x as number, g.y as number);
    body = (
      <>
        <circle cx={q.x} cy={q.y} r={selected ? 7 : 5} fill={color} stroke="var(--bg)" strokeWidth={2} />
      </>
    );
    tag = { x: q.x + 8, y: q.y - 4 };
  }
  const text = proposal ? `${label} (proposal)` : label;
  const tw = text.length * 6.2 + 10;
  return (
    <g pointerEvents="none">
      {title && <title>{`${title}: ${label}`}</title>}
      {body}
      {tag && !ghost && (
        <g>
          <rect x={tag.x} y={tag.y - 17} width={tw} height={16} rx={3} fill={color} />
          <text x={tag.x + 5} y={tag.y - 5} fontSize={11} fontWeight={500} fill={inkOn(toHex(color))}>
            {text}
          </text>
        </g>
      )}
    </g>
  );
}

function toHex(c: string) {
  return c.startsWith("#") ? c : "#6b7178";
}
