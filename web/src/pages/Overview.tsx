import { api } from "../api/client";
import type { ActivityEvent, ProjectStats } from "../api/types";
import { ITEM_STATUSES } from "../api/types";
import { HBarChart, StackedBar } from "../components/Charts";
import { Empty, ErrorState, SkeletonRows } from "../components/States";
import { useAsync } from "../hooks/useAsync";
import { fmtAgo, fmtScore, fmtSeconds, STATUS_META } from "../lib/format";
import { displayColor } from "../lib/palette";
import { useTheme } from "../state";
import { useProject } from "./ProjectLayout";

function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const METRIC_NAME: Record<string, string> = {
  iou: "mean IoU",
  temporal_iou: "mean temporal IoU",
  kappa: "Cohen's kappa",
  fleiss_kappa: "Fleiss' kappa",
  span_f1: "span F1",
};

export function Overview() {
  const { project } = useProject();
  const { theme } = useTheme();
  const stats = useAsync(() => api.stats(project.id), [project.id]);
  const activity = useAsync(() => api.activity(project.id, 25), [project.id]);

  if (stats.error) return <ErrorState error={stats.error} onRetry={stats.reload} />;
  const s = stats.data;
  const colorOf = (label: string, key?: string) => {
    for (const t of project.schema.tools) {
      if (key && t.key !== key) continue;
      const c = t.classes.find((c) => c.value === label);
      if (c) return displayColor(c.color, theme);
    }
    return "var(--text-3)";
  };
  const nameOf = (label: string, key?: string) => {
    for (const t of project.schema.tools) {
      if (key && t.key !== key) continue;
      const c = t.classes.find((c) => c.value === label);
      if (c) return c.name;
    }
    return label;
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="grid grid-4">
        <Tile label="Items" value={s ? String(s.total) : null} sub={s ? `${s.counts.unlabeled} unlabeled` : ""} />
        <Tile
          label="Labeled or later"
          value={s ? `${s.total ? Math.round(((s.total - s.counts.unlabeled - s.counts.in_progress) / s.total) * 100) : 0}%` : null}
          sub={s ? `${s.counts.approved} approved, ${s.counts.rejected} rejected` : ""}
        />
        <Tile
          label="Median time per item"
          value={s ? fmtSeconds(median(s.annotators.map((a) => a.median_seconds).filter((x): x is number => x != null))) : null}
          sub={s ? `across ${s.annotators.length} annotators` : ""}
        />
        <Tile
          label="Agreement"
          value={s ? fmtScore(s.agreement.mean) : null}
          sub={s ? `${METRIC_NAME[s.agreement.metric ?? ""] ?? s.agreement.metric ?? "score"} over ${s.agreement.items} items` : ""}
        />
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Progress by status</h2>
        </div>
        <div className="panel-body">
          {s ? (
            <StackedBar parts={ITEM_STATUSES.map((k) => ({ key: k, label: STATUS_META[k].label, value: s.counts[k], color: STATUS_META[k].color }))} />
          ) : (
            <SkeletonRows rows={1} cols={1} />
          )}
        </div>
      </section>

      <div className="grid grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Throughput per annotator</h2>
            <span className="faint">submitted items</span>
          </div>
          <div className="panel-body">
            {s ? (
              <Throughput s={s} />
            ) : (
              <SkeletonRows rows={3} cols={2} />
            )}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Label distribution</h2>
            <span className="faint">annotations</span>
          </div>
          <div className="panel-body">
            {s ? (
              <HBarChart
                rows={[...s.labels]
                  .sort((a, b) => b.count - a.count)
                  .slice(0, 12)
                  .map((l) => ({ key: `${l.schema_key ?? ""}:${l.label}`, label: nameOf(l.label, l.schema_key), value: l.count, color: colorOf(l.label, l.schema_key) }))}
                empty="No submitted annotations yet."
              />
            ) : (
              <SkeletonRows rows={3} cols={2} />
            )}
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Recent activity</h2>
        </div>
        <div className="panel-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
          {activity.error ? (
            <ErrorState error={activity.error} onRetry={activity.reload} />
          ) : !activity.data ? (
            <SkeletonRows rows={4} cols={3} />
          ) : !activity.data.length ? (
            <Empty title="No activity yet">Submissions, reviews and uploads show up here.</Empty>
          ) : (
            <ul className="feed">
              {activity.data.map((e) => (
                <li key={e.id}>
                  <strong>{e.user_name ?? (e.user_id ? `user ${e.user_id}` : "system")}</strong>
                  <span className="muted">{describe(e)}</span>
                  <time dateTime={e.at}>{fmtAgo(e.at)}</time>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function Throughput({ s }: { s: ProjectStats }) {
  if (!s.annotators.length) return <p className="faint">Nobody has submitted yet.</p>;
  return (
    <HBarChart
      rows={[...s.annotators]
        .sort((a, b) => b.items - a.items)
        .map((a) => ({ key: String(a.user_id), label: a.name, value: a.items, note: `median ${fmtSeconds(a.median_seconds)} per item` }))}
      unit=" items"
    />
  );
}

function Tile({ label, value, sub }: { label: string; value: string | null; sub?: string }) {
  return (
    <div className="panel tile">
      <div className="tile-label">{label}</div>
      {value === null ? <div className="skeleton" style={{ height: 26, width: 80, marginTop: 4 }} /> : <div className="tile-value">{value}</div>}
      <div className="tile-sub">{sub}</div>
    </div>
  );
}

function describe(e: ActivityEvent): string {
  const a = e.action.replace(/_/g, " ");
  const what = e.entity_id != null ? `${e.entity} #${e.entity_id}` : e.entity;
  const extra = typeof e.payload?.decision === "string" ? ` (${e.payload.decision})` : typeof e.payload?.count === "number" ? ` (${e.payload.count})` : "";
  return `${a} ${what}${extra}`;
}
