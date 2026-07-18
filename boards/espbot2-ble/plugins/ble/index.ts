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

// Bluetooth-LE UART blocks for the EspBot board: advertise a Nordic UART
// service and act on a phone gamepad ("control pad"). Codegen ships
// /lib/bleuart.py and emits bleuart.controlPad.* calls.

const COLOUR = 210; // bluetooth blue

const BUTTONS: [string, string][] = [
  ["up", "ButtonUp"],
  ["down", "ButtonDown"],
  ["left", "ButtonLeft"],
  ["right", "ButtonRight"],
  ["button 1", "Button1"],
  ["button 2", "Button2"],
  ["button 3", "Button3"],
  ["button 4", "Button4"],
];

function needsBle(ctx: GenContext): void {
  ctx.ensureImport("import bleuart");
  ctx.requireLibrary("/lib/bleuart.py");
}

export const plugin: BloqPlugin = {
  id: "espbot-ble",
  name: "Bluetooth",
  version: "1.0.0",
  requires: ["ble"],
  toolbox: { category: "Bluetooth", colour: COLOUR, order: 80, faIcon: "fa-brands fa-bluetooth-b" },

  blocks: {
    ble_begin: {
      kind: "statement",
      json: {
        type: "ble_begin",
        message0: "start Bluetooth UART named %1",
        args0: [{ type: "input_value", name: "NAME" }],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
      },
      toolbox: { inputs: { NAME: { shadow: { type: "text_literal", fields: { TEXT: "EspBot" } } } } },
    },
    ble_close: {
      kind: "statement",
      json: {
        type: "ble_close",
        message0: "stop Bluetooth UART",
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
      },
    },
    ble_write: {
      kind: "statement",
      json: {
        type: "ble_write",
        message0: "Bluetooth write %1",
        args0: [{ type: "input_value", name: "TEXT" }],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
      },
      toolbox: { inputs: { TEXT: { shadow: { type: "text_literal", fields: { TEXT: "hello" } } } } },
    },
    ble_connected: {
      kind: "value",
      json: {
        type: "ble_connected",
        message0: "Bluetooth connected?",
        output: null,
        colour: COLOUR,
      },
    },
    ble_read: {
      kind: "value",
      json: {
        type: "ble_read",
        message0: "Bluetooth read text",
        output: null,
        colour: COLOUR,
      },
    },
    ble_button: {
      kind: "value",
      json: {
        type: "ble_button",
        message0: "Bluetooth pad %1 %2",
        args0: [
          { type: "field_dropdown", name: "BTN", options: BUTTONS },
          {
            type: "field_dropdown",
            name: "STATE",
            options: [
              ["pressed", "True"],
              ["released", "False"],
            ],
          },
        ],
        inputsInline: true,
        output: null,
        colour: COLOUR,
      },
    },
  },

  generators: {
    ble_begin: (block: Blockly.Block, ctx: GenContext) => {
      needsBle(ctx);
      ctx.line(`bleuart.controlPad.begin(name=${ctx.value(block, "NAME", "'EspBot'")})`, block.id);
    },
    ble_close: (block: Blockly.Block, ctx: GenContext) => {
      needsBle(ctx);
      ctx.line("bleuart.controlPad.close()", block.id);
    },
    ble_write: (block: Blockly.Block, ctx: GenContext) => {
      needsBle(ctx);
      ctx.line(`bleuart.controlPad.write(${ctx.value(block, "TEXT", "''")} + "\\n")`, block.id);
    },
    ble_connected: (_block: Blockly.Block, ctx: GenContext) => {
      needsBle(ctx);
      return "bleuart.controlPad.isConnected()";
    },
    ble_read: (_block: Blockly.Block, ctx: GenContext) => {
      needsBle(ctx);
      return "bleuart.controlPad.read()";
    },
    ble_button: (block: Blockly.Block, ctx: GenContext) => {
      needsBle(ctx);
      ctx.ensureImport("from bleuart import BleControlPad");
      const btn = block.getFieldValue("BTN");
      const state = block.getFieldValue("STATE");
      return `(bleuart.controlPad.isButtonPressed(BleControlPad.${btn}) == ${state})`;
    },
  },
};
