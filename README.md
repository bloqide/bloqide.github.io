# Bloq

Offline, block-based **MicroPython IDE** for robots and boards — drag Scratch-style
blocks, generate readable MicroPython, and run it on hardware over **Web Serial**.
Fully client-side; works offline after first load.

**▶ Live: <https://bloqide.github.io/>** — use a Chromium browser (Chrome / Edge /
Opera, desktop) since Web Serial is Chromium-only. Auto-deployed from `main` via
GitHub Actions ([`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)).

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
   mode* to *scheduler mode* automatically (`bloq` appears, hats become
   cooperative generators).
4. Plug in an **ESP32-C3** (running MicroPython), click **Connect**, pick the
   port, then **▶ Run** (RAM) or **⬇ Save to board** (writes `main.py`, runs on
   boot). Open **Terminal** for the REPL.

Requires a **Chromium** browser (Web Serial). Firefox/Safari can edit but not
connect.

**Uploading over Bluetooth** (ESP32-family boards): once connected over USB,
click the Bluetooth button on the device's terminal pane. The board reboots
advertising as `Bloq-XXXX`; from then on the Bluetooth button next to
**Connect** lists it, and Run / Stop / the terminal work wirelessly. The link
stays off unless you turn it on: a Run over USB with the toggle off removes it.
While it's on, anyone nearby can connect to the board's REPL, so turn it off
when you don't need it.

**Projects** save automatically to an in-browser library. Use the top menu:
**New**, **Open…** (library + import `.bloq`), **Export** (download `.bloq`),
and click the project name to rename. Your last project reopens on reload.

## Scripts

```bash
npm run dev         # dev server (HMR)
npm run build       # typecheck + production build (PWA/offline)
npm run typecheck   # tsc --noEmit
npx tsx scripts/codegen.test.ts   # headless codegen checks (no browser)
python3 scripts/blelink.test.py   # Bluetooth upload link, on a faked radio
npx tsx scripts/bootlink.test.ts  # boot.py on/off edit for that link (needs python3)
# With a Bluetooth board on USB (pip install mpremote bleak pyserial websockets):
python3 scripts/blelink.hw.py --port /dev/cu.usbmodem101       # board side
python3 scripts/blelink.browser.py --port /dev/cu.usbmodem101  # app in Chrome/Brave (needs npm run dev)
```

## Layout

```
boards/<id>/       self-contained board                — add a board = drop a folder
  <id>.json        definition (pins, capabilities, plugins)
  lib/*.py         device drivers shipped to /lib
  images/*         board photo (icon.imageRef)
  plugins/*/       board-owned block bundles
  examples/*.bloq  board-specific example projects
plugins/<id>/      shared block bundles (TS modules)   — add blocks = drop a folder
  index.ts         BloqPlugin: blocks + generators
  examples/*.bloq  plugin-provided example projects
src/
  core/            types, registry, blocks, codegen
  runtime/         device-side Python: bloq.py (cooperative scheduler),
                   bloq_ble.py + bloq_link.py (Bluetooth upload link)
  serial/          Web Serial / Web Bluetooth + raw-REPL driver
  project/         .bloq model, IndexedDB store, import/export
  ui/              xterm terminal, dialogs (library, boards, examples)
  main.ts          app wiring
scripts/           headless tests
```

Board/plugin `lib`, `images`, and `examples` files are referenced by **basename**
(e.g. `"file": "blink.bloq"`), resolved from wherever they're bundled.

## Adding things

- **A board:** copy a `boards/<id>/` folder, rename it, edit `<id>.json`
  (pins/capabilities/plugins). Drop drivers in `lib/`, a photo in `images/`,
  board-only blocks in `plugins/`, and starters in `examples/`.
- **A block bundle:** copy a `plugins/core-*/` folder; export a `BloqPlugin`
  with `blocks` + `generators`. It appears in the toolbox for any board that
  lists it and satisfies its `requires` capabilities.

See ARCHITECTURE.md §4–5 for the generator API (`GenContext`) and the two codegen
modes.

## License

Bloq is free software, licensed under the [GNU General Public License v3.0](LICENSE)
or (at your option) any later version. It comes with no warranty; see the license
text for details.
