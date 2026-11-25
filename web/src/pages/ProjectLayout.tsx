import { useState } from "react";
import { NavLink, Outlet, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { api } from "../api/client";
import type { Project } from "../api/types";
import { Crumbs } from "../components/AppShell";
import { ExportDialog } from "../components/ExportDialog";
import { Icon, MODALITY_ICON } from "../components/Icon";
import { ErrorState, Loading } from "../components/States";
import { useAsync } from "../hooks/useAsync";
import { useHotkeys } from "../hooks/useHotkeys";
import { normalizeSchema } from "../lib/format";
import { useSession, useShortcutGroups } from "../state";

export interface ProjectCtx {
  project: Project;
  setProject: (p: Project) => void;
  reload: () => void;
}

export function useProject() {
  return useOutletContext<ProjectCtx>();
}

export function ProjectLayout() {
  const { id } = useParams();
  const pid = Number(id);
  const { user } = useSession();
  const nav = useNavigate();
  const { data, error, loading, reload, setData } = useAsync(
    () => api.project(pid).then((p) => ({ ...p, schema: normalizeSchema(p.schema) })),
    [pid],
  );
  const [exporting, setExporting] = useState(false);
  const canReview = user?.role === "reviewer" || user?.role === "admin";
  useShortcutGroups([
    {
      title: "Project",
      keys: [
        ["L", "Start labeling"],
        ["R", "Open review queue"],
        ["E", "Export"],
      ],
    },
  ]);
  useHotkeys({
    l: () => nav(`/projects/${pid}/label`),
    r: () => canReview && nav(`/projects/${pid}/review`),
    e: () => setExporting(true),
  });

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  const p = data;
  return (
    <div className="page">
      <Crumbs items={[{ label: "Projects", to: "/" }, { label: p.name }]} />
      <div className="page-head">
        <div className="grow">
          <h1 className="row">
            <Icon name={MODALITY_ICON[p.modality]} size={18} /> {p.name}
          </h1>
          <p>
            {p.description || "No description"} · {p.annotators_per_item} annotator{p.annotators_per_item > 1 ? "s" : ""} per item
            {p.review_required ? " · review required" : ""}
          </p>
        </div>
        <button className="btn" onClick={() => setExporting(true)}>
          <Icon name="download" /> Export
        </button>
        {canReview && (
          <button className="btn" onClick={() => nav(`/projects/${pid}/review`)}>
            <Icon name="check" /> Review
          </button>
        )}
        <button className="btn btn-primary" onClick={() => nav(`/projects/${pid}/label`)}>
          Start labeling
        </button>
      </div>
      <nav className="tabs" aria-label="Project sections">
        <NavLink to={`/projects/${pid}`} end>
          Overview
        </NavLink>
        <NavLink to={`/projects/${pid}/data`}>Data rows</NavLink>
        <NavLink to={`/projects/${pid}/schema`}>Schema</NavLink>
      </nav>
      <Outlet
        context={
          {
            project: p,
            setProject: (np: Project) => setData({ ...np, schema: normalizeSchema(np.schema) }),
            reload,
          } satisfies ProjectCtx
        }
      />
      {exporting && <ExportDialog project={p} onClose={() => setExporting(false)} />}
    </div>
  );
}
