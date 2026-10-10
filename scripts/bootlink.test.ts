/*
 * Bloq — offline block-based MicroPython IDE
 * Copyright (C) 2026 Benjamin Balga
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Headless check for the boot.py edit that turns the Bluetooth upload link on
// and off (bootLinkScript in src/serial/serialService.ts). The generated device
// script is plain Python, so it runs here under CPython against a temp boot.py:
// the block is added once, removed cleanly, never rewritten without a change,
// and the user's own boot.py lines always survive.
//
// Run: npx tsx scripts/bootlink.test.ts   (needs python3)

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootLinkScript } from "../src/serial/serialService";

const dir = mkdtempSync(join(tmpdir(), "bloq-bootlink-"));
const boot = join(dir, "boot.py");
writeFileSync(join(dir, "on.py"), bootLinkScript(true, boot));
writeFileSync(join(dir, "off.py"), bootLinkScript(false, boot));

const checks = String.raw`
import os, sys
d = sys.argv[1]; bp = os.path.join(d, "boot.py")
ON = open(os.path.join(d, "on.py")).read(); OFF = open(os.path.join(d, "off.py")).read()
failed = 0
def check(name, cond, detail=""):
    global failed
    print(("  PASS  " if cond else "  FAIL  ") + name + (("  -- " + detail) if detail else ""))
    failed += not cond
def run(src): exec(src, {})
def rd(): return open(bp).read() if os.path.exists(bp) else None
def mt(): return os.stat(bp).st_mtime_ns
DEFAULT = "# This file is executed on every boot (including wake-boot from deepsleep)\n#import esp\n#esp.osdebug(None)\n#import webrepl\n#webrepl.start()\n"

run(OFF); check("off on a board without boot.py creates nothing", rd() is None)
run(ON); b = rd()
check("on creates boot.py holding just the block", b.startswith("# >>> bloq-ble-link") and b.endswith("# <<< bloq-ble-link\n"), repr(b))
compile(b, "boot.py", "exec"); check("the result is valid Python", True)
m = mt(); run(ON); check("on again leaves the file untouched", rd() == b and mt() == m)
run(OFF); check("off strips it back to empty", rd() == "", repr(rd()))

open(bp, "w").write(DEFAULT)
run(ON); b = rd()
check("on appends after the stock boot.py", b.startswith(DEFAULT) and "bloq_link.start()" in b)
compile(b, "boot.py", "exec")
run(OFF); check("off restores the stock boot.py byte for byte", rd() == DEFAULT, repr(rd()))
m = mt(); run(OFF); check("off again leaves the file untouched", mt() == m)

open(bp, "w").write(DEFAULT)
run(ON); open(bp, "a").write("print('user line')\n")
run(OFF); check("user lines after the block survive its removal", rd() == DEFAULT + "print('user line')\n", repr(rd()))
run(ON); run(ON); check("the block is never added twice", rd().count("bloq-ble-link") == 2)
print(); print(("%d FAILED" % failed) if failed else "ALL PASS"); sys.exit(1 if failed else 0)
`;

console.log(execFileSync("python3", ["-I", "-c", checks, dir], { encoding: "utf8" }));
