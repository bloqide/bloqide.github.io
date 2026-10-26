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

// Motor blocks for the StepBot board: two steppers driven by a co-processor
// (CH32V003) on IO2 over OneWire. Codegen ships /lib/stepbot.py and emits
// stepbot.motors.* calls in robot units (mm, mm/s, degrees); the co-processor
// generates the steps, so every move runs in the background on its own. An
// "and wait" move is a poll on busy(): the driver's blocking wait() in simple
// mode, a sleeping yield loop in scheduler mode (so other stacks keep running,
// and the plugin never has to force scheduler mode).

const COLOUR = 275; // purple — same as EspBot's motors (and the Servo blocks that share the category)

const NUM = (n: number) => ({ shadow: { type: "math_number", fields: { NUM: n } } });

// Dropdown values are the driver's own constants (the same values as EspBot's).
// Both first: it's the default of a freshly dropped block.
const MOTORS: [string, string][] = [
  ["left + right", "StepBot.MotorLeftAndRight"],
  ["left", "StepBot.MotorLeft"],
  ["right", "StepBot.MotorRight"],
];
const BOTH = "StepBot.MotorLeftAndRight";
const motorField = { type: "field_dropdown", name: "MOTOR", options: MOTORS };

const waitField = {
  type: "field_dropdown",
  name: "WAIT",
  options: [
    ["and wait", "1"],
    ["in background", "0"],
  ],
};

function driver(ctx: GenContext): string {
  ctx.ensureImport("import stepbot");
  ctx.requireLibrary("/lib/stepbot.py");
  return "stepbot.motors";
}

/** The driver plus its constants (for blocks that name a motor or direction). */
function driverWithConstants(ctx: GenContext): string {
  ctx.ensureImport("from stepbot import StepBot");
  return driver(ctx);
}

/** -expr, without parentheses around a plain number. */
function negate(expr: string): string {
  return /^\d+(\.\d+)?$/.test(expr) ? `-${expr}` : `-(${expr})`;
}

/** Wait for the motors to finish, adapting to the codegen mode like `wait until`. */
function waitIdle(ctx: GenContext, block: Blockly.Block): void {
  const m = driver(ctx);
  if (ctx.schedulerMode) {
    // Every busy() is a OneWire round trip: poll at the driver's own pace
    // rather than on every scheduler pass.
    ctx.line(`while ${m}.busy():`, block.id);
    ctx.indented(() => ctx.line("yield from sched.sleep_ms(10)", block.id));
    ctx.markYield();
  } else {
    ctx.line(`${m}.wait()`, block.id);
  }
}

/** A move call honouring the block's WAIT field. The driver's own wait=True is
 *  blocking, so scheduler mode starts the move in the background and yields. */
function move(ctx: GenContext, block: Blockly.Block, method: string, args: string[]): void {
  const m = driver(ctx);
  const wait = block.getFieldValue("WAIT") === "1";
  if (wait && !ctx.schedulerMode) {
    ctx.line(`${m}.${method}(${args.join(", ")})`, block.id);
    return;
  }
  ctx.line(`${m}.${method}(${[...args, "wait=False"].join(", ")})`, block.id);
  if (wait) waitIdle(ctx, block);
}

export const plugin: BloqPlugin = {
  id: "stepbot-motors",
  name: "Motors",
  version: "1.0.0",
  toolbox: { category: "Motors", colour: COLOUR, order: 70, faIcon: "fa-gears" },

  // Snippet: drive a square.
  presets: [
    {
      kind: "block",
      type: "repeat_times",
      fields: { N: 4 },
      inputs: {
        DO: {
          block: {
            type: "stepbot_move",
            fields: { DIR: "1", WAIT: "1" },
            inputs: { DIST: NUM(200) },
            next: {
              block: {
                type: "stepbot_turn",
                fields: { DIR: "turn_left", WAIT: "1" },
                inputs: { ANGLE: NUM(90) },
              },
            },
          },
        },
      },
    },
  ],

  blocks: {
    stepbot_move: {
      kind: "statement",
      json: {
        type: "stepbot_move",
        message0: "move %1 %2 mm %3",
        args0: [
          {
            type: "field_dropdown",
            name: "DIR",
            options: [
              ["forward", "1"],
              ["backward", "-1"],
            ],
          },
          { type: "input_value", name: "DIST" },
          waitField,
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip:
          "Drive straight for a distance, with a smooth start and stop. " +
          "'in background' keeps driving while the next blocks run.",
      },
      toolbox: { inputs: { DIST: NUM(100) } },
    },

    stepbot_turn: {
      kind: "statement",
      json: {
        type: "stepbot_turn",
        message0: "turn %1 %2 degrees %3",
        args0: [
          {
            type: "field_dropdown",
            name: "DIR",
            options: [
              ["left", "turn_left"],
              ["right", "turn_right"],
            ],
          },
          { type: "input_value", name: "ANGLE" },
          waitField,
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip: "Turn on the spot: the wheels turn in opposite directions.",
      },
      toolbox: { inputs: { ANGLE: NUM(90) } },
    },

    stepbot_arc: {
      kind: "statement",
      json: {
        type: "stepbot_arc",
        message0: "curve %1 radius %2 mm for %3 degrees %4",
        args0: [
          {
            type: "field_dropdown",
            name: "SIDE",
            options: [
              ["left", "1"],
              ["right", "-1"],
            ],
          },
          { type: "input_value", name: "RADIUS" },
          { type: "input_value", name: "ANGLE" },
          waitField,
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip:
          "Drive along a circle. The radius is measured from the middle of the robot; " +
          "a negative angle drives the curve backward.",
      },
      toolbox: { inputs: { RADIUS: NUM(200), ANGLE: NUM(90) } },
    },

    stepbot_wheel_move: {
      kind: "statement",
      json: {
        type: "stepbot_wheel_move",
        message0: "move wheel %1 by %2 %3 %4",
        args0: [
          motorField,
          { type: "input_value", name: "AMOUNT" },
          {
            type: "field_dropdown",
            name: "UNIT",
            options: [
              ["mm", "mm"],
              ["degrees", "deg"],
            ],
          },
          waitField,
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip:
          "Move one wheel (or both) by a distance, or rotate it by an angle (360 is a full turn); " +
          "a single wheel moves while the other stays still. A negative amount moves backward.",
      },
      toolbox: [{ inputs: { AMOUNT: NUM(100) } }, { fields: { UNIT: "deg" }, inputs: { AMOUNT: NUM(360) } }],
    },

    stepbot_drive: {
      kind: "statement",
      json: {
        type: "stepbot_drive",
        message0: "drive %1 at %2 mm/s",
        args0: [
          {
            type: "field_dropdown",
            name: "DIR",
            options: [
              ["forward", "forward"],
              ["backward", "backward"],
            ],
          },
          { type: "input_value", name: "SPEED" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip: "Keep driving until told to stop.",
      },
      toolbox: { inputs: { SPEED: NUM(100) } },
    },

    stepbot_run: {
      kind: "statement",
      json: {
        type: "stepbot_run",
        message0: "motor %1 turn at %2 mm/s",
        args0: [motorField, { type: "input_value", name: "SPEED" }],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip:
          "Keep one wheel (or both) turning until told to stop; the other wheel keeps its speed. " +
          "A negative speed turns backward.",
      },
      toolbox: { inputs: { SPEED: NUM(100) } },
    },

    stepbot_spin: {
      kind: "statement",
      json: {
        type: "stepbot_spin",
        message0: "motor %1 go %2 at %3 %% speed",
        args0: [
          motorField,
          {
            type: "field_dropdown",
            name: "DIR",
            options: [
              ["forward", "StepBot.Forward"],
              ["backward", "StepBot.Backward"],
              ["stop", "StepBot.Stop"],
              ["brake", "StepBot.Brake"],
            ],
          },
          { type: "input_value", name: "SPEED" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip: "Like EspBot's motor block: speed is a percentage of the top speed.",
      },
      toolbox: { inputs: { SPEED: NUM(50) } },
    },

    stepbot_stop: {
      kind: "statement",
      json: {
        type: "stepbot_stop",
        message0: "motor %1 %2",
        args0: [
          motorField,
          {
            type: "field_dropdown",
            name: "HOW",
            options: [
              ["stop smoothly", "stop"],
              ["stop now", "brake"],
            ],
          },
        ],
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip:
          "'stop smoothly' slows down first. 'stop now' stops at once (both motors only: " +
          "a single motor always slows down). The motors keep holding their position.",
      },
    },

    stepbot_power: {
      kind: "statement",
      json: {
        type: "stepbot_power",
        message0: "motors %1",
        args0: [
          {
            type: "field_dropdown",
            name: "STATE",
            options: [
              ["release (wheels turn freely)", "release"],
              ["hold position", "hold"],
            ],
          },
        ],
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip:
          "Releasing stops the motors and powers them off, so the wheels can be turned by hand " +
          "and the battery lasts longer.",
      },
    },

    stepbot_wait: {
      kind: "statement",
      json: {
        type: "stepbot_wait",
        message0: "wait until motors have stopped",
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip: "Pause here until a background move finishes.",
      },
    },

    stepbot_is_moving: {
      kind: "value",
      json: {
        type: "stepbot_is_moving",
        message0: "motors are moving?",
        output: "Boolean",
        colour: COLOUR,
        tooltip: "True while a move (or a stop) is still in progress.",
      },
    },

    stepbot_distance: {
      kind: "value",
      json: {
        type: "stepbot_distance",
        message0: "distance driven by %1 (mm)",
        args0: [
          {
            type: "field_dropdown",
            name: "MOTOR",
            options: [
              ["robot", BOTH],
              ["left wheel", "StepBot.MotorLeft"],
              ["right wheel", "StepBot.MotorRight"],
            ],
          },
        ],
        output: "Number",
        colour: COLOUR,
        tooltip: "How far a wheel, or the robot (the average of both wheels), went since the last reset.",
      },
    },

    stepbot_reset_distance: {
      kind: "statement",
      json: {
        type: "stepbot_reset_distance",
        message0: "reset distance",
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip: "Start counting the distance from zero again.",
      },
    },

    stepbot_config: {
      kind: "statement",
      json: {
        type: "stepbot_config",
        message0: "set speed %1 mm/s acceleration %2 mm/s²",
        args0: [
          { type: "input_value", name: "SPEED" },
          { type: "input_value", name: "ACCEL" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip:
          "Speed of the next moves and turns, and how fast they speed up and slow down. " +
          "Acceleration 0 starts and stops at once (a heavy robot may skip steps).",
      },
      toolbox: { inputs: { SPEED: NUM(100), ACCEL: NUM(400) } },
    },

    stepbot_current: {
      kind: "statement",
      json: {
        type: "stepbot_current",
        message0: "set motor power moving %1 %% holding %2 %%",
        args0: [
          { type: "input_value", name: "RUN" },
          { type: "input_value", name: "HOLD" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip:
          "Motor current, in % of the maximum, while moving and when stopped. More is stronger " +
          "but uses more battery and heats the motors.",
      },
      toolbox: { inputs: { RUN: NUM(50), HOLD: NUM(25) } },
    },

    stepbot_setup: {
      kind: "statement",
      json: {
        type: "stepbot_setup",
        message0: "set up motors wheel diameter %1 mm wheel distance %2 mm %3 microsteps %4",
        args0: [
          { type: "field_number", name: "DIAMETER", value: 65, min: 1 },
          { type: "field_number", name: "TRACK", value: 120, min: 1 },
          { type: "input_dummy" },
          {
            type: "field_dropdown",
            name: "MICROSTEPS",
            options: [1, 2, 4, 8, 16, 32, 64, 128, 256].map((n) => [String(n), String(n)]),
          },
        ],
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip:
          "Calibrate the robot: measure the wheels, and the distance between their centres " +
          "(for accurate turns). Applies to the whole program, wherever it is placed.",
      },
      toolbox: { fields: { MICROSTEPS: "16" } },
    },
  },

  generators: {
    stepbot_move: (block: Blockly.Block, ctx: GenContext) => {
      const dist = ctx.value(block, "DIST", "0");
      move(ctx, block, "move", [block.getFieldValue("DIR") === "-1" ? negate(dist) : dist]);
    },
    stepbot_turn: (block: Blockly.Block, ctx: GenContext) => {
      move(ctx, block, block.getFieldValue("DIR"), [ctx.value(block, "ANGLE", "0")]);
    },
    stepbot_arc: (block: Blockly.Block, ctx: GenContext) => {
      const radius = ctx.value(block, "RADIUS", "0");
      move(ctx, block, "arc", [
        block.getFieldValue("SIDE") === "-1" ? negate(radius) : radius,
        ctx.value(block, "ANGLE", "0"),
      ]);
    },
    stepbot_wheel_move: (block: Blockly.Block, ctx: GenContext) => {
      const motor = block.getFieldValue("MOTOR");
      const amount = ctx.value(block, "AMOUNT", "0");
      if (block.getFieldValue("UNIT") === "deg") {
        driverWithConstants(ctx);
        move(ctx, block, "rotate", [motor, amount]);
      } else if (motor === BOTH) {
        move(ctx, block, "move", [amount]); // amount evaluated once, not per wheel
      } else {
        move(ctx, block, "move_motors", motor === "StepBot.MotorLeft" ? [amount, "0"] : ["0", amount]);
      }
    },
    stepbot_drive: (block: Blockly.Block, ctx: GenContext) => {
      const m = driver(ctx);
      ctx.line(`${m}.${block.getFieldValue("DIR")}(${ctx.value(block, "SPEED", "0")})`, block.id);
    },
    stepbot_run: (block: Blockly.Block, ctx: GenContext) => {
      const m = driverWithConstants(ctx);
      ctx.line(`${m}.run(${block.getFieldValue("MOTOR")}, ${ctx.value(block, "SPEED", "0")})`, block.id);
    },
    stepbot_spin: (block: Blockly.Block, ctx: GenContext) => {
      const m = driverWithConstants(ctx);
      const motor = block.getFieldValue("MOTOR");
      const dir = block.getFieldValue("DIR");
      ctx.line(`${m}.spin(${motor}, ${dir}, ${ctx.value(block, "SPEED", "0")})`, block.id);
    },
    stepbot_stop: (block: Blockly.Block, ctx: GenContext) => {
      const motor = block.getFieldValue("MOTOR");
      // Both motors is the driver's default: keep the common case short.
      const m = motor === BOTH ? driver(ctx) : driverWithConstants(ctx);
      ctx.line(`${m}.${block.getFieldValue("HOW")}(${motor === BOTH ? "" : motor})`, block.id);
    },
    stepbot_power: (block: Blockly.Block, ctx: GenContext) => {
      ctx.line(`${driver(ctx)}.${block.getFieldValue("STATE")}()`, block.id);
    },
    stepbot_wait: (block: Blockly.Block, ctx: GenContext) => {
      waitIdle(ctx, block);
    },
    stepbot_is_moving: (_block: Blockly.Block, ctx: GenContext) => `${driver(ctx)}.busy()`,
    stepbot_distance: (block: Blockly.Block, ctx: GenContext) => {
      const motor = block.getFieldValue("MOTOR");
      if (motor === BOTH) return `${driver(ctx)}.distance()`;
      return `${driverWithConstants(ctx)}.distance(${motor})`;
    },
    stepbot_reset_distance: (block: Blockly.Block, ctx: GenContext) => {
      ctx.line(`${driver(ctx)}.reset_distance()`, block.id);
    },
    stepbot_config: (block: Blockly.Block, ctx: GenContext) => {
      const m = driver(ctx);
      ctx.line(`${m}.set_speed(${ctx.value(block, "SPEED", "100")})`, block.id);
      ctx.line(`${m}.set_acceleration(${ctx.value(block, "ACCEL", "400")})`, block.id);
    },
    stepbot_current: (block: Blockly.Block, ctx: GenContext) => {
      const m = driver(ctx);
      ctx.line(`${m}.set_current(${ctx.value(block, "RUN", "50")}, ${ctx.value(block, "HOLD", "25")})`, block.id);
    },
    stepbot_setup: (block: Blockly.Block, ctx: GenContext) => {
      // Hoisted (like servo calibration): it describes the robot, so it applies
      // to the whole program. The driver sends it to the board on first use.
      const m = driver(ctx);
      ctx.addSetup(`${m}.set_wheel(${block.getFieldValue("DIAMETER")}, ${block.getFieldValue("TRACK")})`);
      ctx.addSetup(`${m}.set_microsteps(${block.getFieldValue("MICROSTEPS")})`);
    },
  },
};
