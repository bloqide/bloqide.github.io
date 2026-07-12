// Headless codegen check — proves simple vs scheduler mode without a browser.
// Run: npx tsx scripts/codegen.test.ts
import * as Blockly from "blockly";
import { CodeGen } from "../src/core/codegen";
import type { BlockDef, BlockGenerator, ValueGenerator } from "../src/core/types";
import { plugin as control } from "../plugins/core-control/index";
import { plugin as gpio } from "../plugins/core-gpio/index";
import { plugin as logic } from "../plugins/core-logic/index";
import { plugin as math } from "../plugins/core-math/index";
import { plugin as text } from "../plugins/core-text/index";
import { plugin as variables } from "../plugins/core-variables/index";
import { plugin as motors } from "../plugins/espbot-motors/index";
import { plugin as ble } from "../plugins/espbot-ble/index";
import board from "../boards/esp32-c3.json";

// Register block definitions (resolve the pin-dropdown token to real options).
const defs = new Map<string, BlockDef>();
const gens = new Map<string, BlockGenerator | ValueGenerator>();
for (const p of [control, gpio, logic, math, text, variables, motors, ble]) {
  for (const [type, def] of Object.entries(p.blocks)) {
    const json = JSON.parse(JSON.stringify(def.json));
    for (const k of Object.keys(json)) {
      if (!k.startsWith("args")) continue;
      for (const arg of json[k]) {
        if (arg.options === "$BOARD_DIGITAL_PINS") {
          arg.options = (board as any).pins.digital.map((n: number) => [`GPIO${n}`, String(n)]);
        }
      }
    }
    Blockly.common.defineBlocks(Blockly.common.createBlockDefinitionsFromJsonArray([json]));
    defs.set(type, def);
  }
  for (const [type, g] of Object.entries(p.generators)) gens.set(type, g);
}

function ws() {
  return new Blockly.Workspace();
}
function connectChain(hat: Blockly.Block, ...children: Blockly.Block[]) {
  let prev = hat;
  for (const c of children) {
    prev.nextConnection!.connect(c.previousConnection!);
    prev = c;
  }
}

let failures = 0;
function expect(name: string, code: string, mustInclude: string[], mustExclude: string[] = []) {
  const missing = mustInclude.filter((s) => !code.includes(s));
  const present = mustExclude.filter((s) => code.includes(s));
  if (missing.length || present.length) {
    failures++;
    console.log(`✗ ${name}`);
    if (missing.length) console.log(`   missing: ${missing.join(" | ")}`);
    if (present.length) console.log(`   should not contain: ${present.join(" | ")}`);
    console.log("   --- code ---\n" + code.replace(/^/gm, "   "));
  } else {
    console.log(`✓ ${name}`);
  }
}

const cg = () => new CodeGen(board as any, { defs, gens });

// --- Test 1: single hat -> SIMPLE mode (no scheduler, blocking sleep) ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const forever = w.newBlock("forever");
  const write = w.newBlock("gpio_write");
  write.setFieldValue("8", "PIN");
  write.setFieldValue("1", "VAL");
  const wait = w.newBlock("wait_ms");
  wait.setFieldValue("250", "MS");
  forever.getInput("DO")!.connection!.connect(write.previousConnection!);
  write.nextConnection!.connect(wait.previousConnection!);
  connectChain(hat, forever);

  const r = cg().generate(w);
  expect(
    "single hat => simple mode",
    r.code,
    ["while True:", "time.sleep_ms(250)", ".value(1)"],
    ["sched", "yield", "def stack_"]
  );
  console.assert(!r.schedulerMode, "expected simple mode");
  console.assert(!r.requiredLibraries.has("/lib/bloq.py"), "no runtime lib in simple mode");
}

// --- Test 2: two hats -> SCHEDULER mode (generators, cooperative wait) ---
{
  const w = ws();
  for (const _ of [0, 1]) {
    const hat = w.newBlock("when_started");
    const forever = w.newBlock("forever");
    const led = w.newBlock("gpio_toggle_led");
    const wait = w.newBlock("wait_ms");
    wait.setFieldValue("500", "MS");
    forever.getInput("DO")!.connection!.connect(led.previousConnection!);
    led.nextConnection!.connect(wait.previousConnection!);
    connectChain(hat, forever);
  }
  const r = cg().generate(w);
  expect(
    "two hats => scheduler mode",
    r.code,
    [
      "from bloq import sched",
      "def stack_1():",
      "def stack_2():",
      "yield from sched.sleep_ms(500)",
      "yield",
      "sched.spawn(stack_1)",
      "sched.spawn(stack_2)",
      "sched.run()",
    ],
    ["time.sleep_ms"]
  );
  console.assert(r.schedulerMode, "expected scheduler mode");
  console.assert(r.requiredLibraries.has("/lib/bloq.py"), "runtime lib required");
}

// --- Test 3: source map maps generated lines back to block ids ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const write = w.newBlock("gpio_write");
  write.setFieldValue("8", "PIN");
  write.setFieldValue("1", "VAL");
  connectChain(hat, write);
  const r = cg().generate(w);
  const lines = r.blockToLines.get(write.id) ?? [];
  const ok = lines.length > 0 && r.lineToBlock.get(lines[0]) === write.id;
  console.log(ok ? "✓ source map round-trips block<->line" : "✗ source map broken");
  if (!ok) failures++;
}

// --- Test 4: pin setup is deduped across multiple writes ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const a = w.newBlock("gpio_write");
  a.setFieldValue("8", "PIN");
  a.setFieldValue("1", "VAL");
  const b = w.newBlock("gpio_write");
  b.setFieldValue("8", "PIN");
  b.setFieldValue("0", "VAL");
  connectChain(hat, a, b);
  const r = cg().generate(w);
  const setupCount = (r.code.match(/= Pin\(8, Pin\.OUT\)/g) ?? []).length;
  const ok = setupCount === 1;
  console.log(ok ? "✓ pin setup deduped (1 init for 2 writes)" : `✗ pin setup not deduped (${setupCount})`);
  if (!ok) failures++;
}

// Helpers for value/statement inputs.
function plug(parent: Blockly.Block, input: string, child: Blockly.Block) {
  parent.getInput(input)!.connection!.connect(child.outputConnection!);
}
function body(parent: Blockly.Block, input: string, child: Blockly.Block) {
  parent.getInput(input)!.connection!.connect(child.previousConnection!);
}
function num(w: Blockly.Workspace, n: number) {
  const b = w.newBlock("math_number");
  b.setFieldValue(n, "NUM");
  return b;
}

// --- Test 5: if + comparison + math operators ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const iff = w.newBlock("if_do");
  const cmp = w.newBlock("logic_compare");
  cmp.setFieldValue(">", "OP");
  plug(cmp, "A", num(w, 5));
  plug(cmp, "B", num(w, 3));
  plug(iff, "COND", cmp);
  body(iff, "DO", w.newBlock("gpio_toggle_led"));
  connectChain(hat, iff);
  expect("if + comparison", cg().generate(w).code, ["if (5 > 3):", ".value(not "]);
}

// --- Test 6: repeat until <bool> ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const loop = w.newBlock("repeat_while");
  loop.setFieldValue("until", "MODE");
  plug(loop, "COND", w.newBlock("logic_boolean")); // default True
  body(loop, "DO", w.newBlock("gpio_toggle_led"));
  connectChain(hat, loop);
  expect("repeat until", cg().generate(w).code, ["while not (True):"]);
}

// --- Test 7: wait until — simple busy-poll vs cooperative yield ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const wu = w.newBlock("wait_until");
  const cmp = w.newBlock("logic_compare");
  cmp.setFieldValue("<", "OP");
  plug(cmp, "A", num(w, 1));
  plug(cmp, "B", num(w, 2));
  plug(wu, "COND", cmp);
  connectChain(hat, wu);
  expect("wait until (simple)", cg().generate(w).code, ["while not ((1 < 2)):"], ["sched.wait_until"]);
}
{
  const w = ws();
  for (const _ of [0, 1]) {
    const hat = w.newBlock("when_started"); // two hats -> scheduler mode
    const wu = w.newBlock("wait_until");
    plug(wu, "COND", w.newBlock("logic_boolean")); // True
    connectChain(hat, wu);
  }
  expect("wait until (scheduler)", cg().generate(w).code, ["yield from sched.wait_until(lambda: True)"]);
}

// --- Test 8: print text to terminal ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const pr = w.newBlock("print_terminal");
  const lit = w.newBlock("text_literal");
  lit.setFieldValue("Hello!", "TEXT");
  plug(pr, "MSG", lit);
  connectChain(hat, pr);
  expect("print to terminal", cg().generate(w).code, ['print("Hello!")']);
}

// --- Test 9: nested arithmetic preserves precedence via parens ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const pr = w.newBlock("print_terminal");
  const add = w.newBlock("math_arithmetic");
  add.setFieldValue("+", "OP");
  const mul = w.newBlock("math_arithmetic");
  mul.setFieldValue("*", "OP");
  plug(mul, "A", num(w, 3));
  plug(mul, "B", num(w, 4));
  plug(add, "A", num(w, 2));
  plug(add, "B", mul);
  plug(pr, "MSG", add);
  connectChain(hat, pr);
  expect("nested arithmetic", cg().generate(w).code, ["print((2 + (3 * 4)))"]);
}

// --- Test 10: for_range over a variable (inclusive) ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const loop = w.newBlock("for_range");
  plug(loop, "FROM", num(w, 1));
  plug(loop, "TO", num(w, 5));
  body(loop, "DO", w.newBlock("gpio_toggle_led"));
  connectChain(hat, loop);
  expect("for range (inclusive)", cg().generate(w).code, ["for i in range(1, (5) + 1):"]);
}

// --- Test 11: wait seconds — value input, simple (blocking) vs scheduler ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const wsec = w.newBlock("wait_seconds");
  plug(wsec, "SEC", num(w, 2)); // value input accepts a plugged block
  connectChain(hat, wsec);
  expect("wait seconds (simple)", cg().generate(w).code, ["time.sleep(2)"], ["sched"]);
}
{
  const w = ws();
  for (const _ of [0, 1]) {
    const hat = w.newBlock("when_started"); // two hats -> scheduler
    const wsec = w.newBlock("wait_seconds"); // empty SEC -> fallback 1
    connectChain(hat, wsec);
  }
  expect("wait seconds (scheduler)", cg().generate(w).code, ["yield from sched.sleep_ms(1000)"]);
}

// --- Test 12: on setup declares a global shared across scheduler stacks ---
{
  const w = ws();
  const setup = w.newBlock("on_setup");
  const init = w.newBlock("variables_set");
  plug(init, "VALUE", num(w, 0));
  connectChain(setup, init);
  const gvar = init.getField("VAR")!.getText(); // default variable name
  for (const _ of [0, 1]) {
    const hat = w.newBlock("when_started"); // two run hats -> scheduler mode
    const chg = w.newBlock("math_change");
    plug(chg, "DELTA", num(w, 1));
    connectChain(hat, chg);
  }
  const r = cg().generate(w);
  expect("setup global shared across stacks", r.code, [
    `${gvar} = 0`, // module-level init from on_setup
    `global ${gvar}`, // stack declares it before writing
    `${gvar} = ${gvar} + 1`, // math_change rebinds it
  ]);
  console.assert(r.schedulerMode, "setup + 2 run hats => scheduler");
}

// --- Test 13: unknown block is reported (id + comment) ---
{
  Blockly.common.defineBlocks(
    Blockly.common.createBlockDefinitionsFromJsonArray([
      { type: "mystery", message0: "mystery", previousStatement: null, nextStatement: null },
    ])
  );
  const w = ws();
  const hat = w.newBlock("when_started");
  const mystery = w.newBlock("mystery");
  connectChain(hat, mystery);
  const r = cg().generate(w);
  const ok = r.unknownBlocks.includes(mystery.id) && r.code.includes("# [unknown block: mystery]");
  console.log(ok ? "✓ unknown block reported" : "✗ unknown block not reported");
  if (!ok) failures++;
}

// --- Test 14: boolean xor lowers to a truthiness comparison ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const pr = w.newBlock("print_terminal");
  const xor = w.newBlock("logic_operation");
  xor.setFieldValue("xor", "OP");
  plug(xor, "A", w.newBlock("logic_boolean")); // True
  plug(xor, "B", w.newBlock("logic_boolean")); // True
  plug(pr, "MSG", xor);
  connectChain(hat, pr);
  expect("boolean xor", cg().generate(w).code, ["print((bool(True) != bool(True)))"]);
}

// --- Test 15: for..from..while — init + custom stop test, no auto-increment ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const loop = w.newBlock("for_while");
  plug(loop, "FROM", num(w, 0));
  loop.setFieldValue("while", "MODE");
  const cmp = w.newBlock("logic_compare");
  cmp.setFieldValue("<", "OP");
  plug(cmp, "A", num(w, 0));
  plug(cmp, "B", num(w, 10));
  plug(loop, "COND", cmp);
  body(loop, "DO", w.newBlock("gpio_toggle_led"));
  connectChain(hat, loop);
  expect("for..from..while", cg().generate(w).code, ["i = 0", "while (0 < 10):", ".value(not "], [
    "i = i + 1",
  ]);
}

// --- Test 16: bitwise operators ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const pr = w.newBlock("print_terminal");
  const band = w.newBlock("math_bitwise");
  band.setFieldValue("&", "OP");
  plug(band, "A", num(w, 6));
  const inv = w.newBlock("math_bitnot");
  plug(inv, "A", num(w, 3));
  plug(band, "B", inv);
  plug(pr, "MSG", band);
  connectChain(hat, pr);
  expect("bitwise and + invert", cg().generate(w).code, ["print((6 & (~3)))"]);
}

// --- Test 17: random integer in a range (inclusive, imports random) ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const pr = w.newBlock("print_terminal");
  const rnd = w.newBlock("math_random_int");
  plug(rnd, "LOW", num(w, 1));
  plug(rnd, "HIGH", num(w, 10));
  plug(pr, "MSG", rnd);
  connectChain(hat, pr);
  const r = cg().generate(w);
  expect("random integer", r.code, ["import random", "print(random.randint(1, 10))"]);
}

// --- Test 18: variadic text join with +/- mutator (default 2 slots) ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const pr = w.newBlock("print_terminal");
  const join = w.newBlock("text_join"); // mutator installs ADD0, ADD1
  const lit = w.newBlock("text_literal");
  lit.setFieldValue("n=", "TEXT");
  plug(join, "ADD0", lit);
  plug(join, "ADD1", num(w, 5));
  plug(pr, "MSG", join);
  connectChain(hat, pr);
  expect("variadic text join", cg().generate(w).code, ['print((str("n=") + str(5)))']);
}
// A third slot added via the mutator lands in the generated join.
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const pr = w.newBlock("print_terminal");
  const join = w.newBlock("text_join") as any;
  join.plus_(); // now 3 slots
  plug(join, "ADD0", num(w, 1));
  plug(join, "ADD1", num(w, 2));
  plug(join, "ADD2", num(w, 3));
  plug(pr, "MSG", join);
  connectChain(hat, pr);
  expect("text join +1 slot", cg().generate(w).code, ["print((str(1) + str(2) + str(3)))"]);
}

// --- Test 19: text field \n / \t become real control chars; newline block ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const pr = w.newBlock("print_terminal");
  const lit = w.newBlock("text_literal");
  lit.setFieldValue("a\\nb", "TEXT"); // user typed: a\nb
  plug(pr, "MSG", lit);
  connectChain(hat, pr);
  // Generated Python literal carries a real \n escape, not \\n.
  expect("text escape -> real newline", cg().generate(w).code, ['print("a\\nb")']);
}
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const pr = w.newBlock("print_terminal");
  plug(pr, "MSG", w.newBlock("text_newline"));
  connectChain(hat, pr);
  expect("newline block", cg().generate(w).code, ['print("\\n")']);
}

// --- Test 20: fixed two-slot join (label + value) ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const pr = w.newBlock("print_terminal");
  const join = w.newBlock("text_join2");
  const lit = w.newBlock("text_literal");
  lit.setFieldValue("x=", "TEXT");
  plug(join, "A", lit);
  plug(join, "B", num(w, 5));
  plug(pr, "MSG", join);
  connectChain(hat, pr);
  expect("two-slot join", cg().generate(w).code, ['print((str("x=") + str(5)))']);
}

// --- Test 21: comment block emits # lines ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const c = w.newBlock("comment");
  c.setFieldValue("explain this\nsecond line", "TEXT");
  const led = w.newBlock("gpio_toggle_led");
  connectChain(hat, c, led);
  expect("comment block", cg().generate(w).code, ["# explain this", "# second line", ".value(not "]);
}

// --- Test 22: EspBot motor block emits driver call + ships the library ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const m = w.newBlock("motor_spin");
  m.setFieldValue("EspBot.MotorLeft", "MOTOR");
  m.setFieldValue("EspBot.Forward", "DIR");
  plug(m, "SPEED", num(w, 50));
  connectChain(hat, m);
  const r = cg().generate(w);
  expect("motor spin", r.code, [
    "import espbot",
    "from espbot import EspBot",
    "espbot.motors.spin(EspBot.MotorLeft, EspBot.Forward, 50)",
  ]);
  console.assert(r.requiredLibraries.has("/lib/espbot.py"), "espbot.py required");
}

// --- Test 23: BLE controller-pad value block + library ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const pr = w.newBlock("print_terminal");
  const btn = w.newBlock("ble_button"); // defaults: up / pressed
  plug(pr, "MSG", btn);
  connectChain(hat, pr);
  const r = cg().generate(w);
  expect("ble controller pad", r.code, [
    "import bleuart",
    "from bleuart import BleControlPad",
    "print((bleuart.controlPad.isButtonPressed(BleControlPad.ButtonUp) == True))",
  ]);
  console.assert(r.requiredLibraries.has("/lib/bleuart.py"), "bleuart.py required");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
