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
