import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Fully offline after first load: precache the app shell + all bundled assets.
// Everything (Blockly, xterm, board JSON, plugins, runtime .py) is bundled — no CDN.
export default defineConfig({
  base: "./",
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,json,py,woff2}"],
      },
      manifest: {
        name: "Bloq",
        short_name: "Bloq",
        description: "Block-based MicroPython IDE",
        theme_color: "#1e1e2e",
        display: "standalone",
        start_url: "./",
      },
    }),
  ],
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
