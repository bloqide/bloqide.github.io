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
/** The board's onboard RGB LED (a single WS2812 listed in `onboard`) as a
 *  one-pixel strip created on first mention, or null if the board has none.
 *  Shared by every block that lights it, so they all drive one object. */
export function onboardRgbLed(ctx: GenContext): string | null {
  const led = ctx.board.onboard?.find((o) => o.type === "neopixel");
  if (!led) return null;
  const v = ctx.reserveVariable("rgb_led");
  ctx.ensureImport("from machine import Pin");
  ctx.ensureImport("from neopixel import NeoPixel");
  ctx.addSetup(`${v} = NeoPixel(Pin(${led.pin}), 1)`);
  return v;
}

// Picker palette: fully saturated colours (pastels just look white on an LED).
const PALETTE: [string, string][] = [
  ["#ff0000", "red"],
  ["#ff8000", "orange"],
  ["#ffff00", "yellow"],
  ["#80ff00", "lime"],
  ["#00ff00", "green"],
  ["#00ffff", "cyan"],
  ["#0000ff", "blue"],
  ["#8000ff", "purple"],
  ["#ff00ff", "magenta"],
  ["#ff0080", "pink"],
  ["#ffffff", "white"],
  ["#000000", "off"],
];

/** "#rrggbb" -> "(r, g, b)", so the code shows plain numbers. */
function hexToTuple(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

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
    neopixel_colour_pick: {
      kind: "value",
      json: {
        type: "neopixel_colour_pick",
        message0: "%1",
        args0: [
          {
            type: "field_colour",
            name: "COLOUR",
            colour: "#ff0000",
            colourOptions: PALETTE.map(([hex]) => hex),
            colourTitles: PALETTE.map(([, title]) => title),
            columns: 6,
          },
        ],
        output: null,
        colour: COLOUR,
        tooltip: "A colour from the palette.",
      },
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
    neopixel_colour_pick: (block: Blockly.Block) => hexToTuple(block.getFieldValue("COLOUR")),
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
