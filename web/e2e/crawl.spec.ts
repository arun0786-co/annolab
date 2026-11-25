// Visits every screen as each role and fails on console errors or failed API calls.
import { expect, test, type Page } from "@playwright/test";
import { login, projectId, token } from "./helpers";

function watch(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.url().includes("/api/") && r.status() >= 400) problems.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return problems;
}

const MODALITIES = ["image", "audio", "video", "text"] as const;

test("crawl: admin screens", async ({ page, request }) => {
  const problems = watch(page);
  await login(page, "admin@annolab.dev");
  await expect(page.locator("tbody tr").first()).toBeVisible();
  for (const m of MODALITIES) {
    const pid = await projectId(request, m);
    await page.goto(`/projects/${pid}`);
    await expect(page.getByText("Agreement by tool")).toBeVisible();
    await page.goto(`/projects/${pid}/data`);
    await expect(page.locator("tbody tr").first()).toBeVisible();
    await page.waitForTimeout(800);
    await page.goto(`/projects/${pid}/schema`);
    await expect(page.getByText("Live preview")).toBeVisible();
    await page.goto(`/projects/${pid}`);
    await page.getByRole("button", { name: "Export" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
  }
  expect(problems).toEqual([]);
});

test("crawl: annotator editors", async ({ page, request }) => {
  const problems = watch(page);
  await login(page, "annotator3@annolab.dev");
  for (const m of MODALITIES) {
    const pid = await projectId(request, m);
    await page.goto(`/projects/${pid}/label`);
    await page.waitForURL(/\/label\/\d+$|\/label$/);
    await page.waitForTimeout(1500);
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
  }
  expect(problems).toEqual([]);
});

test("crawl: reviewer screens", async ({ page, request }) => {
  const problems = watch(page);
  await login(page, "reviewer1@annolab.dev");
  const t = await token(request, "reviewer1@annolab.dev");
  for (const m of MODALITIES) {
    const pid = await projectId(request, m);
    await page.goto(`/projects/${pid}`);
    await expect(page.getByText("Agreement by tool")).toBeVisible();
    const r = await request.get(`/api/projects/${pid}/items?status=labeled,in_review,approved`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    const items = (await r.json()).items as { id: number }[];
    if (items.length) {
      await page.goto(`/projects/${pid}/items/${items[0].id}`);
      await page.waitForTimeout(1500);
    }
  }
  expect(problems).toEqual([]);
});
