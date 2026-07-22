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

import type {
  Board,
  BloqPlugin,
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
let _plugins: BloqPlugin[] | null = null;
// plugin id -> owning board id (for board-owned plugins), or null if shared.
let _pluginOwner = new Map<string, string | null>();

function boards(): Board[] {
  if (_boards) return _boards;
  // Each board is self-contained in boards/<id>/<id>.json.
  const mods = import.meta.glob<Board>("../../boards/*/*.json", { eager: true });
  _boards = Object.values(mods).map(
    (m) => (m as unknown as { default?: Board }).default ?? (m as unknown as Board)
  );
  return _boards;
}

function plugins(): BloqPlugin[] {
  if (_plugins) return _plugins;
  // Shared plugins live in plugins/<id>/; board-owned plugins in
  // boards/<id>/plugins/<name>/. Both merge into one registry keyed by plugin id.
  // The path tells us the owner: a board-owned plugin only activates on its board.
  const mods = import.meta.glob<{ plugin: BloqPlugin }>(
    ["../../plugins/*/index.ts", "../../boards/*/plugins/*/index.ts"],
    { eager: true }
  );
  const out: BloqPlugin[] = [];
  const owner = new Map<string, string | null>();
  for (const [path, m] of Object.entries(mods)) {
    const boardMatch = path.match(/\/boards\/([^/]+)\/plugins\//);
    owner.set(m.plugin.id, boardMatch ? boardMatch[1] : null);
    out.push(m.plugin);
  }
  _plugins = out;
  _pluginOwner = owner;
  return _plugins;
}

export function allBoards(): Board[] {
  return boards();
}

export function getBoard(id: string): Board | undefined {
  return boards().find((b) => b.id === id);
}

export function getPlugin(id: string): BloqPlugin | undefined {
  return plugins().find((p) => p.id === id);
}

/**
 * Pure plugin-selection rule (no glob), so it can be unit-tested:
 *   - a board-owned plugin activates only on its owning board;
 *   - any plugin activates only if the board's capabilities satisfy its
 *     `requires` (no `requires` -> available everywhere);
 *   - `board.pluginsExclude` opts a board out of one it would otherwise get.
 * There is no allow-list: adding a shared plugin surfaces it on every capable
 * board automatically, with no board edits. Ordered by toolbox.order.
 */
export function selectPlugins(
  board: Pick<Board, "id" | "capabilities" | "pluginsExclude">,
  all: BloqPlugin[],
  ownerOf: (id: string) => string | null
): BloqPlugin[] {
  const caps = new Set(board.capabilities);
  const exclude = new Set(board.pluginsExclude ?? []);
  return all
    .filter((p) => {
      if (exclude.has(p.id)) return false;
      const owner = ownerOf(p.id);
      if (owner !== null && owner !== board.id) return false; // owned by another board
      return (p.requires ?? []).every((c) => caps.has(c));
    })
    .sort((a, b) => a.toolbox.order - b.toolbox.order);
}

/** Plugins active for a board, resolved against the loaded registry. */
export function activePlugins(board: Board): BloqPlugin[] {
  const all = plugins(); // also populates _pluginOwner
  return selectPlugins(board, all, (id) => _pluginOwner.get(id) ?? null);
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
