import type { BloqPlugin, GenContext } from "../../src/core/types";
import type * as Blockly from "blockly";

// ESP-NOW peer-to-peer radio for ESP32-family boards (MicroPython `espnow`).
// Ported from the microBlock "ESPnow" extension, with three deliberate changes:
//   1. The WLAN is brought up in the *main program* (readable, learnable), while
//      the fiddly ESP-NOW plumbing (peer registration, MAC<->bytes, error
//      handling, decoding) lives in a shipped `BloqEspNow` class so main.py
//      stays uncluttered — `now = BloqEspNow(wlan)`, then `now.method(...)`.
//   2. Explicit "add peer" / "add broadcast peer" blocks (the original hid
//      peer registration inside send()).
//   3. Receiving is a plain "receive (wait up to N ms)" value block backed by
//      espnow's own `recv(timeout)` — no global 10-byte buffer, no separate
//      is-ready / read-as-text / read-as-number dance that silently double-read.

const COLOUR = 174; // teal — reads as "wireless comms", distinct from other cats

const NUM = (n: number) => ({ shadow: { type: "math_number", fields: { NUM: n } } });
const MAC = (s: string) => ({ shadow: { type: "text_literal", fields: { TEXT: s } } });
const TEXT = (s: string) => ({ shadow: { type: "text_literal", fields: { TEXT: s } } });

/** Bring up the WLAN in main.py and create the ESP-NOW helper. Every block
 *  needs this; ensureImport/addSetup dedupe by exact text, so it emits once. */
function ensureRadio(ctx: GenContext): void {
  ctx.ensureImport("import network");
  ctx.ensureImport("from BloqEspNow import BloqEspNow");
  ctx.requireLibrary("/lib/BloqEspNow.py");
  ctx.addSetup("wlan = network.WLAN(network.STA_IF)");
  ctx.addSetup("wlan.active(True)");
  ctx.addSetup("now = BloqEspNow(wlan)");
}

export const plugin: BloqPlugin = {
  id: "core-espnow",
  name: "ESP-NOW",
  version: "1.0.0",
  requires: ["espnow"], // ESP32-family only — declared as a board capability
  toolbox: { category: "ESP-NOW", colour: COLOUR, order: 110, faIcon: "fa-tower-broadcast" },

  // Full starter projects (open on the current board).
  examples: [
    {
      id: "espnow-receiver",
      name: "ESP-NOW receiver",
      description: "Print this board's MAC, then show and act on incoming messages",
      file: "espnow-receiver.bloq",
    },
    {
      id: "espnow-sender",
      name: "ESP-NOW sender",
      description: "Register peers and send / broadcast messages on a button press",
      file: "espnow-sender.bloq",
    },
  ],

  // Ready-made starter stacks, dropped at the bottom of the flyout.
  presets: [
    // Receiver: loop printing whatever arrives (prints a blank line each second
    // nothing does). Receiving needs no peer registration — only sending does.
    {
      kind: "block",
      type: "when_started",
      next: {
        block: {
          type: "forever",
          inputs: {
            DO: {
              block: {
                type: "print_terminal",
                inputs: {
                  MSG: {
                    block: {
                      type: "espnow_receive",
                      inputs: {
                        TIMEOUT: { shadow: { type: "math_number", fields: { NUM: 1000 } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    // Sender: register the broadcast address, then broadcast a message once per
    // second (1 Hz).
    {
      kind: "block",
      type: "when_started",
      next: {
        block: {
          type: "espnow_add_broadcast_peer",
          next: {
            block: {
              type: "forever",
              inputs: {
                DO: {
                  block: {
                    type: "espnow_broadcast",
                    inputs: {
                      MSG: { shadow: { type: "text_literal", fields: { TEXT: "hello" } } },
                    },
                    next: {
                      block: { type: "wait_ms", fields: { MS: 1000 } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  ],

  blocks: {
    espnow_add_peer: {
      kind: "statement",
      json: {
        type: "espnow_add_peer",
        message0: "ESP-NOW add peer %1",
        args0: [{ type: "input_value", name: "MAC", check: "String" }],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip: "Register a peer by MAC address (e.g. AA:BB:CC:DD:EE:FF) so you can send to it.",
      },
      toolbox: { inputs: { MAC: MAC("AA:BB:CC:DD:EE:FF") } },
    },

    espnow_add_broadcast_peer: {
      kind: "statement",
      json: {
        type: "espnow_add_broadcast_peer",
        message0: "ESP-NOW add broadcast peer",
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip: "Register the broadcast address so 'broadcast' reaches every ESP-NOW device nearby.",
      },
    },

    espnow_broadcast: {
      kind: "statement",
      json: {
        type: "espnow_broadcast",
        message0: "ESP-NOW broadcast %1",
        args0: [{ type: "input_value", name: "MSG" }],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip: "Send a message to every device. Use 'add broadcast peer' once before this.",
      },
      toolbox: { inputs: { MSG: TEXT("hello") } },
    },

    espnow_send: {
      kind: "statement",
      json: {
        type: "espnow_send",
        message0: "ESP-NOW send %1 to %2",
        args0: [
          { type: "input_value", name: "MSG" },
          { type: "input_value", name: "MAC", check: "String" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip: "Send a message to one peer by MAC. Add that peer first.",
      },
      toolbox: { inputs: { MSG: TEXT("hello"), MAC: MAC("AA:BB:CC:DD:EE:FF") } },
    },

    espnow_receive: {
      kind: "value",
      json: {
        type: "espnow_receive",
        message0: "ESP-NOW receive (wait up to %1 ms)",
        args0: [{ type: "input_value", name: "TIMEOUT", check: "Number" }],
        inputsInline: true,
        output: "String",
        colour: COLOUR,
        tooltip: "Wait up to this many ms for a message and return its text (empty \"\" if none arrived).",
      },
      toolbox: { inputs: { TIMEOUT: NUM(100) } },
    },

    espnow_sender: {
      kind: "value",
      json: {
        type: "espnow_sender",
        message0: "ESP-NOW sender MAC",
        output: "String",
        colour: COLOUR,
        tooltip: "MAC address of whoever sent the last received message (\"\" before the first one).",
      },
    },

    espnow_my_mac: {
      kind: "value",
      json: {
        type: "espnow_my_mac",
        message0: "ESP-NOW my MAC address",
        output: "String",
        colour: COLOUR,
        tooltip: "This board's own MAC address — share it so other boards can send to you.",
      },
    },
  },

  generators: {
    espnow_add_peer: (block: Blockly.Block, ctx: GenContext) => {
      ensureRadio(ctx);
      ctx.line(`now.add_peer(${ctx.value(block, "MAC", '""')})`, block.id);
    },

    espnow_add_broadcast_peer: (block: Blockly.Block, ctx: GenContext) => {
      ensureRadio(ctx);
      ctx.line("now.add_broadcast_peer()", block.id);
    },

    espnow_broadcast: (block: Blockly.Block, ctx: GenContext) => {
      ensureRadio(ctx);
      ctx.line(`now.broadcast(${ctx.value(block, "MSG", '""')})`, block.id);
    },

    espnow_send: (block: Blockly.Block, ctx: GenContext) => {
      ensureRadio(ctx);
      ctx.line(`now.send(${ctx.value(block, "MAC", '""')}, ${ctx.value(block, "MSG", '""')})`, block.id);
    },

    espnow_receive: (block: Blockly.Block, ctx: GenContext) => {
      ensureRadio(ctx);
      return `now.receive(${ctx.value(block, "TIMEOUT", "0")})`;
    },

    espnow_sender: (_block: Blockly.Block, ctx: GenContext) => {
      ensureRadio(ctx);
      return "now.sender";
    },

    espnow_my_mac: (_block: Blockly.Block, ctx: GenContext) => {
      ensureRadio(ctx);
      return "now.my_mac()";
    },
  },
};
