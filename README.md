# Microblock

Offline, block-based **MicroPython IDE** for robots and boards — drag Scratch-style
blocks, generate readable MicroPython, and run it on hardware over **Web Serial**.
Fully client-side; works offline after first load.

> Full design in **[ARCHITECTURE.md](./ARCHITECTURE.md)**. This is a minimal but
> running skeleton that proves the core pipeline end-to-end.

## Quick start

```bash
npm install
npm run dev        # open the printed localhost URL in Chrome or Edge
```

Then:
1. Drag a **Control ▸ when started**, add **Control ▸ forever**, drop **Pins ▸
   toggle onboard LED** and **Control ▸ wait 500 ms** inside.
2. Click **Split** to see blocks + generated MicroPython side by side. Click a
   code line to select its block, or a block to highlight its code.
3. Add a **second** `when started` stack → watch the code switch from *simple
   mode* to *scheduler mode* automatically (`mbruntime` appears, hats become
   cooperative generators).
4. Plug in an **ESP32-C3** (running MicroPython), click **Connect**, pick the
   port, then **▶ Run** (RAM) or **⬇ Save to board** (writes `main.py`, runs on
   boot). Open **Terminal** for the REPL.

Requires a **Chromium** browser (Web Serial). Firefox/Safari can edit but not
connect.

**Projects** save automatically to an in-browser library. Use the top menu:
**New**, **Open…** (library + import `.mbproj`), **Export** (download `.mbproj`),
and click the project name to rename. Your last project reopens on reload.

## Scripts

```bash
npm run dev         # dev server (HMR)
npm run build       # typecheck + production build (PWA/offline)
npm run typecheck   # tsc --noEmit
npx tsx scripts/codegen.test.ts   # headless codegen checks (no browser)
```

## Layout

```
boards/            board definitions (JSON)         — add a board = drop a file
plugins/           block bundles (TS modules)       — add blocks = drop a folder
  core-control/    hats, loops, wait, raw-python
  core-gpio/       pin write, onboard LED
src/
  core/            types, registry, blocks, codegen
  runtime/         mbruntime.py (cooperative scheduler, shipped to device)
  serial/          Web Serial + raw-REPL driver
  project/         .mbproj model, IndexedDB store, import/export
  ui/              xterm terminal, project library dialog
  main.ts          app wiring
examples/          example projects (.mbproj)
scripts/           headless tests
```

## Adding things

- **A board:** copy `boards/esp32-c3.json`, edit pins/capabilities/overrides.
- **A block bundle:** copy a `plugins/core-*/` folder; export a `MicroblockPlugin`
  with `blocks` + `generators`. It appears in the toolbox for any board that
  lists it and satisfies its `requires` capabilities.

See ARCHITECTURE.md §4–5 for the generator API (`GenContext`) and the two codegen
modes.
