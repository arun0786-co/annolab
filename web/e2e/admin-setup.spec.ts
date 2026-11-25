// Admin sets up a project from scratch in the UI: create, add a tool and a class, save the schema,
// upload two notes. An annotator then tags a span in one of them. The project is deleted afterwards.
import { expect, test } from "@playwright/test";
import { drag, login, token } from "./helpers";

let created: number | null = null;

test.afterAll(async ({ request }) => {
  if (created == null) return;
  const admin = await token(request, "admin@annolab.dev");
  await request.delete(`/api/projects/${created}`, { headers: { Authorization: `Bearer ${admin}` } });
});

test("admin setup: create project, edit schema, upload, label", async ({ page }) => {
  const name = `e2e notes ${Date.now()}`;
  await login(page, "admin@annolab.dev");
  await page.getByRole("button", { name: "New project" }).first().click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Name").fill(name);
  await dlg.getByLabel("Modality").selectOption("text");
  await dlg.getByRole("button", { name: "Create and edit schema" }).click();
  await page.waitForURL(/\/projects\/\d+\/schema$/);
  created = Number(page.url().match(/projects\/(\d+)/)![1]);

  await page.getByRole("button", { name: "Add tool" }).click();
  await page.getByLabel("Class name").first().fill("drug");
  await page.getByRole("button", { name: "Class", exact: true }).first().click();
  await expect(page.getByLabel("Class name")).toHaveCount(2);
  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${created}`) && r.request().method() === "PATCH");
  await page.getByRole("button", { name: "Save schema" }).click();
  expect((await saved).status()).toBe(200);

  await page.getByRole("link", { name: "Data rows" }).click();
  await page.locator('input[type="file"]').setInputFiles([
    { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("Started aspirin 75 mg daily for chest pain.") },
    { name: "b.txt", mimeType: "text/plain", buffer: Buffer.from("No new complaints today.") },
  ]);
  await expect(page.locator("tbody tr")).toHaveCount(2);

  await page.evaluate(() => localStorage.removeItem("annolab.token"));
  await login(page, "annotator1@annolab.dev");
  await page.goto(`/projects/${created}/label`);
  await page.waitForURL(/\/label\/\d+$/);
  const doc = page.locator(".doc");
  await expect(doc).toContainText(/aspirin|complaints/);
  const word = doc.getByText(/aspirin|complaints/).first();
  const b = (await word.boundingBox())!;
  await page.keyboard.press("1");
  await drag(page, b.x + 2, b.y + b.height / 2, b.x + b.width - 2, b.y + b.height / 2);
  await expect(page.locator(".ann-row")).toHaveCount(1);
  await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 10_000 });
});
