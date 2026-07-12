import type { BloqPlugin, GenContext } from "../../src/core/types";
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
