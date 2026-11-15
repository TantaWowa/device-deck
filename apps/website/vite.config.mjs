import { defineConfig } from "vite";
import { deviceDeckDocs } from "../../scripts/build-docs.mjs";

export default defineConfig({ plugins: [deviceDeckDocs()] });
