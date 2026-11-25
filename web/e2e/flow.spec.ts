import { expect, test } from "@playwright/test";
import { drag, login, projectId } from "./helpers";

test("annotator labels an image and submits, reviewer approves", async ({ page, request }) => {
  const pid = await projectId(request, "image");

  await login(page, "annotator1@annolab.dev");
  await page.goto(`/projects/${pid}/label`);
  await page.waitForURL(/\/label\/\d+$/);
  const stage = page.locator(".stage");
  await expect(stage).toBeVisible();
  await expect(page.getByText(/\d+x\d+/).first()).toBeVisible();
  const taskUrl = page.url();

  // The queue may hand back an item this annotator already started; count from there.
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  const rows = page.locator(".ann-row");
  const n0 = await rows.count();

  // Draw a box with class 1, then a second with class 2.
  const b = (await stage.boundingBox())!;
  await page.keyboard.press("b");
  await page.keyboard.press("1");
  await drag(page, b.x + b.width * 0.3, b.y + b.height * 0.3, b.x + b.width * 0.45, b.y + b.height * 0.5);
  await page.keyboard.press("2");
  await drag(page, b.x + b.width * 0.55, b.y + b.height * 0.4, b.x + b.width * 0.7, b.y + b.height * 0.6);
  await expect(rows).toHaveCount(n0 + 2);

  // Undo removes the second box, redo brings it back.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(rows).toHaveCount(n0 + 1);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(rows).toHaveCount(n0 + 2);

  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible({ timeout: 10_000 });

  const submitted = page.waitForResponse((r) => r.url().includes("/submit") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Submit" }).click();
  expect((await submitted).status()).toBe(200);
  await expect(page).not.toHaveURL(taskUrl);

  // Reviewer approves the next item in the review queue.
  await page.evaluate(() => localStorage.removeItem("annolab.token"));
  await login(page, "reviewer1@annolab.dev");
  await page.goto(`/projects/${pid}/review`);
  await page.waitForURL(/\/items\/\d+/);
  await expect(page.getByRole("heading", { name: "Annotators" }).or(page.getByText("Annotators", { exact: true }))).toBeVisible();
  const reviewed = page.waitForResponse((r) => /\/items\/\d+\/reviews$/.test(r.url()) && r.request().method() === "POST");
  await page.getByRole("button", { name: "Approve" }).click();
  expect((await reviewed).status()).toBe(201);
});
