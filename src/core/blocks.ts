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

import * as Blockly from "blockly";
// The colour field left Blockly core in v11. Imported from source, not the
// package entry: that UMD bundle also pulls in every Blockly code generator.
import { registerFieldColour } from "@blockly/field-colour/src/field_colour";
import type { Board, BloqPlugin } from "./types";
import { activePlugins } from "./registry";

registerFieldColour(); // "field_colour" in block JSON (colour pickers)

// Registers Blockly block definitions for a board's active plugins and builds
// the toolbox. Dynamic tokens in field options (e.g. "$BOARD_DIGITAL_PINS") are
// replaced with option-provider functions bound to the current board, so one
// block definition adapts to any board.

type OptionList = [string, string][];

const gpio = (nums: number[]): OptionList => nums.map((p) => [`IO${p}`, String(p)]);
const aliasOpts = (board: Board): OptionList =>
  Object.entries(board.pins.aliases).map(([name, expr]) => [`${name} (${expr})`, String(expr)]);

// Real GPIOs first, aliases (e.g. the onboard LED) last, so a freshly dropped
// block never defaults to the LED — it has its own dedicated blocks.
function digitalPinOptions(board: Board): OptionList {
  const opts = [...gpio(board.pins.digital), ...aliasOpts(board)];
  return opts.length ? opts : [["0", "0"]];
}
function analogPinOptions(board: Board): OptionList {
  const opts = gpio(board.pins.analog);
  return opts.length ? opts : [["0", "0"]];
}
function pwmPinOptions(board: Board): OptionList {
  const opts = [...gpio(board.pins.pwm), ...aliasOpts(board)];
  return opts.length ? opts : [["0", "0"]];
}

// Same as the digital list, plus an explicit "none" for genuinely optional pins
// (a stepper driver's ENABLE line, say). "none" generates the Python literal.
function optionalOutputPinOptions(board: Board): OptionList {
  return [["none", "None"], ...digitalPinOptions(board)];
}

const TOKENS: Record<string, (b: Board) => OptionList> = {
  $BOARD_OUTPUT_PINS: digitalPinOptions,
  $BOARD_OUTPUT_PINS_OR_NONE: optionalOutputPinOptions,
  $BOARD_INPUT_PINS: digitalPinOptions,
  $BOARD_ANALOG_PINS: analogPinOptions,
  $BOARD_PWM_PINS: pwmPinOptions,
  $BOARD_DIGITAL_PINS: digitalPinOptions, // backward-compat alias
};

// The board whose pins the dropdowns should reflect right now. Kept live so
// switching boards updates every pin dropdown without re-defining blocks.
let activeBoard: Board | null = null;

/** Deep-clone a block JSON, replacing option tokens with a live provider bound
 *  to the current board (so dropdowns follow board switches). */
function resolveTokens(json: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(json));
  for (const key of Object.keys(clone)) {
    if (!key.startsWith("args")) continue;
    const args = clone[key] as Array<Record<string, unknown>>;
    for (const arg of args) {
      if (typeof arg.options === "string" && arg.options in TOKENS) {
        const provider = TOKENS[arg.options as string];
        arg.options = () => (activeBoard ? provider(activeBoard) : [["0", "0"]]);
      }
    }
  }
  return clone;
}

/** Full FontAwesome class for a glyph, defaulting to the solid style unless a
 *  style (fa-solid/brands/regular/…) is already named. */
export function faClass(faIcon: string): string {
  return /\bfa-(solid|brands|regular|light|thin|duotone)\b/.test(faIcon)
    ? faIcon
    : `fa-solid ${faIcon}`;
}

let registeredForBoard: string | null = null;

/** (Re)register all block definitions for the given board. */
export function registerBlocks(board: Board): void {
  activeBoard = board; // pin dropdowns read this live, so update it even if we skip re-defining
  if (registeredForBoard === board.id) return;
  for (const plugin of activePlugins(board)) {
    plugin.onBoardChange?.(board);
    for (const [type, def] of Object.entries(plugin.blocks)) {
      if (def.builtin) continue; // Blockly owns the definition (e.g. procedures)
      const json = resolveTokens(def.json);
      // defineBlocks replaces any existing definition of the same type.
      Blockly.common.defineBlocks(
        Blockly.common.createBlockDefinitionsFromJsonArray([json])
      );
      void type;
    }
  }
  registeredForBoard = board.id;
}

// Plugins whose advanced blocks are currently shown (toggled by the "More
// blocks" flyout button). Per session, shared across boards.
const expanded = new Set<string>();

// The workspace whose toolbox the "More blocks" buttons update, once injected.
let toolboxWorkspace: Blockly.WorkspaceSvg | null = null;
const buttonKeys = new Map<string, () => void>();

/** Hook the toolbox's flyout buttons up to the workspace (call once after
 *  inject: the first toolbox is built before the workspace exists). */
export function bindToolbox(workspace: Blockly.WorkspaceSvg): void {
  toolboxWorkspace = workspace;
  for (const [key, fn] of buttonKeys) workspace.registerButtonCallback(key, fn);
}

function buttonKey(key: string, fn: () => void): string {
  buttonKeys.set(key, fn);
  toolboxWorkspace?.registerButtonCallback(key, fn);
  return key;
}

/** Show or hide a plugin's advanced blocks, keeping the open flyout where it is. */
function toggleAdvanced(plugin: BloqPlugin): void {
  if (expanded.has(plugin.id)) expanded.delete(plugin.id);
  else expanded.add(plugin.id);
  const ws = toolboxWorkspace;
  const toolbox = ws?.getToolbox() as Blockly.Toolbox | null | undefined;
  if (!ws || !toolbox || !activeBoard) return;
  const name = plugin.toolbox.category;
  const category = toolbox.getToolboxItemById(categoryId(name)) as Blockly.ToolboxCategory | null;
  if (!category) return;
  const flyoutWs = toolbox.getFlyout()?.getWorkspace();
  const scrollY = flyoutWs?.scrollY ?? 0;
  category.updateFlyoutContents(
    categoryContents(activeBoard, name, groupPlugins(activeBoard).get(name) ?? [plugin]) as unknown as Blockly.utils.toolbox.FlyoutItemInfoArray
  );
  if (toolbox.getSelectedItem() === category) {
    toolbox.refreshSelection(); // re-shows the flyout, scrolled back to the top…
    flyoutWs?.scroll(flyoutWs.scrollX, scrollY); // …so put it back
  }
}

const categoryId = (name: string) => `category:${name}`;

/** Active plugins grouped by category name, in toolbox order. activePlugins is
 *  ordered by toolbox.order and a Map keeps insertion order, so categories keep
 *  that order and the first plugin of a group (the lowest order) leads it. */
function groupPlugins(board: Board): Map<string, BloqPlugin[]> {
  const groups = new Map<string, BloqPlugin[]>();
  for (const plugin of activePlugins(board)) {
    const group = groups.get(plugin.toolbox.category);
    if (group) group.push(plugin);
    else groups.set(plugin.toolbox.category, [plugin]);
  }
  return groups;
}

/** One plugin's part of a flyout: its section label, its blocks, and its
 *  advanced blocks behind a "More blocks" button. */
function pluginEntries(plugin: BloqPlugin): Record<string, unknown>[] {
  // A block yields one flyout entry, or several when its `toolbox` is an
  // array of variants (e.g. one preset per operator of a dropdown block). A
  // variant's own `advanced` overrides the block's.
  const entries = (advanced: boolean) =>
    Object.entries(plugin.blocks).flatMap(([type, def]) => {
      const variants = Array.isArray(def.toolbox) ? def.toolbox : [def.toolbox ?? {}];
      return variants
        .filter((extra) => !!(extra.advanced ?? def.advanced) === advanced)
        .map(({ advanced: _, ...extra }) => ({ kind: "block", type, ...extra }));
    });
  const out: Record<string, unknown>[] = [];
  if (plugin.toolbox.section) out.push({ kind: "label", text: plugin.toolbox.section });
  out.push(...entries(false));
  const advanced = entries(true);
  if (advanced.length) {
    const open = expanded.has(plugin.id);
    out.push({
      kind: "button",
      text: open ? "▴ Fewer blocks" : "▾ More blocks",
      callbackkey: buttonKey(`more-blocks:${plugin.id}`, () => toggleAdvanced(plugin)),
    });
    if (open) out.push(...advanced);
  }
  return out;
}

/** A static category's flyout: each plugin's entries, then the presets. */
function categoryContents(board: Board, name: string, plugins: BloqPlugin[]): Record<string, unknown>[] {
  const entries = plugins.flatMap(pluginEntries);
  // Preset snippets: the plugins' own, plus any the board targets at this
  // category. Grouped under a label at the bottom of the flyout.
  const presets = [
    ...plugins.flatMap((plugin) => plugin.presets ?? []),
    ...(board.presets?.[name] ?? []),
  ];
  if (presets.length) {
    entries.push({ kind: "label", text: "Presets" }, ...presets);
  }
  return entries;
}

/** Build a Blockly category toolbox from the board's active plugins.
 *  Plugins that name the same category merge into one — that's how a shared
 *  plugin (Servo) can land in the same "Motors" category as a board's own
 *  motor blocks; each can label its part with a `section`. */
export function buildToolbox(board: Board): Blockly.utils.toolbox.ToolboxDefinition {
  const contents = [...groupPlugins(board)].map(([name, plugins]) => {
    const head = plugins[0];
    const category: Record<string, unknown> = {
      kind: "category",
      name,
      toolboxitemid: categoryId(name), // lets a "More blocks" button update it in place
      colour: String(head.toolbox.colour),
      // Replace Blockly's default icon span classes with a FontAwesome glyph.
      // Default to the solid style unless the faIcon names one (e.g. brand icons
      // like fa-brands fa-bluetooth-b, which aren't in the solid set).
      cssConfig: head.toolbox.faIcon
        ? { icon: `cat-icon ${faClass(head.toolbox.faIcon)}` }
        : undefined,
    };
    if (head.toolbox.custom) {
      // Dynamic flyout (e.g. Variables): Blockly's registered callback supplies
      // the blocks, plus affordances like the "Create variable" button. It owns
      // the whole flyout, so nothing merges into it.
      category.custom = head.toolbox.custom;
      return category;
    }
    category.contents = categoryContents(board, name, plugins);
    return category;
  });
  return { kind: "categoryToolbox", contents } as unknown as Blockly.utils.toolbox.ToolboxDefinition;
}
