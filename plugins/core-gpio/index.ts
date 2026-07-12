import type { BloqPlugin, GenContext } from "../../src/core/types";
import type * as Blockly from "blockly";

// GPIO blocks. Pin dropdowns are populated from the active board (the registry
// resolves the $BOARD_DIGITAL_PINS token), so one block definition adapts to any
// board. Codegen dedupes Pin() setup via reserved variables so multiple writes
// to the same pin share one initialised object.

// One reusable Pin(...) variable per (pin, direction, pull).
function reservePin(
  ctx: GenContext,
  pin: string,
  dir: "OUT" | "IN",
  pull?: "PULL_UP" | "PULL_DOWN"
): string {
  const key = `pin_${pin}_${dir.toLowerCase()}${pull ? "_" + pull.toLowerCase() : ""}`.replace(
    /[^a-z0-9_]/gi,
    ""
  );
  const v = ctx.reserveVariable(key);
  ctx.ensureImport("from machine import Pin");
  const arg =
    dir === "OUT" ? `${pin}, Pin.OUT` : pull ? `${pin}, Pin.IN, Pin.${pull}` : `${pin}, Pin.IN`;
  ctx.addSetup(`${v} = Pin(${arg})`);
  return v;
}

export const plugin: BloqPlugin = {
  id: "core-gpio",
  name: "Pins",
  version: "1.0.0",
  requires: ["gpio"],
  toolbox: { category: "Pins", colour: 160, order: 20, faIcon: "fa-microchip" },
  icon: { preset: "pin" },

  blocks: {
    gpio_write: {
      kind: "statement",
      json: {
        type: "gpio_write",
        message0: "set pin %1 to %2",
        args0: [
          { type: "field_dropdown", name: "PIN", options: "$BOARD_OUTPUT_PINS" },
          {
            type: "field_dropdown",
            name: "VAL",
            options: [
              ["HIGH", "1"],
              ["LOW", "0"],
            ],
          },
        ],
        previousStatement: null,
        nextStatement: null,
        colour: 160,
      },
    },
    gpio_write_value: {
      kind: "statement",
      json: {
        type: "gpio_write_value",
        message0: "set pin %1 to %2",
        args0: [
          { type: "field_dropdown", name: "PIN", options: "$BOARD_OUTPUT_PINS" },
          { type: "input_value", name: "VALUE" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: 160,
        tooltip: "Set a pin from a value (0 = low, anything else = high).",
      },
      toolbox: { inputs: { VALUE: { shadow: { type: "math_number", fields: { NUM: 1 } } } } },
    },
    gpio_write_dynamic: {
      kind: "statement",
      json: {
        type: "gpio_write_dynamic",
        message0: "set pin %1 to %2",
        args0: [
          { type: "input_value", name: "PIN" },
          { type: "input_value", name: "VALUE" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: 160,
        tooltip: "Set a pin chosen by a value (e.g. from a variable) to a value.",
      },
      toolbox: {
        inputs: {
          PIN: { shadow: { type: "math_number", fields: { NUM: 0 } } },
          VALUE: { shadow: { type: "math_number", fields: { NUM: 1 } } },
        },
      },
    },
    gpio_toggle_led: {
      kind: "statement",
      json: {
        type: "gpio_toggle_led",
        message0: "toggle onboard LED",
        previousStatement: null,
        nextStatement: null,
        colour: 160,
      },
    },
    gpio_read: {
      kind: "value",
      json: {
        type: "gpio_read",
        message0: "read pin %1",
        args0: [{ type: "field_dropdown", name: "PIN", options: "$BOARD_INPUT_PINS" }],
        output: null,
        colour: 160,
        tooltip: "Read a digital pin: 1 (high) or 0 (low).",
      },
    },
    gpio_analog_read: {
      kind: "value",
      json: {
        type: "gpio_analog_read",
        message0: "read analog pin %1",
        args0: [{ type: "field_dropdown", name: "PIN", options: "$BOARD_ANALOG_PINS" }],
        output: null,
        colour: 160,
        tooltip: "Read an analog pin as a number from 0 to 65535.",
      },
    },
    gpio_button: {
      kind: "value",
      json: {
        type: "gpio_button",
        message0: "button %1 pressed",
        args0: [{ type: "field_dropdown", name: "PIN", options: "$BOARD_INPUT_PINS" }],
        output: null,
        colour: 160,
        tooltip:
          "True while a button wired from this pin to GND is held down (uses the pin's internal pull-up).",
      },
    },
    gpio_pwm: {
      kind: "statement",
      json: {
        type: "gpio_pwm",
        message0: "set PWM pin %1 to %2 %%",
        args0: [
          { type: "field_dropdown", name: "PIN", options: "$BOARD_PWM_PINS" },
          { type: "input_value", name: "DUTY" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: 160,
        tooltip: "Drive a pin with PWM at the given duty cycle (0–100%), 1 kHz.",
      },
      toolbox: { inputs: { DUTY: { shadow: { type: "math_number", fields: { NUM: 50 } } } } },
    },
  },

  generators: {
    gpio_write: (block: Blockly.Block, ctx: GenContext) => {
      const pin = block.getFieldValue("PIN");
      const val = block.getFieldValue("VAL");
      const v = reservePin(ctx, pin, "OUT");
      ctx.line(`${v}.value(${val})`, block.id);
    },
    gpio_write_value: (block: Blockly.Block, ctx: GenContext) => {
      const v = reservePin(ctx, block.getFieldValue("PIN"), "OUT");
      ctx.line(`${v}.value(${ctx.value(block, "VALUE", "0")})`, block.id);
    },
    gpio_write_dynamic: (block: Blockly.Block, ctx: GenContext) => {
      // Pin chosen at runtime — can't reserve a static Pin object, so build one
      // inline for this write.
      ctx.ensureImport("from machine import Pin");
      const pin = ctx.value(block, "PIN", "0");
      ctx.line(`Pin(${pin}, Pin.OUT).value(${ctx.value(block, "VALUE", "0")})`, block.id);
    },
    gpio_toggle_led: (block: Blockly.Block, ctx: GenContext) => {
      const led = ctx.board.pins.aliases["LED"];
      const pin = led !== undefined ? String(led) : "8";
      const v = reservePin(ctx, pin, "OUT");
      ctx.line(`${v}.value(not ${v}.value())`, block.id);
    },
    gpio_read: (block: Blockly.Block, ctx: GenContext) => {
      const v = reservePin(ctx, block.getFieldValue("PIN"), "IN");
      return `${v}.value()`;
    },
    gpio_analog_read: (block: Blockly.Block, ctx: GenContext) => {
      const pin = block.getFieldValue("PIN");
      ctx.ensureImport("from machine import ADC, Pin");
      const v = ctx.reserveVariable(`adc_${pin}`);
      ctx.addSetup(`${v} = ADC(Pin(${pin}))`);
      return `${v}.read_u16()`;
    },
    gpio_button: (block: Blockly.Block, ctx: GenContext) => {
      const v = reservePin(ctx, block.getFieldValue("PIN"), "IN", "PULL_UP");
      return `(${v}.value() == 0)`;
    },
    gpio_pwm: (block: Blockly.Block, ctx: GenContext) => {
      const pin = block.getFieldValue("PIN");
      ctx.ensureImport("from machine import Pin, PWM");
      const v = ctx.reserveVariable(`pwm_${pin}`);
      ctx.addSetup(`${v} = PWM(Pin(${pin}))`);
      ctx.addSetup(`${v}.freq(1000)`);
      ctx.line(`${v}.duty_u16(int(${ctx.value(block, "DUTY", "0")} * 65535 / 100))`, block.id);
    },
  },
};
