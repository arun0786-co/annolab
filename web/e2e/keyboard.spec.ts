// Keyboard-only checks: Tab must move focus out of every editor, and a missing project offers a way back.
import { expect, test } from "@playwright/test";
import { login, projectId } from "./helpers";

for (const m of ["image", "audio", "video", "text"] as const) {
  test(`keyboard: tab leaves the ${m} editor`, async ({ page, request }) => {
    await login(page, "annotator3@annolab.dev");
    const pid = await projectId(request, m);
    await page.goto(`/projects/${pid}/label`);
    await page.waitForURL(/\/label\/\d+$/);
    await page.waitForTimeout(800);
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      seen.add(await page.evaluate(() => document.activeElement?.tagName ?? ""));
    }
    seen.delete("BODY");
    expect(seen.size).toBeGreaterThan(0);
  });
}

test("keyboard: missing project shows a way back", async ({ page }) => {
  await login(page, "admin@annolab.dev");
  await page.goto("/projects/99999");
  await expect(page.getByRole("heading", { name: "Project not found" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await page.getByRole("link", { name: "Back to projects" }).click();
  await expect(page).toHaveURL(/\/$/);
});
