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
        background_color: "#1e1e2e",
        display: "standalone",
        start_url: "./",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "maskable-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
          { src: "bloq_icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
    }),
  ],
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
