import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { Annotation, Consensus, Item, Project, Review as ReviewT } from "../api/types";
import { HelpButton, ThemeButton } from "../components/AppShell";
import { Icon } from "../components/Icon";
import { Empty, ErrorState, Loading } from "../components/States";
import { useAsync } from "../hooks/useAsync";
import { useHotkeys } from "../hooks/useHotkeys";
import { useMedia } from "../hooks/useMedia";
import { Rail, Workspace, describeGeometry } from "../editors/Panels";
import { useAnnStore } from "../editors/store";
import type { Anchor, GhostLayer, Pin } from "../editors/types";
import { className, fmtAgo, fmtClock, fmtScore, normalizeSchema, STATUS_META, classColor } from "../lib/format";
import { matchSets } from "../lib/match";
import { annotatorColor } from "../lib/palette";
import { useSession, useShortcutGroups, useTheme } from "../state";

/** /projects/:id/review: next item waiting for review. */
export function ReviewQueue() {
  const { id } = useParams();
  const pid = Number(id);
  const nav = useNavigate();
  const [state, setState] = useState<"loading" | "empty" | Error>("loading");
  const load = useCallback(() => {
    setState("loading");
    api.nextReview(pid).then(
      (r) => (r ? nav(`/projects/${pid}/items/${r.item.id}?queue=1`, { replace: true }) : setState("empty")),
      (e) => setState(e),
    );
  }, [pid, nav]);
  useEffect(load, [load]);
  return (
    <div className="app">
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
        {state === "loading" && <Loading label="Finding the next item to review" />}
        {state instanceof Error && <ErrorState error={state} onRetry={load} />}
        {state === "empty" && (
          <Empty title="Nothing to review" action={<Link className="btn" to={`/projects/${pid}/data`}>Browse data rows</Link>}>
            Items show up here once they have all their annotations submitted.
          </Empty>
        )}
      </main>
    </div>
  );
}

interface Layer {
  user_id: number;
  name: string;
  annotations: Annotation[];
}

interface Loaded {
  project: Project;
  item: Item;
  consensus: Consensus | null;
  layers: Layer[];
  reviews: ReviewT[];
  score: number | null;
}

async function load(pid: number, itemId: number): Promise<Loaded> {
  const [project, ri, consensus] = await Promise.all([api.project(pid), api.reviewItem(itemId), api.consensus(itemId).catch(() => null)]);
  const layers = ri.annotators.map((a) => ({ user_id: a.user.id, name: a.user.name, annotations: a.annotations }));
  return {
    project: { ...project, schema: normalizeSchema(project.schema) },
    item: ri.item,
    consensus,
    layers,
    reviews: ri.reviews,
    score: consensus?.score ?? ri.consensus_score,
  };
}

interface DiffRow {
  a: Annotation;
  b: Annotation;
  score: number;
  sameLabel: boolean;
}

/** Matched pairs and leftovers between two annotators: the server's matching when present, else the local one. */
function diffOf(A: Layer, B: Layer, consensus: Consensus | null) {
  const ga = A.annotations.filter((a) => a.geometry);
  const gb = B.annotations.filter((a) => a.geometry);
  if (consensus?.tools.length) {
    const byId = new Map<number, Annotation>([...ga, ...gb].filter((a) => a.id != null).map((a) => [a.id!, a]));
    const rows: DiffRow[] = [];
    const onlyA: Annotation[] = [];
    const onlyB: Annotation[] = [];
    for (const t of consensus.tools)
      for (const p of t.pairs) {
        const flip = p.a === B.user_id && p.b === A.user_id;
        if (!flip && !(p.a === A.user_id && p.b === B.user_id)) continue;
        for (const m of p.matches) {
          const a = byId.get((flip ? m.b_id : m.a_id) ?? -1);
          const b = byId.get((flip ? m.a_id : m.b_id) ?? -1);
          if (a && b) rows.push({ a, b, score: m.iou, sameLabel: m.label_match });
        }
        for (const id of flip ? p.unmatched_b : p.unmatched_a) id != null && byId.has(id) && onlyA.push(byId.get(id)!);
        for (const id of flip ? p.unmatched_a : p.unmatched_b) id != null && byId.has(id) && onlyB.push(byId.get(id)!);
      }
    return { rows, onlyA, onlyB };
  }
  const m = matchSets(ga, gb);
  return {
    rows: m.pairs.map((p) => ({ a: ga[p.i], b: gb[p.j], score: p.score, sameLabel: p.sameLabel })),
    onlyA: m.onlyA.map((i) => ga[i]),
    onlyB: m.onlyB.map((j) => gb[j]),
  };
}

export function ReviewItem() {
  const { id, itemId } = useParams();
  const { data, error, reload } = useAsync(() => load(Number(id), Number(itemId)), [id, itemId]);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading label="Loading item" />;
  return <ReviewView key={data.item.id} {...data} />;
}

interface DraftPin extends Anchor {
  id: string;
  body: string;
}

function ReviewView({ project, item, consensus, layers, reviews, score }: Loaded) {
  const nav = useNavigate();
  const { user } = useSession();
  const { theme } = useTheme();
  const schema = project.schema;
  const fromQueue = new URLSearchParams(location.search).has("queue");
  const [visible, setVisible] = useState<Set<number>>(new Set(layers.map((l) => l.user_id)));
  const [mode, setMode] = useState("select");
  const [pins, setPins] = useState<DraftPin[]>([]);
  const [comment, setComment] = useState("");
  const [picked, setPicked] = useState<Annotation | null>(null);
  const [colorBy, setColorBy] = useState<"annotator" | "class">("annotator");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const media = useMedia(project.modality === "text" ? null : item.id);
  const dummy = useAnnStore([]);
  const canDecide = user?.role === "reviewer" || user?.role === "admin";

  const ghosts: GhostLayer[] = layers
    .map((l, i) => ({ key: String(l.user_id), name: l.name, color: annotatorColor(i, theme), anns: l.annotations.filter((a) => a.geometry) }))
    .filter((g) => visible.has(Number(g.key)));

  // Pairwise diff between the first two visible annotators (or the server's pairs when present).
  const diff = useMemo(() => {
    const vis = layers.filter((l) => visible.has(l.user_id));
    if (vis.length < 2) return null;
    const [A, B] = vis;
    return { A, B, ...diffOf(A, B, consensus) };
  }, [layers, visible, consensus]);

  const pinsView: Pin[] = pins.map((p, i) => ({ ...p, index: i + 1 }));
  const addPin = (a: Anchor) => {
    setPins((ps) => [...ps, { id: `p${Date.now()}`, ...a, annotation_id: a.annotation_id ?? picked?.id ?? null, body: "" }]);
    // Focus the new note. A click on the canvas moves focus to the canvas on mousedown, after this
    // runs, so focus again when the click event arrives. A timer is too late: browsers run queued
    // key events before timers, so the first words would go to the canvas as hotkeys.
    const focusLast = () => {
      const els = document.querySelectorAll<HTMLTextAreaElement>(".pin-input");
      els[els.length - 1]?.focus();
    };
    window.addEventListener("click", focusLast, { once: true });
    setTimeout(() => {
      window.removeEventListener("click", focusLast);
      if (!(document.activeElement instanceof HTMLTextAreaElement)) focusLast();
    }, 300);
  };

  async function decide(decision: "approve" | "reject") {
    if (!canDecide || busy) return;
    if (decision === "reject" && !comment.trim() && !pins.some((p) => p.body.trim())) {
      setErr("Add a comment or a pinned note so the annotator knows what to fix.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.review(
        item.id,
        decision,
        comment.trim(),
        pins.filter((p) => p.body.trim()).map((p) => ({ annotation_id: p.annotation_id ?? null, body: p.body.trim(), x: p.x ?? null, y: p.y ?? null, t: p.t ?? null })),
      );
      if (fromQueue) nav(`/projects/${project.id}/review`, { replace: true });
      else nav(`/projects/${project.id}/data`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  const toggleLayer = (uid: number) => {
    const n = new Set(visible);
    if (n.has(uid)) n.delete(uid);
    else n.add(uid);
    setVisible(n);
  };
  const keys: Record<string, () => void> = {
    "mod+enter": () => decide("approve"),
    "shift+a": () => decide("approve"),
    "shift+r": () => decide("reject"),
    c: () => setMode(mode === "comment" ? "select" : "comment"),
    v: () => setMode("select"),
    escape: () => {
      setMode("select");
      setPicked(null);
    },
  };
  layers.slice(0, 9).forEach((l, i) => (keys[String(i + 1)] = () => toggleLayer(l.user_id)));
  useHotkeys(keys);
  useShortcutGroups([
    {
      title: "Review",
      keys: [
        ["1-9", "Show or hide an annotator"],
        ["C", "Pin a comment (click the canvas or timeline)"],
        ["V", "Inspect"],
        ["Shift+A or Mod+Enter", "Approve"],
        ["Shift+R", "Reject (needs a comment)"],
        ["Space", "Play or pause (audio, video)"],
      ],
    },
  ]);

  const text = project.modality === "text" ? String(item.meta.text ?? "") : undefined;
  const nameOf = (a: Annotation) => className(schema, a.schema_key, a.label);
  // Where an annotation is, in words a reviewer can find on the canvas or timeline.
  const whereOf = (a: Annotation) => {
    const g = a.geometry as Record<string, number> | null;
    if (g && "w" in g && !("keyframes" in g)) return `${Math.round(g.w)}x${Math.round(g.h)} at ${Math.round(g.x)}, ${Math.round(g.y)}`;
    return describeGeometry(a, text);
  };
  const owner = new Map<number, { name: string; ann: Annotation }>();
  layers.forEach((l) => l.annotations.forEach((a) => a.id != null && owner.set(a.id, { name: l.name, ann: a })));
  const rowStyle: React.CSSProperties = { width: "100%", background: "none", border: 0, borderBottom: "1px solid var(--border)", textAlign: "left", color: "inherit", font: "inherit", cursor: "pointer" };
  return (
    <div className="editor">
      <header className="editor-bar">
        <Link to={`/projects/${project.id}/data`} className="btn btn-ghost btn-icon" aria-label="Back to data rows">
          <Icon name="prev" />
        </Link>
        <div className="title">
          <strong>Review</strong>
          <span className="faint"> / </span>
          {project.name}
          <span className="faint"> / </span>
          <span className="mono">{item.filename}</span>
        </div>
        <span className={`badge ${STATUS_META[item.status]?.badge ?? ""}`}>{STATUS_META[item.status]?.label ?? item.status}</span>
        <span className="spacer" />
        {score != null && (
          <span className="muted num" title="Mean pairwise agreement over tools and classifications: F1 for shapes, match or Jaccard for classifications">
            agreement <strong style={{ color: "var(--text)" }}>{fmtScore(score)}</strong>
          </span>
        )}
        <HelpButton />
        <ThemeButton />
        {canDecide && (
          <>
            <button className="btn btn-danger" onClick={() => decide("reject")} disabled={busy} title="Reject (Shift+R)">
              <Icon name="x" /> Reject
            </button>
            <button className="btn btn-primary" onClick={() => decide("approve")} disabled={busy} title="Approve (Shift+A)">
              <Icon name="check" /> Approve
            </button>
          </>
        )}
      </header>
      <Rail
        tools={[]}
        mode={mode}
        setMode={setMode}
        modality={project.modality}
        extra={
          <button className="btn" aria-pressed={mode === "comment"} onClick={() => setMode(mode === "comment" ? "select" : "comment")} title="Pin a comment (C)" aria-label="Comment tool, C">
            <Icon name="comment" />
          </button>
        }
      />
      <div style={{ minWidth: 0, minHeight: 0, position: "relative" }}>
        {layers.length === 0 ? (
          <Empty title="No annotations on this item">Nobody has submitted work for it yet.</Empty>
        ) : media.error ? (
          <ErrorState error={media.error} />
        ) : (
          <Workspace
            modality={project.modality}
            item={item}
            media={media.url}
            schema={schema}
            anns={[]}
            ghosts={ghosts}
            selected={null}
            select={() => undefined}
            mode={mode === "comment" ? "comment" : mode}
            setMode={setMode}
            tool={null}
            activeClass={null}
            hidden={new Set()}
            locked={new Set()}
            edit={dummy.edit}
            theme={theme}
            readOnly
            pins={pinsView}
            onPin={addPin}
            onPickGhost={(a) => {
              setPicked(a);
              if (mode === "comment") addPin({ annotation_id: a.id ?? null, ...anchorOf(a) });
            }}
            pickedGhostId={picked?.id ?? null}
            ghostColorBy={colorBy}
          />
        )}
        {mode === "comment" && (
          <div
            className="stage-hud"
            style={
              // Audio has a time ruler along the top edge; keep the hint below it, at the right.
              project.modality === "audio"
                ? { top: 30, bottom: "auto", left: "auto", right: 8 }
                : { top: 8, bottom: "auto", left: "50%", transform: "translateX(-50%)" }
            }
          >
            Click to pin a comment. Click a shape to attach it to that annotation. Esc to stop.
          </div>
        )}
      </div>
      <aside className="side" aria-label="Review panel">
        <section>
          <h3>Annotators</h3>
          <div className="seg" role="group" aria-label="Colour shapes by" style={{ marginBottom: 8 }}>
            <button aria-pressed={colorBy === "annotator"} onClick={() => setColorBy("annotator")}>
              Colour by annotator
            </button>
            <button aria-pressed={colorBy === "class"} onClick={() => setColorBy("class")}>
              By class
            </button>
          </div>
          {layers.map((l, i) => (
            <label key={l.user_id} className="annotator-toggle">
              <input type="checkbox" checked={visible.has(l.user_id)} onChange={() => toggleLayer(l.user_id)} />
              <i className="swatch" style={{ background: annotatorColor(i, theme), borderRadius: 5 }} />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</span>
              <span className="faint num" style={{ fontSize: "var(--fs-xs)", whiteSpace: "nowrap" }} title="Mean agreement with the other annotators, and number of shapes">
                {consensus?.per_annotator?.[String(l.user_id)] != null ? `agr ${fmtScore(consensus.per_annotator[String(l.user_id)])} · ` : ""}
                {nShapes(l)} {nShapes(l) === 1 ? "shape" : "shapes"}
              </span>
              {i < 9 && <kbd>{i + 1}</kbd>}
            </label>
          ))}
          {!layers.length && <p className="faint">No submissions.</p>}
        </section>
        <section>
          <h3>Consensus diff</h3>
          {!diff ? (
            <p className="faint">Show two annotators to compare them.</p>
          ) : (
            <div>
              <p className="muted" style={{ fontSize: "var(--fs-sm)", marginBottom: 6 }}>
                {diff.A.name} vs {diff.B.name}: {diff.rows.length} matched, {diff.rows.filter((p) => !p.sameLabel).length} label conflicts, {diff.onlyA.length + diff.onlyB.length} unmatched
              </p>
              {diff.rows.map((p, k) => (
                <button key={k} className="diff-row" style={rowStyle} aria-pressed={picked?.id === p.a.id} onClick={() => setPicked(p.a)}>
                  <span className="row" style={{ gap: 6, minWidth: 0 }}>
                    <i className="swatch" style={{ background: classColor(schema, p.a.schema_key, p.a.label, theme) }} />
                    {nameOf(p.a)}
                    {!p.sameLabel && (
                      <span className="badge badge-warn" title="Label differs">
                        vs {nameOf(p.b)}
                      </span>
                    )}
                    <span className="faint num diff-where">{whereOf(p.a)}</span>
                  </span>
                  <span className="num" title="overlap (IoU)">{p.score.toFixed(2)}</span>
                </button>
              ))}
              {diff.onlyA.map((a, k) => (
                <button key={`a${k}`} className="diff-row" style={rowStyle} aria-pressed={picked?.id === a.id} onClick={() => setPicked(a)}>
                  <span style={{ minWidth: 0 }}>
                    {nameOf(a)} <span className="faint num diff-where">{whereOf(a)}</span> <span className="faint">only {diff.A.name}</span>
                  </span>
                  <span className="badge badge-bad">unmatched</span>
                </button>
              ))}
              {diff.onlyB.map((b, k) => (
                <button key={`b${k}`} className="diff-row" style={rowStyle} aria-pressed={picked?.id === b.id} onClick={() => setPicked(b)}>
                  <span style={{ minWidth: 0 }}>
                    {nameOf(b)} <span className="faint num diff-where">{whereOf(b)}</span> <span className="faint">only {diff.B.name}</span>
                  </span>
                  <span className="badge badge-bad">unmatched</span>
                </button>
              ))}
              <p className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 6 }}>
                Matched one-to-one by highest overlap (IoU at least 0.5 within the same tool).
              </p>
            </div>
          )}
        </section>
        {picked && (
          <section>
            <h3>Picked annotation</h3>
            <div className="row">
              <i className="swatch" style={{ background: classColor(schema, picked.schema_key, picked.label, theme) }} />
              <strong>{nameOf(picked)}</strong>
              <span className="faint num">{whereOf(picked)}</span>
            </div>
            {Object.entries(picked.attributes ?? {}).map(([k, v]) => (
              <div key={k} className="faint" style={{ fontSize: "var(--fs-sm)" }}>
                {k}: {String(v)}
              </div>
            ))}
            <button className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => addPin({ annotation_id: picked.id ?? null, ...anchorOf(picked) })}>
              <Icon name="comment" /> Comment on this
            </button>
          </section>
        )}
        <section>
          <h3>Comments</h3>
          {pinsView.map((p, i) => (
            <div key={p.id} className="comment">
              <div className="row" style={{ marginBottom: 4 }}>
                <span className="badge badge-accent">{p.index}</span>
                <span className="faint num" style={{ fontSize: 11 }}>
                  {p.annotation_id && owner.has(p.annotation_id)
                    ? `${nameOf(owner.get(p.annotation_id)!.ann)} (${owner.get(p.annotation_id)!.name})`
                    : ""}
                  {p.x != null ? ` at ${p.x}, ${p.y}` : ""}
                  {p.t != null ? (project.modality === "text" ? ` at char ${p.t}` : ` at ${fmtClock(p.t)}`) : ""}
                </span>
                <span className="spacer" />
                <button className="icon-btn btn btn-ghost btn-sm btn-icon" aria-label={`Remove comment ${p.index}`} onClick={() => setPins(pins.filter((_, j) => j !== i))}>
                  <Icon name="x" size={12} />
                </button>
              </div>
              <label>
                <span className="sr-only">Comment {p.index}</span>
                <textarea
                  className="textarea pin-input"
                  rows={2}
                  style={{ width: "100%" }}
                  value={p.body}
                  placeholder="What should change here?"
                  onChange={(e) => setPins(pins.map((q, j) => (j === i ? { ...q, body: e.target.value } : q)))}
                />
              </label>
            </div>
          ))}
          <label className="field">
            <span>Overall comment</span>
            <textarea className="textarea" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Optional for approve, required for reject" />
          </label>
          {err && (
            <div className="alert" role="alert" style={{ marginTop: 8 }}>
              {err}
            </div>
          )}
        </section>
        <section>
          <h3>History</h3>
          {reviews.length === 0 ? (
            <p className="faint">No earlier decisions.</p>
          ) : (
            <ul className="feed">
              {reviews.map((r) => (
                <li key={r.id} style={{ flexWrap: "wrap" }}>
                  <span className={`badge ${r.decision === "approve" ? "badge-good" : "badge-bad"}`}>{r.decision}</span>
                  {r.reviewer && <strong>{r.reviewer.name}</strong>}
                  <span className="muted">{r.comment || "No comment"}</span>
                  <time dateTime={r.created_at}>{fmtAgo(r.created_at)}</time>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}

const nShapes = (l: Layer) => l.annotations.filter((a) => a.geometry).length;

function anchorOf(a: Annotation): Anchor {
  const g = a.geometry as Record<string, unknown> | null;
  if (!g) return {};
  if ("keyframes" in g) {
    const k = (g.keyframes as { t: number; x: number; y: number }[])[0];
    return k ? { x: Math.round(k.x), y: Math.round(k.y), t: k.t } : {};
  }
  if ("start" in g) return { t: g.start as number };
  if ("points" in g) {
    const p = (g.points as [number, number][])[0];
    return p ? { x: Math.round(p[0]), y: Math.round(p[1]) } : {};
  }
  if ("x" in g) return { x: Math.round(g.x as number), y: Math.round(g.y as number) };
  return {};
}
