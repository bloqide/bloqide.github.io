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

import type { BloqPlugin, GenContext } from "../../src/core/types";
import type * as Blockly from "blockly";

// Variables. Backed by Blockly's built-in variable model: the category uses the
// dynamic "VARIABLE" flyout (get/set blocks + a "Create variable" button), and
// `for_range` counters are the same variables. Generators emit the variable's
// (sanitised) display name as a plain Python identifier.

function ident(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[a-zA-Z_]/.test(s) ? s : `_${s}`;
}

function varName(block: Blockly.Block): string {
  return ident(block.getField("VAR")?.getText() ?? "item");
}

export const plugin: BloqPlugin = {
  id: "core-variables",
  name: "Variables",
  version: "1.0.0",
  toolbox: { category: "Variables", colour: 330, order: 60, faIcon: "fa-box", custom: "VARIABLE" },

  blocks: {
    variables_set: {
      kind: "statement",
      json: {
        type: "variables_set",
        message0: "set %1 to %2",
        args0: [
          { type: "field_variable", name: "VAR", variable: "item" },
          { type: "input_value", name: "VALUE" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: 330,
      },
    },
    variables_get: {
      kind: "value",
      json: {
        type: "variables_get",
        message0: "%1",
        args0: [{ type: "field_variable", name: "VAR", variable: "item" }],
        output: null,
        colour: 330,
      },
    },
    // Supplied by Blockly's Variables flyout ("change x by 1"). Defined here so
    // it renders in our style and has a generator (otherwise: unknown block).
    math_change: {
      kind: "statement",
      json: {
        type: "math_change",
        message0: "change %1 by %2",
        args0: [
          { type: "field_variable", name: "VAR", variable: "item" },
          { type: "input_value", name: "DELTA" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: 330,
      },
      toolbox: { inputs: { DELTA: { shadow: { type: "math_number", fields: { NUM: 1 } } } } },
    },
  },

  generators: {
    variables_set: (block: Blockly.Block, ctx: GenContext) => {
      const name = varName(block);
      ctx.assign(name);
      ctx.line(`${name} = ${ctx.value(block, "VALUE", "0")}`, block.id);
    },
    variables_get: (block: Blockly.Block) => varName(block),
    math_change: (block: Blockly.Block, ctx: GenContext) => {
      const name = varName(block);
      ctx.assign(name);
      ctx.line(`${name} = ${name} + ${ctx.value(block, "DELTA", "1")}`, block.id);
    },
  },
};
