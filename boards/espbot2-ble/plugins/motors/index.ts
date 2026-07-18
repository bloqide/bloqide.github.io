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

// Motor-driver blocks for the EspBot board. Enabled only for boards that list
// this plugin. Codegen ships /lib/espbot.py (a OneWire motor driver) and emits
// espbot.motors.* calls; the dropdown values are the driver's own constants.

const COLOUR = 275; // purple

const MOTORS: [string, string][] = [
  ["left", "EspBot.MotorLeft"],
  ["right", "EspBot.MotorRight"],
  ["left + right", "EspBot.MotorLeftAndRight"],
];
const DIRECTIONS: [string, string][] = [
  ["forward", "EspBot.Forward"],
  ["backward", "EspBot.Backward"],
  ["stop", "EspBot.Stop"],
  ["brake", "EspBot.Brake"],
];
const motorField = { type: "field_dropdown", name: "MOTOR", options: MOTORS };

function needsDriver(ctx: GenContext): void {
  ctx.ensureImport("import espbot");
  ctx.ensureImport("from espbot import EspBot");
  ctx.requireLibrary("/lib/espbot.py");
}

export const plugin: BloqPlugin = {
  id: "espbot-motors",
  name: "Motors",
  version: "1.0.0",
  toolbox: { category: "Motors", colour: COLOUR, order: 70, faIcon: "fa-gears" },

  // Snippet: drive forward for a second, then stop.
  presets: [
    {
      kind: "block",
      type: "motor_spin",
      fields: { MOTOR: "EspBot.MotorLeftAndRight", DIR: "EspBot.Forward" },
      inputs: { SPEED: { shadow: { type: "math_number", fields: { NUM: 60 } } } },
      next: {
        block: {
          type: "wait_ms",
          fields: { MS: 1000 },
          next: { block: { type: "motor_stop", fields: { MOTOR: "EspBot.MotorLeftAndRight" } } },
        },
      },
    },
  ],

  blocks: {
    motor_spin: {
      kind: "statement",
      json: {
        type: "motor_spin",
        message0: "motor %1 go %2 at %3 %% speed",
        args0: [
          motorField,
          { type: "field_dropdown", name: "DIR", options: DIRECTIONS },
          { type: "input_value", name: "SPEED" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
      },
      toolbox: { inputs: { SPEED: { shadow: { type: "math_number", fields: { NUM: 50 } } } } },
    },
    motor_stop: {
      kind: "statement",
      json: {
        type: "motor_stop",
        message0: "motor %1 stop",
        args0: [motorField],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
      },
    },
    motor_brake: {
      kind: "statement",
      json: {
        type: "motor_brake",
        message0: "motor %1 brake",
        args0: [motorField],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
      },
    },
  },

  generators: {
    motor_spin: (block: Blockly.Block, ctx: GenContext) => {
      needsDriver(ctx);
      const motor = block.getFieldValue("MOTOR");
      const dir = block.getFieldValue("DIR");
      ctx.line(`espbot.motors.spin(${motor}, ${dir}, ${ctx.value(block, "SPEED", "0")})`, block.id);
    },
    motor_stop: (block: Blockly.Block, ctx: GenContext) => {
      needsDriver(ctx);
      ctx.line(`espbot.motors.stop(${block.getFieldValue("MOTOR")})`, block.id);
    },
    motor_brake: (block: Blockly.Block, ctx: GenContext) => {
      needsDriver(ctx);
      ctx.line(`espbot.motors.brake(${block.getFieldValue("MOTOR")})`, block.id);
    },
  },
};
