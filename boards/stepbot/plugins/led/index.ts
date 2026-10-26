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

import type { BloqPlugin, GenContext } from "../../../../src/core/types";
import type * as Blockly from "blockly";
import { onboardRgbLed } from "../../../../plugins/core-neopixel/index";

// The StepBot's RGB LED: a single WS2812 (the board's onboard "neopixel"),
// driven with MicroPython's built-in `neopixel` module. No setup block: the
// one-pixel strip is created on first mention. Colours are the NeoPixel
// plugin's colour blocks (picker or red/green/blue), so they mix freely with
// strips on the headers. The blocks sit in the Pins category, next to the
// onboard LED blocks (which light this LED in white on this board).

const COLOUR = 160; // the Pins category colour

const NUM = (n: number) => ({ shadow: { type: "math_number", fields: { NUM: n } } });

function show(ctx: GenContext, block: Blockly.Block, colour: string): void {
  const v = onboardRgbLed(ctx) ?? "rgb_led"; // StepBot declares it, so never null here
  ctx.line(`${v}.fill(${colour})`, block.id);
  ctx.line(`${v}.write()`, block.id);
}

/** A colour scaled to a brightness in %, via a small helper in the program
 *  (so the code keeps showing the colour and the percentage). */
function dimmed(ctx: GenContext, colour: string, percent: string): string {
  if (percent === "100") return colour;
  const fn = ctx.reserveVariable("dimmed");
  ctx.defineFunction(
    `${fn}(colour, percent)`,
    "return tuple(max(0, min(255, round(c * percent / 100))) for c in colour)"
  );
  return `${fn}(${colour}, ${percent})`;
}

export const plugin: BloqPlugin = {
  id: "stepbot-led",
  name: "RGB LED",
  version: "1.0.0",
  requires: ["neopixel"], // its colour blocks come from the NeoPixel plugin
  // Merges into the Pins category, after the core GPIO blocks.
  toolbox: { category: "Pins", colour: COLOUR, order: 21, faIcon: "fa-microchip" },

  blocks: {
    stepbot_led_set: {
      kind: "statement",
      json: {
        type: "stepbot_led_set",
        message0: "set RGB LED to %1 brightness %2 %%",
        args0: [
          { type: "input_value", name: "COLOR" },
          { type: "input_value", name: "BRIGHTNESS", check: "Number" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip: "Light the RGB LED in a colour. Brightness is in %: 100 shows the colour as it is.",
      },
      // One entry with the palette picker (its colours are at full power, so
      // dimmed by default), one with red/green/blue numbers shown as they are.
      toolbox: [
        {
          inputs: {
            COLOR: { shadow: { type: "neopixel_colour_pick", fields: { COLOUR: "#ff0000" } } },
            BRIGHTNESS: NUM(20),
          },
        },
        {
          inputs: {
            COLOR: { shadow: { type: "neopixel_colour", inputs: { R: NUM(0), G: NUM(0), B: NUM(255) } } },
            BRIGHTNESS: NUM(100),
          },
        },
      ],
    },
    stepbot_led_off: {
      kind: "statement",
      json: {
        type: "stepbot_led_off",
        message0: "turn RGB LED off",
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip: "Switch the RGB LED off.",
      },
    },
  },

  generators: {
    stepbot_led_set: (block: Blockly.Block, ctx: GenContext) => {
      const colour = ctx.value(block, "COLOR", "(0, 0, 0)");
      show(ctx, block, dimmed(ctx, colour, ctx.value(block, "BRIGHTNESS", "100")));
    },
    stepbot_led_off: (block: Blockly.Block, ctx: GenContext) => {
      show(ctx, block, "(0, 0, 0)");
    },
  },
};
