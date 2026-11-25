import { useEffect, useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { ItemStatus } from "../api/types";
import { ITEM_STATUSES } from "../api/types";
import { Icon } from "../components/Icon";
import { Empty, ErrorState, SkeletonRows } from "../components/States";
import { Thumb } from "../components/Thumb";
import { useAsync } from "../hooks/useAsync";
import { useHotkeys } from "../hooks/useHotkeys";
import { fmtAgo, fmtClock, STATUS_META } from "../lib/format";
import { useSession, useShortcutGroups } from "../state";
import { useProject } from "./ProjectLayout";

const PAGE_SIZE = 25;
const ACCEPT: Record<string, string> = { image: "image/*", audio: "audio/*", video: "video/*", text: ".txt,.json,.jsonl,text/plain" };

export function DataRows() {
  const { project } = useProject();
  const { user } = useSession();
  const nav = useNavigate();
  const [status, setStatus] = useState<"" | ItemStatus>("");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [cursor, setCursor] = useState(0);
  const [upload, setUpload] = useState<{ busy: boolean; msg?: string; error?: string }>({ busy: false });
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => setPage(1), [status, debounced]);

  const res = useAsync(
    () => api.items(project.id, { status: status || undefined, q: debounced || undefined, page, page_size: PAGE_SIZE }),
    [project.id, status, debounced, page],
  );
  const items = res.data?.items ?? [];
  const pages = res.data ? Math.max(1, Math.ceil(res.data.total / (res.data.page_size || PAGE_SIZE))) : 1;
  const open = (i: number) => items[i] && nav(`/projects/${project.id}/items/${items[i].id}`);

  useShortcutGroups([
    {
      title: "Data rows",
      keys: [
        ["J or ArrowDown", "Next row"],
        ["K or ArrowUp", "Previous row"],
        ["Enter", "Open item in review view"],
        ["/", "Search"],
        ["ArrowLeft or ArrowRight", "Previous or next page"],
      ],
    },
  ]);
  useHotkeys({
    j: () => setCursor((c) => Math.min(items.length - 1, c + 1)),
    arrowdown: () => setCursor((c) => Math.min(items.length - 1, c + 1)),
    k: () => setCursor((c) => Math.max(0, c - 1)),
    arrowup: () => setCursor((c) => Math.max(0, c - 1)),
    enter: () => open(cursor),
    "/": () => document.getElementById("row-search")?.focus(),
    arrowleft: () => setPage((p) => Math.max(1, p - 1)),
    arrowright: () => setPage((p) => Math.min(pages, p + 1)),
  });

  async function doUpload(files: File[]) {
    if (!files.length) return;
    setUpload({ busy: true });
    try {
      const r = await api.upload(project.id, files);
      const n = r.created.length;
      setUpload({
        busy: false,
        msg: `Added ${n} item${n === 1 ? "" : "s"}${r.errors.length ? `, ${r.errors.length} rejected` : ""}`,
        error: r.errors.length ? r.errors.map((e) => `${e.filename ?? "file"}: ${e.detail ?? "rejected"}`).join("; ") : undefined,
      });
      res.reload();
    } catch (e) {
      setUpload({ busy: false, error: (e as Error).message });
    }
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (user?.role === "admin") doUpload([...e.dataTransfer.files]);
  };

  return (
    <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Filter by status">
          <button aria-pressed={status === ""} onClick={() => setStatus("")}>
            All
          </button>
          {ITEM_STATUSES.map((s) => (
            <button key={s} aria-pressed={status === s} onClick={() => setStatus(s)}>
              {STATUS_META[s].label}
            </button>
          ))}
        </div>
        <label>
          <span className="sr-only">Search by filename or text</span>
          <input id="row-search" className="input" placeholder="Search  /" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <span className="spacer" />
        <span aria-live="polite" className="muted">
          {upload.busy ? "Uploading" : upload.msg}
        </span>
        {user?.role === "admin" && (
          <>
            <input ref={fileRef} type="file" multiple accept={ACCEPT[project.modality]} hidden onChange={(e) => doUpload([...(e.target.files ?? [])])} />
            <button className="btn" onClick={() => fileRef.current?.click()} disabled={upload.busy}>
              <Icon name="upload" /> Upload
            </button>
          </>
        )}
      </div>
      {upload.error && <div className="alert" style={{ marginBottom: 8 }}>{upload.error}</div>}
      {drag && user?.role === "admin" && (
        <div className="panel state" style={{ borderStyle: "dashed", borderColor: "var(--accent)", marginBottom: 8 }}>
          Drop files to add them to this project
        </div>
      )}
      {res.error ? (
        <ErrorState error={res.error} onRetry={res.reload} />
      ) : (
        <div className="table-wrap">
          {res.loading && !res.data ? (
            <SkeletonRows rows={8} cols={5} />
          ) : !items.length ? (
            <Empty title={status || debounced ? "No rows match" : "No data yet"}>
              {status || debounced ? "Clear the filter or search." : user?.role === "admin" ? "Upload files or drop them here." : "An admin has not added data yet."}
            </Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 64 }}>Preview</th>
                  <th>File</th>
                  <th>Status</th>
                  <th className="r">Annotators</th>
                  <th className="r">{project.modality === "image" ? "Size" : project.modality === "text" ? "Chars" : "Duration"}</th>
                  <th className="r">Added</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={it.id} aria-selected={i === cursor} onClick={() => open(i)} style={{ cursor: "pointer" }} onMouseEnter={() => setCursor(i)}>
                    <td>
                      <Thumb item={it} />
                    </td>
                    <td>
                      <span className="mono">{it.filename}</span>
                      <div className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                        #{it.id}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${STATUS_META[it.status].badge}`}>
                        <span className="dot" style={{ color: STATUS_META[it.status].color }} />
                        {STATUS_META[it.status].label}
                      </span>
                    </td>
                    <td className="r">
                      {it.annotator_count ?? 0}/{project.annotators_per_item}
                    </td>
                    <td className="r">
                      {it.kind === "image"
                        ? it.meta.width
                          ? `${it.meta.width}x${it.meta.height}`
                          : "–"
                        : it.kind === "text"
                          ? String(it.meta.text ?? "").length
                          : it.meta.duration
                            ? fmtClock(Number(it.meta.duration), 1)
                            : "–"}
                    </td>
                    <td className="r faint">{fmtAgo(it.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {res.data && res.data.total > 0 && (
        <div className="pager">
          <span className="num">
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(res.data.total, page * PAGE_SIZE)} of {res.data.total}
          </span>
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
            <Icon name="prev" />
          </button>
          <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page">
            <Icon name="next" />
          </button>
        </div>
      )}
    </div>
  );
}
