import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const srcAlias = { "@": resolve(__dirname, "src") };

export default defineConfig({
  main: {
    resolve: { alias: srcAlias },
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    resolve: { alias: srcAlias },
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        ...srcAlias,
        "@plan/shared": resolve(__dirname, "../../shared"),
      },
    },
    plugins: [react()],
    css: {
      postcss: resolve(__dirname, "postcss.config.mjs"),
    },
    build: {
      // Electron ships a modern Chromium, so skip legacy transpilation/polyfills.
      target: "esnext",
    },
  },
});
