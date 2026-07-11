# Microblock — Architecture

An offline, block-based MicroPython IDE for robots and boards. Drag Scratch-style
blocks, generate readable MicroPython, and run it on hardware over Web Serial —
all client-side, no server, no internet after first load.

This document is the design reference. The repo currently ships a **minimal but
running skeleton** that proves the core pipeline (see "Status" at the end).

---

## 1. Principles

1. **Fully client-side / offline.** Everything (Blockly, xterm, board JSON,
   plugins, the scheduler runtime) is bundled. After first load it runs with the
   network off. A PWA service worker precaches the app shell.
2. **Chromium-only, by choice.** Web Serial is Chromium-only (no Firefox/Safari).
   Acceptable for a maker tool; users get a "use Chrome/Edge" notice.
3. **Everything is the same shape.** File plugins, wizard blocks, reusable blocks,
   raw-code blocks and board overrides all produce the same
   `(block definition, generator)` pair and flow through the same `GenContext`.
   That uniformity is what keeps "add things easily" true across every authoring
   path.
4. **Trusted-by-construction plugins.** Plugins are files copied into the app
   (not imported at runtime in the browser), so they carry the same trust as the
   app's own source — no sandboxing needed, full JS generators allowed.
5. **Blocks are the source of truth; code is one-way with an explicit detach.**
   Code → blocks parsing is not attempted. Instead: read-only live code, an
   explicit "Edit code (detach)", and "Revert to blocks".
6. **Simple by default.** Single-hat programs generate plain linear MicroPython
   with no runtime import — readable and ~1:1 with the blocks. Concurrency
   machinery only appears when actually needed.

---

## 2. Layers

```
┌─────────────────────────────────────────────┐
│  UI shell (menu, view tabs, drawers)          │
├───────────────┬──────────────┬───────────────┤
│ Blockly       │ Code view    │ Terminal      │
│ workspace     │ (+ src map)  │ (xterm)       │
├───────────────┴──────────────┴───────────────┤
│  Core services                                │
│  • registry    (boards + plugins, glob-loaded)│
│  • blocks      (register defs, build toolbox)  │
│  • CodeGen     (workspace → MicroPython)       │
│  • SerialService (Web Serial + raw REPL)       │
├───────────────────────────────────────────────┤
│  Persistence: localStorage / IndexedDB         │
│  Offline: service worker (vite-plugin-pwa)     │
└───────────────────────────────────────────────┘
```

Stack: **Vite + vanilla TypeScript**, **Blockly** (MIT), **xterm.js**,
**vite-plugin-pwa** (Workbox). No UI framework — Blockly and xterm are
framework-agnostic and the core stays light.

---

## 3. Boards

A board is **pure JSON data** (`boards/*.json`), so boards can be added by
dropping a file in, or through an in-app Board Editor that writes the same shape
to IndexedDB. See `src/core/types.ts` (`Board`) and `boards/esp32-c3.json`.

Key insight: a board must be able to **change how blocks generate code**, because
MicroPython dialects differ (a Pico uses `machine.Pin(0).value(1)`; a micro:bit
uses `pin0.write_digital(1)`). So a board carries `overrides` — per-block-type
template replacements — alongside the hardware facts.

| Field | Consumed by | Effect |
|---|---|---|
| `connection.*` | SerialService | baud, REPL mode, reset behaviour, EOL |
| `runtime.dialect` / `imports` | CodeGen | default template set + header import seed |
| `pins.*` | block dropdowns | `$BOARD_DIGITAL_PINS` token resolves to these |
| `pins.aliases` | dropdowns | friendly names (`LED`) → pin expressions |
| `buses.*` | bus blocks | default sda/scl/freq so I²C works with no config |
| `constraints.*` | field validators | reject out-of-range ADC/PWM/voltage |
| `onboard` | toolbox | auto-surface convenience blocks (onboard LED) |
| `capabilities` | toolbox filter | a block `requires` a capability; hidden otherwise |
| `plugins` | registry | which block bundles load for this board |
| `overrides` | CodeGen | per-block template per dialect (the escape hatch) |
| `libraries` | device sync | `.py` files shipped to the board filesystem |
| `examples` | gallery | separate `.mbproj` files, lazy-loaded |
| `icon` | UI | preset name, or user-imported image (blob in IndexedDB) |

**Decoupling rule:** `capabilities` = hardware facts; `plugins` = which bundles
load; `overrides` = how blocks generate for this dialect. A block references a
*capability*, never a board — so blocks and boards evolve independently.

---

## 4. Plugins (block bundles)

A plugin is a **file-based TS module** (`plugins/<id>/index.ts`) exporting a
`MicroblockPlugin`. Trusted, so full JS generators are allowed. See
`src/core/types.ts` (`MicroblockPlugin`) and `plugins/core-*/`.

A plugin bundles: `blocks` (Blockly JSON defs), `generators` (JS function *or*
template string per block), a `toolbox` category contribution, `requires`
(capability gate), `dependencies`, `libraries` (device `.py` deps merged into the
sync set), `examples`, an `icon`, and an optional `onBoardChange` hook.

### The generator context (`GenContext`)

Every generator receives one `ctx`. This is the real authoring API surface, and
what lets independent blocks compose one clean program without colliding:

- Header management (deduped across the whole program): `ensureImport`,
  `addSetup`, `defineFunction`, `requireLibrary`.
- Safe naming: `reserveVariable(base)` — idempotent per base, so two writes to the
  same pin share one initialised `Pin(...)`.
- Emitting statements: `line(text, blockId)`, `indented(fn)`, `statement(block,
  input)` (recurse into a container), `value(block, input)` (evaluate a value
  input to an expression string).
- Scheduler bookkeeping: `schedulerMode` (read), `markYield()`.

Generators **write lines into `ctx`** (rather than returning a string). That's
what makes precise **line → block** source maps possible for the side-by-side
view. Template-string generators (Tier A) are wrapped into an emit call by the
engine.

### The five authoring paths — all one shape

| Path | Who | Storage | Generator |
|---|---|---|---|
| **File plugin** | devs | `plugins/` (rebuild) | full JS or template |
| **In-app wizard block** | end users | IndexedDB | template only (Tier A) |
| **Reusable block** ("make a block") | end users | project, promotable to library | template call + one `defineFunction` |
| **Raw MicroPython block** | end users | in the block | verbatim text |
| **Board override** | board author | board JSON | template (per dialect) |

- **Wizard block:** a form produces the plugin manifest shape minus the JS
  function — `{type, label, inputs, kind, imports, template}` — interpreted by one
  generic template generator. No code execution; safe and offline.
- **Reusable block:** wrap a self-contained sub-program, **collapse** it to a
  single block for display, **unroll** to expand. Codegen emits the `def` once
  (hoisted) + a call. Starts project-local; "Promote to My Blocks" lifts it to an
  IndexedDB library. Nested reusable blocks: collect the transitive set of
  function defs at generation time, dedupe by name.
- **Raw block:** escape hatch. Emitted verbatim; linted for blocking `sleep` in
  scheduler mode.

---

## 5. Code generation

`src/core/codegen.ts`. Walks the workspace and emits MicroPython in one of two
modes, chosen automatically:

- **Simple mode** — ≤1 hat and no block requires the scheduler. Plain linear
  code, `time.sleep_ms`, no runtime import. Readable, beginner-friendly.
- **Scheduler mode** — >1 hat, OR a block sets `requiresScheduler`. Each hat
  becomes a cooperative generator run by the round-robin scheduler.

`schedulerMode = (hatCount > 1) || anyBlock.requiresScheduler`

Core control blocks (`forever`, `wait`, …) **adapt** to the active mode — they
never force the scheduler. Only a plugin that genuinely needs cooperative
background behaviour sets `requiresScheduler`, so implicit scheduler use can't
silently change a beginner's timings.

### Mode-dependent block output

| Block | Simple mode | Scheduler mode |
|---|---|---|
| hat (`when_started`) | body emitted at top level | `def stack_N():` + `sched.spawn(stack_N)` |
| `forever` / `repeat` | `while True:` / `for …:` | same + trailing `yield` per iteration |
| `wait N ms` | `time.sleep_ms(N)` | `yield from sched.sleep_ms(N)` |
| event hat | `while True:` + poll | `while True: yield from sched.wait_until(...)` |

Assembly order: header comment → imports (sorted, deduped) → `from mbruntime
import sched` (scheduler only) → setup lines → hoisted function defs → body
(linear, or `def stack_N` + `spawn` + `sched.run()`).

### Source map (bidirectional)

As it emits, CodeGen records `line → blockId` and `blockId → [lines]`. Uses:
- **Runtime errors:** parse a traceback off serial (`line 14`) → highlight the
  offending block red.
- **Understanding:** the side-by-side view — click a code line to select its
  block, select a block to highlight its code lines.

---

## 6. Concurrency runtime (cooperative scheduler)

`src/runtime/mbruntime.py`, shipped to the device (`/lib/mbruntime.py`) **only
when scheduler mode is used**. ~20 lines. Each stack is a Python generator; the
scheduler runs each until its next `yield`.

Cooperative, not preemptive, which buys a real bonus: **everything between two
yields is atomic → no locks needed**. Waits (`sched.sleep_ms`) yield instead of
blocking, so stacks interleave. `sched.wait_until(pred)` yields until a condition
holds (event hats).

---

## 7. Serial + device I/O

`src/serial/serialService.ts`. Web Serial gives bytes; MicroPython gives a REPL.

- **connect()** — user-gesture port pick, open at the board's baud, optional
  DTR/RTS reset, then a single read loop feeds the terminal and buffers bytes for
  command parsing.
- **Raw REPL** (`Ctrl-A` … code … `Ctrl-D`) to upload/execute reliably (not typing
  into the friendly REPL). *(Skeleton uses plain raw REPL; large uploads would
  want raw-paste flow control.)*
- **Run** — sync libs (delta) → paste program → execute in RAM. `main.py`
  untouched.
- **Save to board** — sync libs → write program as `/main.py` → soft-reboot →
  runs on power-up.
- **Stop** — `Ctrl-C` `Ctrl-C`.

### Device-file sync (upload speed)

Don't blast files every run. Required files = `board.libraries ∪
Σ plugin.libraries ∪ main.py`. Keep a hash manifest; upload only changed/missing
files. So repeated Runs move just the changed `main.py`. *(Skeleton uses an
in-memory session hash cache; a full impl reads a device-side manifest.)*

---

## 8. UI

- **Menu bar** (top): view tabs (Blocks / Split / Code), Connect, Run, Save to
  board, Stop, Terminal.
- **Toolbox** (left): vertical category rail (icon + text); clicking opens a
  flyout; drag blocks onto the canvas. Blockly's category toolbox.
- **Canvas**: zoom, pan, grid, auto-size, trashcan (Blockly). Zelos renderer for
  the rounded Scratch look.
- **Code view**: read-only, line-numbered, source-map-highlighted; **Split** shows
  blocks + code side by side. "Edit code (detach)" → editable textarea, blocks go
  read-only; "Revert to blocks" restores.
- **Terminal** (right drawer): xterm; renders serial output, forwards keystrokes
  for an interactive REPL.

---

## 9. Projects & persistence

- A **project** = one JSON doc: `{ board, blocks (Blockly serialization),
  reusableBlocks, detached, editedCode? }`, saved as `.mbproj`.
- **Multi-project** = tabs, each its own workspace; copy-paste and diff work
  because everything is serializable JSON.
- Store in IndexedDB; import/export `.mbproj` files. Wizard blocks and promoted
  reusable blocks live in a separate IndexedDB library, shared across projects.
- **Built:** IndexedDB project library (list / open / duplicate / delete),
  per-project autosave, reopen-last-project on boot, rename, `.mbproj`
  export/import (`src/project/`, `src/ui/library.ts`). Single active project;
  multi-project tabs still deferred.

---

## 10. Data-model quick reference

See `src/core/types.ts` for the authoritative definitions: `Board`,
`MicroblockPlugin`, `BlockDef`, `BlockGenerator` / `ValueGenerator`, `GenContext`,
`GenResult`.

---

## Status — what the skeleton ships vs. designed

**Working & verified (typecheck + build + headless codegen tests):**

- ESP32-C3 board definition, glob-loaded registry (boards + plugins).
- `core-control` (hats, forever, repeat, wait, raw-python) and `core-gpio`
  (pin write, onboard LED toggle) plugins.
- CodeGen: simple ↔ scheduler auto-mode, header dedup, pin-setup dedup,
  bidirectional source map. (`scripts/codegen.test.ts` — 4 checks pass.)
- Cooperative scheduler runtime.
- Blockly workspace (zelos, grid, zoom/pan), toolbox from plugins, live codegen,
  Split view with source-map highlighting, detach/revert.
- SerialService (Web Serial + raw REPL: run / save-to-board / stop / delta lib
  sync) + xterm terminal.
- PWA offline precache.
- **Project library** (IndexedDB): open / duplicate / delete, per-project
  autosave, reopen-last-on-boot, rename, `.mbproj` export/import.

**Designed, not yet built (clean add-ons — no foundation changes):**

- In-app wizard block editor; reusable "make a block" (collapse/unroll/promote);
  in-app Board Editor; multi-project tabs; examples gallery (files exist, loader
  not wired); board/plugin icons in UI; block search; i18n; traceback → block
  highlighting; device-side sync manifest; raw-paste flow control; additional
  boards/plugins (I²C/SPI/PWM/NeoPixel).
```
