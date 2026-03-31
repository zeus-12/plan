import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        "@plan/shared": resolve(__dirname, "../../shared"),
      },
    },
    plugins: [react()],
    css: {
      postcss: resolve(__dirname, "postcss.config.mjs"),
    },
  },
});
