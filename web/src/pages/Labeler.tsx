import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { Annotation, ClassDef, Item, Project, Review, Task } from "../api/types";
import { HelpButton, ThemeButton } from "../components/AppShell";
import { Icon } from "../components/Icon";
import { Empty, ErrorState, Loading } from "../components/States";
import { useAsync } from "../hooks/useAsync";
import { useAutosave, type SaveState } from "../hooks/useAutosave";
import { MOD_LABEL, useHotkeys } from "../hooks/useHotkeys";
import { useMedia } from "../hooks/useMedia";
import { fmtAgo, fmtClock, normalizeSchema, STATUS_META, uid } from "../lib/format";
import { AnnotationList, AttributePanel, ClassPicker, Classifications, classHotkey, MODALITY_TOOLS, Rail, TOOL_KEY, toolHotkeys, Workspace } from "../editors/Panels";
import { useAnnStore } from "../editors/store";
import { toolFor, type Ann, type Pin } from "../editors/types";
import { useSession, useShortcutGroups, useTheme, type ShortcutGroup } from "../state";

/** /projects/:id/label asks the queue for the next task and redirects to it. */
export function QueueEntry() {
  const { id } = useParams();
  const pid = Number(id);
  const nav = useNavigate();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "empty"; project?: Project } | { kind: "error"; error: Error }>({ kind: "loading" });
  const load = useCallback(() => {
    setState({ kind: "loading" });
    api.nextTask(pid).then(
      async (t) => {
        if (t) nav(`/projects/${pid}/label/${t.id}`, { replace: true });
        else setState({ kind: "empty", project: await api.project(pid).catch(() => undefined) });
      },
      (error) => setState({ kind: "error", error }),
    );
  }, [pid, nav]);
  useEffect(load, [load]);
  return (
    <div className="app" style={{ gridTemplateRows: "44px 1fr" }}>
      <header className="topbar">
        <Link to={`/projects/${pid}`} className="btn btn-ghost btn-sm">
          <Icon name="prev" /> Back to project
        </Link>
        <div className="topbar-right">
          <HelpButton />
          <ThemeButton />
        </div>
      </header>
      <main className="main">
        {state.kind === "loading" && <Loading label="Finding the next item" />}
        {state.kind === "error" && <ErrorState error={state.error} onRetry={load} />}
        {state.kind === "empty" && (
          <Empty
            title="Queue is empty"
            action={
              <div className="row">
                <Link className="btn" to={`/projects/${pid}`}>
                  Project overview
                </Link>
                <button className="btn" onClick={load}>
                  Check again
                </button>
              </div>
            }
          >
            You have labeled every item available to you{state.project ? ` in ${state.project.name}` : ""}. Items that already have enough annotators are not served again.
          </Empty>
        )}
      </main>
    </div>
  );
}

interface Loaded {
  project: Project;
  task: Task;
  item: Item;
  anns: Annotation[];
}

async function loadTask(pid: number, taskId: number, userId: number): Promise<Loaded> {
  const [project, task] = await Promise.all([api.project(pid), api.task(taskId)]);
  const item = task.item ?? (await api.item(task.item_id));
  const all = task.annotations ?? (await api.annotations(item.id, userId));
  const anns = all.filter((a) => a.task_id == null || a.task_id === task.id);
  return { project: { ...project, schema: normalizeSchema(project.schema) }, task, item, anns };
}

export function LabelTask() {
  const { id, taskId } = useParams();
  const { user } = useSession();
  const { data, error, reload } = useAsync(() => loadTask(Number(id), Number(taskId), user!.id), [id, taskId, user?.id]);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading label="Loading item" />;
  return <Labeler key={data.task.id} {...data} />;
}

function toAnns(xs: Annotation[]): Ann[] {
  return xs.map((a) => ({ ...a, cid: a.id != null ? `s${a.id}` : uid(), attributes: a.attributes ?? {} }));
}

function strip(a: Ann): Annotation {
  const { cid: _cid, id: _id, task_id: _t, item_id: _i, user_id: _u, created_at: _c, updated_at: _up, ...rest } = a;
  void _cid, _id, _t, _i, _u, _c, _up;
  return rest;
}

function Labeler({ project, task, item, anns: initial }: Loaded) {
  const nav = useNavigate();
  const { theme } = useTheme();
  const schema = project.schema;
  const tools = useMemo(() => schema.tools.filter((t) => MODALITY_TOOLS[project.modality].includes(t.type)), [schema, project.modality]);
  const store = useAnnStore(useMemo(() => toAnns(initial), [initial]));
  const { anns, edit } = store;
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<string>(tools[0]?.key ?? "select");
  const [classByTool, setClassByTool] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [locked, setLocked] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<"submit" | "skip" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const media = useMedia(project.modality === "text" ? null : item.id);
  const elapsed = useElapsed(task.time_spent_ms ?? 0);

  const selAnn = anns.find((a) => a.cid === selected) ?? null;
  // The tool whose classes are shown: the mode's tool, else the selected annotation's tool, else the first tool.
  const tool = toolFor(schema, mode) ?? (selAnn ? toolFor(schema, selAnn.schema_key) : undefined) ?? tools[0] ?? null;
  const activeClass: ClassDef | null = tool ? tool.classes.find((c) => c.value === classByTool[tool.key]) ?? tool.classes[0] ?? null : null;
  const drawTool = toolFor(schema, mode) ?? (project.modality === "text" ? tools[0] : undefined) ?? null;

  const autosave = useAutosave(anns, (xs) => api.saveAnnotations(task.id, xs.map(strip), elapsed.get()), { key: task.id });

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const pickClass = (c: ClassDef) => {
    if (!tool) return;
    setClassByTool((m) => ({ ...m, [tool.key]: c.value }));
    // Relabel only while editing a selection; in a drawing tool the number keys just pick the next class.
    const editing = mode === "select" || mode === "pan" || project.modality === "text";
    if (editing && selAnn && selAnn.schema_key === tool.key && selAnn.label !== c.value && !locked.has(selAnn.cid))
      edit.patch(selAnn.cid, (a) => ({ ...a, label: c.value }));
  };

  async function next() {
    const t = await api.nextTask(project.id).catch(() => null);
    if (t) nav(`/projects/${project.id}/label/${t.id}`);
    else nav(`/projects/${project.id}/label`);
  }

  async function submit() {
    if (busy) return;
    setBusy("submit");
    setActionError(null);
    try {
      await autosave.flush();
      await api.submitTask(task.id, elapsed.get());
      setToast("Submitted");
      await next();
    } catch (e) {
      setActionError(`Submit failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }
  async function skip() {
    if (busy) return;
    setBusy("skip");
    setActionError(null);
    try {
      await autosave.flush().catch(() => undefined);
      await api.skipTask(task.id);
      await next();
    } catch (e) {
      setActionError(`Skip failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, cid: string) => {
    const n = new Set(set);
    if (n.has(cid)) n.delete(cid);
    else n.add(cid);
    setter(n);
  };
  const remove = (cid: string) => {
    if (locked.has(cid)) return;
    edit.remove(cid);
    if (selected === cid) setSelected(null);
  };

  const keys: Record<string, () => void> = {
    "mod+z": store.undo,
    "mod+shift+z": store.redo,
    "mod+y": store.redo,
    enter: submit,
    "mod+enter": submit,
    s: skip,
    delete: () => selected && remove(selected),
    escape: () => setSelected(null),
    "shift+h": () => selected && toggle(hidden, setHidden, selected),
    "shift+l": () => selected && toggle(locked, setLocked, selected),
    a: () => selected && edit.patch(selected, (a) => ({ ...a, source: "human" })),
  };
  if (project.modality !== "text") keys.v = () => setMode("select");
  if (project.modality === "image") keys.h = () => setMode("pan");
  for (const [k, tk] of Object.entries(toolHotkeys(tools))) keys[k] = () => setMode(tk);
  tool?.classes.forEach((c, i) => {
    const hk = classHotkey(c, i);
    if (hk) keys[hk.toLowerCase()] = () => pickClass(c);
  });
  useHotkeys(keys);

  useShortcutGroups(shortcutGroups(project.modality, tools.map((t) => [TOOL_KEY[t.type].toUpperCase(), t.name])));

  // The latest review, if it sent this item back, is shown with its pinned comments.
  const feedback: Review | null = task.reviews?.[0]?.decision === "reject" && task.status !== "submitted" ? task.reviews[0] : null;
  const pins: Pin[] = (feedback?.comments ?? []).map((c, i) => ({ ...c, id: `r${c.id}`, index: i + 1 }));

  const commonProps = {
    item,
    media: media.url,
    schema,
    anns,
    selected,
    select: setSelected,
    mode,
    setMode,
    tool: drawTool,
    activeClass: drawTool ? drawTool.classes.find((c) => c.value === classByTool[drawTool.key]) ?? drawTool.classes[0] ?? null : null,
    hidden,
    locked,
    edit,
    theme,
    pins,
  };

  const selTool = selAnn ? toolFor(schema, selAnn.schema_key) : undefined;
  return (
    <div className="editor">
      <header className="editor-bar">
        <Link to={`/projects/${project.id}`} className="btn btn-ghost btn-icon" aria-label="Back to project" title="Back to project">
          <Icon name="prev" />
        </Link>
        <div className="title">
          <strong>{project.name}</strong>
          <span className="faint"> / </span>
          <span className="mono">{item.filename}</span>
        </div>
        <span className={`badge ${STATUS_META[item.status]?.badge ?? ""}`}>{STATUS_META[item.status]?.label ?? item.status}</span>
        {task.status === "submitted" && <span className="badge badge-good">submitted</span>}
        <span className="spacer" />
        <SaveStatus state={autosave.state} />
        <span className="timer" title="Time on this item" aria-label={`Time on item ${Math.floor(elapsed.ms / 1000)} seconds`}>
          {fmtTimer(elapsed.ms)}
        </span>
        <button className="btn btn-ghost btn-icon" onClick={store.undo} disabled={!store.canUndo} aria-label="Undo" title={`Undo (${MOD_LABEL}+Z)`}>
          <Icon name="undo" />
        </button>
        <button className="btn btn-ghost btn-icon" onClick={store.redo} disabled={!store.canRedo} aria-label="Redo" title={`Redo (Shift+${MOD_LABEL}+Z)`}>
          <Icon name="redo" />
        </button>
        <HelpButton />
        <ThemeButton />
        <button className="btn" onClick={skip} disabled={!!busy} title="Skip (S)">
          Skip <kbd>S</kbd>
        </button>
        <button className="btn btn-primary" onClick={submit} disabled={!!busy} title="Submit (Enter)">
          {busy === "submit" ? "Submitting" : "Submit"}
        </button>
      </header>
      <Rail tools={tools} mode={mode} setMode={setMode} modality={project.modality} />
      <div style={{ minWidth: 0, minHeight: 0, position: "relative" }}>
        {media.error ? <ErrorState error={media.error} /> : <Workspace modality={project.modality} {...commonProps} />}
        {actionError && (
          <div className="alert" role="alert" style={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)" }}>
            {actionError}
          </div>
        )}
      </div>
      <aside className="side" aria-label="Labels and annotations">
        {feedback && (
          <ReviewerFeedback
            review={feedback}
            pins={pins}
            text={project.modality === "text" ? String(item.meta.text ?? "") : undefined}
            onPick={(pin) => pin.annotation_id != null && anns.some((a) => a.id === pin.annotation_id) && setSelected(`s${pin.annotation_id}`)}
          />
        )}
        <section>
          <h3>{tool ? tool.name : "Classes"}</h3>
          <ClassPicker tool={tool} active={activeClass} onPick={pickClass} theme={theme} />
        </section>
        {selAnn && selTool && (
          <section>
            <h3>Selected</h3>
            <AttributePanel ann={selAnn} tool={selTool} edit={edit} readOnly={locked.has(selAnn.cid)} />
          </section>
        )}
        {schema.classifications.length > 0 && (
          <section>
            <h3>Item</h3>
            <Classifications schema={schema} anns={anns} edit={edit} />
          </section>
        )}
        <section>
          <h3>
            Annotations <span className="num">({anns.filter((a) => a.geometry).length})</span>
          </h3>
          <AnnotationList
            anns={anns}
            schema={schema}
            selected={selected}
            select={setSelected}
            hidden={hidden}
            locked={locked}
            toggleHidden={(c) => toggle(hidden, setHidden, c)}
            toggleLocked={(c) => toggle(locked, setLocked, c)}
            remove={remove}
            theme={theme}
            text={project.modality === "text" ? String(item.meta.text ?? "") : undefined}
          />
        </section>
        {project.instructions && (
          <section>
            <details>
              <summary className="muted" style={{ cursor: "pointer" }}>
                Instructions
              </summary>
              <p style={{ whiteSpace: "pre-wrap", marginTop: 8 }} className="muted">
                {project.instructions}
              </p>
            </details>
          </section>
        )}
      </aside>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function ReviewerFeedback({ review, pins, text, onPick }: { review: Review; pins: Pin[]; text?: string; onPick: (p: Pin) => void }) {
  const anchor = (p: Pin) => {
    if (text !== undefined && p.t != null) return `char ${Math.round(p.t)}`;
    if (p.t != null) return fmtClock(p.t);
    if (p.x != null && p.y != null) return `${Math.round(p.x)}, ${Math.round(p.y)}`;
    return "";
  };
  return (
    <section className="feedback" aria-label="Reviewer feedback">
      <h3>
        Sent back by {review.reviewer?.name ?? "reviewer"} <span className="faint">{fmtAgo(review.created_at)}</span>
      </h3>
      {review.comment && <p className="feedback-note">{review.comment}</p>}
      {pins.length > 0 && (
        <ol className="feedback-pins">
          {pins.map((p) => (
            <li key={p.id}>
              <button className="btn btn-ghost btn-sm" onClick={() => onPick(p)} disabled={p.annotation_id == null}>
                <span className="pin-num" aria-hidden="true">
                  {p.index}
                </span>
                <span className="feedback-body">{p.body}</span>
                <span className="faint num">{p.annotation_id != null ? "on annotation" : anchor(p)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function SaveStatus({ state }: { state: SaveState }) {
  const label = { saved: "Saved", saving: "Saving", pending: "Unsaved", offline: "Offline, retrying", error: "Save failed, retrying" }[state];
  return (
    <span className="save-status" data-state={state === "pending" ? "saving" : state} role="status" aria-live="polite">
      <span className="dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function fmtTimer(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Time on the item, counted only while the tab is visible. */
function useElapsed(start: number) {
  const [ms, setMs] = useState(start);
  const ref = useRef(start);
  useEffect(() => {
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      if (document.visibilityState === "visible") ref.current += now - last;
      last = now;
      setMs(ref.current);
    }, 500);
    return () => clearInterval(id);
  }, []);
  return { ms, get: () => Math.round(ref.current) };
}

function shortcutGroups(modality: string, tools: [string, string][]): ShortcutGroup[] {
  const common: ShortcutGroup = {
    title: "Labeling",
    keys: [
      ["1-9", "Pick class (in Select mode, relabels the selection)"],
      ...(modality !== "text" ? ([["V", "Select tool"]] as [string, string][]) : []),
      ...tools,
      ["Mod+Z", "Undo"],
      ["Shift+Mod+Z or Mod+Y", "Redo"],
      ["Del", "Delete selection"],
      ["Esc", "Clear selection"],
      ["Shift+H", "Hide or show selection"],
      ["Shift+L", "Lock or unlock selection"],
      ["A", "Accept selected proposal"],
      ["Enter", "Submit and go to next"],
      ["S", "Skip"],
    ],
  };
  const per: Record<string, ShortcutGroup> = {
    image: {
      title: "Image",
      keys: [
        ["H or Space", "Pan (hold Space and drag)"],
        ["Plus or Minus", "Zoom in or out"],
        ["0 or F", "Fit to screen"],
        ["Arrows", "Nudge selection 1 px (Shift: 10 px)"],
        ["Enter", "Close polygon while drawing"],
        ["Delete", "Remove last polygon point while drawing"],
      ],
    },
    audio: {
      title: "Audio",
      keys: [
        ["Space", "Play or pause"],
        ["[ or ]", "Step 0.1 s"],
        ["{ or }", "Step 1 s"],
        ["Plus or Minus", "Zoom time"],
        ["0", "Show full length"],
        ["W", "Waveform or spectrogram"],
        [", or .", "Slower or faster playback"],
        ["M", "Propose segments"],
        ["Shift+A", "Accept all proposals"],
        ["Tab", "Next segment (when the plot has focus)"],
      ],
    },
    video: {
      title: "Video",
      keys: [
        ["Space", "Play or pause"],
        ["[ or ]", "Previous or next frame"],
        ["{ or }", "Back or forward 1 s"],
        ["K", "Set keyframe on selected track"],
        ["Shift+K", "Remove keyframe here"],
        ["N or Shift+N", "Next or previous keyframe"],
        ["E", "Mark segment in, then out (segment tool)"],
        [", or .", "Slower or faster playback"],
      ],
    },
    text: {
      title: "Text",
      keys: [
        ["Drag", "Select words to create a span"],
        ["Shift+ArrowRight", "Grow selected span end"],
        ["Shift+ArrowLeft", "Shrink selected span end"],
        ["Alt+Shift+Arrows", "Move selected span start"],
      ],
    },
  };
  return [common, per[modality]].filter(Boolean);
}
