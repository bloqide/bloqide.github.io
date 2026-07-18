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

import * as Blockly from "blockly";
import type { BloqPlugin, GenContext } from "../../src/core/types";
import "../../src/ui/fieldTextArea"; // registers the resizable "field_textarea"

// Text: string literals, concatenation, and printing to the serial terminal.
// `text_literal`/`text_join` are value blocks (return an expression);
// `print_terminal` is a statement (emits a `print(...)` line).

// --- Variadic-join mutator -------------------------------------------------
// A self-contained mutator for text_join: instead of Blockly's gear/flyout
// (which shows container blocks and confuses non-devs), it puts inline + / −
// buttons on the block that add/remove item slots (ADD0, ADD1, …), stacked
// vertically. State is one number (itemCount_), serialized via saveExtraState.

const JOIN_MUTATOR = "bloq_join_mutator";
const svg = (path: string) =>
  "data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15">` +
      `<path d="${path}" stroke="white" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>`
  );
const PLUS_ICON = svg("M7.5 3.4v8.2M3.4 7.5h8.2");
const MINUS_ICON = svg("M3.4 7.5h8.2");

// A mutator (not a plain extension — Blockly only allows serialization state on
// mutators). No compose/decompose means no gear icon; the + / − buttons drive it.
const JOIN_MIXIN = {
  itemCount_: 2,

  saveExtraState(this: any) {
    return { itemCount: this.itemCount_ };
  },
  loadExtraState(this: any, state: any) {
    this.itemCount_ = state?.itemCount ?? 2;
    this.updateShape_();
  },

  updateShape_(this: any) {
    // Header row: "join" label + the two buttons (created once).
    if (!this.getInput("HEADER")) {
      this.appendDummyInput("HEADER")
        .appendField("join")
        .appendField(new Blockly.FieldImage(PLUS_ICON, 15, 15, "+", () => this.plus_()), "PLUS")
        .appendField(new Blockly.FieldImage(MINUS_ICON, 15, 15, "−", () => this.minus_()), "MINUS");
    }
    // Add / remove item slots to match the count.
    for (let i = 0; i < this.itemCount_; i++) {
      if (!this.getInput("ADD" + i)) this.appendValueInput("ADD" + i);
    }
    for (let i = this.itemCount_; this.getInput("ADD" + i); i++) this.removeInput("ADD" + i);
  },

  // Change the item count as an undoable, listener-visible mutation.
  changeItems_(this: any, n: number) {
    const before = JSON.stringify(this.saveExtraState());
    this.itemCount_ = n;
    this.updateShape_();
    const after = JSON.stringify(this.saveExtraState());
    if (before !== after) {
      Blockly.Events.fire(new Blockly.Events.BlockChange(this, "mutation", null, before, after));
    }
  },
  plus_(this: any) {
    this.changeItems_(this.itemCount_ + 1);
  },
  minus_(this: any) {
    if (this.itemCount_ > 1) this.changeItems_(this.itemCount_ - 1); // keep at least one slot
  },
};

if (!Blockly.Extensions.isRegistered(JOIN_MUTATOR)) {
  Blockly.Extensions.registerMutator(JOIN_MUTATOR, JOIN_MIXIN, function (this: any) {
    this.updateShape_();
  });
}

// Turn escape sequences a user types in a text field (\n \t \r \\ \" \' \0)
// into the real characters, so they render as a newline/tab rather than literal
// backslash-n. `\\` escapes the backslash itself. JSON.stringify then re-encodes
// the result into a valid MicroPython string literal.
function pyString(text: string): string {
  const unescaped = text.replace(/\\(["'\\nrt0])/g, (_, ch) => {
    switch (ch) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "0": return "\0";
      default: return ch; // \\  \"  \'
    }
  });
  return JSON.stringify(unescaped);
}

// ---------------------------------------------------------------------------

export const plugin: BloqPlugin = {
  id: "core-text",
  name: "Text",
  version: "1.0.0",
  toolbox: { category: "Text", colour: 45, order: 50, faIcon: "fa-quote-right" },

  blocks: {
    text_literal: {
      kind: "value",
      json: {
        type: "text_literal",
        message0: '“ %1 ”',
        args0: [{ type: "field_input", name: "TEXT", text: "" }],
        output: null,
        colour: 45,
        tooltip: "A piece of text. Type \\n for a newline, \\t for a tab.",
      },
    },
    text_newline: {
      kind: "value",
      json: {
        type: "text_newline",
        message0: "↵ newline",
        output: null,
        colour: 45,
        tooltip: "A line break (same as \\n).",
      },
    },
    // Variadic string join with inline + / − buttons (see JOIN_MUTATOR above).
    // Slots are named ADD0, ADD1, … and hold any value (text or number).
    text_join: {
      kind: "value",
      json: {
        type: "text_join",
        message0: "",
        output: null,
        colour: 45,
        mutator: JOIN_MUTATOR,
        tooltip: "Join values into one string. Use + / − to add or remove slots.",
      },
    },
    // Fixed two-slot join — handy for one-liner "label + value" prints.
    text_join2: {
      kind: "value",
      json: {
        type: "text_join2",
        message0: "%1 join %2",
        args0: [
          { type: "input_value", name: "A" },
          { type: "input_value", name: "B" },
        ],
        inputsInline: true,
        output: null,
        colour: 45,
        tooltip: "Join two values into one string.",
      },
      toolbox: {
        inputs: {
          A: { shadow: { type: "text_literal", fields: { TEXT: "value: " } } },
          B: { shadow: { type: "math_number", fields: { NUM: 0 } } },
        },
      },
    },
    comment: {
      kind: "statement",
      json: {
        type: "comment",
        message0: "note %1",
        args0: [{ type: "field_textarea", name: "TEXT", text: "" }],
        previousStatement: null,
        nextStatement: null,
        colour: 60,
        tooltip: "A comment to explain the code. Does nothing when the program runs.",
      },
    },
    print_terminal: {
      kind: "statement",
      json: {
        type: "print_terminal",
        message0: "print %1 to terminal",
        args0: [{ type: "input_value", name: "MSG" }],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: 45,
        tooltip: "Print a value to the serial terminal (REPL output).",
      },
      toolbox: {
        inputs: { MSG: { shadow: { type: "text_literal", fields: { TEXT: "Hello!" } } } },
      },
    },
  },

  generators: {
    // Python string literal, with \n / \t etc. interpreted (see pyString).
    text_literal: (block: Blockly.Block) => pyString(String(block.getFieldValue("TEXT") ?? "")),
    text_newline: () => JSON.stringify("\n"),
    text_join2: (block: Blockly.Block, ctx: GenContext) =>
      `(str(${ctx.value(block, "A", "''")}) + str(${ctx.value(block, "B", "''")}))`,
    text_join: (block: Blockly.Block, ctx: GenContext) => {
      // Concatenate every item slot, coercing each to str so numbers join too.
      const parts: string[] = [];
      for (let i = 0; block.getInput(`ADD${i}`); i++) {
        parts.push(`str(${ctx.value(block, `ADD${i}`, "''")})`);
      }
      return parts.length ? `(${parts.join(" + ")})` : "''";
    },
    print_terminal: (block: Blockly.Block, ctx: GenContext) => {
      ctx.line(`print(${ctx.value(block, "MSG", "''")})`, block.id);
    },
    comment: (block: Blockly.Block, ctx: GenContext) => {
      const text = String(block.getFieldValue("TEXT") ?? "");
      for (const ln of text.split("\n")) ctx.line(ln === "" ? "#" : `# ${ln}`, block.id);
    },
  },
};
