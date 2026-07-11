import type { MicroblockPlugin, GenContext } from "../../src/core/types";
import type * as Blockly from "blockly";

// GPIO blocks. Pin dropdowns are populated from the active board (the registry
// resolves the $BOARD_DIGITAL_PINS token), so one block definition adapts to any
// board. Codegen dedupes Pin() setup via reserved variables so multiple writes
// to the same pin share one initialised object.

// One reusable Pin(...) variable per (pin, direction).
function reservePin(ctx: GenContext, pin: string, dir: "OUT" | "IN"): string {
  const key = `pin_${pin}_${dir.toLowerCase()}`.replace(/[^a-z0-9_]/gi, "");
  const v = ctx.reserveVariable(key);
  ctx.ensureImport("from machine import Pin");
  const arg = dir === "IN" ? `${pin}, Pin.IN, Pin.PULL_UP` : `${pin}, Pin.OUT`;
  ctx.addSetup(`${v} = Pin(${arg})`);
  return v;
}

export const plugin: MicroblockPlugin = {
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
          { type: "field_dropdown", name: "PIN", options: "$BOARD_DIGITAL_PINS" },
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
  },

  generators: {
    gpio_write: (block: Blockly.Block, ctx: GenContext) => {
      const pin = block.getFieldValue("PIN");
      const val = block.getFieldValue("VAL");
      const v = reservePin(ctx, pin, "OUT");
      ctx.line(`${v}.value(${val})`, block.id);
    },
    gpio_toggle_led: (block: Blockly.Block, ctx: GenContext) => {
      const led = ctx.board.pins.aliases["LED"];
      const pin = led !== undefined ? String(led) : "8";
      const v = reservePin(ctx, pin, "OUT");
      ctx.line(`${v}.value(not ${v}.value())`, block.id);
    },
  },
};
