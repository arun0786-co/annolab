import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { AttributeDef, ClassDef, ClassificationDef, Modality, Schema, ToolDef, ToolType } from "../api/types";
import { Icon } from "../components/Icon";
import { ClassPicker, Classifications, MODALITY_TOOLS, Rail, TOOL_ICON } from "../editors/Panels";
import { useAnnStore } from "../editors/store";
import { useHotkeys } from "../hooks/useHotkeys";
import { contrast, displayColor, inkOn, nextColor, PALETTE_LIGHT, SURFACE_DARK, SURFACE_LIGHT } from "../lib/palette";
import { slug, validateSchema } from "../lib/schema";
import { useSession, useShortcutGroups, useTheme } from "../state";
import { useProject } from "./ProjectLayout";

const TOOL_NAMES: Record<ToolType, string> = { bbox: "Bounding box", polygon: "Polygon", point: "Point", segment: "Time segment", track: "Box track", span: "Text span" };

export function SchemaEditor() {
  const { project, setProject } = useProject();
  const { user } = useSession();
  const { theme } = useTheme();
  const [schema, setSchema] = useState<Schema>(project.schema);
  const [saved, setSaved] = useState<Schema>(project.schema);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [previewTool, setPreviewTool] = useState<string>("");
  const readOnly = user?.role !== "admin";
  const dirty = JSON.stringify(schema) !== JSON.stringify(saved);
  const issues = useMemo(() => validateSchema(schema, project.modality), [schema, project.modality]);
  const errors = issues.filter((i) => i.level === "error");
  const allowed = MODALITY_TOOLS[project.modality];

  useEffect(() => {
    setSchema(project.schema);
    setSaved(project.schema);
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (readOnly || errors.length || !dirty) return;
    setState("saving");
    setErr(null);
    try {
      const p = await api.updateProject(project.id, { schema });
      setProject(p);
      setSaved(schema);
      setState("saved");
    } catch (e) {
      setErr((e as Error).message);
      setState("error");
    }
  }
  useHotkeys({ "mod+s": save });
  useShortcutGroups([{ title: "Schema", keys: [["Mod+S", "Save schema"]] }]);

  const upTool = (i: number, fn: (t: ToolDef) => ToolDef) => setSchema((s) => ({ ...s, tools: s.tools.map((t, j) => (j === i ? fn(t) : t)) }));
  const upCls = (i: number, fn: (c: ClassificationDef) => ClassificationDef) =>
    setSchema((s) => ({ ...s, classifications: s.classifications.map((c, j) => (j === i ? fn(c) : c)) }));

  const addTool = () => {
    const type = allowed[0];
    const n = schema.tools.length + 1;
    setSchema((s) => ({
      ...s,
      tools: [...s.tools, { key: `${type}_${n}`, type, name: `${TOOL_NAMES[type]} ${n}`, classes: [{ value: "class_1", name: "Class 1", color: nextColor(s.tools.flatMap((x) => x.classes.map((c) => c.color))), hotkey: "1" }], attributes: [] }],
    }));
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 340px", gap: 16, alignItems: "start" }}>
      <div>
        <div className="toolbar">
          <span className="muted">
            {schema.tools.length} tools, {schema.tools.reduce((a, t) => a + t.classes.length, 0)} classes, {schema.classifications.length} classifications
          </span>
          <span className="spacer" />
          <span aria-live="polite" className="muted">
            {state === "saving" ? "Saving" : state === "saved" && !dirty ? "Saved" : dirty ? "Unsaved changes" : ""}
          </span>
          <button className="btn" onClick={() => setRaw(raw === null ? JSON.stringify(schema, null, 2) : null)} aria-pressed={raw !== null}>
            JSON
          </button>
          {!readOnly && (
            <>
              <button className="btn" onClick={() => setSchema(saved)} disabled={!dirty}>
                Discard
              </button>
              <button className="btn btn-primary" onClick={save} disabled={!dirty || errors.length > 0 || state === "saving"} title="Save (Mod+S)">
                Save schema
              </button>
            </>
          )}
        </div>
        {readOnly && <div className="alert" style={{ background: "var(--accent-soft)", color: "var(--text)", marginBottom: 12 }}>Only admins can change the schema.</div>}
        {err && <div className="alert" style={{ marginBottom: 12 }}>{err}</div>}
        {raw !== null ? (
          <div className="stack">
            <label className="field">
              <span>Schema JSON</span>
              <textarea className="textarea mono" rows={24} value={raw} onChange={(e) => setRaw(e.target.value)} readOnly={readOnly} spellCheck={false} />
            </label>
            {!readOnly && (
              <div className="row">
                <button
                  className="btn"
                  onClick={() => {
                    try {
                      const s = JSON.parse(raw) as Schema;
                      setSchema({ tools: s.tools ?? [], classifications: s.classifications ?? [] });
                      setRaw(null);
                      setErr(null);
                    } catch (e) {
                      setErr(`JSON: ${(e as Error).message}`);
                    }
                  }}
                >
                  Apply JSON
                </button>
              </div>
            )}
          </div>
        ) : (
          <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <h2 style={{ margin: "4px 0 8px" }}>Tools</h2>
            {schema.tools.map((t, i) => (
              <ToolEditor
                key={i}
                tool={t}
                allowed={allowed}
                usedColors={schema.tools.flatMap((x) => x.classes.map((c) => c.color))}
                onChange={(fn) => upTool(i, fn)}
                onRemove={() => setSchema((s) => ({ ...s, tools: s.tools.filter((_, j) => j !== i) }))}
              />
            ))}
            <button className="btn" onClick={addTool}>
              <Icon name="plus" /> Add tool
            </button>
            <h2 style={{ margin: "20px 0 8px" }}>Item classifications</h2>
            {schema.classifications.map((c, i) => (
              <div key={i} className="schema-tool">
                <header>
                  <input className="input" aria-label="Classification name" value={c.name} onChange={(e) => upCls(i, (x) => ({ ...x, name: e.target.value }))} style={{ flex: 1 }} />
                  <input className="input mono" aria-label="Classification key" value={c.key} onChange={(e) => upCls(i, (x) => ({ ...x, key: e.target.value }))} style={{ width: 140 }} />
                  <select className="select" aria-label="Classification type" value={c.type} onChange={(e) => upCls(i, (x) => ({ ...x, type: e.target.value as ClassificationDef["type"] }))}>
                    <option value="radio">One of</option>
                    <option value="checkbox">Any of</option>
                    <option value="text">Free text</option>
                  </select>
                  <button className="btn btn-ghost btn-icon" aria-label="Remove classification" onClick={() => setSchema((s) => ({ ...s, classifications: s.classifications.filter((_, j) => j !== i) }))}>
                    <Icon name="trash" />
                  </button>
                </header>
                {c.type !== "text" && (
                  <div className="body">
                    <label className="field">
                      <span>Options, comma separated</span>
                      <input className="input" value={(c.options ?? []).join(", ")} onChange={(e) => upCls(i, (x) => ({ ...x, options: splitList(e.target.value) }))} />
                    </label>
                  </div>
                )}
              </div>
            ))}
            <button
              className="btn"
              onClick={() =>
                setSchema((s) => ({ ...s, classifications: [...s.classifications, { key: `class_${s.classifications.length + 1}`, name: "New question", type: "radio", options: ["yes", "no"] }] }))
              }
            >
              <Icon name="plus" /> Add classification
            </button>
          </fieldset>
        )}
      </div>

      <aside className="stack" style={{ gap: 12, position: "sticky", top: 0 }}>
        <section className="panel">
          <div className="panel-head">
            <h3>Checks</h3>
            {issues.length === 0 ? <span className="badge badge-good">ok</span> : <span className={`badge ${errors.length ? "badge-bad" : "badge-warn"}`}>{issues.length}</span>}
          </div>
          <div className="panel-body" style={{ paddingTop: 8, paddingBottom: 8 }}>
            {issues.length === 0 ? (
              <p className="faint">No problems found.</p>
            ) : (
              <ul className="issues">
                {issues.map((i, k) => (
                  <li key={k} style={{ color: i.level === "error" ? "var(--bad)" : "var(--warn)" }}>
                    {i.level === "error" ? "Error" : "Warning"}: {i.msg}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h3>Live preview</h3>
            <span className="faint">what annotators see</span>
          </div>
          <Preview schema={schema} modality={project.modality} theme={theme} previewTool={previewTool} setPreviewTool={setPreviewTool} />
        </section>
      </aside>
    </div>
  );
}

function splitList(s: string) {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function ToolEditor({
  tool,
  allowed,
  usedColors,
  onChange,
  onRemove,
}: {
  tool: ToolDef;
  allowed: ToolType[];
  usedColors: string[];
  onChange: (fn: (t: ToolDef) => ToolDef) => void; onRemove: () => void }) {
  const upClass = (i: number, patch: Partial<ClassDef>) => onChange((t) => ({ ...t, classes: t.classes.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const upAttr = (i: number, patch: Partial<AttributeDef>) => onChange((t) => ({ ...t, attributes: (t.attributes ?? []).map((a, j) => (j === i ? { ...a, ...patch } : a)) }));
  return (
    <div className="schema-tool">
      <header>
        <Icon name={TOOL_ICON[tool.type]} />
        <input className="input" aria-label="Tool name" value={tool.name} onChange={(e) => onChange((t) => ({ ...t, name: e.target.value }))} style={{ flex: 1 }} />
        <input className="input mono" aria-label="Tool key" value={tool.key} onChange={(e) => onChange((t) => ({ ...t, key: e.target.value }))} style={{ width: 140 }} />
        <select className="select" aria-label="Tool type" value={tool.type} onChange={(e) => onChange((t) => ({ ...t, type: e.target.value as ToolType }))}>
          {(Object.keys(TOOL_NAMES) as ToolType[]).map((k) => (
            <option key={k} value={k} disabled={!allowed.includes(k)}>
              {TOOL_NAMES[k]}
            </option>
          ))}
        </select>
        <button className="btn btn-ghost btn-icon" aria-label={`Remove tool ${tool.name}`} onClick={onRemove}>
          <Icon name="trash" />
        </button>
      </header>
      <div className="body">
        <div className="class-row faint" style={{ fontSize: "var(--fs-xs)" }} aria-hidden="true">
          <span>Color</span>
          <span>Name</span>
          <span>Value</span>
          <span>Key</span>
          <span />
        </div>
        {tool.classes.map((c, i) => (
          <div key={i} className="class-row">
            <ColorField value={c.color} onChange={(color) => upClass(i, { color })} label={`${c.name} colour`} />
            <input
              className="input"
              aria-label="Class name"
              value={c.name}
              onChange={(e) => {
                const name = e.target.value;
                upClass(i, slug(c.name) === c.value || !c.value ? { name, value: slug(name) } : { name });
              }}
            />
            <input className="input mono" aria-label="Class value" value={c.value} onChange={(e) => upClass(i, { value: e.target.value })} />
            <input className="input" aria-label="Class hotkey" value={c.hotkey ?? ""} maxLength={1} onChange={(e) => upClass(i, { hotkey: e.target.value || undefined })} />
            <button className="btn btn-ghost btn-icon" aria-label={`Remove class ${c.name}`} onClick={() => onChange((t) => ({ ...t, classes: t.classes.filter((_, j) => j !== i) }))}>
              <Icon name="x" />
            </button>
          </div>
        ))}
        <div className="row">
          <button
            className="btn btn-sm"
            onClick={() =>
              onChange((t) => {
                const n = t.classes.length + 1;
                return { ...t, classes: [...t.classes, { value: `class_${n}`, name: `Class ${n}`, color: nextColor(usedColors), hotkey: n <= 9 ? String(n) : undefined }] };
              })
            }
          >
            <Icon name="plus" /> Class
          </button>
          <button
            className="btn btn-sm"
            onClick={() => onChange((t) => ({ ...t, attributes: [...(t.attributes ?? []), { key: `attr_${(t.attributes ?? []).length + 1}`, type: "select", options: ["low", "medium", "high"] }] }))}
          >
            <Icon name="plus" /> Attribute
          </button>
        </div>
        {(tool.attributes ?? []).map((a, i) => (
          <div key={i} className="row" style={{ gap: 8 }}>
            <span className="faint" style={{ width: 60, fontSize: "var(--fs-sm)" }}>
              attribute
            </span>
            <input className="input mono" aria-label="Attribute key" value={a.key} onChange={(e) => upAttr(i, { key: e.target.value })} style={{ width: 130 }} />
            <select className="select" aria-label="Attribute type" value={a.type} onChange={(e) => upAttr(i, { type: e.target.value as AttributeDef["type"] })}>
              <option value="select">Select</option>
              <option value="checkbox">Checkbox</option>
              <option value="text">Text</option>
              <option value="number">Number</option>
            </select>
            {a.type === "select" && (
              <input className="input" aria-label="Attribute options" placeholder="options, comma separated" value={(a.options ?? []).join(", ")} onChange={(e) => upAttr(i, { options: splitList(e.target.value) })} style={{ flex: 1 }} />
            )}
            <button className="btn btn-ghost btn-icon" aria-label={`Remove attribute ${a.key}`} onClick={() => onChange((t) => ({ ...t, attributes: (t.attributes ?? []).filter((_, j) => j !== i) }))}>
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ColorField({ value, onChange, label }: { value: string; onChange: (c: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: "relative" }}>
      <button
        type="button"
        className="color-input"
        style={{ background: value }}
        aria-label={`${label}: ${value}. Choose colour`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      {open && (
        <div
          className="panel"
          style={{ position: "absolute", zIndex: 5, top: 32, left: 0, padding: 8, width: 196, boxShadow: "var(--elev)" }}
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        >
          <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
            {PALETTE_LIGHT.map((c, i) => (
              <button
                key={c}
                type="button"
                aria-label={`Palette colour ${i + 1}`}
                aria-pressed={value.toLowerCase() === c}
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                }}
                style={{ width: 20, height: 20, borderRadius: 4, background: c, border: value.toLowerCase() === c ? "2px solid var(--text)" : "1px solid var(--border)", cursor: "pointer" }}
              />
            ))}
          </div>
          <label className="row" style={{ marginTop: 8 }}>
            <span className="faint" style={{ fontSize: 11 }}>
              Custom
            </span>
            <input type="color" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Custom colour" />
          </label>
          <div className="faint num" style={{ fontSize: 11, marginTop: 6 }}>
            {contrast(value, SURFACE_LIGHT).toFixed(1)}:1 on light, {contrast(displayColor(value, "dark"), SURFACE_DARK).toFixed(1)}:1 on dark
          </div>
        </div>
      )}
    </span>
  );
}

function Preview({
  schema,
  modality,
  theme,
  previewTool,
  setPreviewTool,
}: {
  schema: Schema;
  modality: Modality;
  theme: "light" | "dark";
  previewTool: string;
  setPreviewTool: (k: string) => void;
}) {
  const tools = schema.tools.filter((t) => MODALITY_TOOLS[modality].includes(t.type));
  const tool = tools.find((t) => t.key === previewTool) ?? tools[0] ?? null;
  const [active, setActive] = useState<string | null>(null);
  const store = useAnnStore([]);
  const cls = tool?.classes.find((c) => c.value === active) ?? tool?.classes[0] ?? null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "44px 1fr", minHeight: 240 }}>
      <Rail tools={tools} mode={tool?.key ?? "select"} setMode={setPreviewTool} modality={modality} />
      <div className="side" style={{ borderLeft: 0 }}>
        <section>
          <h3>{tool?.name ?? "Classes"}</h3>
          <ClassPicker tool={tool} active={cls} onPick={(c) => setActive(c.value)} theme={theme} />
        </section>
        {tool && tool.classes.length > 0 && (
          <section>
            <h3>Colours in both themes</h3>
            {tool.classes.map((c) => (
              <div key={c.value} className="row" style={{ fontSize: "var(--fs-sm)", padding: "2px 0" }}>
                <span style={{ flex: 1 }}>{c.name}</span>
                <span style={{ background: SURFACE_LIGHT, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--border)" }}>
                  <span style={{ background: displayColor(c.color, "light"), color: inkOn(displayColor(c.color, "light")), padding: "0 6px", borderRadius: 3, fontSize: 11 }}>{c.name}</span>
                </span>
                <span style={{ background: SURFACE_DARK, padding: "2px 6px", borderRadius: 4 }}>
                  <span style={{ background: displayColor(c.color, "dark"), color: inkOn(displayColor(c.color, "dark")), padding: "0 6px", borderRadius: 3, fontSize: 11 }}>{c.name}</span>
                </span>
              </div>
            ))}
          </section>
        )}
        {(tool?.attributes ?? []).length > 0 && (
          <section>
            <h3>Attributes</h3>
            {(tool!.attributes ?? []).map((a) => (
              <div key={a.key} className="faint" style={{ fontSize: "var(--fs-sm)" }}>
                {a.name ?? a.key}: {a.type === "select" ? (a.options ?? []).join(" / ") : a.type}
              </div>
            ))}
          </section>
        )}
        {schema.classifications.length > 0 && (
          <section>
            <h3>Item</h3>
            <Classifications schema={schema} anns={store.anns} edit={store.edit} />
          </section>
        )}
      </div>
    </div>
  );
}
