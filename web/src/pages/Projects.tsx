import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { Modality, Project, ProjectStats } from "../api/types";
import { Progress } from "../components/Charts";
import { Dialog } from "../components/Dialog";
import { Icon, MODALITY_ICON } from "../components/Icon";
import { Empty, ErrorState, SkeletonRows } from "../components/States";
import { useAsync } from "../hooks/useAsync";
import { useHotkeys } from "../hooks/useHotkeys";
import { fmtScore, STATUS_META } from "../lib/format";
import { useSession, useShortcutGroups } from "../state";
import { ITEM_STATUSES } from "../api/types";

type Row = Project & { stats?: ProjectStats };

async function load(): Promise<Row[]> {
  const ps = await api.projects();
  const stats = await Promise.allSettled(ps.map((p) => api.stats(p.id)));
  return ps.map((p, i) => ({ ...p, stats: stats[i].status === "fulfilled" ? stats[i].value : undefined }));
}

export function Projects() {
  const { user } = useSession();
  const { data, error, loading, reload } = useAsync(load, []);
  const [filter, setFilter] = useState<"all" | Modality>("all");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [cursor, setCursor] = useState(0);
  const nav = useNavigate();

  const rows = useMemo(
    () =>
      (data ?? []).filter(
        (p) => (filter === "all" || p.modality === filter) && (!q || p.name.toLowerCase().includes(q.toLowerCase())),
      ),
    [data, filter, q],
  );

  useShortcutGroups([
    {
      title: "Projects",
      keys: [
        ["J or ArrowDown", "Next project"],
        ["K or ArrowUp", "Previous project"],
        ["Enter", "Open project"],
        ["L", "Start labeling selected project"],
        ["/", "Search"],
        ["N", "New project (admin)"],
      ],
    },
  ]);
  const move = (d: number) => setCursor((c) => Math.max(0, Math.min(rows.length - 1, c + d)));
  useHotkeys({
    j: () => move(1),
    arrowdown: () => move(1),
    k: () => move(-1),
    arrowup: () => move(-1),
    enter: () => rows[cursor] && nav(`/projects/${rows[cursor].id}`),
    l: () => rows[cursor] && nav(`/projects/${rows[cursor].id}/label`),
    "/": () => document.getElementById("project-search")?.focus(),
    n: () => user?.role === "admin" && setCreating(true),
  });

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Projects</h1>
          <p>{data ? `${data.length} projects` : " "}</p>
        </div>
        {user?.role === "admin" && (
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" /> New project
          </button>
        )}
      </div>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Filter by modality">
          {(["all", "image", "audio", "video", "text"] as const).map((m) => (
            <button key={m} aria-pressed={filter === m} onClick={() => setFilter(m)}>
              {m === "all" ? "All" : m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        <label className="row" style={{ marginLeft: "auto" }}>
          <span className="sr-only">Search projects</span>
          <input id="project-search" className="input" placeholder="Search  /" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      {loading && !data ? (
        <div className="table-wrap">
          <SkeletonRows rows={4} cols={6} />
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !rows.length ? (
        <div className="panel">
          <Empty
            title={data?.length ? "No projects match" : "No projects yet"}
            action={
              user?.role === "admin" && !data?.length ? (
                <button className="btn btn-primary" onClick={() => setCreating(true)}>
                  Create a project
                </button>
              ) : undefined
            }
          >
            {data?.length ? "Try another filter or search." : "An admin creates projects. Seed demo data with make seed."}
          </Empty>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Modality</th>
                <th style={{ width: "26%" }}>Progress</th>
                <th className="r">Items</th>
                <th className="r">Done</th>
                <th className="r">Agreement</th>
                <th className="r">Per item</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => {
                const s = p.stats;
                const total = s?.total ?? p.item_count ?? 0;
                const done = s ? s.counts.labeled + s.counts.in_review + s.counts.approved : 0;
                return (
                  <tr key={p.id} aria-selected={i === cursor} onMouseEnter={() => setCursor(i)}>
                    <td>
                      <Link to={`/projects/${p.id}`} style={{ color: "var(--text)", fontWeight: 500 }}>
                        {p.name}
                      </Link>
                      <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>
                        {p.description}
                      </div>
                    </td>
                    <td>
                      <span className="modality">
                        <Icon name={MODALITY_ICON[p.modality]} /> {p.modality}
                      </span>
                    </td>
                    <td>
                      {s ? (
                        <Progress
                          label={ITEM_STATUSES.map((k) => `${STATUS_META[k].label} ${s.counts[k]}`).join(", ")}
                          parts={ITEM_STATUSES.map((k) => ({ value: s.counts[k], color: STATUS_META[k].color }))}
                        />
                      ) : (
                        <span className="faint">–</span>
                      )}
                    </td>
                    <td className="r">{total}</td>
                    <td className="r">{total ? `${Math.round((done / total) * 100)}%` : "–"}</td>
                    <td className="r">{fmtScore(s?.agreement.mean ?? p.agreement)}</td>
                    <td className="r">{p.annotators_per_item}x</td>
                    <td className="r">
                      <Link className="btn btn-sm" to={`/projects/${p.id}/label`} tabIndex={-1}>
                        Label
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewProject onClose={() => setCreating(false)} onCreated={(id) => nav(`/projects/${id}/schema`)} />}
    </div>
  );
}

function NewProject({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [name, setName] = useState("");
  const [modality, setModality] = useState<Modality>("image");
  const [description, setDescription] = useState("");
  const [per, setPer] = useState(1);
  const [review, setReview] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    setErr(null);
    try {
      const p = await api.createProject({
        name,
        modality,
        description,
        annotators_per_item: per,
        review_required: review,
        schema: { tools: [], classifications: [] },
      });
      onCreated(p.id);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="New project"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={create} disabled={!name.trim() || busy}>
            Create and edit schema
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <label className="field">
          <span>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>Description</span>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="grid grid-2">
          <label className="field">
            <span>Modality</span>
            <select className="select" value={modality} onChange={(e) => setModality(e.target.value as Modality)}>
              <option value="image">Image</option>
              <option value="audio">Audio</option>
              <option value="video">Video</option>
              <option value="text">Text</option>
            </select>
          </label>
          <label className="field">
            <span>Annotators per item</span>
            <input className="input" type="number" min={1} max={10} value={per} onChange={(e) => setPer(Number(e.target.value) || 1)} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} /> Require review before an item is done
        </label>
        {err && <div className="alert">{err}</div>}
      </div>
    </Dialog>
  );
}
