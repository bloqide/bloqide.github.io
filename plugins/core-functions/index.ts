import * as Blockly from "blockly";
import type { BloqPlugin, GenContext } from "../../src/core/types";

// Custom functions. The two *definition* blocks are our own, with inline +/-
// parameter editing (the same mutator idiom as core-control's if/else), but they
// implement Blockly's legacy procedure contract — getProcedureDef / callType_ /
// mutationToDom — so Blockly's built-in CALL blocks, the PROCEDURE flyout, and
// caller auto-sync all keep working. The call + if-return blocks stay built-in.
//
//   procedures_defnoreturn  ->  def name(params): <body>      (custom, inline +/-)
//   procedures_defreturn    ->  def name(params): <body>; return <expr>  (custom)
//   procedures_callnoreturn ->  name(args)              (Blockly built-in)
//   procedures_callreturn   ->  name(args)              (Blockly built-in)
//   procedures_ifreturn     ->  if cond: return [value] (Blockly built-in)
//
// Definitions are top-level blocks; codegen emits them as module-level defs (see
// CodeGen's procedure pass), not scheduler stacks. A wait inside a function is
// blocking, since a plain def can't drive the cooperative scheduler.

function ident(name: string): string {
  const s = String(name).replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[a-zA-Z_]/.test(s) ? s : `_${s}`;
}

// ----------------------------- inline +/- params ---------------------------

const DEF_MUTATOR = "bloq_procedure_params";
const btnSvg = (path: string) =>
  "data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15">` +
      `<path d="${path}" stroke="white" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>`
  );
const PLUS_ICON = btnSvg("M7.5 3.4v8.2M3.4 7.5h8.2");
const MINUS_ICON = btnSvg("M3.4 7.5h8.2");

// A fresh, unused single-letter (then p1, p2, …) parameter name.
function nextParam(existing: string[]): string {
  for (const ch of "xyzabcdefghijklmnopqrstuvw") if (!existing.includes(ch)) return ch;
  let i = 1;
  while (existing.includes(`p${i}`)) i++;
  return `p${i}`;
}

const DEF_MIXIN = {
  arguments_: [] as string[],
  hasReturn_: false,
  callType_: "procedures_callnoreturn",

  // ---- Blockly procedure contract (read by Procedures.* and the callers) ----
  getProcedureDef(this: any): [string, string[], boolean] {
    return [this.getFieldValue("NAME"), this.arguments_.slice(), this.hasReturn_];
  },
  // NB: getVars is assigned in defHelper, not here — Blockly's mixin refuses to
  // overwrite the base Block.getVars, but a per-block own property is fine.

  // The callers' domToMutation reads: <mutation name="f"><arg name="x"/>…</mutation>
  mutationToDom(this: any): Element {
    const container = Blockly.utils.xml.createElement("mutation");
    container.setAttribute("name", this.getFieldValue("NAME"));
    for (const arg of this.arguments_) {
      const el = Blockly.utils.xml.createElement("arg");
      el.setAttribute("name", arg);
      container.appendChild(el);
    }
    return container;
  },
  domToMutation(this: any, xml: Element): void {
    this.arguments_ = [];
    for (const child of Array.from(xml.childNodes) as Element[]) {
      if (child.nodeName?.toLowerCase() === "arg") this.arguments_.push(child.getAttribute("name") || "arg");
    }
    this.updateShape_();
  },

  // ---- inline parameter row: [with: (x) (y) ＋ －] before the body ----
  updateShape_(this: any): void {
    if (this.getInput("PARAMS")) this.removeInput("PARAMS");
    const row = this.appendDummyInput("PARAMS");
    if (this.arguments_.length) row.appendField("with:");
    this.arguments_.forEach((name: string, i: number) => {
      row.appendField(
        new Blockly.FieldTextInput(name, (v: string) => {
          // Codegen reads arguments_; caller shape is positional, so a rename
          // needs no caller re-sync — just keep the array in step with the field.
          this.arguments_[i] = v;
          return v;
        }),
        "P" + i
      );
    });
    row.appendField(new Blockly.FieldImage(PLUS_ICON, 15, 15, "+", () => this.addParam_()), "ADD");
    if (this.arguments_.length)
      row.appendField(new Blockly.FieldImage(MINUS_ICON, 15, 15, "-", () => this.removeParam_()), "DEL");
    if (this.getInput("STACK")) this.moveInputBefore("PARAMS", "STACK");
  },

  addParam_(this: any): void {
    this.mutateWith_(() => this.arguments_.push(nextParam(this.arguments_)));
  },
  removeParam_(this: any): void {
    if (this.arguments_.length) this.mutateWith_(() => this.arguments_.pop());
  },
  // Apply a param edit, refresh the shape, sync callers, and record one undo step.
  mutateWith_(this: any, edit: () => void): void {
    const before = Blockly.Xml.domToText(this.mutationToDom());
    edit();
    this.updateShape_();
    const after = Blockly.Xml.domToText(this.mutationToDom());
    if (before !== after) {
      Blockly.Events.fire(new Blockly.Events.BlockChange(this, "mutation", null, before, after));
      Blockly.Procedures.mutateCallers(this);
    }
  },
};

// Runs on each definition block's creation: seed state, wire the name validator
// (dedupes + renames callers), and build the initial (empty) parameter row.
function defHelper(this: any): void {
  this.arguments_ = [];
  this.hasReturn_ = this.type === "procedures_defreturn";
  this.callType_ = this.hasReturn_ ? "procedures_callreturn" : "procedures_callnoreturn";
  // Own-property override (see note in DEF_MIXIN): the base Block.getVars can't be
  // replaced via the mixin, so shadow it here.
  this.getVars = function (this: any): string[] {
    return this.arguments_.slice();
  };
  this.getField("NAME")?.setValidator(Blockly.Procedures.rename);
  this.updateShape_();
}

if (!Blockly.Extensions.isRegistered(DEF_MUTATOR)) {
  Blockly.Extensions.registerMutator(DEF_MUTATOR, DEF_MIXIN, defHelper);
}

// --------------------------------- codegen ---------------------------------

function funcName(block: any): string {
  const raw = block.getFieldValue?.("NAME") ?? block.getProcedureModel?.()?.getName?.() ?? block.getProcedureCall?.();
  return ident(raw || "my_function");
}

// A definition's parameter names, de-duplicated after sanitising to identifiers.
function paramNames(block: any): string[] {
  const raw: string[] = typeof block.getVars === "function" ? block.getVars() : block.arguments_ ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of raw) {
    let name = ident(p);
    let n = 2;
    while (seen.has(name)) name = `${ident(p)}${n++}`;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// The argument expressions plugged into a call block's ARG0..ARGn value inputs.
function callArgs(block: Blockly.Block, ctx: GenContext): string[] {
  const args: string[] = [];
  for (let i = 0; block.getInput("ARG" + i); i++) args.push(ctx.value(block, "ARG" + i, "None"));
  return args;
}

// Marker for the built-in blocks we keep as-is: register a generator, don't
// redefine the JSON.
const builtinBlock = () => ({ builtin: true as const, json: { type: "" } });

// Shared JSON for the two custom definition blocks (return input added below).
const defJson = (type: string) => ({
  type,
  message0: "function %1",
  args0: [{ type: "field_input", name: "NAME", text: "do something", spellcheck: false }],
  message1: "%1",
  args1: [{ type: "input_statement", name: "STACK" }],
  colour: 290,
  mutator: DEF_MUTATOR,
  tooltip: "Define a function. Use + / − to add or remove parameters.",
});

export const plugin: BloqPlugin = {
  id: "core-functions",
  name: "Functions",
  version: "1.0.0",
  toolbox: { category: "Functions", colour: 290, order: 65, faIcon: "fa-diagram-project", custom: "PROCEDURE" },

  blocks: {
    // Custom definition blocks (override Blockly's built-ins to get inline +/-).
    procedures_defnoreturn: { procedure: true, json: defJson("procedures_defnoreturn") },
    procedures_defreturn: {
      procedure: true,
      json: {
        ...defJson("procedures_defreturn"),
        message2: "return %1",
        args2: [{ type: "input_value", name: "RETURN", align: "RIGHT" }],
        tooltip: "Define a function that returns a value.",
      },
    },
    // Kept as Blockly built-ins (don't redefine — preserves caller auto-sync).
    procedures_callnoreturn: builtinBlock(),
    procedures_callreturn: builtinBlock(),
    procedures_ifreturn: builtinBlock(),
  },

  generators: {
    procedures_defnoreturn: (block: Blockly.Block, ctx: GenContext) => {
      const params = paramNames(block);
      ctx.line(`def ${funcName(block)}(${params.join(", ")}):`, block.id);
      ctx.indented(() => {
        const before = ctx.linesEmitted();
        ctx.statement(block, "STACK");
        if (ctx.linesEmitted() === before) ctx.line("pass", block.id);
      });
    },

    procedures_defreturn: (block: Blockly.Block, ctx: GenContext) => {
      const params = paramNames(block);
      ctx.line(`def ${funcName(block)}(${params.join(", ")}):`, block.id);
      ctx.indented(() => {
        ctx.statement(block, "STACK");
        ctx.line(`return ${ctx.value(block, "RETURN", "None")}`, block.id);
      });
    },

    procedures_callnoreturn: (block: Blockly.Block, ctx: GenContext) => {
      ctx.line(`${funcName(block)}(${callArgs(block, ctx).join(", ")})`, block.id);
    },

    procedures_callreturn: (block: Blockly.Block, ctx: GenContext): string =>
      `${funcName(block)}(${callArgs(block, ctx).join(", ")})`,

    // "if <cond> return <value>" — early return. The VALUE input only exists
    // inside a value-returning function.
    procedures_ifreturn: (block: Blockly.Block, ctx: GenContext) => {
      ctx.line(`if ${ctx.value(block, "CONDITION", "False")}:`, block.id);
      ctx.indented(() => {
        if (block.getInput("VALUE")) ctx.line(`return ${ctx.value(block, "VALUE", "None")}`, block.id);
        else ctx.line("return", block.id);
      });
    },
  },
};
