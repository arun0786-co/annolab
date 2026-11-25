// README screenshots: `make screenshots` seeds a throwaway stack and runs this file.
// Annotations drawn here follow each item's ground truth (meta.truth, read with the admin token),
// so the pictures show sensible labels rather than random boxes.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drag, login, projectId, token } from "./helpers";

const OUT = process.env.SHOTS_DIR ?? fileURLToPath(new URL("../../docs/images", import.meta.url));

/** Full-viewport PNG. Files over 400 KB are reduced afterwards by scripts/shrink_png.py. */
async function shot(page: Page, name: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.mouse.move(1439, 899);
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

async function get<T>(request: APIRequestContext, url: string, tok: string): Promise<T> {
  const r = await request.get(`/api${url}`, { headers: { Authorization: `Bearer ${tok}` } });
  expect(r.ok(), `GET ${url} -> ${r.status()}`).toBeTruthy();
  return (await r.json()) as T;
}

const pageToken = (page: Page) => page.evaluate(() => localStorage.getItem("annolab.token") ?? "");

interface TaskInfo {
  id: number;
  item: { id: number; filename: string; meta: Record<string, unknown> };
  annotations: { geometry: { start?: number; end?: number } | null }[];
}

/** Open the labeling queue of a project and return the task it served plus the item's ground truth. */
async function openQueue(page: Page, request: APIRequestContext, pid: number) {
  await page.goto(`/projects/${pid}/label`);
  await page.waitForURL(/\/label\/\d+$/);
  const taskId = Number(page.url().match(/label\/(\d+)$/)![1]);
  const task = await get<TaskInfo>(request, `/tasks/${taskId}`, await pageToken(page));
  const admin = await token(request, "admin@annolab.dev");
  const item = await get<{ meta: { truth: Record<string, unknown> } }>(request, `/items/${task.item.id}`, admin);
  return { task, truth: item.meta.truth };
}

/** Hotkey of a class within a tool of a project schema (explicit hotkey, else its 1-based position). */
async function classKey(request: APIRequestContext, pid: number, tool: string, value: string) {
  const p = await get<{ schema: { tools: { key: string; classes: { value: string; hotkey?: string }[] }[] } }>(
    request,
    `/projects/${pid}`,
    await token(request, "admin@annolab.dev"),
  );
  const classes = p.schema.tools.find((t) => t.key === tool)!.classes;
  const i = classes.findIndex((c) => c.value === value);
  return classes[i]?.hotkey || String(i + 1);
}

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });

test("screenshots: admin pages", async ({ page, request }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("admin@annolab.dev");
  await shot(page, "login");
  await login(page, "admin@annolab.dev");
  await expect(page.locator("tbody tr").first()).toBeVisible();
  await shot(page, "projects");

  const audio = await projectId(request, "audio");
  const image = await projectId(request, "image");
  await page.goto(`/projects/${audio}`);
  await expect(page.getByText("Agreement by tool")).toBeVisible();
  await expect(page.locator(".feed li").first()).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, "overview");

  await page.goto(`/projects/${image}/data`);
  await expect(page.locator("tbody tr").first()).toBeVisible();
  await page.waitForTimeout(1200);
  await shot(page, "data-rows");

  await page.goto(`/projects/${image}/schema`);
  await expect(page.getByText("Live preview")).toBeVisible();
  await shot(page, "schema-editor");

  await page.goto(`/projects/${image}`);
  await expect(page.getByText("Agreement by tool")).toBeVisible();
  await expect(page.locator(".feed li").first()).toBeVisible();
  await page.getByRole("button", { name: "Export" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel(/COCO JSON/).check();
  await shot(page, "export");
  await page.keyboard.press("Escape");

  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`/projects/${audio}`);
  await expect(page.getByText("Agreement by tool")).toBeVisible();
  await expect(page.locator(".feed li").first()).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, "overview-dark");
});

test("screenshots: labeling editors", async ({ page, request }) => {
  await login(page, "annotator2@annolab.dev");

  // image: a box per ground-truth object, and an outline (polygon) on one shape
  const image = await projectId(request, "image");
  const img = await openQueue(page, request, image);
  await expect(page.getByText(/\d+x\d+/).first()).toBeVisible();
  const pic = page.locator(".stage svg image");
  await expect(pic).toBeVisible();
  const r = (await pic.boundingBox())!;
  const W = Number(img.task.item.meta.width);
  const H = Number(img.task.item.meta.height);
  const at = (x: number, y: number) => [r.x + (x / W) * r.width, r.y + (y / H) * r.height] as const;
  type Obj = { label: string; bbox: [number, number, number, number]; points?: [number, number][] };
  const objects = ((img.truth.objects ?? []) as Obj[]).slice(0, 6);
  const outlined = objects.find((o) => o.points && o.points.length <= 6 && o.label !== "circle");
  for (const o of objects) {
    if (o === outlined) continue;
    await page.keyboard.press("b");
    await page.keyboard.press(await classKey(request, image, "box", o.label));
    const [x, y, w, h] = o.bbox;
    await drag(page, ...at(x, y), ...at(x + w, y + h));
  }
  if (outlined) {
    await page.keyboard.press("p");
    await page.keyboard.press(await classKey(request, image, "outline", outlined.label));
    for (const [x, y] of outlined.points!) await page.mouse.click(...at(x, y));
    await page.keyboard.press("Enter");
  }
  await page.keyboard.press("v");
  await page.locator(".ann-row").first().click();
  await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 10_000 });
  await shot(page, "label-image");

  await page.keyboard.press("?");
  await expect(page.getByRole("dialog")).toBeVisible();
  await shot(page, "shortcuts");
  await page.keyboard.press("Escape");

  // audio: model proposals, plus one segment drawn on a beat nobody has labeled yet
  const audio = await projectId(request, "audio");
  const aud = await openQueue(page, request, audio);
  const plot = page.locator("[role=application]");
  await expect(plot).toBeVisible();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /Propose/ }).click();
  await expect(page.locator(".transport [aria-live]")).toContainText("proposals");
  const dur = Number(aud.task.item.meta.duration);
  const taken = aud.task.annotations.map((a) => a.geometry).filter((g): g is { start: number; end: number } => g?.start != null);
  const segs = (aud.truth.segments ?? []) as { label: string; start: number; end: number }[];
  const free = segs.find((s) => s.start > 2 && s.end < dur * 0.6 && !taken.some((g) => g.start < s.end && g.end > s.start));
  if (free) {
    const pb = (await plot.boundingBox())!;
    const tx = (t: number) => pb.x + (t / dur) * pb.width;
    await page.keyboard.press(await classKey(request, audio, "heart", free.label));
    await drag(page, tx(free.start), pb.y + pb.height * 0.5, tx(free.end), pb.y + pb.height * 0.5);
  }
  await page.keyboard.press("=");
  await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 10_000 });
  await shot(page, "label-audio");
  await page.getByRole("button", { name: "Spectrogram" }).click();
  await page.waitForTimeout(2500);
  await shot(page, "label-audio-spectrogram");

  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expect(plot).toBeVisible();
  await page.waitForTimeout(1500);
  await page.keyboard.press("=");
  await page.waitForTimeout(300);
  await shot(page, "label-audio-dark");
  await page.emulateMedia({ colorScheme: "light" });

  // video: the walker as a box track with keyframes at 0 s and 2 s, and one gait phase segment
  const video = await projectId(request, "video");
  const vid = await openQueue(page, request, video);
  const vel = page.locator(".stage video");
  await expect(vel).toBeVisible();
  await page.waitForTimeout(1200);
  const vb = (await vel.boundingBox())!;
  const VW = Number(vid.task.item.meta.width);
  const VH = Number(vid.task.item.meta.height);
  const fps = Number(vid.task.item.meta.fps);
  const vat = (x: number, y: number) => [vb.x + (x / VW) * vb.width, vb.y + (y / VH) * vb.height] as const;
  type Kf = { t: number; x: number; y: number; w: number; h: number };
  const walker = ((vid.truth.tracks ?? []) as { label: string; keyframes: Kf[] }[]).find((t) => t.label === "walker")!;
  const k0 = walker.keyframes[0];
  const k2 = walker.keyframes.find((k) => Math.abs(k.t - 2) < 0.05)!;
  await page.keyboard.press("b");
  await page.keyboard.press(await classKey(request, video, "body", "walker"));
  await drag(page, ...vat(k0.x, k0.y), ...vat(k0.x + k0.w, k0.y + k0.h));
  for (let i = 0; i < Math.round(2 * fps); i++) await page.keyboard.press("]");
  await page.keyboard.press("v");
  await drag(page, ...vat(k0.x + k0.w / 2, k0.y + k0.h / 2), ...vat(k2.x + k2.w / 2, k2.y + k2.h / 2));
  for (let i = 0; i < Math.round(1.6 * fps); i++) await page.keyboard.press("[");
  await page.keyboard.press("r");
  await page.keyboard.press(await classKey(request, video, "phase", "steady"));
  await page.keyboard.press("e");
  for (let i = 0; i < Math.round(1.4 * fps); i++) await page.keyboard.press("]");
  await page.keyboard.press("e");
  await page.keyboard.press("v");
  await page.locator(".ann-row").first().click();
  await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 10_000 });
  await page.waitForTimeout(500);
  await shot(page, "label-video");

  // text: the ground-truth entities, plus a finding span that overlaps a body site
  const text = await projectId(request, "text");
  const txt = await openQueue(page, request, text);
  await expect(page.locator(".doc")).toBeVisible();
  const note = String(txt.task.item.meta.text ?? "");
  const spans = [...((txt.truth.spans ?? []) as { label: string; start: number; end: number }[])];
  const site = spans.find((s) => s.label === "body_site");
  if (site) {
    const sStart = note.lastIndexOf(". ", site.start) + 2;
    const f = note.indexOf(" for ", sStart);
    spans.push({ label: "symptom", start: f >= 0 && f < site.start ? f + 5 : sStart, end: site.end });
  }
  for (const s of spans) {
    const box = await page.evaluate(
      ([a, b]) => {
        // Character offset -> client rect, using the data-start offsets the editor renders.
        const pos = (off: number) => {
          for (const el of document.querySelectorAll<HTMLElement>(".doc [data-start]")) {
            const st = Number(el.dataset.start);
            const tn = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text | undefined;
            if (!tn || off < st || off >= st + tn.length) continue;
            const r = document.createRange();
            r.setStart(tn, off - st);
            r.setEnd(tn, off - st + 1);
            return r.getBoundingClientRect();
          }
          return null;
        };
        const p = pos(a);
        const q = pos(b - 1);
        return p && q ? { x1: p.left + 1, y1: p.top + p.height / 2, x2: q.right - 1, y2: q.top + q.height / 2 } : null;
      },
      [s.start, s.end] as const,
    );
    if (!box) continue;
    await page.keyboard.press(await classKey(request, text, "entity", s.label));
    await drag(page, box.x1, box.y1, box.x2, box.y2);
  }
  await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 10_000 });
  await shot(page, "label-text");
});

test("screenshots: feedback and review", async ({ page, request }) => {
  // An annotator whose rejected work came back, with the reviewer's pinned comment.
  const image = await projectId(request, "image");
  for (const who of ["annotator1", "annotator2", "annotator3"]) {
    const tok = await token(request, `${who}@annolab.dev`);
    const tasks = await get<{ id: number; project_id: number }[]>(request, `/tasks?project_id=${image}&status=in_progress`, tok);
    let found: number | null = null;
    for (const t of tasks) {
      const d = await get<{ item: { status: string }; reviews: { decision: string }[] }>(request, `/tasks/${t.id}`, tok);
      if (d.item.status === "rejected" && d.reviews[0]?.decision === "reject") found = t.id;
    }
    if (found == null) continue;
    await login(page, `${who}@annolab.dev`);
    await page.goto(`/projects/${image}/label/${found}`);
    await expect(page.getByRole("region", { name: "Reviewer feedback" })).toBeVisible();
    await page.waitForTimeout(1000);
    await shot(page, "label-feedback");
    await page.evaluate(() => localStorage.removeItem("annolab.token"));
    break;
  }

  await login(page, "reviewer1@annolab.dev");
  await page.goto(`/projects/${image}/review`);
  await page.waitForURL(/\/items\/\d+/);
  await page.waitForTimeout(1500);
  const s = (await page.locator(".stage").boundingBox())!;
  await page.keyboard.press("c");
  await page.mouse.click(s.x + s.width * 0.5, s.y + s.height * 0.45);
  await page.keyboard.type("Top edge cuts off the tip of the object");
  await page.waitForTimeout(400);
  await shot(page, "review-image");

  await page.goto(`/projects/${await projectId(request, "audio")}/review`);
  await page.waitForURL(/\/items\/\d+/);
  const plot = page.locator("[role=application]");
  await expect(plot).toBeVisible();
  await page.waitForTimeout(2000);
  const pb = (await plot.boundingBox())!;
  await page.keyboard.press("c");
  await page.mouse.click(pb.x + pb.width * 0.31, pb.y + pb.height * 0.4);
  await page.keyboard.type("Two annotators disagree on this S2; check the onset");
  await page.waitForTimeout(400);
  await shot(page, "review-audio");

  await page.goto(`/projects/${await projectId(request, "text")}/review`);
  await page.waitForURL(/\/items\/\d+/);
  await page.waitForTimeout(1000);
  await shot(page, "review-text");
});
