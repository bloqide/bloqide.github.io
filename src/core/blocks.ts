import * as Blockly from "blockly";
import type { Board } from "./types";
import { activePlugins } from "./registry";

// Registers Blockly block definitions for a board's active plugins and builds
// the toolbox. Dynamic tokens in field options (e.g. "$BOARD_DIGITAL_PINS") are
// replaced with option-provider functions bound to the current board, so one
// block definition adapts to any board.

type OptionList = [string, string][];

function digitalPinOptions(board: Board): OptionList {
  const opts: OptionList = [];
  for (const [name, expr] of Object.entries(board.pins.aliases)) {
    opts.push([`${name} (${expr})`, String(expr)]);
  }
  for (const p of board.pins.digital) opts.push([`GPIO${p}`, String(p)]);
  return opts.length ? opts : [["0", "0"]];
}

function analogPinOptions(board: Board): OptionList {
  const opts: OptionList = board.pins.analog.map((p) => [`GPIO${p}`, String(p)]);
  return opts.length ? opts : [["0", "0"]];
}

const TOKENS: Record<string, (b: Board) => OptionList> = {
  $BOARD_DIGITAL_PINS: digitalPinOptions,
  $BOARD_ANALOG_PINS: analogPinOptions,
};

/** Deep-clone a block JSON, replacing option tokens with live providers. */
function resolveTokens(json: Record<string, unknown>, board: Board): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(json));
  for (const key of Object.keys(clone)) {
    if (!key.startsWith("args")) continue;
    const args = clone[key] as Array<Record<string, unknown>>;
    for (const arg of args) {
      if (typeof arg.options === "string" && arg.options in TOKENS) {
        arg.options = TOKENS[arg.options as string](board);
      }
    }
  }
  return clone;
}

let registeredForBoard: string | null = null;

/** (Re)register all block definitions for the given board. */
export function registerBlocks(board: Board): void {
  if (registeredForBoard === board.id) return;
  for (const plugin of activePlugins(board)) {
    plugin.onBoardChange?.(board);
    for (const [type, def] of Object.entries(plugin.blocks)) {
      const json = resolveTokens(def.json, board);
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
      cssConfig: plugin.toolbox.faIcon
        ? { icon: `cat-icon fa-solid ${plugin.toolbox.faIcon}` }
        : undefined,
    };
    if (plugin.toolbox.custom) {
      // Dynamic flyout (e.g. Variables): Blockly's registered callback supplies
      // the blocks, plus affordances like the "Create variable" button.
      category.custom = plugin.toolbox.custom;
    } else {
      // A block yields one flyout entry, or several when its `toolbox` is an
      // array of variants (e.g. one preset per operator of a dropdown block).
      category.contents = Object.entries(plugin.blocks).flatMap(([type, def]) => {
        const variants = Array.isArray(def.toolbox) ? def.toolbox : [def.toolbox ?? {}];
        return variants.map((extra) => ({ kind: "block", type, ...extra }));
      });
    }
    return category;
  });
  return { kind: "categoryToolbox", contents } as unknown as Blockly.utils.toolbox.ToolboxDefinition;
}
