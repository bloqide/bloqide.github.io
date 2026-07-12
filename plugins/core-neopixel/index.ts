import type { BloqPlugin, GenContext } from "../../src/core/types";
import type * as Blockly from "blockly";

// NeoPixel (WS2812) strips via MicroPython's built-in `neopixel` module. A strip
// is identified by its data pin: the "set up" block creates NeoPixel(Pin, n);
// set/fill/show reference the same reserved object by pin. Colours are (r,g,b)
// tuples; the module handles WS2812 byte order internally.

const COLOUR = 300; // magenta

// One reusable NeoPixel object per data pin (created by the setup block).
function stripVar(ctx: GenContext, pin: string): string {
  return ctx.reserveVariable(`np_${pin}`);
}

const pinField = { type: "field_dropdown", name: "PIN", options: "$BOARD_OUTPUT_PINS" };
const NUM = (n: number) => ({ shadow: { type: "math_number", fields: { NUM: n } } });
const COLOR_SHADOW = {
  shadow: {
    type: "neopixel_colour",
    inputs: { R: NUM(255), G: NUM(0), B: NUM(0) },
  },
};

export const plugin: BloqPlugin = {
  id: "core-neopixel",
  name: "NeoPixel",
  version: "1.0.0",
  requires: ["neopixel"],
  toolbox: { category: "NeoPixel", colour: COLOUR, order: 100, faIcon: "fa-palette" },

  blocks: {
    neopixel_setup: {
      kind: "statement",
      json: {
        type: "neopixel_setup",
        message0: "set up NeoPixel on pin %1 with %2 pixels",
        args0: [pinField, { type: "field_number", name: "COUNT", value: 8, min: 1, precision: 1 }],
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip: "Create a NeoPixel strip on this pin. Do this once, before setting pixels.",
      },
    },
    neopixel_colour: {
      kind: "value",
      json: {
        type: "neopixel_colour",
        message0: "colour red %1 green %2 blue %3",
        args0: [
          { type: "input_value", name: "R" },
          { type: "input_value", name: "G" },
          { type: "input_value", name: "B" },
        ],
        inputsInline: true,
        output: null,
        colour: COLOUR,
        tooltip: "A colour from red/green/blue components (0–255).",
      },
      toolbox: { inputs: { R: NUM(255), G: NUM(0), B: NUM(0) } },
    },
    neopixel_set: {
      kind: "statement",
      json: {
        type: "neopixel_set",
        message0: "pin %1 set pixel %2 to %3",
        args0: [
          pinField,
          { type: "input_value", name: "INDEX" },
          { type: "input_value", name: "COLOR" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip: "Set one pixel's colour in the buffer (call 'show' to display).",
      },
      toolbox: { inputs: { INDEX: NUM(0), COLOR: COLOR_SHADOW } },
    },
    neopixel_fill: {
      kind: "statement",
      json: {
        type: "neopixel_fill",
        message0: "pin %1 fill %2",
        args0: [pinField, { type: "input_value", name: "COLOR" }],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip: "Set every pixel to one colour in the buffer (call 'show' to display).",
      },
      toolbox: { inputs: { COLOR: COLOR_SHADOW } },
    },
    neopixel_show: {
      kind: "statement",
      json: {
        type: "neopixel_show",
        message0: "pin %1 show",
        args0: [pinField],
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip: "Send the buffered colours to the strip.",
      },
    },
  },

  generators: {
    neopixel_setup: (block: Blockly.Block, ctx: GenContext) => {
      const pin = block.getFieldValue("PIN");
      ctx.ensureImport("from machine import Pin");
      ctx.ensureImport("from neopixel import NeoPixel");
      const v = stripVar(ctx, pin);
      ctx.addSetup(`${v} = NeoPixel(Pin(${pin}), ${block.getFieldValue("COUNT")})`);
    },
    neopixel_colour: (block: Blockly.Block, ctx: GenContext) =>
      `(${ctx.value(block, "R", "0")}, ${ctx.value(block, "G", "0")}, ${ctx.value(block, "B", "0")})`,
    neopixel_set: (block: Blockly.Block, ctx: GenContext) => {
      const v = stripVar(ctx, block.getFieldValue("PIN"));
      ctx.line(`${v}[${ctx.value(block, "INDEX", "0")}] = ${ctx.value(block, "COLOR", "(0, 0, 0)")}`, block.id);
    },
    neopixel_fill: (block: Blockly.Block, ctx: GenContext) => {
      const v = stripVar(ctx, block.getFieldValue("PIN"));
      ctx.line(`${v}.fill(${ctx.value(block, "COLOR", "(0, 0, 0)")})`, block.id);
    },
    neopixel_show: (block: Blockly.Block, ctx: GenContext) => {
      const v = stripVar(ctx, block.getFieldValue("PIN"));
      ctx.line(`${v}.write()`, block.id);
    },
  },
};
