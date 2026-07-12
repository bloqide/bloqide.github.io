import * as Blockly from "blockly";
import type { BloqPlugin, GenContext } from "../../src/core/types";
import "../../src/ui/fieldTextArea"; // registers the resizable "field_textarea"

// --- if/else-if mutator ----------------------------------------------------
// Gives the if_else block a variable number of "else if" clauses, driven by
// inline + / − buttons sitting just above the else branch (no gear/flyout).
// Clauses are inputs IF1/THEN1, IF2/THEN2, …; the base if uses COND/DO.

const IFELSE_MUTATOR = "bloq_ifelse_mutator";
const btnSvg = (path: string) =>
  "data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15">` +
      `<path d="${path}" stroke="white" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>`
  );
const PLUS_ICON = btnSvg("M7.5 3.4v8.2M3.4 7.5h8.2");
const MINUS_ICON = btnSvg("M3.4 7.5h8.2");

const IFELSE_MIXIN = {
  elifCount_: 0,

  saveExtraState(this: any) {
    return { elif: this.elifCount_ };
  },
  loadExtraState(this: any, state: any) {
    this.elifCount_ = state?.elif ?? 0;
    this.updateShape_();
  },

  updateShape_(this: any) {
    // The button row + else are created once and always kept last.
    if (!this.getInput("CTRL")) {
      this.appendDummyInput("CTRL")
        .appendField("else if")
        .appendField(new Blockly.FieldImage(PLUS_ICON, 15, 15, "+", () => this.plus_()), "PLUS")
        .appendField(new Blockly.FieldImage(MINUS_ICON, 15, 15, "−", () => this.minus_()), "MINUS");
    }
    if (!this.getInput("ELSE")) this.appendStatementInput("ELSE").appendField("else");
    // Add missing else-if clauses, inserted just above the button row.
    for (let i = 1; i <= this.elifCount_; i++) {
      if (!this.getInput("IF" + i)) {
        this.appendValueInput("IF" + i).appendField("else if");
        this.appendStatementInput("THEN" + i);
        this.moveInputBefore("IF" + i, "CTRL");
        this.moveInputBefore("THEN" + i, "CTRL");
      }
    }
    // Drop surplus clauses.
    for (let i = this.elifCount_ + 1; this.getInput("IF" + i); i++) {
      this.removeInput("IF" + i);
      this.removeInput("THEN" + i);
    }
  },

  setElif_(this: any, n: number) {
    const before = JSON.stringify(this.saveExtraState());
    this.elifCount_ = n;
    this.updateShape_();
    const after = JSON.stringify(this.saveExtraState());
    if (before !== after) {
      Blockly.Events.fire(new Blockly.Events.BlockChange(this, "mutation", null, before, after));
    }
  },
  plus_(this: any) {
    this.setElif_(this.elifCount_ + 1);
  },
  minus_(this: any) {
    if (this.elifCount_ > 0) this.setElif_(this.elifCount_ - 1);
  },
};

if (!Blockly.Extensions.isRegistered(IFELSE_MUTATOR)) {
  Blockly.Extensions.registerMutator(IFELSE_MUTATOR, IFELSE_MIXIN, function (this: any) {
    this.updateShape_();
  });
}
// ---------------------------------------------------------------------------

// Control blocks: program entry (hats), loops, waits, and the raw-code escape
// hatch. These blocks ADAPT to the active codegen mode — they never force the
// scheduler themselves. Two `when_started` stacks => scheduler mode; a single
// one => plain linear code.

// A Python-safe identifier from a (possibly free-text) Blockly variable name.
function ident(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[a-zA-Z_]/.test(s) ? s : `_${s}`;
}

// Emit a loop body, appending a cooperative `yield` in scheduler mode (so the
// loop doesn't starve other stacks) or a `pass` if a simple-mode body is empty.
function emitLoopBody(block: Blockly.Block, ctx: GenContext): void {
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
}

// Emit a non-looping statement body (if/else branch): just a `pass` when empty.
function emitBranch(block: Blockly.Block, input: string, ctx: GenContext): void {
  ctx.indented(() => {
    const before = ctx.linesEmitted();
    ctx.statement(block, input);
    if (ctx.linesEmitted() === before) ctx.line("pass", block.id);
  });
}

export const plugin: BloqPlugin = {
  id: "core-control",
  name: "Control",
  version: "1.0.0",
  toolbox: { category: "Control", colour: 210, order: 10, faIcon: "fa-flag" },
  icon: { preset: "flag" },

  // Board-agnostic starter projects (open on whatever board is current).
  examples: [
    {
      id: "blink",
      name: "Blink",
      description: "Toggle the onboard LED in a loop",
      file: "blink.bloq",
    },
    {
      id: "two-blinkers",
      name: "Two blinkers",
      description: "Two independent blink loops (scheduler)",
      file: "two-stacks.bloq",
    },
  ],

  // Ready-made snippet: a blink loop (drop under a "when started").
  presets: [
    {
      kind: "block",
      type: "forever",
      inputs: {
        DO: {
          block: {
            type: "gpio_toggle_led",
            next: { block: { type: "wait_ms", fields: { MS: 500 } } },
          },
        },
      },
    },
  ],

  blocks: {
    when_started: {
      hat: true,
      kind: "hat",
      json: {
        type: "when_started",
        message0: "%1",
        args0: [{ type: "field_label", name: "LABEL", text: "START", class: "bloq-hat-label" }],
        nextStatement: null,
        colour: "#40c057",
        tooltip: "Program entry point. Multiple of these run concurrently.",
      },
    },
    on_setup: {
      hat: true,
      setup: true,
      kind: "hat",
      json: {
        type: "on_setup",
        message0: "%1",
        args0: [{ type: "field_label", name: "LABEL", text: "SETUP", class: "bloq-hat-label" }],
        nextStatement: null,
        colour: 260,
        tooltip:
          "Runs once at startup, before the stacks begin. Put 'set variable' blocks here to create variables shared across all stacks (globals).",
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
    wait_seconds: {
      kind: "statement",
      json: {
        type: "wait_seconds",
        message0: "wait %1 seconds",
        args0: [{ type: "input_value", name: "SEC" }],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: 210,
      },
      toolbox: { inputs: { SEC: { shadow: { type: "math_number", fields: { NUM: 1 } } } } },
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
    repeat_while: {
      kind: "statement",
      json: {
        type: "repeat_while",
        message0: "repeat %1 %2 %3 %4",
        args0: [
          {
            type: "field_dropdown",
            name: "MODE",
            options: [
              ["while", "while"],
              ["until", "until"],
            ],
          },
          { type: "input_value", name: "COND" },
          { type: "input_dummy" },
          { type: "input_statement", name: "DO" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: 210,
        tooltip: "Loop while a condition holds (or until it becomes true).",
      },
    },
    for_range: {
      kind: "statement",
      json: {
        type: "for_range",
        message0: "count %1 from %2 to %3 %4 %5",
        args0: [
          { type: "field_variable", name: "VAR", variable: "i" },
          { type: "input_value", name: "FROM" },
          { type: "input_value", name: "TO" },
          { type: "input_dummy" },
          { type: "input_statement", name: "DO" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: 210,
        tooltip: "Count a variable from a start to an end value (inclusive).",
      },
      toolbox: {
        inputs: {
          FROM: { shadow: { type: "math_number", fields: { NUM: 1 } } },
          TO: { shadow: { type: "math_number", fields: { NUM: 10 } } },
        },
      },
    },
    for_while: {
      kind: "statement",
      json: {
        type: "for_while",
        message0: "repeat with %1 from %2 %3 %4 %5 %6",
        args0: [
          { type: "field_variable", name: "VAR", variable: "i" },
          { type: "input_value", name: "FROM" },
          {
            type: "field_dropdown",
            name: "MODE",
            options: [
              ["while", "while"],
              ["until", "until"],
            ],
          },
          { type: "input_value", name: "COND" },
          { type: "input_dummy" },
          { type: "input_statement", name: "DO" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: 210,
        tooltip:
          "Counting loop with a custom stop test: sets the variable to the start value, then repeats (incrementing it by 1 each pass) while/until the condition holds.",
      },
      toolbox: {
        inputs: {
          FROM: { shadow: { type: "math_number", fields: { NUM: 0 } } },
          COND: {
            shadow: {
              type: "logic_compare",
              fields: { OP: "<" },
              inputs: {
                A: { shadow: { type: "variables_get", fields: { VAR: { name: "i" } } } },
                B: { shadow: { type: "math_number", fields: { NUM: 10 } } },
              },
            },
          },
        },
      },
    },
    if_do: {
      kind: "statement",
      json: {
        type: "if_do",
        message0: "if %1 %2 %3",
        args0: [
          { type: "input_value", name: "COND" },
          { type: "input_dummy" },
          { type: "input_statement", name: "DO" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: 210,
      },
    },
    if_else: {
      kind: "statement",
      json: {
        // Base "if COND / do DO"; the mutator appends any else-if clauses, the
        // +/- button row, and the else branch.
        type: "if_else",
        message0: "if %1 %2 %3",
        args0: [
          { type: "input_value", name: "COND" },
          { type: "input_dummy" },
          { type: "input_statement", name: "DO" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: 210,
        mutator: IFELSE_MUTATOR,
      },
    },
    wait_until: {
      kind: "statement",
      json: {
        type: "wait_until",
        message0: "wait until %1",
        args0: [{ type: "input_value", name: "COND" }],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: 210,
        tooltip: "Pause this stack until the condition becomes true.",
      },
    },
    raw_python: {
      kind: "statement",
      json: {
        type: "raw_python",
        message0: "MicroPython %1 %2",
        args0: [
          { type: "input_dummy" },
          { type: "field_textarea", name: "CODE", text: "# your code here" },
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
      emitLoopBody(block, ctx);
    },

    repeat_times: (block: Blockly.Block, ctx: GenContext) => {
      const n = block.getFieldValue("N");
      ctx.line(`for _ in range(${n}):`, block.id);
      emitLoopBody(block, ctx);
    },

    repeat_while: (block: Blockly.Block, ctx: GenContext) => {
      const mode = block.getFieldValue("MODE"); // "while" | "until"
      const cond = ctx.value(block, "COND", "False");
      ctx.line(`while ${mode === "until" ? `not (${cond})` : cond}:`, block.id);
      emitLoopBody(block, ctx);
    },

    for_range: (block: Blockly.Block, ctx: GenContext) => {
      const name = ident(block.getField("VAR")?.getText() ?? "i");
      ctx.assign(name);
      const from = ctx.value(block, "FROM", "0");
      const to = ctx.value(block, "TO", "10");
      // Inclusive of the end value, matching the "from X to Y" wording.
      ctx.line(`for ${name} in range(${from}, (${to}) + 1):`, block.id);
      emitLoopBody(block, ctx);
    },

    for_while: (block: Blockly.Block, ctx: GenContext) => {
      const name = ident(block.getField("VAR")?.getText() ?? "i");
      ctx.assign(name);
      const mode = block.getFieldValue("MODE"); // "while" | "until"
      const from = ctx.value(block, "FROM", "0");
      const cond = ctx.value(block, "COND", "False");
      ctx.line(`${name} = ${from}`, block.id);
      ctx.line(`while ${mode === "until" ? `not (${cond})` : cond}:`, block.id);
      // No auto-increment — the user advances the variable in the body themselves.
      emitLoopBody(block, ctx);
    },

    if_do: (block: Blockly.Block, ctx: GenContext) => {
      ctx.line(`if ${ctx.value(block, "COND", "False")}:`, block.id);
      emitBranch(block, "DO", ctx);
    },

    if_else: (block: Blockly.Block, ctx: GenContext) => {
      ctx.line(`if ${ctx.value(block, "COND", "False")}:`, block.id);
      emitBranch(block, "DO", ctx);
      for (let i = 1; block.getInput(`IF${i}`); i++) {
        ctx.line(`elif ${ctx.value(block, `IF${i}`, "False")}:`, block.id);
        emitBranch(block, `THEN${i}`, ctx);
      }
      ctx.line("else:", block.id);
      emitBranch(block, "ELSE", ctx);
    },

    wait_until: (block: Blockly.Block, ctx: GenContext) => {
      const cond = ctx.value(block, "COND", "False");
      if (ctx.schedulerMode) {
        ctx.line(`yield from sched.wait_until(lambda: ${cond})`, block.id);
        ctx.markYield();
      } else {
        // No concurrency to wait for — busy-poll the condition.
        ctx.line(`while not (${cond}):`, block.id);
        ctx.indented(() => ctx.line("pass", block.id));
      }
    },

    wait_seconds: (block: Blockly.Block, ctx: GenContext) => {
      const sec = ctx.value(block, "SEC", "1");
      if (ctx.schedulerMode) {
        // Fold a literal to whole milliseconds; otherwise convert at runtime.
        const ms = /^\d+(\.\d+)?$/.test(sec) ? String(Math.round(Number(sec) * 1000)) : `int(${sec} * 1000)`;
        ctx.line(`yield from sched.sleep_ms(${ms})`, block.id);
        ctx.markYield();
      } else {
        ctx.ensureImport("import time");
        ctx.line(`time.sleep(${sec})`, block.id);
      }
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
