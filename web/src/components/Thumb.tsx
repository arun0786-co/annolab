import { useEffect, useRef, useState } from "react";
import type { Item } from "../api/types";
import { api } from "../api/client";
import { useMedia } from "../hooks/useMedia";
import { peaks } from "../lib/dsp";

/** Lazy thumbnail: image, first video frame, mini waveform, or a text snippet. */
export function Thumb({ item }: { item: Item }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  if (item.kind === "text")
    return (
      <div className="thumb-text num" aria-hidden="true">
        {String(item.meta.text ?? "").split(/\s+/).filter(Boolean).length}
        <br />
        words
      </div>
    );
  return (
    <div ref={ref} aria-hidden="true">
      {visible ? <MediaThumb item={item} /> : <div className="thumb" />}
    </div>
  );
}

function MediaThumb({ item }: { item: Item }) {
  const { url } = useMedia(item.id);
  if (!url) return <div className="thumb skeleton" />;
  if (item.thumbnail_url) return <img className="thumb" src={api.thumbSrc(item.id)} alt="" loading="lazy" />;
  if (item.kind === "image") return <img className="thumb" src={url} alt="" loading="lazy" />;
  if (item.kind === "video") return <video className="thumb" src={`${url}#t=0.1`} muted preload="metadata" />;
  return <WaveThumb url={url} />;
}

let sharedCtx: AudioContext | null = null;

function WaveThumb({ url }: { url: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        sharedCtx ??= new AudioContext();
        const buf = await sharedCtx.decodeAudioData(await (await fetch(url)).arrayBuffer());
        if (!live || !ref.current) return;
        const c = ref.current;
        const dpr = window.devicePixelRatio || 1;
        c.width = 48 * dpr;
        c.height = 32 * dpr;
        const g = c.getContext("2d")!;
        const p = peaks(buf.getChannelData(0), 48 * dpr);
        const amp = Math.max(1e-6, ...p.max.map(Math.abs), ...p.min.map(Math.abs));
        g.fillStyle = getComputedStyle(c).color;
        for (let i = 0; i < p.max.length; i++) {
          const y1 = (0.5 - (p.max[i] / amp) * 0.45) * c.height;
          const y2 = (0.5 - (p.min[i] / amp) * 0.45) * c.height;
          g.fillRect(i, y1, 1, Math.max(1, y2 - y1));
        }
      } catch {
        /* undecodable: leave the empty frame */
      }
    })();
    return () => {
      live = false;
    };
  }, [url]);
  return <canvas ref={ref} className="thumb" style={{ color: "var(--accent)", width: 48, height: 32 }} />;
}
