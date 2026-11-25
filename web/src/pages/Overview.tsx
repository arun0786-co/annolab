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
      // The same class value can live in two tools (a box "circle" and an outline "circle").
      const shared = project.schema.tools.filter((u) => u.classes.some((x) => x.value === label)).length > 1;
      if (c) return shared ? `${c.name} (${t.name})` : c.name;
    }
    const cl = project.schema.classifications.find((c) => c.key === key);
    return cl ? `${cl.name}: ${label}` : label;
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
          sub={s ? `mean pairwise F1 over ${s.agreement.items} items` : ""}
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
            <span className="faint">submitted work</span>
          </div>
          {s ? <Throughput s={s} /> : <SkeletonRows rows={3} cols={2} />}
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
                labelWidth={190}
              />
            ) : (
              <SkeletonRows rows={3} cols={2} />
            )}
          </div>
        </section>
      </div>

      <div className="grid grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Agreement by tool</h2>
            <span className="faint">pairs of annotators on the same item</span>
          </div>
          {s ? <AgreementTable s={s} names={Object.fromEntries([...project.schema.tools, ...project.schema.classifications].map((t) => [t.key, t.name]))} /> : <SkeletonRows rows={3} cols={4} />}
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Submissions per day</h2>
          </div>
          <div className="panel-body">{s ? <DailyBars daily={s.daily} /> : <SkeletonRows rows={3} cols={1} />}</div>
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
                  <strong>{e.user?.name ?? "system"}</strong>
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
  if (!s.annotators.length) return <p className="faint panel-body">Nobody has submitted yet.</p>;
  const rows = [...s.annotators].sort((a, b) => b.items - a.items);
  const max = Math.max(1, ...rows.map((a) => a.items));
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Annotator</th>
          <th>Submitted</th>
          <th className="r">Skipped</th>
          <th className="r">Median per item</th>
          <th className="r">Total time</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((a) => (
          <tr key={a.user_id}>
            <td>{a.name}</td>
            <td>
              <span className="inline-bar">
                <span style={{ width: `${(a.items / max) * 100}%` }} />
              </span>
              <span className="num">{a.items}</span>
            </td>
            <td className="r">{a.skipped}</td>
            <td className="r">{fmtSeconds(a.median_seconds)}</td>
            <td className="r">{fmtSeconds(a.total_seconds)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AgreementTable({ s, names }: { s: ProjectStats; names: Record<string, string> }) {
  const { tools, classifications } = s.agreement;
  if (!tools.length && !classifications.length) return <p className="faint panel-body">Needs items labeled by two or more annotators.</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Tool</th>
          <th className="r">Items</th>
          <th className="r">F1 agreement</th>
          <th className="r">Mean IoU</th>
          <th className="r">Kappa</th>
        </tr>
      </thead>
      <tbody>
        {tools.map((t) => (
          <tr key={t.schema_key}>
            <td>
              {names[t.schema_key] ?? t.schema_key} <span className="faint">{t.type}</span>
            </td>
            <td className="r">{t.items}</td>
            <td className="r">{fmtScore(t.mean_agreement)}</td>
            <td className="r">{fmtScore(t.mean_iou)}</td>
            <td className="r faint">{"\u2013"}</td>
          </tr>
        ))}
        {classifications.map((c) => (
          <tr key={c.schema_key}>
            <td>
              {names[c.schema_key] ?? c.schema_key} <span className="faint">classification</span>
            </td>
            <td className="r">{c.items}</td>
            <td className="r faint">{"\u2013"}</td>
            <td className="r faint">{"\u2013"}</td>
            <td className="r" title={`Fleiss ${fmtScore(c.fleiss_kappa)}, mean Cohen ${fmtScore(c.mean_cohen_kappa)}`}>
              {fmtScore(c.fleiss_kappa ?? c.mean_cohen_kappa)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DailyBars({ daily }: { daily: ProjectStats["daily"] }) {
  if (!daily.length) return <p className="faint">No submissions yet.</p>;
  const last = daily.slice(-14);
  return <HBarChart rows={last.map((d) => ({ key: d.date, label: d.date, value: d.submitted }))} labelWidth={90} unit=" submitted" />;
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
  const a = e.action.replace(/[._]/g, " ");
  const what = e.entity_id != null ? `${e.entity} #${e.entity_id}` : e.entity;
  const extra = typeof e.payload?.decision === "string" ? ` (${e.payload.decision})` : typeof e.payload?.count === "number" ? ` (${e.payload.count})` : "";
  return `${a} ${what}${extra}`;
}
