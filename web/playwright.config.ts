import { defineConfig } from "@playwright/test";

// Runs against a live dev stack (make dev) seeded with make seed.
// WEB_URL overrides the address, e.g. WEB_URL=http://127.0.0.1:5181.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.WEB_URL ?? "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    trace: "retain-on-failure",
  },
});
