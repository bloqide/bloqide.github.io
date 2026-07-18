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

// Sensors. Ultrasonic (HC-SR04-style) distance read via a shipped Ultrasonic.py
// driver (time_pulse_us), which works on any GPIO board. Driver ported from the
// microBlock "Ultrasonic2" extension.

const COLOUR = 220; // blue

const NUM = (n: number) => ({ shadow: { type: "math_number", fields: { NUM: n } } });

export const plugin: BloqPlugin = {
  id: "core-sensors",
  name: "Sensors",
  version: "1.0.0",
  requires: ["gpio"],
  toolbox: { category: "Sensors", colour: COLOUR, order: 90, faIcon: "fa-satellite-dish" },

  blocks: {
    ultrasonic_read: {
      kind: "value",
      json: {
        type: "ultrasonic_read",
        message0: "ultrasonic distance (cm) trig %1 echo %2",
        args0: [
          { type: "input_value", name: "TRIG" },
          { type: "input_value", name: "ECHO" },
        ],
        inputsInline: true,
        output: null,
        colour: COLOUR,
        tooltip: "Distance in cm from an HC-SR04 ultrasonic sensor (-1 if out of range).",
      },
      toolbox: { inputs: { TRIG: NUM(2), ECHO: NUM(3) } },
    },
  },

  generators: {
    ultrasonic_read: (block: Blockly.Block, ctx: GenContext) => {
      ctx.ensureImport("import Ultrasonic");
      ctx.requireLibrary("/lib/Ultrasonic.py");
      return `Ultrasonic.read(${ctx.value(block, "TRIG", "2")}, ${ctx.value(block, "ECHO", "3")})`;
    },
  },
};
