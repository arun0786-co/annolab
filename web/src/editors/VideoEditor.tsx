import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { Annotation, Keyframe } from "../api/types";
import { Icon } from "../components/Icon";
import { useElementSize } from "../hooks/useElementSize";
import { classColor, className, fmtClock, uid } from "../lib/format";
import { clamp, clampRect, handlePoint, HANDLES, hitHandle, normRect, rectContains, resizeRect, type Handle, type Pt, type Rect } from "../lib/geometry";
import { inkOn } from "../lib/palette";
import { interpolate, isKeyframe, removeKeyframe, snapToFrame, sortKeyframes, trackExtent, upsertKeyframe } from "../lib/track";
import { ghostColor, type Ann, type EditorProps } from "./types";

type Drag =
  | { kind: "create"; from: Pt; to: Pt }
  | { kind: "move"; cid: string; grab: Pt; orig: Rect }
  | { kind: "resize"; cid: string; handle: Handle; orig: Rect }
  | { kind: "scrub" }
  | { kind: "seg-new"; t0: number; t1: number }
  | { kind: "seg-edge"; cid: string; side: "start" | "end" };

const ROW_H = 20;
const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

function kfsOf(a: Annotation): Keyframe[] {
  const g = a.geometry as { keyframes?: Keyframe[] } | null;
  return g?.keyframes ?? [];
}

/** Box of a track at t; when t is outside the track, the nearest end box marked as `outside`. */
function boxAt(kfs: Keyframe[], t: number): { r: Rect; outside: boolean } | null {
  const b = interpolate(kfs, t);
  if (b) return { r: { x: b.x, y: b.y, w: b.w, h: b.h }, outside: false };
  if (!kfs.length) return null;
  const k = sortKeyframes(kfs);
  const e = t < k[0].t ? k[0] : k[k.length - 1];
  return { r: { x: e.x, y: e.y, w: e.w, h: e.h }, outside: true };
}

export function VideoEditor(p: EditorProps) {
  const { item, media, schema, anns, selected, select, mode, tool, activeClass, hidden, locked, edit, theme, readOnly } = p;
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const tlRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(stageRef);
  const tl = useElementSize(tlRef);
  const [dims, setDims] = useState({ w: Number(item.meta.width ?? 0), h: Number(item.meta.height ?? 0) });
  const [duration, setDuration] = useState(Number(item.meta.duration ?? 0));
  const fps = Number(item.meta.fps ?? 25) || 25;
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [drag, setDrag] = useState<Drag | null>(null);

  // Fit the video frame into the stage.
  const k = dims.w && width ? Math.min((width - 32) / dims.w, (height - 32) / dims.h) : 1;
  const ox = (width - dims.w * k) / 2;
  const oy = (height - dims.h * k) / 2;
  const S = (x: number, y: number) => ({ x: ox + x * k, y: oy + y * k });
  const toSrc = (e: { clientX: number; clientY: number }) => {
    const b = stageRef.current!.getBoundingClientRect();
    return { x: (e.clientX - b.left - ox) / k, y: (e.clientY - b.top - oy) / k };
  };

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (videoRef.current) setTime(videoRef.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    if (playing) raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed]);

  const seek = (t: number) => {
    const tt = clamp(snapToFrame(t, fps), 0, duration || 0);
    if (videoRef.current) videoRef.current.currentTime = tt;
    setTime(tt);
  };
  // Review: jump to the start of an annotation picked in the side panel.
  useEffect(() => {
    if (p.pickedGhostId == null) return;
    const a = (p.ghosts ?? []).flatMap((g) => g.anns).find((x) => x.id === p.pickedGhostId);
    const g = a?.geometry as { keyframes?: { t: number }[]; start?: number } | null | undefined;
    const t0 = g?.keyframes?.[0]?.t ?? g?.start;
    if (t0 != null) seek(t0);
  }, [p.pickedGhostId]);
  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().then(() => setPlaying(true), () => setPlaying(false));
    else {
      v.pause();
      setPlaying(false);
      seek(v.currentTime);
    }
  };
  const t = snapToFrame(time, fps);
  const frame = Math.round(t * fps);

  const tracks = anns.filter((a) => !hidden.has(a.cid) && a.geometry && "keyframes" in a.geometry);
  const segments = anns.filter((a) => !hidden.has(a.cid) && a.geometry && "start" in a.geometry);
  const [markIn, setMarkIn] = useState<number | null>(null);
  const segTool = tool?.type === "segment" ? tool : null;
  const boxes = useMemo(
    () =>
      tracks
        .map((a) => ({ a, b: boxAt(kfsOf(a), t) }))
        .filter((x): x is { a: Ann; b: { r: Rect; outside: boolean } } => !!x.b && (!x.b.outside || x.a.cid === selected)),
    [tracks, t, selected],
  );

  function setKey(cid: string, r: Rect) {
    edit.patch(cid, (a) => ({
      ...a,
      geometry: { keyframes: upsertKeyframe(kfsOf(a), { t: +t.toFixed(4), x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.w.toFixed(1), h: +r.h.toFixed(1) }) },
    }));
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tg = e.target as HTMLElement;
      if (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.tagName === "SELECT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      let handled = true;
      const step = 1 / fps;
      if (e.key === " ") toggle();
      else if (e.key === "[") seek(t - step);
      else if (e.key === "]") seek(t + step);
      else if (e.key === "{") seek(t - 1);
      else if (e.key === "}") seek(t + 1);
      else if (e.key === "Home") seek(0);
      else if (e.key === "End") seek(duration);
      else if (e.key === "," ) setSpeed((s) => SPEEDS[Math.max(0, SPEEDS.indexOf(s) - 1)]);
      else if (e.key === ".") setSpeed((s) => SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(s) + 1)]);
      else if (e.key === "k" && selected && !readOnly) {
        const a = anns.find((x) => x.cid === selected);
        const b = a && boxAt(kfsOf(a), t);
        if (b) setKey(selected, b.r);
      } else if (e.key === "K" && selected && !readOnly) {
        edit.patch(selected, (a) => {
          const left = removeKeyframe(kfsOf(a), t);
          return left.length ? { ...a, geometry: { keyframes: left } } : a;
        });
      } else if ((e.key === "n" || e.key === "N") && selected) {
        // jump to next / previous keyframe of the selected track
        const a = anns.find((x) => x.cid === selected);
        const ks = a ? sortKeyframes(kfsOf(a)).map((q) => q.t) : [];
        const n = e.key === "n" ? ks.find((q) => q > t + 1e-4) : [...ks].reverse().find((q) => q < t - 1e-4);
        if (n != null) seek(n);
      } else if (e.key === "e" && segTool && activeClass && !readOnly) {
        // Mark in, then mark out: creates a time segment between the two frames.
        if (markIn == null) setMarkIn(t);
        else {
          const s0 = Math.min(markIn, t);
          const s1 = Math.max(markIn, t);
          if (s1 > s0) {
            const cid = uid();
            edit.add({ cid, schema_key: segTool.key, label: activeClass.value, geometry: { start: +s0.toFixed(4), end: +s1.toFixed(4) }, attributes: {}, source: "human" });
            select(cid);
          }
          setMarkIn(null);
        }
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  function onDown(e: RPointerEvent) {
    if (!dims.w) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const q = toSrc(e);
    if (mode === "comment") {
      p.onPin?.({ x: Math.round(q.x), y: Math.round(q.y), t: +t.toFixed(3) });
      return;
    }
    if (readOnly) {
      const g = ghostHit(q);
      if (g) p.onPickGhost?.(g);
      return;
    }
    const tol = 6 / k;
    const sel = boxes.find((x) => x.a.cid === selected);
    if (sel && !locked.has(sel.a.cid)) {
      const h = hitHandle(sel.b.r, q, tol);
      if (h) {
        edit.begin();
        setDrag({ kind: "resize", cid: sel.a.cid, handle: h, orig: sel.b.r });
        return;
      }
    }
    const hits = boxes.filter((x) => !locked.has(x.a.cid) && rectContains(x.b.r, q, tol)).sort((a, b) => a.b.r.w * a.b.r.h - b.b.r.w * b.b.r.h);
    if (mode === "select" || hits.length) {
      if (hits.length && (mode === "select" || hits[0].a.cid === selected)) {
        select(hits[0].a.cid);
        edit.begin();
        setDrag({ kind: "move", cid: hits[0].a.cid, grab: q, orig: hits[0].b.r });
        return;
      }
      if (mode === "select") {
        select(null);
        return;
      }
    }
    if (tool?.type === "track" && activeClass) setDrag({ kind: "create", from: q, to: q });
  }

  function ghostHit(q: Pt): Annotation | null {
    for (const g of p.ghosts ?? [])
      for (const a of g.anns) {
        const b = interpolate(kfsOf(a), t);
        if (b && rectContains(b, q, 4 / k)) return a;
      }
    return null;
  }

  function onMove(e: RPointerEvent) {
    if (!drag) return;
    if (drag.kind === "scrub") return scrubTo(e);
    if (drag.kind === "seg-new") return setDrag({ ...drag, t1: timeAt(e) });
    if (drag.kind === "seg-edge") {
      const tt = timeAt(e);
      edit.patch(drag.cid, (a) => {
        const g = a.geometry as { start: number; end: number };
        const n = drag.side === "start" ? { start: Math.min(tt, g.end - 1 / fps), end: g.end } : { start: g.start, end: Math.max(tt, g.start + 1 / fps) };
        return { ...a, geometry: { start: +n.start.toFixed(4), end: +n.end.toFixed(4) } };
      });
      return;
    }
    const q = toSrc(e);
    if (drag.kind === "create") setDrag({ ...drag, to: { x: clamp(q.x, 0, dims.w), y: clamp(q.y, 0, dims.h) } });
    else if (drag.kind === "move") setKey(drag.cid, clampRect({ ...drag.orig, x: drag.orig.x + q.x - drag.grab.x, y: drag.orig.y + q.y - drag.grab.y }, dims.w, dims.h));
    else if (drag.kind === "resize") setKey(drag.cid, resizeRect(drag.orig, drag.handle, { x: clamp(q.x, 0, dims.w), y: clamp(q.y, 0, dims.h) }));
  }

  function onUp() {
    if (!drag) return;
    if (drag.kind === "create" && tool && activeClass) {
      const r = normRect(drag.from, drag.to);
      if (r.w * k >= 4 && r.h * k >= 4) {
        const cid = uid();
        edit.add({
          cid,
          schema_key: tool.key,
          label: activeClass.value,
          geometry: { keyframes: [{ t: +t.toFixed(4), x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.w.toFixed(1), h: +r.h.toFixed(1) }] },
          attributes: {},
          source: "human",
        });
        select(cid);
      }
    } else if (drag.kind === "seg-new" && segTool && activeClass) {
      const s0 = Math.min(drag.t0, drag.t1);
      const s1 = Math.max(drag.t0, drag.t1);
      if (s1 - s0 >= 1 / fps) {
        const cid = uid();
        edit.add({ cid, schema_key: segTool.key, label: activeClass.value, geometry: { start: +s0.toFixed(4), end: +s1.toFixed(4) }, attributes: {}, source: "human" });
        select(cid);
      }
    } else if (drag.kind === "move" || drag.kind === "resize" || drag.kind === "seg-edge") edit.commit();
    setDrag(null);
  }

  function timeAt(e: { clientX: number }) {
    const b = tlRef.current!.getBoundingClientRect();
    return clamp(snapToFrame(((e.clientX - b.left - LABEL_W) / Math.max(1, b.width - LABEL_W)) * duration, fps), 0, duration);
  }

  function scrubTo(e: { clientX: number }) {
    const b = tlRef.current!.getBoundingClientRect();
    seek(((e.clientX - b.left - LABEL_W) / Math.max(1, b.width - LABEL_W)) * duration);
  }

  // Review rows carry the annotator's name too, so they get a wider label column.
  const LABEL_W = readOnly ? 200 : 140;
  const tx = (tt: number) => LABEL_W + (tt / Math.max(1e-6, duration)) * Math.max(1, tl.width - LABEL_W);
  const rows = readOnly
    ? (p.ghosts ?? []).flatMap((g) => g.anns.map((a) => ({ a, color: g.color, who: g.name })))
    : [...tracks, ...segments].map((a) => ({ a, color: "", who: "" }));

  return (
    <div style={{ display: "grid", gridTemplateRows: "1fr auto auto", height: "100%", minHeight: 0 }}>
      <div
        ref={stageRef}
        className="stage"
        style={{ cursor: mode === "comment" ? "copy" : tool?.type === "track" && mode !== "select" ? "crosshair" : "default" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        role="application"
        aria-label={`Video frame ${frame}. Space plays, brackets step one frame, K sets a keyframe.`}
      >
        <video
          ref={videoRef}
          src={media ?? undefined}
          preload="auto"
          muted
          playsInline
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            setDims({ w: v.videoWidth, h: v.videoHeight });
            setDuration(v.duration);
          }}
          onEnded={() => setPlaying(false)}
          style={{ position: "absolute", left: ox, top: oy, width: dims.w * k, height: dims.h * k, background: "#000" }}
        />
        {!media && <div className="state" style={{ position: "absolute", inset: 0 }}>Loading video</div>}
        {width > 0 && (
          <svg width={width} height={height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {(p.ghosts ?? []).map((g) =>
              g.anns.map((a, i) => {
                const b = interpolate(kfsOf(a), t);
                if (!b) return null;
                const p1 = S(b.x, b.y);
                const picked = a.id != null && a.id === p.pickedGhostId;
                return <rect key={`${g.key}${i}`} x={p1.x} y={p1.y} width={b.w * k} height={b.h * k} fill="none" stroke={ghostColor(g, a, schema, theme, p.ghostColorBy)} strokeWidth={picked ? 3 : 2} strokeDasharray="6 4" />;
              }),
            )}
            {boxes.map(({ a, b }) => {
              const c = classColor(schema, a.schema_key, a.label, theme);
              const p1 = S(b.r.x, b.r.y);
              const sel = a.cid === selected;
              const key = isKeyframe(kfsOf(a), t);
              const name = className(schema, a.schema_key, a.label);
              const label = `${name}${key ? " · key" : b.outside ? " · outside track" : ""}`;
              return (
                <g key={a.cid} opacity={b.outside ? 0.55 : 1}>
                  <rect x={p1.x} y={p1.y} width={b.r.w * k} height={b.r.h * k} fill={c} fillOpacity={sel ? 0.16 : 0.08} stroke={c} strokeWidth={sel ? 2.5 : 2} strokeDasharray={b.outside ? "5 4" : undefined} />
                  <rect x={p1.x} y={p1.y - 17} width={label.length * 6.2 + 10} height={16} rx={3} fill={c} />
                  <text x={p1.x + 5} y={p1.y - 5} fontSize={11} fill={inkOn(c)}>
                    {label}
                  </text>
                  {sel &&
                    HANDLES.map((h) => {
                      const hp = handlePoint(b.r, h);
                      const q = S(hp.x, hp.y);
                      return <rect key={h} x={q.x - 4} y={q.y - 4} width={8} height={8} rx={1} fill="var(--bg)" stroke={c} strokeWidth={1.5} />;
                    })}
                </g>
              );
            })}
            {drag?.kind === "create" && activeClass && (() => {
              const r = normRect(drag.from, drag.to);
              const p1 = S(r.x, r.y);
              const c = classColor(schema, tool!.key, activeClass.value, theme);
              return <rect x={p1.x} y={p1.y} width={r.w * k} height={r.h * k} fill={c} fillOpacity={0.12} stroke={c} strokeWidth={2} strokeDasharray="5 3" />;
            })()}
            {(p.pins ?? []).filter((pin) => pin.x != null && pin.t != null && Math.abs(pin.t! - t) < 0.5).map((pin) => {
              const s = S(pin.x!, pin.y!);
              return (
                <g key={pin.id}>
                  <circle cx={s.x} cy={s.y - 12} r={9} fill="var(--accent-fill)" stroke="var(--bg)" strokeWidth={2} />
                  <text x={s.x} y={s.y - 8} textAnchor="middle" fontSize={11} fontWeight={600} fill="#fff">
                    {pin.index}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
        <div className="stage-hud num">
          <span>frame {frame}</span>
          <span>{fps} fps</span>
          {dims.w > 0 && (
            <span className="faint">
              {dims.w}x{dims.h}
            </span>
          )}
        </div>
      </div>
      {/* timeline */}
      <div
        ref={tlRef}
        className="timeline"
        style={{ borderTop: "1px solid var(--border)", background: "var(--bg)", maxHeight: 180, overflowY: "auto" }}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        <div
          style={{ position: "relative", height: 22, borderBottom: "1px solid var(--border)", cursor: "pointer" }}
          onPointerDown={(e) => {
            (e.currentTarget as Element).setPointerCapture(e.pointerId);
            scrubTo(e);
            setDrag({ kind: "scrub" });
          }}
          role="slider"
          aria-label="Scrubber"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration * fps)}
          aria-valuenow={frame}
          tabIndex={0}
        >
          <span className="faint" style={{ position: "absolute", left: 8, top: 3, fontSize: 11 }}>
            Tracks
          </span>
          {Array.from({ length: Math.max(0, Math.floor(duration)) + 1 }, (_, s) => (
            <span key={s} className="num faint" style={{ position: "absolute", left: tx(s), top: 4, fontSize: "var(--fs-xs)", borderLeft: "1px solid var(--border-strong)", paddingLeft: 3, height: 18 }}>
              {s}s
            </span>
          ))}
        </div>
        {segTool && !readOnly && (
          <div
            style={{ position: "relative", height: ROW_H, borderBottom: "1px solid var(--border)", cursor: "crosshair", background: "var(--bg-sunken)" }}
            onPointerDown={(e) => {
              const b = tlRef.current!.getBoundingClientRect();
              if (e.clientX - b.left < LABEL_W || !activeClass) return;
              (e.currentTarget as Element).setPointerCapture(e.pointerId);
              const t0 = timeAt(e);
              setDrag({ kind: "seg-new", t0, t1: t0 });
            }}
            title="Drag here to add a time segment, or press E at the start and end frames"
          >
            <span className="faint" style={{ position: "absolute", left: 8, top: 2, fontSize: 11 }}>
              + {segTool.name} {markIn != null ? `(in at ${fmtClock(markIn)})` : ""}
            </span>
            {drag?.kind === "seg-new" && activeClass && (
              <span
                style={{
                  position: "absolute",
                  left: tx(Math.min(drag.t0, drag.t1)),
                  width: Math.max(2, Math.abs(tx(drag.t1) - tx(drag.t0))),
                  top: 3,
                  height: ROW_H - 6,
                  borderRadius: 3,
                  background: classColor(schema, segTool.key, activeClass.value, theme),
                  opacity: 0.6,
                }}
              />
            )}
            {markIn != null && <span style={{ position: "absolute", left: tx(markIn) - 1, top: 0, bottom: 0, width: 2, background: "var(--accent)" }} />}
          </div>
        )}
        {rows.length === 0 && (
          <div className="faint" style={{ padding: "6px 8px", fontSize: "var(--fs-sm)" }}>
            {readOnly ? "No tracks from the selected annotators." : "No tracks. Pick the box tool and drag on the frame to start one."}
          </div>
        )}
        {rows.map(({ a, color, who }, i) => {
          const kfs = sortKeyframes(kfsOf(a));
          const seg = a.geometry && "start" in a.geometry ? (a.geometry as { start: number; end: number }) : null;
          const ext = seg ?? trackExtent(kfs);
          const c = classColor(schema, a.schema_key, a.label, theme);
          const cid = (a as Ann).cid;
          const sel = cid != null && cid === selected;
          return (
            <div
              key={cid ?? i}
              style={{ position: "relative", height: ROW_H, borderBottom: "1px solid var(--border)", background: sel ? "var(--accent-soft)" : undefined, cursor: "pointer" }}
              onPointerDown={(e) => {
                if (cid) select(cid);
                else p.onPickGhost?.(a);
                const b = tlRef.current!.getBoundingClientRect();
                if (e.clientX - b.left > LABEL_W) scrubTo(e);
              }}
            >
              <span style={{ position: "absolute", left: 8, top: 2, width: LABEL_W - 18, fontSize: 11 }} className="row" title={`${who ? `${who}: ` : ""}${className(schema, a.schema_key, a.label)}`}>
                {/* One swatch: the annotator in review, the class while labeling (the bar already shows the class). */}
                <i className="swatch" style={{ background: color || c }} />
                <span style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", minWidth: 0 }}>
                  {who ? `${who}: ` : ""}
                  {className(schema, a.schema_key, a.label)}
                </span>
              </span>
              {ext && !seg && <span style={{ position: "absolute", left: tx(ext.start), width: Math.max(2, tx(ext.end) - tx(ext.start)), top: 8, height: 4, borderRadius: 2, background: c }} />}
              {seg && (
                <span style={{ position: "absolute", left: tx(seg.start), width: Math.max(3, tx(seg.end) - tx(seg.start)), top: 4, height: ROW_H - 8, borderRadius: 3, background: c, opacity: 0.85 }}>
                  {sel && !readOnly &&
                    (["start", "end"] as const).map((side) => (
                      <span
                        key={side}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          (e.currentTarget as Element).setPointerCapture(e.pointerId);
                          edit.begin();
                          setDrag({ kind: "seg-edge", cid: cid!, side });
                        }}
                        style={{ position: "absolute", [side === "start" ? "left" : "right"]: -3, top: -2, bottom: -2, width: 6, cursor: "ew-resize", background: "var(--bg)", border: `1.5px solid ${c}`, borderRadius: 2 }}
                      />
                    ))}
                </span>
              )}
              {kfs.map((kf) => (
                <span
                  key={kf.t}
                  title={`keyframe ${fmtClock(kf.t)}`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    if (cid) select(cid);
                    seek(kf.t);
                  }}
                  style={{ position: "absolute", left: tx(kf.t) - 4, top: 6, width: 8, height: 8, transform: "rotate(45deg)", background: "var(--bg)", border: `1.5px solid ${c}` }}
                />
              ))}
            </div>
          );
        })}
        {rows.length > 0 && (
          <div aria-hidden="true" style={{ position: "absolute", left: tx(t), top: 0, bottom: 0, width: 2, marginLeft: -1, background: "var(--bad)", pointerEvents: "none" }} />
        )}
      </div>
      <div className="transport">
        <button className="btn btn-sm btn-icon" onClick={() => seek(t - 1 / fps)} aria-label="Previous frame" title="Previous frame ([)">
          <Icon name="prev" />
        </button>
        <button className="btn btn-sm btn-icon" onClick={toggle} aria-label={playing ? "Pause" : "Play"} title="Play or pause (Space)" disabled={!media}>
          <Icon name={playing ? "pause" : "play"} />
        </button>
        <button className="btn btn-sm btn-icon" onClick={() => seek(t + 1 / fps)} aria-label="Next frame" title="Next frame (])">
          <Icon name="next" />
        </button>
        <span className="num" style={{ minWidth: 150 }}>
          {fmtClock(t)} / {fmtClock(duration)} · f{frame}
        </span>
        <label className="row">
          <span className="faint">Speed</span>
          <select className="select" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={{ height: 24 }}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}x
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        {!readOnly && selected && (
          <>
            <button
              className="btn btn-sm"
              onClick={() => {
                const a = anns.find((x) => x.cid === selected);
                const b = a && boxAt(kfsOf(a), t);
                if (b) setKey(selected, b.r);
              }}
              title="Set keyframe at this frame (K)"
            >
              <Icon name="key" /> Keyframe
            </button>
            <button
              className="btn btn-sm"
              onClick={() =>
                edit.patch(selected, (a) => {
                  const left = removeKeyframe(kfsOf(a), t);
                  return left.length ? { ...a, geometry: { keyframes: left } } : a;
                })
              }
              title="Remove keyframe at this frame (Shift+K)"
            >
              Remove key
            </button>
          </>
        )}
      </div>
    </div>
  );
}
