// Small SVG charts. Thin marks, recessive axes, text in text colours, hover tooltip per mark,
// and a table fallback through the title/aria attributes.
import { useRef, useState } from "react";
import { useElementSize } from "../hooks/useElementSize";

export interface BarRow {
  key: string;
  label: string;
  value: number;
  color?: string;
  note?: string;
}

/** Horizontal bars: label column, bar, value column. One series; colour only when it carries identity. */
export function HBarChart({
  rows,
  format = (v) => String(v),
  unit = "",
  labelWidth = 120,
  empty = "No data yet",
}: {
  rows: BarRow[];
  format?: (v: number) => string;
  unit?: string;
  labelWidth?: number;
  empty?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(wrap);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const rowH = 24;
  const barH = 10;
  const valueW = 56;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const plotW = Math.max(40, width - labelWidth - valueW - 8);
  const h = rows.length * rowH;
  if (!rows.length) return <p className="faint">{empty}</p>;
  return (
    <div ref={wrap} style={{ position: "relative" }}>
      {width > 0 && (
        <svg className="chart" width={width} height={h} role="img" aria-label={rows.map((r) => `${r.label}: ${format(r.value)}${unit}`).join(", ")}>
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <line key={f} className="grid-line" x1={labelWidth + plotW * f} x2={labelWidth + plotW * f} y1={0} y2={h} />
          ))}
          <line className="axis-line" x1={labelWidth} x2={labelWidth} y1={0} y2={h} />
          {rows.map((r, i) => {
            const y = i * rowH;
            const w = Math.max(r.value > 0 ? 2 : 0, (r.value / max) * plotW);
            return (
              <g
                key={r.key}
                onMouseMove={(e) => {
                  const b = wrap.current!.getBoundingClientRect();
                  setHover({ i, x: e.clientX - b.left, y: e.clientY - b.top });
                }}
                onMouseLeave={() => setHover(null)}
              >
                <rect x={0} y={y} width={width} height={rowH} fill="transparent" />
                <text x={0} y={y + rowH / 2 + 4} style={{ fill: "var(--text)" }}>
                  {truncate(r.label, Math.floor(labelWidth / 7))}
                </text>
                <path d={barPath(labelWidth, y + (rowH - barH) / 2, w, barH)} fill={r.color ?? "var(--accent)"} />
                <text x={width - 4} y={y + rowH / 2 + 4} textAnchor="end" style={{ fill: "var(--text)" }}>
                  {format(r.value)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {hover && rows[hover.i] && (
        <div className="chart-tip" style={{ left: Math.min(hover.x + 12, Math.max(0, width - 180)), top: hover.y + 12 }}>
          <strong>{rows[hover.i].label}</strong> <span className="num">{format(rows[hover.i].value)}{unit}</span>
          {rows[hover.i].note && <div className="faint">{rows[hover.i].note}</div>}
        </div>
      )}
    </div>
  );
}

/** Bar with the data end rounded (4px) and the baseline end square. */
function barPath(x: number, y: number, w: number, h: number) {
  if (w <= 0) return "";
  const r = Math.min(4, w, h / 2);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s;
}

export interface StackPart {
  key: string;
  label: string;
  value: number;
  color: string;
}

/** One 100% bar split into parts with 2px gaps, plus a legend with counts. */
export function StackedBar({ parts, height = 12 }: { parts: StackPart[]; height?: number }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const [hover, setHover] = useState<string | null>(null);
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div
        className="progress"
        style={{ height, borderRadius: 4 }}
        role="img"
        aria-label={parts.map((p) => `${p.label} ${p.value}`).join(", ")}
      >
        {total === 0 ? null : parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <span
              key={p.key}
              title={`${p.label}: ${p.value} (${Math.round((p.value / total) * 100)}%)`}
              onMouseEnter={() => setHover(p.key)}
              onMouseLeave={() => setHover(null)}
              style={{
                width: `${(p.value / total) * 100}%`,
                background: p.color,
                opacity: hover && hover !== p.key ? 0.45 : 1,
              }}
            />
          ))}
      </div>
      <div className="legend">
        {parts.map((p) => (
          <span key={p.key}>
            <i className="swatch" style={{ background: p.color }} />
            {p.label} <strong className="num" style={{ color: "var(--text)" }}>{p.value}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Inline progress bar used in tables and cards. */
export function Progress({ parts, label }: { parts: { value: number; color: string }[]; label: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  return (
    <div className="progress" role="img" aria-label={label} style={{ minWidth: 80 }}>
      {total > 0 &&
        parts.filter((p) => p.value > 0).map((p, i) => <span key={i} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />)}
    </div>
  );
}

/** Histogram of values in [0,1] (per-item agreement). */
export function Histogram({ values, bins = 10 }: { values: number[]; bins?: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(wrap);
  const counts = Array(bins).fill(0) as number[];
  values.forEach((v) => counts[Math.min(bins - 1, Math.max(0, Math.floor(v * bins)))]++);
  const max = Math.max(1, ...counts);
  const h = 90;
  const bw = width / bins;
  return (
    <div ref={wrap}>
      {width > 0 && (
        <svg className="chart" width={width} height={h + 16} role="img" aria-label={`Agreement histogram over ${values.length} items`}>
          <line className="axis-line" x1={0} x2={width} y1={h} y2={h} />
          {counts.map((c, i) => {
            const bh = (c / max) * (h - 4);
            return (
              <g key={i}>
                <title>{`${(i / bins).toFixed(1)} to ${((i + 1) / bins).toFixed(1)}: ${c} items`}</title>
                {c > 0 && <rect x={i * bw + 1} y={h - bh} width={bw - 2} height={bh} rx={2} fill="var(--accent)" />}
              </g>
            );
          })}
          <text x={0} y={h + 13}>0</text>
          <text x={width / 2} y={h + 13} textAnchor="middle">0.5</text>
          <text x={width} y={h + 13} textAnchor="end">1</text>
        </svg>
      )}
    </div>
  );
}
