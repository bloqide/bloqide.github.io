import type {
  Board,
  MicroblockPlugin,
  BlockDef,
  BlockGenerator,
  ValueGenerator,
} from "./types";

// Loads all bundled boards and file plugins via Vite glob (build-time, trusted).
// To add a board or plugin: drop a file in boards/ or plugins/ and rebuild —
// no runtime import of untrusted code.
//
// The globs are evaluated lazily (first access) so this module can be imported
// in non-Vite contexts (e.g. headless tests) that inject their own defs.

let _boards: Board[] | null = null;
let _plugins: MicroblockPlugin[] | null = null;

function boards(): Board[] {
  if (_boards) return _boards;
  const mods = import.meta.glob<Board>("../../boards/*.json", { eager: true });
  _boards = Object.values(mods).map(
    (m) => (m as unknown as { default?: Board }).default ?? (m as unknown as Board)
  );
  return _boards;
}

function plugins(): MicroblockPlugin[] {
  if (_plugins) return _plugins;
  const mods = import.meta.glob<{ plugin: MicroblockPlugin }>("../../plugins/*/index.ts", {
    eager: true,
  });
  _plugins = Object.values(mods).map((m) => m.plugin);
  return _plugins;
}

export function allBoards(): Board[] {
  return boards();
}

export function getBoard(id: string): Board | undefined {
  return boards().find((b) => b.id === id);
}

export function getPlugin(id: string): MicroblockPlugin | undefined {
  return plugins().find((p) => p.id === id);
}

/**
 * Plugins active for a board: those it lists AND whose required capabilities the
 * board satisfies. Ordered by toolbox.order.
 */
export function activePlugins(board: Board): MicroblockPlugin[] {
  const caps = new Set(board.capabilities);
  return plugins()
    .filter((p) => board.plugins.includes(p.id))
    .filter((p) => (p.requires ?? []).every((c) => caps.has(c)))
    .sort((a, b) => a.toolbox.order - b.toolbox.order);
}

/** Flat map of block type -> its definition across active plugins. */
export function blockDefsFor(board: Board): Map<string, BlockDef> {
  const map = new Map<string, BlockDef>();
  for (const p of activePlugins(board)) {
    for (const [type, def] of Object.entries(p.blocks)) map.set(type, def);
  }
  return map;
}

/** Flat map of block type -> its generator across active plugins. */
export function generatorsFor(
  board: Board
): Map<string, BlockGenerator | ValueGenerator> {
  const map = new Map<string, BlockGenerator | ValueGenerator>();
  for (const p of activePlugins(board)) {
    for (const [type, gen] of Object.entries(p.generators)) map.set(type, gen);
  }
  return map;
}
