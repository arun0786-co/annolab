import { useEffect, useMemo, useRef, useState } from "react";
import type { Annotation } from "../api/types";
import { classColor, className, uid } from "../lib/format";
import { assignLanes, pieces, snapToWords } from "../lib/spans";
import type { EditorProps } from "./types";

const LANE_PX = 4;

interface Mark {
  id: string;
  start: number;
  end: number;
  color: string;
  title: string;
  lane: number;
  proposal?: boolean;
  ann: Annotation;
  cid?: string;
}

/** Character offset of a DOM position inside the document element. */
function offsetOf(root: HTMLElement, node: Node, off: number): number | null {
  const el = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement))?.closest<HTMLElement>("[data-start]");
  if (!el || !root.contains(el)) return null;
  const base = Number(el.dataset.start);
  return node.nodeType === Node.TEXT_NODE ? base + off : base + (off > 0 ? (el.textContent?.length ?? 0) : 0);
}

export function TextEditor(p: EditorProps) {
  const { item, schema, anns, selected, select, tool, activeClass, hidden, edit, theme, readOnly, mode } = p;
  const text = String(item.meta.text ?? "");
  const docRef = useRef<HTMLDivElement>(null);
  const [cycle, setCycle] = useState(0);
  const spanTool = tool?.type === "span" ? tool : schema.tools.find((t) => t.type === "span") ?? null;

  const marks: Mark[] = useMemo(() => {
    if (readOnly) {
      const out: Mark[] = [];
      (p.ghosts ?? []).forEach((g, gi) =>
        g.anns.forEach((a, i) => {
          const s = a.geometry as { start: number; end: number } | null;
          if (!s || !("start" in s)) return;
          out.push({ id: `${g.key}:${i}`, start: s.start, end: s.end, color: classColor(schema, a.schema_key, a.label, theme), title: `${g.name}: ${className(schema, a.schema_key, a.label)}`, lane: gi, ann: a });
        }),
      );
      return out;
    }
    const vis = anns.filter((a) => !hidden.has(a.cid) && a.geometry && "start" in a.geometry);
    const lanes = assignLanes(vis.map((a) => ({ id: a.cid, ...(a.geometry as { start: number; end: number }) })));
    return vis.map((a) => {
      const s = a.geometry as { start: number; end: number };
      return {
        id: a.cid,
        cid: a.cid,
        start: s.start,
        end: s.end,
        color: classColor(schema, a.schema_key, a.label, theme),
        title: className(schema, a.schema_key, a.label),
        lane: lanes.get(a.cid) ?? 0,
        proposal: a.source === "model",
        ann: a,
      };
    });
  }, [anns, hidden, schema, theme, readOnly, p.ghosts]);

  const byId = useMemo(() => new Map(marks.map((m) => [m.id, m])), [marks]);
  const parts = useMemo(() => pieces(text.length, marks), [text.length, marks]);

  function onMouseUp() {
    const sel = window.getSelection();
    const root = docRef.current;
    if (!sel || !root || sel.isCollapsed || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    const a = offsetOf(root, r.startContainer, r.startOffset);
    const b = offsetOf(root, r.endContainer, r.endOffset);
    if (a == null || b == null) return;
    const s = snapToWords(text, a, b);
    sel.removeAllRanges();
    if (s.end <= s.start) return;
    if (mode === "comment") {
      p.onPin?.({ t: s.start });
      return;
    }
    if (readOnly || !spanTool || !activeClass) return;
    if (!spanTool.classes.some((c) => c.value === activeClass.value)) return;
    const cid = uid();
    edit.add({ cid, schema_key: spanTool.key, label: activeClass.value, geometry: { start: s.start, end: s.end }, attributes: {}, source: "human" });
    select(cid);
  }

  function onPieceClick(ids: string[]) {
    if (window.getSelection()?.isCollapsed === false) return;
    if (!ids.length) {
      if (!readOnly) select(null);
      return;
    }
    // Repeated clicks on stacked spans cycle through them, shortest first.
    const sorted = [...ids].sort((x, y) => byId.get(x)!.end - byId.get(x)!.start - (byId.get(y)!.end - byId.get(y)!.start));
    const next = sorted[cycle % sorted.length];
    setCycle((c) => c + 1);
    const m = byId.get(next)!;
    if (readOnly) p.onPickGhost?.(m.ann);
    else if (m.cid) select(m.cid);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
      if (!selected || readOnly) return;
      const a = anns.find((x) => x.cid === selected);
      const g = a?.geometry as { start: number; end: number } | undefined;
      if (!a || !g || !e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const d = e.key === "ArrowLeft" ? -1 : 1;
      const n = e.altKey ? { start: Math.max(0, Math.min(g.end - 1, g.start + d)), end: g.end } : { start: g.start, end: Math.min(text.length, Math.max(g.start + 1, g.end + d)) };
      edit.patch(selected, (x) => ({ ...x, geometry: n }));
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const selMark = selected ? byId.get(selected) : undefined;
  return (
    <div className="stage" style={{ overflow: "auto", background: "var(--bg-sunken)" }}>
      {!text ? (
        <div className="state">This item has no text.</div>
      ) : (
        <div
          ref={docRef}
          className="doc"
          onMouseUp={onMouseUp}
          role="document"
          aria-label={`Text, ${text.length} characters, ${marks.length} spans. Select text to add a span.`}
          style={{ cursor: readOnly ? "default" : "text" }}
        >
          {parts.map((pc) => {
            const ms = pc.ids.map((id) => byId.get(id)!).sort((a, b) => a.lane - b.lane);
            const depth = ms.length ? Math.max(...ms.map((m) => m.lane)) + 1 : 0;
            const isSel = selMark && pc.start >= selMark.start && pc.end <= selMark.end;
            const style: React.CSSProperties = ms.length
              ? {
                  backgroundImage: ms.map((m) => (m.proposal ? `repeating-linear-gradient(90deg, ${m.color} 0 4px, transparent 4px 7px)` : `linear-gradient(${m.color}, ${m.color})`)).join(","),
                  backgroundSize: ms.map(() => "100% 3px").join(","),
                  backgroundPosition: ms.map((m) => `0 calc(100% - ${m.lane * LANE_PX}px)`).join(","),
                  backgroundRepeat: "no-repeat",
                  paddingBottom: depth * LANE_PX,
                  cursor: "pointer",
                }
              : {};
            return (
              <span
                key={pc.start}
                data-start={pc.start}
                className={`tok${isSel ? " tok-sel" : ""}`}
                style={style}
                title={ms.map((m) => m.title).join(" / ") || undefined}
                onClick={() => onPieceClick(pc.ids)}
              >
                {text.slice(pc.start, pc.end)}
              </span>
            );
          })}
        </div>
      )}
      {!readOnly && spanTool && (
        <div className="stage-hud" style={{ position: "sticky", left: 8, bottom: 8, width: "fit-content" }}>
          {activeClass ? (
            <>
              Select text to tag as <strong style={{ color: "var(--text)" }}>{activeClass.name}</strong>. Click a tagged word to select; click again to cycle stacked spans.
            </>
          ) : (
            "Pick a class to start tagging."
          )}
        </div>
      )}
    </div>
  );
}
