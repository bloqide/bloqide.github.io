// Headless codegen check — proves simple vs scheduler mode without a browser.
// Run: npx tsx scripts/codegen.test.ts
import * as Blockly from "blockly";
import { CodeGen } from "../src/core/codegen";
import type { BlockDef, BlockGenerator, ValueGenerator } from "../src/core/types";
import { plugin as control } from "../plugins/core-control/index";
import { plugin as gpio } from "../plugins/core-gpio/index";
import board from "../boards/esp32-c3.json";

// Register block definitions (resolve the pin-dropdown token to real options).
const defs = new Map<string, BlockDef>();
const gens = new Map<string, BlockGenerator | ValueGenerator>();
for (const p of [control, gpio]) {
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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
