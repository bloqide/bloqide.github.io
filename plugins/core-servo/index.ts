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

// Hobby servos — positional (SG90, MG996R, …) and continuous-rotation — on any
// PWM pin, backed by the shipped BloqServo.py driver.
//
// A servo is identified by its signal pin (the neopixel-by-data-pin idiom), so
// no setup block is needed to use one: the first block that mentions a pin gets
// the reserved Servo object created for it, and nothing is driven until it is
// commanded. "set up servo" is only for calibration, and is hoisted into the
// program header so it applies wherever the user drops it.
//
// The timed move is the one block with real machinery behind it: the driver
// interpolates the pulse width from the clock and reports done, so the wait
// adapts to the active codegen mode exactly like the core `wait until` block
// (poll in simple mode, yield in scheduler mode) — one slow servo never blocks
// another stack, and the plugin never has to force scheduler mode.

const COLOUR = 275; // purple — shared with the boards' own motor blocks

const NUM = (n: number) => ({ shadow: { type: "math_number", fields: { NUM: n } } });

const pinField = { type: "field_dropdown", name: "PIN", options: "$BOARD_PWM_PINS" };

/** One reusable Servo object per signal pin, created on first mention. */
function servo(ctx: GenContext, block: Blockly.Block): string {
  const pin = block.getFieldValue("PIN");
  const v = ctx.reserveVariable(`servo_${pin}`);
  ctx.ensureImport("from BloqServo import Servo");
  ctx.requireLibrary("/lib/BloqServo.py");
  ctx.addSetup(`${v} = Servo(${pin})`);
  return v;
}

export const plugin: BloqPlugin = {
  id: "core-servo",
  name: "Servo",
  version: "1.0.0",
  requires: ["pwm"],
  // Shares the "Motors" category with a board's own motor blocks (the toolbox
  // merges plugins that name the same category).
  toolbox: { category: "Motors", colour: COLOUR, order: 75, faIcon: "fa-gears" },

  // Snippet: sweep back and forth, smoothly.
  presets: [
    {
      kind: "block",
      type: "servo_move_timed",
      inputs: { ANGLE: NUM(0), MS: NUM(500) },
      next: {
        block: {
          type: "servo_move_timed",
          inputs: { ANGLE: NUM(180), MS: NUM(1000) },
          next: {
            block: {
              type: "servo_move_timed",
              inputs: { ANGLE: NUM(0), MS: NUM(1000) },
            },
          },
        },
      },
    },
  ],

  blocks: {
    servo_write: {
      kind: "statement",
      json: {
        type: "servo_write",
        message0: "servo %1 go to %2 °",
        args0: [pinField, { type: "input_value", name: "ANGLE" }],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip:
          "Move a servo to an angle (0–180° by default), as fast as it can. " +
          "The servo then holds that angle until told otherwise.",
      },
      toolbox: { inputs: { ANGLE: NUM(90) } },
    },

    servo_move_timed: {
      kind: "statement",
      json: {
        type: "servo_move_timed",
        message0: "servo %1 move to %2 ° over %3 ms",
        args0: [
          pinField,
          { type: "input_value", name: "ANGLE" },
          { type: "input_value", name: "MS" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip:
          "Move to an angle slowly, spread over a duration, instead of snapping " +
          "there. Waits here until the move finishes.",
      },
      toolbox: { inputs: { ANGLE: NUM(180), MS: NUM(1000) } },
    },

    servo_speed: {
      kind: "statement",
      json: {
        type: "servo_speed",
        message0: "continuous servo %1 spin at %2 %% speed",
        args0: [pinField, { type: "input_value", name: "SPEED" }],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip:
          "For a continuous-rotation servo, which spins instead of holding an " +
          "angle: -100 is full reverse, 0 stops, 100 is full forward.",
      },
      toolbox: { inputs: { SPEED: NUM(50) } },
    },

    servo_pulse: {
      kind: "statement",
      json: {
        type: "servo_pulse",
        message0: "servo %1 set pulse to %2 µs",
        args0: [pinField, { type: "input_value", name: "US" }],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip:
          "Command the pulse width directly (clamped to the calibrated range). " +
          "Useful for finding a servo's real end points, or its exact stop point.",
      },
      toolbox: { inputs: { US: NUM(1500) } },
    },

    servo_power: {
      kind: "statement",
      json: {
        type: "servo_power",
        message0: "servo %1 %2",
        args0: [
          pinField,
          {
            type: "field_dropdown",
            name: "STATE",
            options: [
              ["release (free to turn)", "release"],
              ["hold position", "hold"],
            ],
          },
        ],
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip:
          "Releasing stops the pulses, so the servo stops drawing current, stops " +
          "buzzing and can be turned by hand. Holding resumes at the last angle.",
      },
    },

    servo_setup: {
      kind: "statement",
      json: {
        type: "servo_setup",
        message0: "set up servo %1 pulse %2 µs to %3 µs over %4 °",
        args0: [
          pinField,
          { type: "field_number", name: "MIN_US", value: 500, min: 100, max: 20000, precision: 1 },
          { type: "field_number", name: "MAX_US", value: 2500, min: 100, max: 20000, precision: 1 },
          { type: "field_number", name: "ANGLE", value: 180, min: 1, precision: 1 },
        ],
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip:
          "Optional calibration — the defaults (500–2500 µs over 180°) suit most " +
          "servos. Narrow the range if yours buzzes or strains at the ends of its " +
          "travel. Applies to the whole program wherever you put this block.",
      },
    },

    servo_angle: {
      kind: "value",
      json: {
        type: "servo_angle",
        message0: "servo %1 angle",
        args0: [pinField],
        output: "Number",
        colour: COLOUR,
        tooltip:
          "The angle last commanded. A servo cannot report where it really is, " +
          "so this is what it was asked for, not proof it got there.",
      },
    },
  },

  generators: {
    servo_write: (block: Blockly.Block, ctx: GenContext) => {
      ctx.line(`${servo(ctx, block)}.angle(${ctx.value(block, "ANGLE", "0")})`, block.id);
    },

    servo_move_timed: (block: Blockly.Block, ctx: GenContext) => {
      const v = servo(ctx, block);
      ctx.line(
        `${v}.move_to(${ctx.value(block, "ANGLE", "0")}, ${ctx.value(block, "MS", "0")})`,
        block.id
      );
      // The driver advances the move from the clock, so waiting for it is just a
      // predicate — the same shape as `wait until`, adapting to the mode.
      if (ctx.schedulerMode) {
        ctx.line(`yield from sched.wait_until(${v}.update)`, block.id);
        ctx.markYield();
      } else {
        ctx.ensureImport("import time");
        ctx.line(`while not ${v}.update():`, block.id);
        // A servo only acts on ~50 pulses a second, so polling faster than that
        // buys nothing and just burns the CPU.
        ctx.indented(() => ctx.line("time.sleep_ms(20)", block.id));
      }
    },

    servo_speed: (block: Blockly.Block, ctx: GenContext) => {
      ctx.line(`${servo(ctx, block)}.speed(${ctx.value(block, "SPEED", "0")})`, block.id);
    },

    servo_pulse: (block: Blockly.Block, ctx: GenContext) => {
      ctx.line(`${servo(ctx, block)}.write_us(${ctx.value(block, "US", "1500")})`, block.id);
    },

    servo_power: (block: Blockly.Block, ctx: GenContext) => {
      ctx.line(`${servo(ctx, block)}.${block.getFieldValue("STATE")}()`, block.id);
    },

    servo_setup: (block: Blockly.Block, ctx: GenContext) => {
      const v = servo(ctx, block);
      ctx.addSetup(
        `${v}.set_range(${block.getFieldValue("MIN_US")}, ${block.getFieldValue("MAX_US")}, ` +
          `${block.getFieldValue("ANGLE")})`
      );
    },

    servo_angle: (block: Blockly.Block, ctx: GenContext) => `${servo(ctx, block)}.read_angle()`,
  },
};
