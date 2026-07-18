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

// Boolean logic. `logic_compare` and `logic_operation` are dropdown blocks; the
// toolbox lists a preset variant per operator so you can drag the one you want
// and still switch the dropdown afterwards. Value blocks return a MicroPython
// expression; binary ops parenthesise their result to preserve precedence.

const COLOUR = 200;
const NUM_SHADOW = { shadow: { type: "math_number", fields: { NUM: 0 } } };
const TRUE_SHADOW = { shadow: { type: "logic_boolean", fields: { BOOL: "True" } } };

// [dropdown value, on-block label]
const COMPARE: [string, string][] = [
  ["==", "="],
  ["!=", "≠"],
  ["<", "<"],
  ["<=", "≤"],
  [">", ">"],
  [">=", "≥"],
];
const OPERATION: [string, string][] = [
  ["and", "and"],
  ["or", "or"],
  ["xor", "xor"],
];

export const plugin: BloqPlugin = {
  id: "core-logic",
  name: "Logic",
  version: "1.0.0",
  toolbox: { category: "Logic", colour: COLOUR, order: 30, faIcon: "fa-code-branch" },

  blocks: {
    logic_compare: {
      kind: "value",
      json: {
        type: "logic_compare",
        message0: "%1 %2 %3",
        args0: [
          { type: "input_value", name: "A" },
          { type: "field_dropdown", name: "OP", options: COMPARE.map(([v, label]) => [label, v]) },
          { type: "input_value", name: "B" },
        ],
        inputsInline: true,
        output: "Boolean",
        colour: COLOUR,
      },
      toolbox: COMPARE.map(([v]) => ({ fields: { OP: v }, inputs: { A: NUM_SHADOW, B: NUM_SHADOW } })),
    },
    logic_operation: {
      kind: "value",
      json: {
        type: "logic_operation",
        message0: "%1 %2 %3",
        args0: [
          { type: "input_value", name: "A", check: "Boolean" },
          { type: "field_dropdown", name: "OP", options: OPERATION.map(([v, label]) => [label, v]) },
          { type: "input_value", name: "B", check: "Boolean" },
        ],
        inputsInline: true,
        output: "Boolean",
        colour: COLOUR,
      },
      toolbox: OPERATION.map(([v]) => ({ fields: { OP: v }, inputs: { A: TRUE_SHADOW, B: TRUE_SHADOW } })),
    },
    logic_not: {
      kind: "value",
      json: {
        type: "logic_not",
        message0: "not %1",
        args0: [{ type: "input_value", name: "BOOL", check: "Boolean" }],
        inputsInline: true,
        output: "Boolean",
        colour: COLOUR,
      },
      toolbox: { inputs: { BOOL: TRUE_SHADOW } },
    },
    logic_boolean: {
      kind: "value",
      json: {
        type: "logic_boolean",
        message0: "%1",
        args0: [
          {
            type: "field_dropdown",
            name: "BOOL",
            options: [
              ["true", "True"],
              ["false", "False"],
            ],
          },
        ],
        output: "Boolean",
        colour: COLOUR,
      },
      // Offer both true and false as ready-to-drag variants.
      toolbox: [{ fields: { BOOL: "True" } }, { fields: { BOOL: "False" } }],
    },
  },

  generators: {
    logic_compare: (block: Blockly.Block, ctx: GenContext) => {
      const op = block.getFieldValue("OP");
      return `(${ctx.value(block, "A", "0")} ${op} ${ctx.value(block, "B", "0")})`;
    },
    logic_operation: (block: Blockly.Block, ctx: GenContext) => {
      const op = block.getFieldValue("OP");
      const a = ctx.value(block, "A", "False");
      const b = ctx.value(block, "B", "False");
      // Python has no boolean xor operator; compare truthiness instead.
      if (op === "xor") return `(bool(${a}) != bool(${b}))`;
      return `(${a} ${op} ${b})`;
    },
    logic_not: (block: Blockly.Block, ctx: GenContext) => `(not ${ctx.value(block, "BOOL", "False")})`,
    logic_boolean: (block: Blockly.Block) => block.getFieldValue("BOOL"),
  },
};
