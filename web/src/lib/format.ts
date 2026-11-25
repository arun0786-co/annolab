import type { ItemStatus, Schema } from "../api/types";
import { displayColor, type Theme } from "./palette";

export const STATUS_META: Record<ItemStatus, { label: string; color: string; badge: string }> = {
  unlabeled: { label: "Unlabeled", color: "var(--unlabeled)", badge: "" },
  in_progress: { label: "In progress", color: "var(--warn)", badge: "badge-warn" },
  labeled: { label: "Labeled", color: "var(--accent)", badge: "badge-accent" },
  in_review: { label: "In review", color: "var(--review)", badge: "badge-review" },
  approved: { label: "Approved", color: "var(--good)", badge: "badge-good" },
  rejected: { label: "Rejected", color: "var(--bad)", badge: "badge-bad" },
};

export function fmtSeconds(s: number | null | undefined): string {
  if (s == null || !isFinite(s)) return "–";
  if (s < 9.95) return `${s.toFixed(1)}s`;
  // Round once, then split, so 659.6 s reads 11m 00s and never 10m 60s.
  const t = Math.round(s);
  if (t < 60) return `${t}s`;
  return `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`;
}

export function fmtClock(t: number, decimals = 2): string {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(decimals).padStart(decimals ? decimals + 3 : 2, "0")}`;
}

export function fmtPct(v: number | null | undefined, digits = 0): string {
  if (v == null || !isFinite(v)) return "–";
  return `${(v * 100).toFixed(digits)}%`;
}

export function fmtScore(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "–";
  return v.toFixed(2);
}

export function fmtAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Colour of a class in the current theme; grey if the class is unknown. */
export function classColor(schema: Schema, schemaKey: string, label: string | null, theme: Theme): string {
  const tool = schema.tools.find((t) => t.key === schemaKey);
  const c = tool?.classes.find((c) => c.value === label);
  return c ? displayColor(c.color, theme) : theme === "dark" ? "#8a9099" : "#6b7178";
}

export function className(schema: Schema, schemaKey: string, label: string | null): string {
  const tool = schema.tools.find((t) => t.key === schemaKey);
  return tool?.classes.find((c) => c.value === label)?.name ?? label ?? "Unlabeled";
}

export function emptySchema(): Schema {
  return { tools: [], classifications: [] };
}

export function normalizeSchema(s: unknown): Schema {
  const o = (s ?? {}) as Partial<Schema>;
  return {
    tools: Array.isArray(o.tools) ? o.tools.map((t) => ({ ...t, classes: t.classes ?? [], attributes: t.attributes ?? [] })) : [],
    classifications: Array.isArray(o.classifications) ? o.classifications : [],
  };
}

let seq = 0;
export function uid(prefix = "a"): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
}
