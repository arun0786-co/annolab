/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.ANNOLAB_API ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: { "/api": { target: api, changeOrigin: true } },
  },
  preview: {
    proxy: { "/api": { target: api, changeOrigin: true } },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
