// Pieces shared by the labeling and review screens: tool rail, class picker, attributes,
// item-level classifications and the annotation list.
import type { AttributeDef, ClassDef, Modality, Schema, ToolDef, ToolType } from "../api/types";
import { Icon, type IconName } from "../components/Icon";
import { classColor, className, fmtClock, uid } from "../lib/format";
import type { Theme } from "../lib/palette";
import { AudioEditor } from "./AudioEditor";
import { ImageEditor } from "./ImageEditor";
import { TextEditor } from "./TextEditor";
import type { Ann, EditApi, EditorProps } from "./types";
import { VideoEditor } from "./VideoEditor";

export const TOOL_ICON: Record<ToolType, IconName> = { bbox: "bbox", polygon: "polygon", point: "point", segment: "segment", track: "track", span: "span" };
export const TOOL_KEY: Record<ToolType, string> = { bbox: "b", polygon: "p", point: "o", segment: "r", track: "b", span: "t" };

/** Geometry types each modality can draw. Tools of other types are ignored by that editor. */
export const MODALITY_TOOLS: Record<Modality, ToolType[]> = {
  image: ["bbox", "polygon", "point"],
  audio: ["segment"],
  video: ["track", "segment"],
  text: ["span"],
};

/** First tool of each hotkey letter wins: returns map letter -> tool key. */
export function toolHotkeys(tools: ToolDef[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tools) {
    const k = TOOL_KEY[t.type];
    if (k && !out[k]) out[k] = t.key;
  }
  return out;
}

export function classHotkey(c: ClassDef, i: number) {
  return c.hotkey || (i < 9 ? String(i + 1) : "");
}

export function Workspace(p: EditorProps & { modality: Modality }) {
  if (p.modality === "image") return <ImageEditor {...p} />;
  if (p.modality === "audio") return <AudioEditor {...p} />;
  if (p.modality === "video") return <VideoEditor {...p} />;
  return <TextEditor {...p} />;
}

export function Rail({
  tools,
  mode,
  setMode,
  modality,
  extra,
}: {
  tools: ToolDef[];
  mode: string;
  setMode: (m: string) => void;
  modality: Modality;
  extra?: React.ReactNode;
}) {
  const keys = toolHotkeys(tools);
  const keyOf = (tk: string) => Object.entries(keys).find(([, v]) => v === tk)?.[0]?.toUpperCase();
  return (
    <nav className="rail" aria-label="Tools">
      {modality !== "text" && (
        <button className="btn" aria-pressed={mode === "select"} onClick={() => setMode("select")} title="Select and edit (V)" aria-label="Select tool, V">
          <Icon name="select" />
        </button>
      )}
      {modality === "image" && (
        <button className="btn" aria-pressed={mode === "pan"} onClick={() => setMode("pan")} title="Pan (H, or hold Space)" aria-label="Pan tool, H">
          <Icon name="pan" />
        </button>
      )}
      {modality !== "text" && <hr />}
      {tools.map((t) => (
        <button
          key={t.key}
          className="btn"
          aria-pressed={mode === t.key}
          onClick={() => setMode(t.key)}
          title={`${t.name}${keyOf(t.key) ? ` (${keyOf(t.key)})` : ""}`}
          aria-label={`${t.name} tool${keyOf(t.key) ? `, ${keyOf(t.key)}` : ""}`}
        >
          <Icon name={TOOL_ICON[t.type]} />
        </button>
      ))}
      {extra}
    </nav>
  );
}

export function ClassPicker({
  tool,
  active,
  onPick,
  theme,
}: {
  tool: ToolDef | null;
  active: ClassDef | null;
  onPick: (c: ClassDef) => void;
  theme: Theme;
}) {
  if (!tool) return <p className="faint">Pick a tool to see its classes.</p>;
  if (!tool.classes.length) return <p className="faint">This tool has no classes. Add some in the schema.</p>;
  return (
    <ul className="class-list" aria-label={`${tool.name} classes`}>
      {tool.classes.map((c, i) => (
        <li key={c.value}>
          <button className="class-btn" aria-pressed={active?.value === c.value} onClick={() => onPick(c)}>
            <i className="swatch" style={{ background: classColor({ tools: [tool], classifications: [] }, tool.key, c.value, theme) }} />
            <span className="name">{c.name}</span>
            {classHotkey(c, i) && <kbd>{classHotkey(c, i)}</kbd>}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function AttributePanel({ ann, tool, edit, readOnly }: { ann: Ann; tool: ToolDef; edit: EditApi; readOnly?: boolean }) {
  const attrs = tool.attributes ?? [];
  const set = (k: string, v: unknown) => edit.patch(ann.cid, (a) => ({ ...a, attributes: { ...a.attributes, [k]: v } }));
  return (
    <div className="stack">
      <label className="field">
        <span>Class</span>
        <select className="select" value={ann.label ?? ""} disabled={readOnly} onChange={(e) => edit.patch(ann.cid, (a) => ({ ...a, label: e.target.value }))}>
          {tool.classes.map((c) => (
            <option key={c.value} value={c.value}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {attrs.map((at) => (
        <AttrField key={at.key} def={at} value={ann.attributes[at.key]} onChange={(v) => set(at.key, v)} readOnly={readOnly} />
      ))}
      {!attrs.length && <p className="faint">No attributes on this tool.</p>}
    </div>
  );
}

function AttrField({ def, value, onChange, readOnly }: { def: AttributeDef; value: unknown; onChange: (v: unknown) => void; readOnly?: boolean }) {
  const label = def.name || def.key;
  if (def.type === "select")
    return (
      <label className="field">
        <span>{label}</span>
        <select className="select" value={String(value ?? "")} disabled={readOnly} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Not set</option>
          {(def.options ?? []).map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </label>
    );
  if (def.type === "checkbox")
    return (
      <label className="check">
        <input type="checkbox" checked={!!value} disabled={readOnly} onChange={(e) => onChange(e.target.checked)} /> {label}
      </label>
    );
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="input"
        type={def.type === "number" ? "number" : "text"}
        value={value == null ? "" : String(value)}
        disabled={readOnly}
        onChange={(e) => onChange(def.type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)}
      />
    </label>
  );
}

/** Item-level classifications are stored as annotations with no geometry. */
export function Classifications({ schema, anns, edit, readOnly }: { schema: Schema; anns: Ann[]; edit: EditApi; readOnly?: boolean }) {
  if (!schema.classifications.length) return null;
  return (
    <div className="stack" style={{ gap: 12 }}>
      {schema.classifications.map((c) => {
        const mine = anns.filter((a) => a.schema_key === c.key && !a.geometry);
        if (c.type === "text") {
          const cur = mine[0];
          return (
            <label key={c.key} className="field">
              <span>{c.name}</span>
              <textarea
                className="textarea"
                rows={2}
                value={cur?.label ?? ""}
                disabled={readOnly}
                onChange={(e) =>
                  edit.setAll((xs) => [
                    ...xs.filter((a) => !(a.schema_key === c.key && !a.geometry)),
                    ...(e.target.value ? [{ cid: cur?.cid ?? uid("c"), schema_key: c.key, label: e.target.value, geometry: null, attributes: {}, source: "human" as const }] : []),
                  ])
                }
              />
            </label>
          );
        }
        const values = new Set(mine.map((a) => a.label));
        const toggle = (o: string) =>
          edit.setAll((xs) => {
            const rest = xs.filter((a) => !(a.schema_key === c.key && !a.geometry && (c.type === "radio" || a.label === o)));
            if (c.type === "checkbox" && values.has(o)) return rest;
            if (c.type === "radio" && values.has(o)) return rest;
            return [...rest, { cid: uid("c"), schema_key: c.key, label: o, geometry: null, attributes: {}, source: "human" as const }];
          });
        return (
          <fieldset key={c.key} style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="muted" style={{ fontSize: "var(--fs-sm)", marginBottom: 4 }}>
              {c.name}
            </legend>
            <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
              {(c.options ?? []).map((o) => (
                <button key={o} className="btn btn-sm" aria-pressed={values.has(o)} disabled={readOnly} onClick={() => toggle(o)} role={c.type === "radio" ? "radio" : "checkbox"} aria-checked={values.has(o)}>
                  {o}
                </button>
              ))}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}

export function describeGeometry(a: { geometry: Ann["geometry"] }, text?: string): string {
  const g = a.geometry as Record<string, unknown> | null;
  if (!g) return "";
  if ("keyframes" in g) {
    const k = g.keyframes as { t: number }[];
    return `${k.length} key${k.length === 1 ? "" : "s"}${k.length ? ` · ${fmtClock(k[0].t, 1)}-${fmtClock(k[k.length - 1].t, 1)}` : ""}`;
  }
  if ("start" in g && text !== undefined) return `"${text.slice(g.start as number, g.end as number).slice(0, 28)}"`;
  if ("start" in g) return `${fmtClock(g.start as number)}-${fmtClock(g.end as number)}`;
  if ("points" in g) return `${(g.points as unknown[]).length} pts`;
  if ("w" in g) return `${Math.round(g.w as number)}x${Math.round(g.h as number)}`;
  if ("x" in g) return `${Math.round(g.x as number)}, ${Math.round(g.y as number)}`;
  return "";
}

export function AnnotationList({
  anns,
  schema,
  selected,
  select,
  hidden,
  locked,
  toggleHidden,
  toggleLocked,
  remove,
  theme,
  text,
}: {
  anns: Ann[];
  schema: Schema;
  selected: string | null;
  select: (c: string) => void;
  hidden: Set<string>;
  locked: Set<string>;
  toggleHidden: (c: string) => void;
  toggleLocked: (c: string) => void;
  remove: (c: string) => void;
  theme: Theme;
  text?: string;
}) {
  const geo = anns.filter((a) => a.geometry);
  if (!geo.length) return <p className="faint">Nothing drawn yet.</p>;
  return (
    <ul className="ann-list" role="listbox" aria-label="Annotations">
      {geo.map((a, i) => (
        <li key={a.cid} className="ann-row" role="option" aria-selected={a.cid === selected} onClick={() => select(a.cid)} style={{ opacity: hidden.has(a.cid) ? 0.5 : 1 }}>
          <span className="faint num" style={{ width: 18 }}>
            {i + 1}
          </span>
          <i className="swatch" style={{ background: classColor(schema, a.schema_key, a.label, theme) }} />
          <span className="name">
            <span className="row" style={{ gap: 4 }}>
              {className(schema, a.schema_key, a.label)}
              {a.source === "model" && <span className="badge" style={{ height: 16, padding: "0 6px" }}>model</span>}
            </span>
            <span className="faint num ann-geom">{describeGeometry(a, text)}</span>
          </span>
          <button className="icon-btn" aria-pressed={hidden.has(a.cid)} aria-label={hidden.has(a.cid) ? "Show" : "Hide"} title="Hide (Shift+H)" onClick={(e) => (e.stopPropagation(), toggleHidden(a.cid))}>
            <Icon name={hidden.has(a.cid) ? "eyeOff" : "eye"} size={14} />
          </button>
          <button className="icon-btn" aria-pressed={locked.has(a.cid)} aria-label={locked.has(a.cid) ? "Unlock" : "Lock"} title="Lock (Shift+L)" onClick={(e) => (e.stopPropagation(), toggleLocked(a.cid))}>
            <Icon name={locked.has(a.cid) ? "lock" : "unlock"} size={14} />
          </button>
          <button className="icon-btn" aria-label="Delete" title="Delete (Del)" onClick={(e) => (e.stopPropagation(), remove(a.cid))}>
            <Icon name="trash" size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}
