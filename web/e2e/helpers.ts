import type { APIRequestContext, Page } from "@playwright/test";

export const PASSWORD = "annolab";

export async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

export async function token(request: APIRequestContext, email: string): Promise<string> {
  const r = await request.post("/api/auth/login", { data: { email, password: PASSWORD } });
  return (await r.json()).token;
}

export async function projectId(request: APIRequestContext, modality: string): Promise<number> {
  const t = await token(request, "admin@annolab.dev");
  const r = await request.get("/api/projects", { headers: { Authorization: `Bearer ${t}` } });
  const ps = (await r.json()) as { id: number; modality: string }[];
  const p = ps.find((x) => x.modality === modality);
  if (!p) throw new Error(`no ${modality} project; run make seed`);
  return p.id;
}

/** Drag on the page in screen pixels. */
export async function drag(page: Page, x1: number, y1: number, x2: number, y2: number) {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 6 });
  await page.mouse.up();
}
