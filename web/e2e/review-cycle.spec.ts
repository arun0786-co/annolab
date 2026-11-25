// Full review cycle on two fresh projects (deleted afterwards, so the seed stays as it was):
// annotator labels an image and an audio clip, reviewer rejects the image with a pinned comment,
// annotator sees the comment when the item comes back and resubmits, reviewer approves, admin exports COCO.
import { expect, test, type APIRequestContext } from "@playwright/test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { drag, login, projectId, token } from "./helpers";

const MEDIA = fileURLToPath(new URL("../../data/media/", import.meta.url));
const created: number[] = [];
let admin = "";

async function api<T>(request: APIRequestContext, method: string, url: string, tok: string, body?: unknown): Promise<T> {
  const r = await request.fetch(`/api${url}`, { method, headers: { Authorization: `Bearer ${tok}` }, data: body });
  expect(r.ok(), `${method} ${url} -> ${r.status()} ${await r.text()}`).toBeTruthy();
  return (r.status() === 204 ? null : await r.json()) as T;
}

/** Copy a seeded project's schema into a new one-annotator project and upload one media file. */
async function freshProject(request: APIRequestContext, modality: string, file: string, mime: string) {
  const src = await api<{ schema: unknown }>(request, "GET", `/projects/${await projectId(request, modality)}`, admin);
  const p = await api<{ id: number }>(request, "POST", "/projects", admin, {
    name: `e2e ${modality} ${Date.now()}`,
    modality,
    schema: src.schema,
    annotators_per_item: 1,
    review_required: true,
  });
  created.push(p.id);
  const path = fs.readdirSync(MEDIA, { recursive: true }).map(String).find((f) => f.endsWith(file));
  if (!path) throw new Error(`${file} not found under data/media; run make seed`);
  const up = await request.post(`/api/projects/${p.id}/items`, {
    headers: { Authorization: `Bearer ${admin}` },
    multipart: { files: { name: file, mimeType: mime, buffer: fs.readFileSync(MEDIA + path) } },
  });
  expect(up.ok()).toBeTruthy();
  const item = (await up.json()).created[0] as { id: number };
  return { pid: p.id, itemId: item.id };
}

test.beforeAll(async ({ request }) => {
  admin = await token(request, "admin@annolab.dev");
});

test.afterAll(async ({ request }) => {
  for (const id of created) await request.delete(`/api/projects/${id}`, { headers: { Authorization: `Bearer ${admin}` } });
});

test("review cycle: label image and audio, reject with a pinned comment, export COCO", async ({ page, request }) => {
  const img = await freshProject(request, "image", "camera.png", "image/png");
  const aud = await freshProject(request, "audio", "pcg_01.wav", "audio/wav");
  const saved = page.locator(".save-status");

  // Annotator: one box of class 2 on the image.
  await login(page, "annotator1@annolab.dev");
  await page.goto(`/projects/${img.pid}/label`);
  await page.waitForURL(/\/label\/\d+$/);
  const stage = page.locator(".stage");
  await expect(page.getByText(/\d+x\d+/).first()).toBeVisible();
  const b = (await stage.boundingBox())!;
  await page.keyboard.press("b");
  await page.keyboard.press("2");
  await drag(page, b.x + b.width * 0.35, b.y + b.height * 0.3, b.x + b.width * 0.6, b.y + b.height * 0.65);
  await expect(page.locator(".ann-row")).toHaveCount(1);
  await expect(saved).toHaveText("Saved", { timeout: 10_000 });
  let submitted = page.waitForResponse((r) => r.url().includes("/submit") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Submit" }).click();
  expect((await submitted).status()).toBe(200);
  await expect(page.getByText("Queue is empty")).toBeVisible();

  const a1 = await token(request, "annotator1@annolab.dev");
  const imgAnns = await api<{ label: string; geometry: { x: number; w: number; h: number } }[]>(request, "GET", `/items/${img.itemId}/annotations`, a1);
  expect(imgAnns).toHaveLength(1);
  expect(imgAnns[0].geometry.w).toBeGreaterThan(10);

  // Annotator: one audio segment, drawn by dragging on the plot.
  await page.goto(`/projects/${aud.pid}/label`);
  await page.waitForURL(/\/label\/\d+$/);
  const plot = page.locator("[role=application]");
  await expect(plot).toBeVisible();
  await page.waitForTimeout(800);
  const pb = (await plot.boundingBox())!;
  await page.keyboard.press("1");
  await drag(page, pb.x + pb.width * 0.2, pb.y + pb.height * 0.5, pb.x + pb.width * 0.3, pb.y + pb.height * 0.5);
  await expect(page.locator(".ann-row")).toHaveCount(1);
  await expect(saved).toHaveText("Saved", { timeout: 10_000 });
  submitted = page.waitForResponse((r) => r.url().includes("/submit") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Submit" }).click();
  expect((await submitted).status()).toBe(200);
  const audAnns = await api<{ geometry: { start: number; end: number } }[]>(request, "GET", `/items/${aud.itemId}/annotations`, a1);
  expect(audAnns).toHaveLength(1);
  expect(audAnns[0].geometry.end).toBeGreaterThan(audAnns[0].geometry.start);

  // Reviewer: pin a comment on the image and reject.
  await page.evaluate(() => localStorage.removeItem("annolab.token"));
  await login(page, "reviewer1@annolab.dev");
  await page.goto(`/projects/${img.pid}/review`);
  await page.waitForURL(new RegExp(`/items/${img.itemId}(\\?|$)`));
  const rs = (await page.locator(".stage").boundingBox())!;
  await page.keyboard.press("c");
  await page.mouse.click(rs.x + rs.width * 0.2, rs.y + rs.height * 0.2);
  const note = "Box should include the camera tripod";
  await page.keyboard.type(note);
  const reviewed = page.waitForResponse((r) => /\/items\/\d+\/reviews$/.test(r.url()) && r.request().method() === "POST");
  await page.getByRole("button", { name: "Reject" }).click();
  expect((await reviewed).status()).toBe(201);

  // Annotator: the rejected item comes back first, with the pinned comment.
  await page.evaluate(() => localStorage.removeItem("annolab.token"));
  await login(page, "annotator1@annolab.dev");
  await page.goto(`/projects/${img.pid}/label`);
  await page.waitForURL(/\/label\/\d+$/);
  const fb = page.getByRole("region", { name: "Reviewer feedback" });
  await expect(fb).toContainText("Sent back by");
  await expect(fb).toContainText(note);
  await expect(page.locator(".stage").getByText("1", { exact: true })).toBeVisible();
  await expect(page.locator(".ann-row")).toHaveCount(1);

  // Annotator moves the box 10 px right with Shift+Arrow and resubmits; reviewer approves.
  await page.keyboard.press("v");
  await page.locator(".ann-row").first().click();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(saved).toHaveText("Saved", { timeout: 10_000 });
  await expect
    .poll(async () => (await api<{ geometry: { x: number } }[]>(request, "GET", `/items/${img.itemId}/annotations`, a1))[0].geometry.x)
    .toBeCloseTo(imgAnns[0].geometry.x + 10, 3);
  submitted = page.waitForResponse((r) => r.url().includes("/submit") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Submit" }).click();
  expect((await submitted).status()).toBe(200);
  await page.evaluate(() => localStorage.removeItem("annolab.token"));
  await login(page, "reviewer1@annolab.dev");
  await page.goto(`/projects/${img.pid}/items/${img.itemId}`);
  await expect(page.locator(".stage")).toBeVisible();
  const approved = page.waitForResponse((r) => /\/items\/\d+\/reviews$/.test(r.url()) && r.request().method() === "POST");
  await page.getByRole("button", { name: "Approve" }).click();
  expect((await approved).status()).toBe(201);

  // Admin: COCO export of the image project.
  await page.evaluate(() => localStorage.removeItem("annolab.token"));
  await login(page, "admin@annolab.dev");
  await page.goto(`/projects/${img.pid}`);
  await page.getByRole("button", { name: "Export" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel(/COCO JSON/).check();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  const file = await (await download).path();
  const coco = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(coco.images).toHaveLength(1);
  expect(coco.annotations).toHaveLength(1);
  expect(coco.annotations[0].bbox[2]).toBeGreaterThan(10);
  const cat = coco.categories.find((c: { id: number }) => c.id === coco.annotations[0].category_id);
  expect(cat).toBeTruthy();
});
