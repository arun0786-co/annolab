import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { api } from "../api/client";
import type { Annotation } from "../api/types";
import { useElementSize } from "../hooks/useElementSize";
import { detectOnsets, peaks, spectrogram, type Spectrogram } from "../lib/dsp";
import { classColor, className, fmtClock, uid } from "../lib/format";
import { clamp } from "../lib/geometry";
import { inkOn } from "../lib/palette";
import { assignLanes } from "../lib/spans";
import { Icon } from "../components/Icon";
import type { Ann, EditorProps } from "./types";

type Seg = { start: number; end: number };
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const SNAP_PX = 6;
const LANE_H = 22;

let ctx: AudioContext | null = null;

export function useDecodedAudio(url: string | null) {
  const [buf, setBuf] = useState<AudioBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBuf(null);
    setError(null);
    if (!url) return;
    let live = true;
    (async () => {
      try {
        ctx ??= new AudioContext();
        const b = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
        if (live) setBuf(b);
      } catch (e) {
        if (live) setError((e as Error).message || "Could not decode audio");
      }
    })();
    return () => {
      live = false;
    };
  }, [url]);
  return { buf, error };
}

/** Sequential ramp for the spectrogram: surface -> accent blue -> high-contrast ink. */
function ramp(theme: "light" | "dark") {
  const stops: [number, number, number][] = theme === "dark" ? [[12, 13, 14], [37, 125, 224], [235, 242, 255]] : [[255, 255, 255], [37, 125, 224], [10, 30, 70]];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const [a, b, u] = t < 0.5 ? [stops[0], stops[1], t * 2] : [stops[1], stops[2], (t - 0.5) * 2];
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = a[c] + (b[c] - a[c]) * u;
  }
  return lut;
}

function specImage(sp: Spectrogram, theme: "light" | "dark", maxBin: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = sp.frames;
  c.height = maxBin;
  const g = c.getContext("2d")!;
  const img = g.createImageData(sp.frames, maxBin);
  const lut = ramp(theme);
  // Map the median bin level (mostly background noise) to the surface and the 99.7th percentile to full ink.
  const sample: number[] = [];
  const stride = Math.max(1, Math.floor((sp.frames * maxBin) / 20000));
  for (let f = 0; f < sp.frames; f++) for (let b = 0; b < maxBin; b += stride) sample.push(sp.db[f * sp.bins + b]);
  sample.sort((a, b) => a - b);
  const floor = sample[Math.floor(sample.length * 0.5)] ?? sp.minDb;
  const ceil = Math.max(floor + 1, sample[Math.floor(sample.length * 0.997)] ?? sp.maxDb);
  for (let f = 0; f < sp.frames; f++)
    for (let b = 0; b < maxBin; b++) {
      const v = Math.round(clamp((sp.db[f * sp.bins + b] - floor) / (ceil - floor), 0, 1) * 255);
      const o = ((maxBin - 1 - b) * sp.frames + f) * 4;
      img.data[o] = lut[v * 3];
      img.data[o + 1] = lut[v * 3 + 1];
      img.data[o + 2] = lut[v * 3 + 2];
      img.data[o + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return c;
}

type Drag =
  | { kind: "create"; t0: number; t1: number }
  | { kind: "move"; cid: string; grab: number; orig: Seg }
  | { kind: "edge"; cid: string; side: "start" | "end" }
  | { kind: "seek" }
  | { kind: "pan"; x0: number; v0: number };

export function AudioEditor(p: EditorProps) {
  const { item, media, schema, anns, selected, select, mode, tool, activeClass, hidden, locked, edit, theme, readOnly } = p;
  const { buf, error } = useDecodedAudio(media);
  const audioRef = useRef<HTMLAudioElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { width, height } = useElementSize(plotRef);
  const duration = buf?.duration ?? Number(item.meta.duration ?? 0);
  const [view, setView] = useState({ t0: 0, span: 0 });
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [display, setDisplay] = useState<"wave" | "spec">("wave");
  const [spec, setSpec] = useState<Spectrogram | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const span = view.span || duration || 1;

  useEffect(() => setView({ t0: 0, span: duration }), [duration, item.id]);
  useEffect(() => {
    setSpec(null);
  }, [buf]);
  useEffect(() => {
    if (display !== "spec" || !buf || spec) return;
    const id = setTimeout(() => {
      const s = buf.getChannelData(0);
      const hop = Math.max(64, Math.ceil(s.length / 3000));
      setSpec(spectrogram(s, 512, hop));
    }, 0);
    return () => clearTimeout(id);
  }, [display, buf, spec]);
  const specCanvas = useMemo(() => {
    if (!spec || !buf) return null;
    const nyq = buf.sampleRate / 2;
    // Heart and lung sounds live below ~1 kHz; show up to 1 kHz when the rate allows.
    const maxBin = Math.min(spec.bins, Math.ceil((Math.min(nyq, 1000) / nyq) * spec.bins));
    return { img: specImage(spec, theme, maxBin), maxHz: (maxBin / spec.bins) * nyq };
  }, [spec, buf, theme]);

  const x2t = useCallback((x: number) => view.t0 + (x / Math.max(1, width)) * span, [view.t0, span, width]);
  const t2x = useCallback((t: number) => ((t - view.t0) / span) * width, [view.t0, span, width]);

  // Draw waveform or spectrogram for the visible window.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    const g = c.getContext("2d")!;
    const css = getComputedStyle(c);
    g.clearRect(0, 0, c.width, c.height);
    if (!buf) return;
    if (display === "spec" && specCanvas && spec) {
      const f0 = (view.t0 * buf.sampleRate) / spec.hop;
      const f1 = ((view.t0 + span) * buf.sampleRate) / spec.hop;
      g.imageSmoothingEnabled = true;
      g.drawImage(specCanvas.img, f0, 0, Math.max(1, f1 - f0), specCanvas.img.height, 0, 0, c.width, c.height);
      return;
    }
    const s = buf.getChannelData(0);
    const a = Math.floor(view.t0 * buf.sampleRate);
    const b = Math.ceil((view.t0 + span) * buf.sampleRate);
    const pk = peaks(s, c.width, clamp(a, 0, s.length), clamp(b, 0, s.length));
    let amp = 1e-6;
    for (let i = 0; i < s.length; i += 7) amp = Math.max(amp, Math.abs(s[i]));
    const mid = c.height / 2;
    g.strokeStyle = css.getPropertyValue("--border");
    g.beginPath();
    g.moveTo(0, mid);
    g.lineTo(c.width, mid);
    g.stroke();
    g.fillStyle = css.color;
    for (let i = 0; i < pk.max.length; i++) {
      const y1 = mid - (pk.max[i] / amp) * mid * 0.92;
      const y2 = mid - (pk.min[i] / amp) * mid * 0.92;
      g.fillRect(i, y1, 1, Math.max(1, y2 - y1));
    }
  }, [buf, width, height, view.t0, span, display, specCanvas, spec, theme]);

  // Playback clock.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const a = audioRef.current;
      if (a) setTime(a.currentTime);
      raf = requestAnimationFrame(tick);
    };
    if (playing) raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);
  // Keep the playhead visible while playing.
  useEffect(() => {
    if (playing && (time > view.t0 + span || time < view.t0)) setView((v) => ({ ...v, t0: clamp(time - span * 0.1, 0, Math.max(0, duration - span)) }));
  }, [time, playing, span, view.t0, duration]);

  const seek = (t: number) => {
    const a = audioRef.current;
    const tt = clamp(t, 0, duration);
    if (a) a.currentTime = tt;
    setTime(tt);
  };
  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().then(() => setPlaying(true), () => setPlaying(false));
    else {
      a.pause();
      setPlaying(false);
    }
  };
  const zoom = (f: number, around = time) => {
    const ns = clamp(span * f, 0.05, duration || 1);
    const u = (around - view.t0) / span;
    setView({ span: ns, t0: clamp(around - u * ns, 0, Math.max(0, duration - ns)) });
  };

  const visible = anns.filter((a) => !hidden.has(a.cid) && a.geometry && "start" in a.geometry);
  const lanes = useMemo(
    () => assignLanes(visible.map((a) => ({ id: a.cid, ...(a.geometry as Seg) }))),
    [visible],
  );
  const laneCount = Math.max(1, ...[...lanes.values()].map((l) => l + 1));
  const proposals = visible.filter((a) => a.source === "model");

  /** Snap a time to nearby segment edges (proposals first) within SNAP_PX. */
  const snap = (t: number, except?: string) => {
    const tol = (SNAP_PX / Math.max(1, width)) * span;
    let best = t;
    let bd = tol;
    const cands = [...proposals, ...visible].filter((a) => a.cid !== except);
    for (const a of cands) {
      const g = a.geometry as Seg;
      for (const e of [g.start, g.end]) {
        const d = Math.abs(e - t);
        if (d < bd) {
          bd = d;
          best = e;
        }
      }
    }
    return best;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      let handled = true;
      if (k === " ") toggle();
      else if (k === "[") seek(time - (e.shiftKey ? 1 : 0.1));
      else if (k === "]") seek(time + (e.shiftKey ? 1 : 0.1));
      else if (k === "{") seek(time - 1);
      else if (k === "}") seek(time + 1);
      else if (k === "=" || k === "+") zoom(0.66);
      else if (k === "-") zoom(1.5);
      else if (k === "0") setView({ t0: 0, span: duration });
      else if (k === "Home") seek(0);
      else if (k === "End") seek(duration);
      else if (k === ",") setSpeed((s) => SPEEDS[Math.max(0, SPEEDS.indexOf(s) - 1)]);
      else if (k === ".") setSpeed((s) => SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(s) + 1)]);
      else if (k === "w") setDisplay((d) => (d === "wave" ? "spec" : "wave"));
      else if (k === "m" && !readOnly) propose();
      else if (k === "a" && !readOnly && selected) accept([selected]);
      else if (k === "A" && !readOnly) accept(proposals.map((a) => a.cid));
      else if ((k === "n" || k === "N") && visible.length) {
        // N / Shift+N, like keyframes in the video editor. Tab is left to the browser.
        const sorted = [...visible].sort((x, y) => (x.geometry as Seg).start - (y.geometry as Seg).start);
        const i = sorted.findIndex((a) => a.cid === selected);
        const n = sorted[i < 0 ? (k === "N" ? sorted.length - 1 : 0) : (i + (k === "N" ? sorted.length - 1 : 1)) % sorted.length];
        select(n.cid);
        seek((n.geometry as Seg).start);
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  function accept(cids: string[]) {
    if (!cids.length) return;
    const set = new Set(cids);
    edit.setAll((xs) => xs.map((a) => (set.has(a.cid) && a.source === "model" ? { ...a, source: "human" } : a)));
  }

  async function propose() {
    if (!buf) return;
    setBusy("Finding events");
    const segTool = schema.tools.find((t) => t.type === "segment");
    let props: Annotation[] = [];
    try {
      props = await api.prelabel(item.id);
    } catch {
      // Server pre-labeller unavailable: fall back to the same energy rule in the browser.
      const ev = detectOnsets(buf.getChannelData(0), buf.sampleRate);
      const classes = segTool?.classes ?? [];
      props = ev.map((g, i) => ({
        schema_key: segTool?.key ?? "segment",
        label: classes.length ? classes[i % Math.min(2, classes.length)].value : null,
        geometry: { start: +g.start.toFixed(3), end: +g.end.toFixed(3) },
        attributes: {},
        source: "model",
      }));
    }
    edit.setAll((xs) => [
      ...xs.filter((a) => a.source !== "model"),
      ...props.map((a) => ({ ...a, cid: uid("m"), source: "model" as const, attributes: a.attributes ?? {} })),
    ]);
    setBusy(`${props.length} proposals`);
    setTimeout(() => setBusy(null), 2500);
  }

  function localX(e: { clientX: number }) {
    return e.clientX - plotRef.current!.getBoundingClientRect().left;
  }

  function onPlotDown(e: RPointerEvent) {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const x = localX(e);
    const t = x2t(x);
    if (e.button === 1 || e.altKey) return setDrag({ kind: "pan", x0: x, v0: view.t0 });
    if (mode === "comment") {
      p.onPin?.({ t: +t.toFixed(3) });
      return;
    }
    if (readOnly || mode === "select" || !tool || tool.type !== "segment" || !activeClass) {
      seek(t);
      setDrag({ kind: "seek" });
      if (!readOnly) select(null);
      return;
    }
    const st = snap(t);
    setDrag({ kind: "create", t0: st, t1: st });
  }

  function onSegDown(e: RPointerEvent, a: Ann, part: "body" | "start" | "end") {
    e.stopPropagation();
    if (mode === "comment") {
      p.onPin?.({ t: +x2t(localX(e)).toFixed(3) });
      return;
    }
    select(a.cid);
    if (readOnly || locked.has(a.cid)) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    edit.begin();
    if (part === "body") setDrag({ kind: "move", cid: a.cid, grab: x2t(localX(e)), orig: a.geometry as Seg });
    else setDrag({ kind: "edge", cid: a.cid, side: part });
  }

  function onMove(e: RPointerEvent) {
    if (!drag) return;
    const x = localX(e);
    const t = clamp(x2t(x), 0, duration);
    if (drag.kind === "seek") seek(t);
    else if (drag.kind === "pan") setView((v) => ({ ...v, t0: clamp(drag.v0 - ((x - drag.x0) / width) * span, 0, Math.max(0, duration - span)) }));
    else if (drag.kind === "create") setDrag({ ...drag, t1: snap(t) });
    else if (drag.kind === "move") {
      const len = drag.orig.end - drag.orig.start;
      let s = clamp(drag.orig.start + (t - drag.grab), 0, duration - len);
      const ss = snap(s, drag.cid);
      if (ss !== s) s = ss;
      else {
        const se = snap(s + len, drag.cid);
        if (se !== s + len) s = se - len;
      }
      edit.patch(drag.cid, (a) => ({ ...a, geometry: { start: +s.toFixed(3), end: +(s + len).toFixed(3) } }));
    } else if (drag.kind === "edge") {
      const st = snap(t, drag.cid);
      edit.patch(drag.cid, (a) => {
        const g = a.geometry as Seg;
        const n = drag.side === "start" ? { start: Math.min(st, g.end - 0.005), end: g.end } : { start: g.start, end: Math.max(st, g.start + 0.005) };
        return { ...a, geometry: { start: +n.start.toFixed(3), end: +n.end.toFixed(3) } };
      });
    }
  }

  function onUp() {
    if (!drag) return;
    if (drag.kind === "create" && tool && activeClass) {
      const s = Math.min(drag.t0, drag.t1);
      const en = Math.max(drag.t0, drag.t1);
      if (t2x(en) - t2x(s) >= 3) {
        const cid = uid();
        edit.add({ cid, schema_key: tool.key, label: activeClass.value, geometry: { start: +s.toFixed(3), end: +en.toFixed(3) }, attributes: {}, source: "human" });
        select(cid);
      }
    } else if (drag.kind === "move" || drag.kind === "edge") edit.commit();
    setDrag(null);
  }

  function onWheel(e: React.WheelEvent) {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) setView((v) => ({ ...v, t0: clamp(v.t0 + (e.deltaX / width) * span, 0, Math.max(0, duration - span)) }));
    else zoom(Math.exp(e.deltaY * 0.002), x2t(localX(e)));
  }

  const ticks = useMemo(() => {
    const target = span / Math.max(1, width / 90);
    const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60];
    const step = steps.find((s) => s >= target) ?? 60;
    const out: number[] = [];
    for (let t = Math.ceil(view.t0 / step) * step; t <= view.t0 + span + 1e-9; t += step) out.push(+t.toFixed(4));
    return { step, out };
  }, [span, width, view.t0]);

  const ghosts = p.ghosts ?? [];
  const ghostRows = ghosts.length;

  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr auto auto", height: "100%", minHeight: 0, background: "var(--bg)" }}>
      <audio ref={audioRef} src={media ?? undefined} preload="auto" onEnded={() => setPlaying(false)} onPause={() => setPlaying(false)} />
      {/* ruler */}
      <div className="timeline" style={{ height: 22, borderBottom: "1px solid var(--border)", position: "relative", overflow: "hidden", fontSize: 10, color: "var(--text-3)" }} aria-hidden="true">
        {ticks.out.map((t) => (
          <span key={t} className="num" style={{ position: "absolute", left: t2x(t), top: 4, borderLeft: "1px solid var(--border-strong)", paddingLeft: 3, height: 18 }}>
            {fmtClock(t, ticks.step < 0.1 ? 2 : 1)}
          </span>
        ))}
      </div>
      {/* plot */}
      <div
        ref={plotRef}
        className="timeline"
        style={{ position: "relative", minHeight: 120, overflow: "hidden", background: "var(--bg-raised)", cursor: mode === "comment" ? "copy" : tool?.type === "segment" && mode !== "select" ? "crosshair" : "text" }}
        onPointerDown={onPlotDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onWheel={onWheel}
        role="application"
        tabIndex={0}
        aria-label={`Audio ${display === "spec" ? "spectrogram" : "waveform"}, ${fmtClock(duration)} long. Space plays, brackets step 0.1 seconds.`}
      >
        <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", color: "var(--text-2)" }} />
        {display === "spec" && specCanvas && (
          <div className="stage-hud num" style={{ top: 6, bottom: "auto", left: "auto", right: 6 }}>
            0 to {Math.round(specCanvas.maxHz)} Hz
          </div>
        )}
        {display === "spec" && !spec && buf && <div className="state" style={{ position: "absolute", inset: 0 }}>Computing spectrogram</div>}
        {!buf && !error && <div className="state" style={{ position: "absolute", inset: 0 }}>Decoding audio</div>}
        {error && <div className="state state-error" style={{ position: "absolute", inset: 0 }}>Could not decode audio: {error}</div>}
        {visible.map((a) => {
          const g = a.geometry as Seg;
          const c = classColor(schema, a.schema_key, a.label, theme);
          const x1 = t2x(g.start);
          const x2 = t2x(g.end);
          if (x2 < 0 || x1 > width) return null;
          return (
            <div
              key={a.cid}
              style={{
                position: "absolute",
                left: x1,
                width: Math.max(1, x2 - x1),
                top: 0,
                bottom: 0,
                background: c,
                opacity: a.cid === selected ? 0.28 : 0.14,
                borderLeft: `1px ${a.source === "model" ? "dashed" : "solid"} ${c}`,
                borderRight: `1px ${a.source === "model" ? "dashed" : "solid"} ${c}`,
                pointerEvents: "none",
              }}
            />
          );
        })}
        {/* In review, each annotator's segments shade the plot too; where two annotators agree the shading doubles. */}
        {readOnly &&
          ghosts.map((gl) =>
            gl.anns
              .filter((a) => a.geometry && "start" in a.geometry)
              .map((a, i) => {
                const g = a.geometry as Seg;
                const x1 = t2x(g.start);
                const x2 = t2x(g.end);
                if (x2 < 0 || x1 > width) return null;
                return (
                  <div
                    key={`band${gl.key}${i}`}
                    style={{
                      position: "absolute",
                      left: x1,
                      width: Math.max(1, x2 - x1),
                      top: 0,
                      bottom: 0,
                      background: classColor(schema, a.schema_key, a.label, theme),
                      opacity: 0.12,
                      pointerEvents: "none",
                    }}
                  />
                );
              }),
          )}
        {drag?.kind === "create" && activeClass && (
          <div
            style={{
              position: "absolute",
              left: t2x(Math.min(drag.t0, drag.t1)),
              width: Math.abs(t2x(drag.t1) - t2x(drag.t0)),
              top: 0,
              bottom: 0,
              background: classColor(schema, tool!.key, activeClass.value, theme),
              opacity: 0.25,
              pointerEvents: "none",
            }}
          />
        )}
        <Playhead x={t2x(time)} />
        {(p.pins ?? []).filter((pin) => pin.t != null).map((pin) => (
          <div key={pin.id} style={{ position: "absolute", left: t2x(pin.t!) - 9, top: 4, width: 18, height: 18, borderRadius: 9, background: "var(--accent)", color: "#fff", fontSize: 11, fontWeight: 600, display: "grid", placeItems: "center", pointerEvents: "none" }}>
            {pin.index}
          </div>
        ))}
      </div>
      {/* segment lanes */}
      <div
        style={{ position: "relative", height: (readOnly ? ghostRows : laneCount) * LANE_H + 8, borderTop: "1px solid var(--border)", overflow: "hidden", background: "var(--bg)" }}
        onPointerMove={onMove}
        onPointerUp={onUp}
        aria-label="Segments"
      >
        {!readOnly &&
          visible.map((a) => {
            const g = a.geometry as Seg;
            const c = classColor(schema, a.schema_key, a.label, theme);
            const x1 = t2x(g.start);
            const x2 = t2x(g.end);
            if (x2 < -10 || x1 > width + 10) return null;
            const lane = lanes.get(a.cid) ?? 0;
            const name = className(schema, a.schema_key, a.label);
            return (
              <div
                key={a.cid}
                role="button"
                aria-pressed={a.cid === selected}
                aria-label={`${name} ${fmtClock(g.start)} to ${fmtClock(g.end)}${a.source === "model" ? ", proposal" : ""}`}
                title={`${name}  ${fmtClock(g.start)} - ${fmtClock(g.end)}`}
                onPointerDown={(e) => onSegDown(e, a, "body")}
                style={{
                  position: "absolute",
                  left: x1,
                  width: Math.max(4, x2 - x1),
                  top: 4 + lane * LANE_H,
                  height: LANE_H - 4,
                  background: a.source === "model" ? "transparent" : c,
                  border: `1.5px ${a.source === "model" ? "dashed" : "solid"} ${c}`,
                  outline: a.cid === selected ? "2px solid var(--focus)" : undefined,
                  outlineOffset: 1,
                  borderRadius: 4,
                  color: a.source === "model" ? "var(--text)" : inkOn(c),
                  fontSize: 11,
                  lineHeight: `${LANE_H - 7}px`,
                  paddingLeft: 6,
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  cursor: locked.has(a.cid) ? "default" : "grab",
                }}
              >
                {!locked.has(a.cid) && (
                  <>
                    <span onPointerDown={(e) => onSegDown(e, a, "start")} style={{ position: "absolute", left: -2, top: 0, bottom: 0, width: 7, cursor: "ew-resize" }} />
                    <span onPointerDown={(e) => onSegDown(e, a, "end")} style={{ position: "absolute", right: -2, top: 0, bottom: 0, width: 7, cursor: "ew-resize" }} />
                  </>
                )}
                {x2 - x1 > 28 ? name : ""}
              </div>
            );
          })}
        {readOnly &&
          ghosts.map((gl, gi) =>
            gl.anns
              .filter((a) => a.geometry && "start" in a.geometry)
              .map((a, i) => {
                const g = a.geometry as Seg;
                const x1 = t2x(g.start);
                const x2 = t2x(g.end);
                const picked = a.id != null && a.id === p.pickedGhostId;
                return (
                  <div
                    key={`${gl.key}${i}`}
                    title={`${gl.name}: ${className(schema, a.schema_key, a.label)} ${fmtClock(g.start)} - ${fmtClock(g.end)}`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      p.onPickGhost?.(a);
                    }}
                    style={{
                      position: "absolute",
                      left: x1,
                      width: Math.max(3, x2 - x1),
                      top: 4 + gi * LANE_H,
                      height: LANE_H - 4,
                      background: classColor(schema, a.schema_key, a.label, theme),
                      borderLeft: `3px solid ${gl.color}`,
                      outline: picked ? "2px solid var(--focus)" : undefined,
                      borderRadius: 3,
                      fontSize: 10,
                      color: inkOn(classColor(schema, a.schema_key, a.label, theme)),
                      paddingLeft: 4,
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                      cursor: "pointer",
                    }}
                  >
                    {x2 - x1 > 24 ? className(schema, a.schema_key, a.label) : ""}
                  </div>
                );
              }),
          )}
        <Playhead x={t2x(time)} thin />
      </div>
      {/* transport */}
      <div className="transport">
        <button className="btn btn-sm btn-icon" onClick={toggle} aria-label={playing ? "Pause" : "Play"} title="Play or pause (Space)" disabled={!media}>
          <Icon name={playing ? "pause" : "play"} />
        </button>
        <span className="num" style={{ minWidth: 110 }}>
          {fmtClock(time)} / {fmtClock(duration)}
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
        <div className="seg" role="group" aria-label="Display">
          <button aria-pressed={display === "wave"} onClick={() => setDisplay("wave")}>
            Waveform
          </button>
          <button aria-pressed={display === "spec"} onClick={() => setDisplay("spec")}>
            Spectrogram
          </button>
        </div>
        <button className="btn btn-sm" onClick={() => zoom(1.5)} aria-label="Zoom out">
          -
        </button>
        <button className="btn btn-sm" onClick={() => zoom(0.66)} aria-label="Zoom in">
          +
        </button>
        <span className="faint num">{span < duration ? `${span.toFixed(2)}s window` : "full length"}</span>
        <span className="spacer" />
        <span aria-live="polite" className="muted">
          {busy}
        </span>
        {!readOnly && (
          <>
            <button className="btn btn-sm" onClick={propose} disabled={!buf} title="Propose segments from signal energy (M)">
              <Icon name="wand" /> Propose
            </button>
            {proposals.length > 0 && (
              <button className="btn btn-sm" onClick={() => accept(proposals.map((a) => a.cid))} title="Accept all proposals (Shift+A)">
                Accept {proposals.length}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Playhead({ x, thin }: { x: number; thin?: boolean }) {
  return <div aria-hidden="true" style={{ position: "absolute", left: x, top: 0, bottom: 0, width: thin ? 1 : 2, marginLeft: thin ? 0 : -1, background: "var(--bad)", pointerEvents: "none" }} />;
}
