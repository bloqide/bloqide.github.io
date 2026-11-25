/// <reference types="vite-plugin-pwa/vanillajs" />

// Injected by vite.config.ts `define`.
declare const __BUILD_DATE__: string; // YYMMDD (UTC)
declare const __BUILD_TIME__: string; // ISO timestamp
declare const __BUILD_COMMIT__: string; // short git hash, or "" outside a checkout
