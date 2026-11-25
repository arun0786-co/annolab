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
      (it) => (it ? nav(`/projects/${pid}/items/${it.id}?queue=1`, { replace: true }) : setState("empty")),
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

interface Loaded {
  project: Project;
  item: Item;
  consensus: Consensus | null;
  layers: { user_id: number; name: string; annotations: Annotation[] }[];
  reviews: ReviewT[];
}

async function load(pid: number, itemId: number): Promise<Loaded> {
  const [project, item] = await Promise.all([api.project(pid), api.item(itemId)]);
  const consensus = await api.consensus(itemId).catch(() => null);
  let layers = consensus?.annotators ?? [];
  if (!layers.length) {
    const all = await api.annotations(itemId);
    const by = new Map<number, Annotation[]>();
    all.forEach((a) => by.set(a.user_id ?? 0, [...(by.get(a.user_id ?? 0) ?? []), a]));
    layers = [...by.entries()].map(([user_id, annotations]) => ({ user_id, name: `user ${user_id}`, annotations }));
  }
  const reviews = await api.reviews(itemId).catch(() => []);
  return { project: { ...project, schema: normalizeSchema(project.schema) }, item, consensus, layers, reviews };
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

function ReviewView({ project, item, consensus, layers, reviews }: Loaded) {
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
    const ga = A.annotations.filter((a) => a.geometry);
    const gb = B.annotations.filter((a) => a.geometry);
    return { A, B, ga, gb, ...matchSets(ga, gb) };
  }, [layers, visible]);

  const pinsView: Pin[] = pins.map((p, i) => ({ ...p, index: i + 1 }));
  const addPin = (a: Anchor) => {
    setPins((ps) => [...ps, { id: `p${Date.now()}`, ...a, annotation_id: a.annotation_id ?? picked?.id ?? null, body: "" }]);
    setTimeout(() => document.querySelector<HTMLTextAreaElement>(".pin-input:last-of-type")?.focus(), 0);
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
        {consensus && (
          <span className="muted num" title={consensus.metric}>
            agreement <strong style={{ color: "var(--text)" }}>{fmtScore(consensus.score)}</strong> <span className="faint">{consensus.metric}</span>
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
          />
        )}
        {mode === "comment" && (
          <div className="stage-hud" style={{ top: 8, bottom: "auto", left: "50%", transform: "translateX(-50%)" }}>
            Click to pin a comment. Click a shape to attach it to that annotation. Esc to stop.
          </div>
        )}
      </div>
      <aside className="side" aria-label="Review panel">
        <section>
          <h3>Annotators</h3>
          {layers.map((l, i) => (
            <label key={l.user_id} className="annotator-toggle">
              <input type="checkbox" checked={visible.has(l.user_id)} onChange={() => toggleLayer(l.user_id)} />
              <i className="swatch" style={{ background: annotatorColor(i, theme), borderRadius: 5 }} />
              <span style={{ flex: 1 }}>{l.name}</span>
              <span className="faint num">{l.annotations.filter((a) => a.geometry).length}</span>
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
                {diff.A.name} vs {diff.B.name}: {diff.pairs.length} matched, {diff.pairs.filter((p) => !p.sameLabel).length} label conflicts, {diff.onlyA.length + diff.onlyB.length} unmatched
              </p>
              {diff.pairs.map((p) => (
                <button
                  key={`${p.i}-${p.j}`}
                  className="diff-row"
                  style={{ width: "100%", background: "none", border: 0, borderBottom: "1px solid var(--border)", textAlign: "left", color: "inherit", font: "inherit", cursor: "pointer" }}
                  onClick={() => setPicked(diff.ga[p.i])}
                >
                  <span className="row" style={{ gap: 6 }}>
                    <i className="swatch" style={{ background: classColor(schema, diff.ga[p.i].schema_key, diff.ga[p.i].label, theme) }} />
                    {nameOf(diff.ga[p.i])}
                    {!p.sameLabel && (
                      <span className="badge badge-warn" title="Label differs">
                        vs {nameOf(diff.gb[p.j])}
                      </span>
                    )}
                  </span>
                  <span className="num">{p.score.toFixed(2)}</span>
                </button>
              ))}
              {diff.onlyA.map((i) => (
                <div key={`a${i}`} className="diff-row">
                  <span>
                    {nameOf(diff.ga[i])} <span className="faint">only {diff.A.name}</span>
                  </span>
                  <span className="badge badge-bad">miss</span>
                </div>
              ))}
              {diff.onlyB.map((j) => (
                <div key={`b${j}`} className="diff-row">
                  <span>
                    {nameOf(diff.gb[j])} <span className="faint">only {diff.B.name}</span>
                  </span>
                  <span className="badge badge-bad">miss</span>
                </div>
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
              <span className="faint num">{describeGeometry(picked, text)}</span>
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
                  {p.annotation_id ? `annotation #${p.annotation_id}` : ""}
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
