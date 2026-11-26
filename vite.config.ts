/*
 * Bloq — offline block-based MicroPython IDE
 * Copyright (C) 2026 Benjamin Balga
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Build stamp shown in the UI so users can tell whether they're on the latest
// deploy. A date code (YYMMDD, UTC — the deploy runs on GitHub Actions) is all
// that matters to users; the short commit hash goes in the tooltip.
const now = new Date();
const pad = (n: number) => String(n).padStart(2, "0");
const BUILD_DATE = `${pad(now.getUTCFullYear() % 100)}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
let BUILD_COMMIT = "";
try {
  BUILD_COMMIT = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
} catch {
  /* not a git checkout: date code only */
}

// Blockly's media (zoom/trash sprites, cursors, sounds). Without a `media`
// option Blockly hot-links blockly-demo.appspot.com, which serves the *latest*
// release's sprite sheet — mismatched with our pinned version (garbled zoom /
// trash icons) and unavailable offline. Serve the copy matching the installed
// package at ./blockly-media/ instead (dev: middleware; build: emitted assets).
const BLOCKLY_MEDIA_DIR = "node_modules/blockly/media";
const BLOCKLY_MEDIA_URL = "blockly-media/";
const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png", ".svg": "image/svg+xml", ".gif": "image/gif",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".cur": "image/x-icon",
};
function blocklyMedia(): Plugin {
  return {
    name: "bloq-blockly-media",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/\/blockly-media\/([\w.-]+)$/);
        if (!m) return next();
        try {
          const data = readFileSync(join(BLOCKLY_MEDIA_DIR, m[1]));
          res.setHeader("Content-Type", MEDIA_TYPES[extname(m[1])] ?? "application/octet-stream");
          res.end(data);
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const f of readdirSync(BLOCKLY_MEDIA_DIR)) {
        this.emitFile({
          type: "asset",
          fileName: BLOCKLY_MEDIA_URL + f,
          source: readFileSync(join(BLOCKLY_MEDIA_DIR, f)),
        });
      }
    },
  };
}

// Fully offline after first load: precache the app shell + all bundled assets.
// Everything (Blockly, xterm, board JSON, plugins, runtime .py) is bundled — no CDN.
export default defineConfig({
  base: "./",
  define: {
    __BUILD_DATE__: JSON.stringify(BUILD_DATE),
    __BUILD_TIME__: JSON.stringify(now.toISOString()),
    __BUILD_COMMIT__: JSON.stringify(BUILD_COMMIT),
  },
  plugins: [
    blocklyMedia(),
    VitePWA({
      // "prompt": a downloaded update waits until the user restarts via the
      // Update button (src/ui/appStatus.ts), instead of swapping the code under
      // a running session with open serial connections.
      registerType: "prompt",
      injectRegister: false, // registered from appStatus.ts via virtual:pwa-register
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,json,py,woff2,gif,cur,mp3}"],
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
