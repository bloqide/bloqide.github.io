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
import { plugin as motors } from "../boards/espbot2-ble/plugins/motors/index";
import { plugin as ble } from "../boards/espbot2-ble/plugins/ble/index";
import { plugin as neopixel } from "../plugins/core-neopixel/index";
import { plugin as sensors } from "../plugins/core-sensors/index";
import { plugin as functions } from "../plugins/core-functions/index";
import board from "../boards/esp32-c3/esp32-c3.json";

// Register block definitions (resolve the pin-dropdown tokens to real options).
const pinTokens: Record<string, number[]> = {
  $BOARD_OUTPUT_PINS: (board as any).pins.digital,
  $BOARD_INPUT_PINS: (board as any).pins.digital,
  $BOARD_ANALOG_PINS: (board as any).pins.analog,
  $BOARD_PWM_PINS: (board as any).pins.pwm,
};
const defs = new Map<string, BlockDef>();
const gens = new Map<string, BlockGenerator | ValueGenerator>();
for (const p of [control, gpio, logic, math, text, variables, functions, motors, ble, neopixel, sensors]) {
  for (const [type, def] of Object.entries(p.blocks)) {
    if (!def.builtin) {
      // builtin blocks (Blockly's procedure call/if-return) keep their own defs
      const json = JSON.parse(JSON.stringify(def.json));
      for (const k of Object.keys(json)) {
        if (!k.startsWith("args")) continue;
        for (const arg of json[k]) {
          if (typeof arg.options === "string" && arg.options in pinTokens) {
            arg.options = pinTokens[arg.options].map((n) => [`GPIO${n}`, String(n)]);
          }
        }
      }
      Blockly.common.defineBlocks(Blockly.common.createBlockDefinitionsFromJsonArray([json]));
    }
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

// --- Test 24: if / else-if / else via the mutator ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const iff = w.newBlock("if_else") as any;
  iff.plus_(); // add one else-if clause -> IF1 / THEN1
  const c0 = w.newBlock("logic_compare");
  c0.setFieldValue(">", "OP");
  plug(c0, "A", num(w, 5));
  plug(c0, "B", num(w, 3));
  plug(iff, "COND", c0);
  body(iff, "DO", w.newBlock("gpio_toggle_led"));
  const c1 = w.newBlock("logic_compare");
  c1.setFieldValue("<", "OP");
  plug(c1, "A", num(w, 1));
  plug(c1, "B", num(w, 2));
  plug(iff, "IF1", c1);
  body(iff, "THEN1", w.newBlock("gpio_toggle_led"));
  connectChain(hat, iff);
  expect("if / elif / else", cg().generate(w).code, [
    "if (5 > 3):",
    "elif (1 < 2):",
    "else:",
  ]);
}

// --- Test 25: digital read / button / analog read / PWM ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const pwm = w.newBlock("gpio_pwm");
  pwm.setFieldValue("5", "PIN");
  plug(pwm, "DUTY", num(w, 50));
  const p1 = w.newBlock("print_terminal");
  const rd = w.newBlock("gpio_read");
  rd.setFieldValue("8", "PIN");
  plug(p1, "MSG", rd);
  const p2 = w.newBlock("print_terminal");
  const btn = w.newBlock("gpio_button");
  btn.setFieldValue("9", "PIN");
  plug(p2, "MSG", btn);
  const p3 = w.newBlock("print_terminal");
  const an = w.newBlock("gpio_analog_read");
  an.setFieldValue("0", "PIN");
  plug(p3, "MSG", an);
  connectChain(hat, pwm, p1, p2, p3);
  expect("gpio read / button / analog / pwm", cg().generate(w).code, [
    "pin_8_in = Pin(8, Pin.IN)",
    "print(pin_8_in.value())",
    "pin_9_in_pull_up = Pin(9, Pin.IN, Pin.PULL_UP)",
    "print((pin_9_in_pull_up.value() == 0))",
    "adc_0 = ADC(Pin(0))",
    "print(adc_0.read_u16())",
    "pwm_5 = PWM(Pin(5))",
    "pwm_5.freq(1000)",
    "pwm_5.duty_u16(int(50 * 65535 / 100))",
  ]);
}

// --- Test 26: set-pin variants — value, and dynamic pin+value ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const wv = w.newBlock("gpio_write_value");
  wv.setFieldValue("8", "PIN");
  plug(wv, "VALUE", num(w, 1));
  const wd = w.newBlock("gpio_write_dynamic");
  plug(wd, "PIN", num(w, 4));
  plug(wd, "VALUE", num(w, 0));
  connectChain(hat, wv, wd);
  expect("set pin (value / dynamic)", cg().generate(w).code, [
    "pin_8_out = Pin(8, Pin.OUT)",
    "pin_8_out.value(1)",
    "Pin(4, Pin.OUT).value(0)",
  ]);
}

// --- Test 27: NeoPixel setup / colour / set / fill / show ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const setup = w.newBlock("neopixel_setup");
  setup.setFieldValue("4", "PIN");
  setup.setFieldValue(10, "COUNT");
  const set = w.newBlock("neopixel_set");
  set.setFieldValue("4", "PIN");
  plug(set, "INDEX", num(w, 0));
  const col = w.newBlock("neopixel_colour");
  plug(col, "R", num(w, 255));
  plug(col, "G", num(w, 0));
  plug(col, "B", num(w, 0));
  plug(set, "COLOR", col);
  const show = w.newBlock("neopixel_show");
  show.setFieldValue("4", "PIN");
  connectChain(hat, setup, set, show);
  expect("neopixel", cg().generate(w).code, [
    "from neopixel import NeoPixel",
    "np_4 = NeoPixel(Pin(4), 10)",
    "np_4[0] = (255, 0, 0)",
    "np_4.write()",
  ]);
}

// --- Test 28: ultrasonic sensor read ships the driver ---
{
  const w = ws();
  const hat = w.newBlock("when_started");
  const pr = w.newBlock("print_terminal");
  const us = w.newBlock("ultrasonic_read");
  plug(us, "TRIG", num(w, 2));
  plug(us, "ECHO", num(w, 3));
  plug(pr, "MSG", us);
  connectChain(hat, pr);
  const r = cg().generate(w);
  expect("ultrasonic read", r.code, ["import Ultrasonic", "print(Ultrasonic.read(2, 3))"]);
  console.assert(r.requiredLibraries.has("/lib/Ultrasonic.py"), "Ultrasonic.py required");
}

// --- Test 29: user function definition emits a module-level def, called from a
// stack, without forcing scheduler mode. Uses synthetic procedure-def/-call
// blocks (real Blockly blocks + injected defs/gens) to exercise codegen's
// procedure pass independent of Blockly's built-in procedure internals. ---
{
  Blockly.common.defineBlocks(
    Blockly.common.createBlockDefinitionsFromJsonArray([
      { type: "test_fndef", message0: "define %1", args0: [{ type: "input_statement", name: "STACK" }], colour: 290 },
      { type: "test_fncall", message0: "call greet", previousStatement: null, nextStatement: null, colour: 290 },
    ])
  );
  defs.set("test_fndef", { json: {}, procedure: true });
  gens.set("test_fndef", (b, ctx) => {
    ctx.line("def greet(name):", b.id);
    ctx.indented(() => {
      const before = ctx.linesEmitted();
      ctx.statement(b, "STACK");
      if (ctx.linesEmitted() === before) ctx.line("pass", b.id);
    });
  });
  defs.set("test_fncall", { json: {} });
  gens.set("test_fncall", (b, ctx) => ctx.line('greet("hi")', b.id));

  const w = ws();
  const def = w.newBlock("test_fndef");
  body(def, "STACK", w.newBlock("gpio_toggle_led"));
  const hat = w.newBlock("when_started");
  connectChain(hat, w.newBlock("test_fncall"));
  const r = cg().generate(w);
  expect("function def -> module def, called from stack (simple mode)", r.code, ["def greet(name):", 'greet("hi")'], [
    "sched.spawn",
    "# (empty program)",
  ]);
  console.assert(r.code.indexOf("def greet") < r.code.indexOf('greet("hi")'), "def must precede its call");
}

// --- Test 30: the real core-functions generators (fake block + ctx) ---
function fnCtx(values: Record<string, string> = {}, bodyLines = 0) {
  const lines: string[] = [];
  let indent = 0;
  const ctx = {
    line: (t: string) => lines.push("    ".repeat(indent) + t),
    indented: (fn: () => void) => {
      indent++;
      try {
        fn();
      } finally {
        indent--;
      }
    },
    statement: () => {
      for (let i = 0; i < bodyLines; i++) lines.push("    ".repeat(indent) + "BODY");
    },
    value: (_b: unknown, name: string, fb: string) => values[name] ?? fb,
    linesEmitted: () => lines.length,
  } as unknown as import("../src/core/types").GenContext;
  return { ctx, lines };
}
const fnGen = functions.generators as Record<string, any>;
{
  // def, no return: name + params sanitised & deduped; empty body -> pass
  const { ctx, lines } = fnCtx({}, 0);
  fnGen.procedures_defnoreturn(
    {
      id: "d",
      getFieldValue: (f: string) => (f === "NAME" ? "add nums" : null),
      getVars: () => ["x", "y"],
      getInput: (n: string) => (n === "STACK" ? {} : null),
    },
    ctx
  );
  expect("fn def: sanitised name/params + empty-body pass", lines.join("\n"), ["def add_nums(x, y):", "    pass"]);
}
{
  // duplicate params after sanitising get suffixed
  const { ctx, lines } = fnCtx({}, 0);
  fnGen.procedures_defnoreturn(
    {
      id: "d",
      getFieldValue: (f: string) => (f === "NAME" ? "f" : null),
      getVars: () => ["a b", "a-b"],
      getInput: (n: string) => (n === "STACK" ? {} : null),
    },
    ctx
  );
  expect("fn def: duplicate params deduped", lines.join("\n"), ["def f(a_b, a_b2):"]);
}
{
  // def with return
  const { ctx, lines } = fnCtx({ RETURN: "x + y" }, 1);
  fnGen.procedures_defreturn(
    {
      id: "d",
      getFieldValue: (f: string) => (f === "NAME" ? "total" : null),
      getVars: () => ["x", "y"],
      getInput: () => ({}),
    },
    ctx
  );
  expect("fn def: return value", lines.join("\n"), ["def total(x, y):", "    return x + y"]);
}
{
  // call, no return (statement)
  const { ctx, lines } = fnCtx({ ARG0: "1", ARG1: "2" });
  fnGen.procedures_callnoreturn(
    {
      id: "c",
      getFieldValue: (f: string) => (f === "NAME" ? "greet" : null),
      getInput: (n: string) => (n === "ARG0" || n === "ARG1" ? {} : null),
    },
    ctx
  );
  expect("fn call (statement): args passed", lines.join("\n"), ["greet(1, 2)"]);
}
{
  // call with return (value) -> returns an expression string
  const { ctx } = fnCtx({ ARG0: "3", ARG1: "5" });
  const out = fnGen.procedures_callreturn(
    {
      getFieldValue: (f: string) => (f === "NAME" ? "add" : null),
      getInput: (n: string) => (n === "ARG0" || n === "ARG1" ? {} : null),
    },
    ctx
  );
  expect("fn call (value): returns expression", String(out), ["add(3, 5)"]);
}
{
  // if-return with a value (inside a value-returning function)
  const { ctx, lines } = fnCtx({ CONDITION: "x > 0", VALUE: "x" });
  fnGen.procedures_ifreturn({ id: "r", getInput: (n: string) => (n === "VALUE" ? {} : null) }, ctx);
  expect("fn if-return: with value", lines.join("\n"), ["if x > 0:", "    return x"]);
}
{
  // if-return without a value (inside a void function) — bare `return`, not `return None`
  const { ctx, lines } = fnCtx({ CONDITION: "done" });
  fnGen.procedures_ifreturn({ id: "r", getInput: () => null }, ctx);
  expect("fn if-return: no value -> bare return", lines.join("\n"), ["if done:", "    return"], ["return None"]);
}
{
  // unconditional return with a value
  const { ctx, lines } = fnCtx({ VALUE: "x + 1" });
  fnGen.procedures_return({ id: "r", getInputTargetBlock: (n: string) => (n === "VALUE" ? {} : null) }, ctx);
  expect("fn return: with value", lines.join("\n"), ["return x + 1"]);
}
{
  // unconditional return, empty slot -> bare `return`, not `return None`
  const { ctx, lines } = fnCtx({});
  fnGen.procedures_return({ id: "r", getInputTargetBlock: () => null }, ctx);
  expect("fn return: empty -> bare return", lines.join("\n"), ["return"], ["return None"]);
}
// Real block: a return block inside a function body emits `return <value>`, and
// its value slot shows/hides with the enclosing function's return-ness.
{
  const w = ws();
  const def = w.newBlock("procedures_defreturn") as any;
  def.setFieldValue("compute", "NAME");
  const ret = w.newBlock("procedures_return") as any;
  body(def, "STACK", ret);
  ret.onchange({});
  const slotShown = (b: any) => !!(b.getInput("VALUE") && b.getInput("VALUE").connection);
  console.assert(slotShown(ret), "value slot shown inside a value-returning function");
  plug(ret, "VALUE", num(w, 5));
  expect("real return block in function body", cg().generate(w).code, ["def compute():", "    return 5"]);
}
{
  // Inside a no-value function, the value slot is removed (like if-return).
  const w = ws();
  const def = w.newBlock("procedures_defnoreturn") as any;
  def.setFieldValue("blink", "NAME");
  const ret = w.newBlock("procedures_return") as any;
  body(def, "STACK", ret);
  ret.onchange({});
  console.assert(!(ret.getInput("VALUE") && ret.getInput("VALUE").connection), "value slot hidden in void function");
  expect("return in void function -> bare return", cg().generate(w).code, ["def blink():", "    return"], ["return None"]);
}

// --- Test 31: the REAL custom definition block — inline +/- params, built-in
// caller auto-sync (Blockly.Procedures.mutateCallers), serialization, codegen ---
{
  const w = ws();
  const def = w.newBlock("procedures_defnoreturn") as any;
  def.setFieldValue("greet", "NAME");
  def.addParam_(); // inline "+" -> param "x"
  def.addParam_(); // inline "+" -> param "y"
  console.assert(def.getVars().join(",") === "x,y", "two inline params");
  console.assert(!!def.getField("P0") && !!def.getField("P1"), "param fields rendered inline");

  const call = w.newBlock("procedures_callnoreturn") as any;
  call.setFieldValue("greet", "NAME");
  Blockly.Procedures.mutateCallers(def); // built-in caller must gain 2 arg slots
  const argN = call.inputList.map((i: any) => i.name).filter((n: string) => /^ARG\d+$/.test(n));
  console.assert(argN.length === 2, `caller synced to 2 args, got ${argN.length}`);

  // Serialization round-trips the params.
  const saved = Blockly.serialization.workspaces.save(w);
  const w2 = new Blockly.Workspace();
  Blockly.serialization.workspaces.load(saved, w2);
  const def2 = w2.getBlocksByType("procedures_defnoreturn", false)[0] as any;
  console.assert(def2 && def2.getVars().join(",") === "x,y", "params survive save/load");

  // Codegen over the real blocks.
  body(def, "STACK", w.newBlock("gpio_toggle_led"));
  const hat = w.newBlock("when_started");
  connectChain(hat, call);
  plug(call, "ARG0", num(w, 1));
  plug(call, "ARG1", num(w, 2));
  expect("real function block: def(params) + synced call", cg().generate(w).code, [
    "def greet(x, y):",
    "greet(1, 2)",
  ]);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
