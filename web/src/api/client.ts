// The only module that talks to the backend. Every request goes through `request`.
import type {
  ActivityEvent,
  Annotation,
  Consensus,
  ExportFormat,
  Item,
  ItemStatus,
  Page,
  Project,
  ProjectInput,
  ProjectStats,
  Review,
  ReviewCommentInput,
  Task,
  User,
} from "./types";
import { ITEM_STATUSES } from "./types";

const BASE = "/api";
const TOKEN_KEY = "annolab.token";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
  get offline() {
    return this.status === 0;
  }
}

let token: string | null = readToken();
const unauthorizedListeners = new Set<() => void>();

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(t: string | null) {
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: keep the token in memory only */
  }
}

export function hasToken() {
  return token !== null;
}

export function onUnauthorized(fn: () => void) {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

type Query = Record<string, string | number | boolean | null | undefined>;

function qs(q?: Query) {
  if (!q) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

async function raw(method: string, path: string, body?: unknown, query?: Query): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(BASE + path + qs(query), { method, headers, body: payload });
  } catch {
    throw new ApiError(0, "Network unreachable");
  }
  if (res.status === 401 && token) {
    setToken(null);
    unauthorizedListeners.forEach((fn) => fn());
  }
  if (!res.ok) {
    let detail = res.statusText || `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (typeof j.detail === "string") detail = j.detail;
      else if (Array.isArray(j.detail)) detail = j.detail.map((d: { msg?: string }) => d.msg ?? "").join("; ");
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(res.status, detail);
  }
  return res;
}

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const res = await raw(method, path, body, query);
  if (res.status === 204) return null as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

// ---------- normalizers: keep the UI independent of small server shape changes ----------

function normStats(s: Record<string, unknown>): ProjectStats {
  const countsSrc = (s.counts ?? s.by_status ?? s.status_counts ?? {}) as Record<string, number>;
  const counts = Object.fromEntries(ITEM_STATUSES.map((k) => [k, Number(countsSrc[k] ?? 0)])) as Record<
    ItemStatus,
    number
  >;
  const total = Number(s.total ?? s.total_items ?? Object.values(counts).reduce((a, b) => a + b, 0));
  const annSrc = (s.annotators ?? s.throughput ?? []) as Record<string, unknown>[];
  const annotators = annSrc.map((a) => ({
    user_id: Number(a.user_id ?? a.id),
    name: String(a.name ?? a.email ?? `user ${a.user_id}`),
    items: Number(a.items ?? a.submitted ?? a.count ?? 0),
    median_seconds: a.median_seconds == null ? null : Number(a.median_seconds),
  }));
  const agSrc = (s.agreement ?? {}) as Record<string, unknown>;
  const agreement = {
    mean: agSrc.mean ?? agSrc.score ?? agSrc.overall ?? null,
    items: Number(agSrc.items ?? agSrc.n_items ?? 0),
    metric: agSrc.metric as string | undefined,
  } as ProjectStats["agreement"];
  if (typeof agreement.mean !== "number") agreement.mean = null;
  const labSrc = (s.labels ?? s.label_distribution ?? []) as unknown;
  let labels: ProjectStats["labels"] = [];
  if (Array.isArray(labSrc))
    labels = labSrc.map((l: Record<string, unknown>) => ({
      label: String(l.label ?? l.value),
      schema_key: l.schema_key as string | undefined,
      count: Number(l.count ?? 0),
    }));
  else if (labSrc && typeof labSrc === "object")
    labels = Object.entries(labSrc as Record<string, number>).map(([label, count]) => ({ label, count: Number(count) }));
  return { counts, total, annotators, agreement, labels };
}

function normPage<T>(p: unknown): Page<T> {
  if (Array.isArray(p)) return { items: p as T[], total: p.length, page: 1, page_size: p.length };
  return p as Page<T>;
}

// ---------- endpoints ----------

export const api = {
  login: (email: string, password: string) =>
    request<{ token?: string; access_token?: string; user: User }>("POST", "/auth/login", { email, password }).then(
      (r) => ({ token: (r.token ?? r.access_token) as string, user: r.user }),
    ),
  me: () => request<User>("GET", "/auth/me"),

  users: () => request<User[] | Page<User>>("GET", "/users").then((r) => normPage<User>(r).items),
  createUser: (u: Partial<User> & { password: string }) => request<User>("POST", "/users", u),
  updateUser: (id: number, u: Partial<User> & { password?: string }) => request<User>("PATCH", `/users/${id}`, u),

  projects: () => request<Project[] | Page<Project>>("GET", "/projects").then((r) => normPage<Project>(r).items),
  project: (id: number) => request<Project>("GET", `/projects/${id}`),
  createProject: (p: ProjectInput) => request<Project>("POST", "/projects", p),
  updateProject: (id: number, p: Partial<ProjectInput>) => request<Project>("PATCH", `/projects/${id}`, p),
  deleteProject: (id: number) => request<null>("DELETE", `/projects/${id}`),
  stats: (id: number) => request<Record<string, unknown>>("GET", `/projects/${id}/stats`).then(normStats),
  activity: (id: number, limit = 30) =>
    request<ActivityEvent[] | Page<ActivityEvent>>("GET", `/projects/${id}/activity`, undefined, { limit }).then(
      (r) => normPage<ActivityEvent>(r).items,
    ),

  items: (projectId: number, q: { status?: string; q?: string; page?: number; page_size?: number }) =>
    request<Page<Item>>("GET", `/projects/${projectId}/items`, undefined, q).then((r) => normPage<Item>(r)),
  item: (id: number) => request<Item>("GET", `/items/${id}`),
  upload: (projectId: number, files: File[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f, f.name));
    return request<Item[] | { items: Item[] }>("POST", `/projects/${projectId}/items`, fd);
  },

  /** Media needs the bearer header, so it is fetched as a blob and exposed as an object URL. */
  mediaBlob: async (itemId: number) => (await raw("GET", `/items/${itemId}/media`)).blob(),

  nextTask: (projectId: number) => request<Task | null>("GET", `/projects/${projectId}/queue/next`),
  task: (id: number) => request<Task>("GET", `/tasks/${id}`),
  submitTask: (id: number, time_spent_ms: number) =>
    request<Task>("POST", `/tasks/${id}/submit`, { time_spent_ms }),
  skipTask: (id: number) => request<Task>("POST", `/tasks/${id}/skip`),

  annotations: (itemId: number, userId?: number) =>
    request<Annotation[] | { items: Annotation[] }>("GET", `/items/${itemId}/annotations`, undefined, {
      user_id: userId,
    }).then((r) => (Array.isArray(r) ? r : r.items)),
  saveAnnotations: (taskId: number, annotations: Annotation[], time_spent_ms?: number) =>
    request<Annotation[] | { items: Annotation[] }>("PUT", `/tasks/${taskId}/annotations`, {
      annotations,
      time_spent_ms,
    }).then((r) => (Array.isArray(r) ? r : r?.items ?? [])),
  prelabel: (itemId: number) =>
    request<Annotation[] | { items?: Annotation[]; proposals?: Annotation[] }>("POST", `/items/${itemId}/prelabel`).then(
      (r) => (Array.isArray(r) ? r : r.proposals ?? r.items ?? []),
    ),

  nextReview: (projectId: number) => request<Item | { item: Item } | null>("GET", `/projects/${projectId}/review/queue/next`).then(
    (r) => (r && "item" in r ? r.item : (r as Item | null)),
  ),
  reviews: (itemId: number) =>
    request<Review[] | Page<Review>>("GET", `/items/${itemId}/reviews`).then((r) => normPage<Review>(r).items),
  review: (itemId: number, decision: "approve" | "reject", comment: string, comments: ReviewCommentInput[]) =>
    request<Review>("POST", `/items/${itemId}/reviews`, { decision, comment, comments }),
  consensus: (itemId: number) => request<Consensus>("GET", `/items/${itemId}/consensus`),

  exportUrl: (projectId: number, format: ExportFormat) => `${BASE}/projects/${projectId}/export${qs({ format })}`,
  exportBlob: async (projectId: number, format: ExportFormat) => {
    const res = await raw("GET", `/projects/${projectId}/export`, undefined, { format });
    const cd = res.headers.get("Content-Disposition") ?? "";
    const m = /filename="?([^";]+)"?/.exec(cd);
    return { blob: await res.blob(), filename: m?.[1] ?? `export.${format === "yolo" ? "zip" : format === "coco" ? "json" : "jsonl"}` };
  },
};

export type Api = typeof api;
