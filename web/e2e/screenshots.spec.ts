// Captures the README screenshots: `make screenshots` (needs `make seed` and `make dev`).
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drag, login, projectId } from "./helpers";

const OUT = process.env.SHOTS_DIR ?? fileURLToPath(new URL("../../docs/images", import.meta.url));
const LIMIT = 400 * 1024;

/**
 * PNG screenshot kept under 400 KB. Photos in the canvas can push a capture past the limit;
 * those are posterised in the page's own canvas (fewer levels per channel) until they fit.
 */
async function shot(page: Page, name: string) {
  let buf = await page.screenshot();
  for (const bits of [6, 5, 4]) {
    if (buf.length <= LIMIT) break;
    const b64 = await page.evaluate(
      async ([src, bits]) => {
        const img = new Image();
        img.src = `data:image/png;base64,${src}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d")!;
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height);
        const step = 256 >> (bits as number);
        for (let i = 0; i < d.data.length; i += 4)
          for (let k = 0; k < 3; k++) d.data[i + k] = Math.min(255, Math.round(d.data[i + k] / step) * step);
        g.putImageData(d, 0, 0);
        return c.toDataURL("image/png").split(",")[1];
      },
      [buf.toString("base64"), bits] as const,
    );
    buf = Buffer.from(b64, "base64");
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), buf);
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
  await page.goto(`/projects/${audio}`);
  await expect(page.getByText("Agreement by tool")).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, "overview");

  const image = await projectId(request, "image");
  await page.goto(`/projects/${image}/data`);
  await expect(page.locator("tbody tr").first()).toBeVisible();
  await page.waitForTimeout(1200);
  await shot(page, "data-rows");

  await page.goto(`/projects/${image}/schema`);
  await expect(page.getByText("Live preview")).toBeVisible();
  await shot(page, "schema-editor");

  await page.goto(`/projects/${audio}`);
  await page.getByRole("button", { name: "Export" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await shot(page, "export");
  await page.keyboard.press("Escape");

  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`/projects/${audio}`);
  await expect(page.getByText("Agreement by tool")).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, "overview-dark");
});

test("screenshots: labeling editors", async ({ page, request }) => {
  await login(page, "annotator2@annolab.dev");

  // image: boxes, a polygon and a point
  await page.goto(`/projects/${await projectId(request, "image")}/label`);
  await page.waitForURL(/\/label\/\d+$/);
  await expect(page.getByText(/\d+x\d+/).first()).toBeVisible();
  const s = (await page.locator(".stage").boundingBox())!;
  const at = (fx: number, fy: number) => [s.x + s.width * fx, s.y + s.height * fy] as const;
  await page.keyboard.press("b");
  await page.keyboard.press("1");
  await drag(page, ...at(0.3, 0.25), ...at(0.48, 0.62));
  await page.keyboard.press("2");
  await drag(page, ...at(0.56, 0.35), ...at(0.74, 0.7));
  await page.keyboard.press("p");
  for (const [fx, fy] of [[0.12, 0.6], [0.24, 0.55], [0.27, 0.78], [0.15, 0.85]]) await page.mouse.click(...at(fx, fy));
  await page.keyboard.press("Enter");
  await page.keyboard.press("v");
  await page.mouse.click(...at(0.4, 0.45));
  await page.waitForTimeout(1200);
  await shot(page, "label-image");

  await page.keyboard.press("?");
  await expect(page.getByRole("dialog")).toBeVisible();
  await shot(page, "shortcuts");
  await page.keyboard.press("Escape");

  // audio: model proposals, then the spectrogram
  await page.goto(`/projects/${await projectId(request, "audio")}/label`);
  await page.waitForURL(/\/label\/\d+$/);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /Propose/ }).click();
  await expect(page.locator(".transport [aria-live]")).toContainText("proposals");
  const plot = (await page.locator("[role=application]").boundingBox())!;
  await page.keyboard.press("2");
  await drag(page, plot.x + plot.width * 0.62, plot.y + 200, plot.x + plot.width * 0.68, plot.y + 200);
  await page.keyboard.press("=");
  await expect(page.locator(".save-status")).toHaveText("Saved", { timeout: 10_000 });
  await shot(page, "label-audio");
  await page.getByRole("button", { name: "Spectrogram" }).click();
  await page.waitForTimeout(2500);
  await shot(page, "label-audio-spectrogram");

  // video: one box track with two keyframes and a time segment
  await page.goto(`/projects/${await projectId(request, "video")}/label`);
  await page.waitForURL(/\/label\/\d+$/);
  await page.waitForTimeout(1500);
  const v = (await page.locator(".stage").boundingBox())!;
  const vat = (fx: number, fy: number) => [v.x + v.width * fx, v.y + v.height * fy] as const;
  await page.keyboard.press("b");
  await drag(page, ...vat(0.2, 0.3), ...vat(0.33, 0.72));
  for (let i = 0; i < 30; i++) await page.keyboard.press("]");
  await page.keyboard.press("v");
  await drag(page, ...vat(0.26, 0.5), ...vat(0.5, 0.5));
  for (let i = 0; i < 12; i++) await page.keyboard.press("[");
  await page.keyboard.press("r");
  await page.keyboard.press("e");
  for (let i = 0; i < 25; i++) await page.keyboard.press("]");
  await page.keyboard.press("e");
  await page.waitForTimeout(800);
  await shot(page, "label-video");

  // text: overlapping spans
  await page.goto(`/projects/${await projectId(request, "text")}/label`);
  await page.waitForURL(/\/label\/\d+$/);
  const doc = (await page.locator(".doc").boundingBox())!;
  await page.keyboard.press("1");
  await drag(page, doc.x + 40, doc.y + 50, doc.x + 330, doc.y + 50);
  await page.keyboard.press("4");
  await drag(page, doc.x + 200, doc.y + 50, doc.x + 420, doc.y + 50);
  await page.keyboard.press("2");
  await drag(page, doc.x + 60, doc.y + 90, doc.x + 200, doc.y + 90);
  await page.waitForTimeout(800);
  await shot(page, "label-text");
});

test("screenshots: review", async ({ page, request }) => {
  await login(page, "reviewer1@annolab.dev");
  await page.goto(`/projects/${await projectId(request, "image")}/review`);
  await page.waitForURL(/\/items\/\d+/);
  await page.waitForTimeout(1500);
  const s = (await page.locator(".stage").boundingBox())!;
  await page.keyboard.press("c");
  await page.mouse.click(s.x + s.width * 0.5, s.y + s.height * 0.45);
  await page.keyboard.type("Box misses the left edge of the object");
  await page.waitForTimeout(400);
  await shot(page, "review-image");

  await page.goto(`/projects/${await projectId(request, "audio")}/review`);
  await page.waitForURL(/\/items\/\d+/);
  await page.waitForTimeout(2000);
  await shot(page, "review-audio");

  await page.goto(`/projects/${await projectId(request, "text")}/review`);
  await page.waitForURL(/\/items\/\d+/);
  await page.waitForTimeout(1000);
  await shot(page, "review-text");
});
