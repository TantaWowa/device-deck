import { defineConfig } from "vite";

export default defineConfig({
  base: "/app/",
  server: { proxy: { "/api": { target: process.env.DEVICE_DECK_CLOUD_URL || "http://127.0.0.1:8080", changeOrigin: false } } },
});
