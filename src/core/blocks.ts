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
import type { Board } from "./types";
import { activePlugins } from "./registry";

// Registers Blockly block definitions for a board's active plugins and builds
// the toolbox. Dynamic tokens in field options (e.g. "$BOARD_DIGITAL_PINS") are
// replaced with option-provider functions bound to the current board, so one
// block definition adapts to any board.

type OptionList = [string, string][];

const gpio = (nums: number[]): OptionList => nums.map((p) => [`GPIO${p}`, String(p)]);
const aliasOpts = (board: Board): OptionList =>
  Object.entries(board.pins.aliases).map(([name, expr]) => [`${name} (${expr})`, String(expr)]);

// Output-ish dropdowns (write, PWM): aliases first, so the LED is a natural
// default. Input dropdowns (read, button): real GPIOs first, so they don't
// default to an output alias like the LED.
function outputPinOptions(board: Board): OptionList {
  const opts = [...aliasOpts(board), ...gpio(board.pins.digital)];
  return opts.length ? opts : [["0", "0"]];
}
function inputPinOptions(board: Board): OptionList {
  const opts = [...gpio(board.pins.digital), ...aliasOpts(board)];
  return opts.length ? opts : [["0", "0"]];
}
function analogPinOptions(board: Board): OptionList {
  const opts = gpio(board.pins.analog);
  return opts.length ? opts : [["0", "0"]];
}
function pwmPinOptions(board: Board): OptionList {
  const opts = [...aliasOpts(board), ...gpio(board.pins.pwm)];
  return opts.length ? opts : [["0", "0"]];
}

// Same as the output list, plus an explicit "none" for genuinely optional pins
// (a stepper driver's ENABLE line, say). "none" generates the Python literal.
function optionalOutputPinOptions(board: Board): OptionList {
  return [["none", "None"], ...outputPinOptions(board)];
}

const TOKENS: Record<string, (b: Board) => OptionList> = {
  $BOARD_OUTPUT_PINS: outputPinOptions,
  $BOARD_OUTPUT_PINS_OR_NONE: optionalOutputPinOptions,
  $BOARD_INPUT_PINS: inputPinOptions,
  $BOARD_ANALOG_PINS: analogPinOptions,
  $BOARD_PWM_PINS: pwmPinOptions,
  $BOARD_DIGITAL_PINS: outputPinOptions, // backward-compat alias
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

/** Build a Blockly category toolbox from the board's active plugins. */
export function buildToolbox(board: Board): Blockly.utils.toolbox.ToolboxDefinition {
  const contents = activePlugins(board).map((plugin) => {
    const category: Record<string, unknown> = {
      kind: "category",
      name: plugin.toolbox.category,
      colour: String(plugin.toolbox.colour),
      // Replace Blockly's default icon span classes with a FontAwesome glyph.
      // Default to the solid style unless the faIcon names one (e.g. brand icons
      // like fa-brands fa-bluetooth-b, which aren't in the solid set).
      cssConfig: plugin.toolbox.faIcon
        ? { icon: `cat-icon ${faClass(plugin.toolbox.faIcon)}` }
        : undefined,
    };
    if (plugin.toolbox.custom) {
      // Dynamic flyout (e.g. Variables): Blockly's registered callback supplies
      // the blocks, plus affordances like the "Create variable" button.
      category.custom = plugin.toolbox.custom;
    } else {
      // A block yields one flyout entry, or several when its `toolbox` is an
      // array of variants (e.g. one preset per operator of a dropdown block).
      const contents: Record<string, unknown>[] = Object.entries(plugin.blocks).flatMap(
        ([type, def]) => {
          const variants = Array.isArray(def.toolbox) ? def.toolbox : [def.toolbox ?? {}];
          return variants.map((extra) => ({ kind: "block", type, ...extra }));
        }
      );
      // Preset snippets: the plugin's own, plus any the board targets at this
      // category. Grouped under a label at the bottom of the flyout.
      const presets = [
        ...(plugin.presets ?? []),
        ...(board.presets?.[plugin.toolbox.category] ?? []),
      ];
      if (presets.length) {
        contents.push({ kind: "label", text: "Presets" }, ...presets);
      }
      category.contents = contents;
    }
    return category;
  });
  return { kind: "categoryToolbox", contents } as unknown as Blockly.utils.toolbox.ToolboxDefinition;
}
