import type { BloqPlugin, GenContext } from "../../src/core/types";
import type * as Blockly from "blockly";

// Numbers and arithmetic. `math_arithmetic` is a single dropdown block; the
// toolbox lists it once per operator (preset variants) so you can drag the one
// you want, and still switch the dropdown afterwards. Value blocks return a
// MicroPython expression; binary ops parenthesise their result so nested
// operations keep the intended precedence.

const COLOUR = 230;
const NUM_SHADOW = { shadow: { type: "math_number", fields: { NUM: 0 } } };

// [dropdown value, on-block label]
const OPS: [string, string][] = [
  ["+", "+"],
  ["-", "−"],
  ["*", "×"],
  ["/", "÷"],
  ["%", "mod"],
  ["**", "aᵇ"],
];

// Bitwise binary operators (integers only).
const BITWISE: [string, string][] = [
  ["&", "&"],
  ["|", "|"],
  ["^", "^"],
];

export const plugin: BloqPlugin = {
  id: "core-math",
  name: "Math",
  version: "1.0.0",
  toolbox: { category: "Math", colour: COLOUR, order: 40, faIcon: "fa-calculator" },

  blocks: {
    math_number: {
      kind: "value",
      json: {
        type: "math_number",
        message0: "%1",
        args0: [{ type: "field_number", name: "NUM", value: 0 }],
        output: null,
        colour: COLOUR,
      },
    },
    math_arithmetic: {
      kind: "value",
      json: {
        type: "math_arithmetic",
        message0: "%1 %2 %3",
        args0: [
          { type: "input_value", name: "A" },
          { type: "field_dropdown", name: "OP", options: OPS.map(([v, label]) => [label, v]) },
          { type: "input_value", name: "B" },
        ],
        inputsInline: true,
        output: null,
        colour: COLOUR,
      },
      // One preset variant per operator, each with number-literal defaults.
      toolbox: OPS.map(([v]) => ({ fields: { OP: v }, inputs: { A: NUM_SHADOW, B: NUM_SHADOW } })),
    },
    math_bitwise: {
      kind: "value",
      json: {
        type: "math_bitwise",
        message0: "%1 %2 %3",
        args0: [
          { type: "input_value", name: "A" },
          { type: "field_dropdown", name: "OP", options: BITWISE.map(([v, label]) => [label, v]) },
          { type: "input_value", name: "B" },
        ],
        inputsInline: true,
        output: null,
        colour: COLOUR,
        tooltip: "Bitwise AND / OR / XOR (integers).",
      },
      toolbox: BITWISE.map(([v]) => ({ fields: { OP: v }, inputs: { A: NUM_SHADOW, B: NUM_SHADOW } })),
    },
    math_bitnot: {
      kind: "value",
      json: {
        type: "math_bitnot",
        message0: "~ %1",
        args0: [{ type: "input_value", name: "A" }],
        inputsInline: true,
        output: null,
        colour: COLOUR,
        tooltip: "Bitwise NOT / invert (integers).",
      },
      toolbox: { inputs: { A: NUM_SHADOW } },
    },
    math_random_int: {
      kind: "value",
      json: {
        type: "math_random_int",
        message0: "random integer %1 to %2",
        args0: [
          { type: "input_value", name: "LOW" },
          { type: "input_value", name: "HIGH" },
        ],
        inputsInline: true,
        output: null,
        colour: COLOUR,
        tooltip: "A random whole number between the two values (both included).",
      },
      toolbox: {
        inputs: {
          LOW: { shadow: { type: "math_number", fields: { NUM: 1 } } },
          HIGH: { shadow: { type: "math_number", fields: { NUM: 100 } } },
        },
      },
    },
  },

  generators: {
    math_number: (block: Blockly.Block) => String(block.getFieldValue("NUM")),
    math_arithmetic: (block: Blockly.Block, ctx: GenContext) => {
      const op = block.getFieldValue("OP");
      return `(${ctx.value(block, "A", "0")} ${op} ${ctx.value(block, "B", "0")})`;
    },
    math_bitwise: (block: Blockly.Block, ctx: GenContext) => {
      const op = block.getFieldValue("OP");
      return `(${ctx.value(block, "A", "0")} ${op} ${ctx.value(block, "B", "0")})`;
    },
    math_bitnot: (block: Blockly.Block, ctx: GenContext) => `(~${ctx.value(block, "A", "0")})`,
    math_random_int: (block: Blockly.Block, ctx: GenContext) => {
      ctx.ensureImport("import random");
      // randint(a, b) includes both endpoints.
      return `random.randint(${ctx.value(block, "LOW", "1")}, ${ctx.value(block, "HIGH", "100")})`;
    },
  },
};
