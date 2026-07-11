import type { MicroblockPlugin, GenContext } from "../../src/core/types";
import type * as Blockly from "blockly";

// Control blocks: program entry (hats), loops, waits, and the raw-code escape
// hatch. These blocks ADAPT to the active codegen mode — they never force the
// scheduler themselves. Two `when_started` stacks => scheduler mode; a single
// one => plain linear code.

export const plugin: MicroblockPlugin = {
  id: "core-control",
  name: "Control",
  version: "1.0.0",
  toolbox: { category: "Control", colour: 210, order: 10, faIcon: "fa-flag" },
  icon: { preset: "flag" },

  blocks: {
    when_started: {
      hat: true,
      kind: "hat",
      json: {
        type: "when_started",
        message0: "when started",
        nextStatement: null,
        colour: 210,
        tooltip: "Program entry point. Multiple of these run concurrently.",
      },
    },
    forever: {
      kind: "statement",
      json: {
        type: "forever",
        message0: "forever %1 %2",
        args0: [
          { type: "input_dummy" },
          { type: "input_statement", name: "DO" },
        ],
        previousStatement: null,
        nextStatement: null,
        colour: 210,
      },
    },
    repeat_times: {
      kind: "statement",
      json: {
        type: "repeat_times",
        message0: "repeat %1 times %2 %3",
        args0: [
          { type: "field_number", name: "N", value: 10, min: 0, precision: 1 },
          { type: "input_dummy" },
          { type: "input_statement", name: "DO" },
        ],
        previousStatement: null,
        nextStatement: null,
        colour: 210,
      },
    },
    wait_ms: {
      kind: "statement",
      json: {
        type: "wait_ms",
        message0: "wait %1 ms",
        args0: [{ type: "field_number", name: "MS", value: 500, min: 0 }],
        previousStatement: null,
        nextStatement: null,
        colour: 210,
      },
    },
    raw_python: {
      kind: "statement",
      json: {
        type: "raw_python",
        message0: "MicroPython %1 %2",
        args0: [
          { type: "input_dummy" },
          { type: "field_multilinetext", name: "CODE", text: "# your code here" },
        ],
        previousStatement: null,
        nextStatement: null,
        colour: 20,
        tooltip: "Emitted verbatim. Avoid blocking calls (time.sleep) in scheduler mode.",
      },
    },
  },

  generators: {
    // NB: `when_started` needs no generator — the engine wraps each hat's
    // next-block chain into a stack (def stack_N / spawn) based on the mode.

    forever: (block: Blockly.Block, ctx: GenContext) => {
      ctx.line("while True:", block.id);
      ctx.indented(() => {
        const before = ctx.linesEmitted();
        ctx.statement(block, "DO");
        if (ctx.schedulerMode) {
          ctx.line("yield", block.id);
          ctx.markYield();
        } else if (ctx.linesEmitted() === before) {
          // empty body in simple mode would be a syntax error
          ctx.line("pass", block.id);
        }
      });
    },

    repeat_times: (block: Blockly.Block, ctx: GenContext) => {
      const n = block.getFieldValue("N");
      ctx.line(`for _ in range(${n}):`, block.id);
      ctx.indented(() => {
        const before = ctx.linesEmitted();
        ctx.statement(block, "DO");
        if (ctx.schedulerMode) {
          ctx.line("yield", block.id);
          ctx.markYield();
        } else if (ctx.linesEmitted() === before) {
          ctx.line("pass", block.id);
        }
      });
    },

    wait_ms: (block: Blockly.Block, ctx: GenContext) => {
      const ms = block.getFieldValue("MS");
      if (ctx.schedulerMode) {
        ctx.line(`yield from sched.sleep_ms(${ms})`, block.id);
        ctx.markYield();
      } else {
        ctx.ensureImport("import time");
        ctx.line(`time.sleep_ms(${ms})`, block.id);
      }
    },

    raw_python: (block: Blockly.Block, ctx: GenContext) => {
      const code = String(block.getFieldValue("CODE") ?? "");
      for (const ln of code.split("\n")) ctx.line(ln, block.id);
    },
  },
};
