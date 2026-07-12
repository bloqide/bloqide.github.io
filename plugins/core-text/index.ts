import type { BloqPlugin, GenContext } from "../../src/core/types";
import type * as Blockly from "blockly";

// Text: string literals, concatenation, and printing to the serial terminal.
// `text_literal`/`text_join` are value blocks (return an expression);
// `print_terminal` is a statement (emits a `print(...)` line).

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
      },
    },
    text_join: {
      kind: "value",
      json: {
        type: "text_join",
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
          A: { shadow: { type: "text_literal", fields: { TEXT: "hello " } } },
          B: { shadow: { type: "text_literal", fields: { TEXT: "world" } } },
        },
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
    // Python string literal — JSON.stringify escapes quotes/backslashes/newlines
    // into a form MicroPython accepts verbatim.
    text_literal: (block: Blockly.Block) => JSON.stringify(String(block.getFieldValue("TEXT") ?? "")),
    text_join: (block: Blockly.Block, ctx: GenContext) =>
      `(str(${ctx.value(block, "A", "''")}) + str(${ctx.value(block, "B", "''")}))`,
    print_terminal: (block: Blockly.Block, ctx: GenContext) => {
      ctx.line(`print(${ctx.value(block, "MSG", "''")})`, block.id);
    },
  },
};
