# Bloq — offline block-based MicroPython IDE
# Copyright (C) 2026 Benjamin Balga
# SPDX-License-Identifier: GPL-3.0-or-later

"""On-hardware check for the Bluetooth upload link, end to end.

Needs a real board with Bluetooth (ESP32 family) on USB, and this computer's
Bluetooth. It does over USB what the IDE does (sync the link libraries, edit
boot.py with the IDE's own generated script), then talks to the board over
Bluetooth exactly like src/serial/blePort.ts + SerialService: same service,
180-byte writes with response, the empty hello write, raw-paste with flow
control. Re-run it after a MicroPython update, or to qualify a new board.

What it checks:
  1. link on: the board boots with the link and still runs main.py
  2. Bluetooth: found by the link's service UUID, program output streams while
     it runs, Ctrl-C stops it, a raw-paste upload returns the right
     stdout/stderr (and its speed), a soft reboot drops the link and it comes
     back (reconnect time)
  3. a user program's Bluetooth UART (bleuart gamepad) running alongside: the
     board advertises under the program's name, the IDE isn't counted as a
     gamepad connection, Ctrl-C still works
  4. link off: boot.py stripped, board boots without Bluetooth (not advertising)

The board's main.py and boot.py are backed up first and restored at the end,
even on failure. Other files the test syncs to /lib are left (the IDE re-syncs
by its manifest anyway).

Setup (once, any venv):  pip install mpremote bleak pyserial
Run:  python3 scripts/blelink.hw.py --port /dev/cu.usbmodem101
(also needs npx/tsx from this repo's node_modules, to generate the boot.py edit)
On macOS the terminal app needs Bluetooth permission the first time.
"""
import argparse
import asyncio
import os
import subprocess
import sys
import tempfile
import time

import serial
from bleak import BleakClient, BleakScanner

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SVC = "41f20001-bd16-41bb-bf93-e98d477f33a8"
RX = "41f20002-bd16-41bb-bf93-e98d477f33a8"
TX = "41f20003-bd16-41bb-bf93-e98d477f33a8"
CHUNK = 180  # same as blePort.ts
LIBS = ["src/runtime/bloq_ble.py", "src/runtime/bloq_link.py", "plugins/core-ble/lib/bleuart.py"]

TICK_MAIN = """import time
n = 0
while True:
    print("tick", n)
    n += 1
    time.sleep(1)
"""
PAD_MAIN = """import bleuart, time
bleuart.controlPad.begin(name="EspBot")
n = 0
while True:
    print("pad", bleuart.controlPad.isConnected(), n)
    n += 1
    time.sleep(1)
"""


def check(name, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + name + (("  -- " + detail) if detail else ""))
    if not cond:
        check.failed += 1


check.failed = 0


# ---- USB side ---------------------------------------------------------------
class Usb:
    def __init__(self, port, tmp):
        self.port, self.tmp = port, tmp

    def mp(self, *args, check_rc=True, tries=3):
        # Retried: entering the raw REPL now and then misses a busy-printing program.
        for attempt in range(tries):
            r = subprocess.run(
                [sys.executable, "-m", "mpremote", "connect", self.port, *args], capture_output=True, text=True
            )
            if not r.returncode:
                return r
            time.sleep(1)
        if check_rc:
            raise RuntimeError(f"mpremote {' '.join(args)}: {r.stderr.strip().splitlines()[-1]}")
        return r

    def exists(self, path):
        r = self.mp("exec", f"import os\ntry:\n os.stat({path!r});print('yes')\nexcept OSError:\n print('no')")
        return r.stdout.strip().endswith("yes")

    def put(self, text, dest):
        local = os.path.join(self.tmp, "upload.py")
        with open(local, "w") as f:
            f.write(text)
        self.mp("cp", local, ":" + dest)

    def boot_link(self, enable):
        """Run the IDE's own boot.py edit (bootLinkScript) on the board."""
        js = (
            'import("./src/serial/serialService.ts")'
            f".then(m => process.stdout.write(m.bootLinkScript({'true' if enable else 'false'})))"
        )
        script = subprocess.run(["npx", "tsx", "-e", js], cwd=ROOT, capture_output=True, text=True, check=True)
        self.put(script.stdout, "/tmp_bootlink.py")
        self.mp("exec", "exec(open('/tmp_bootlink.py').read())")
        self.mp("rm", ":/tmp_bootlink.py")

    def reboot_and_read(self, seconds):
        """Soft-reboot from the friendly REPL (like the IDE's Run) so boot.py AND
        main.py run, and return what the board prints. The port opens with
        pyserial's default line states: forcing DTR/RTS low before open passes
        through DTR low + RTS high, which on the ESP32-C3's native USB is the
        hard-reset sequence (and the board then ignored USB input)."""
        s = serial.Serial(self.port, 115200, timeout=0.1)
        try:
            s.write(b"\x03\x03\x02")
            time.sleep(0.3)
            s.read(10000)
            s.write(b"\x04")
            out, end = b"", time.time() + seconds
            while time.time() < end:
                out += s.read(1000)
            return out.decode(errors="replace")
        finally:
            s.close()


# ---- Bluetooth side (mirrors blePort.ts + SerialService's raw-REPL driver) -----
class Link:
    def __init__(self):
        self.rx = bytearray()
        self.c = None

    async def connect(self, dev):
        self.c = BleakClient(dev)
        await self.c.connect()
        await self.c.start_notify(TX, lambda _, d: self.rx.extend(d))
        await self.c.write_gatt_char(RX, b"", response=True)  # hello: marks us as the IDE

    async def send(self, data):
        for i in range(0, len(data), CHUNK):
            await self.c.write_gatt_char(RX, data[i : i + CHUNK], response=True)

    async def wait_for(self, token, timeout=5.0):
        end = time.time() + timeout
        while token not in self.rx:
            if time.time() > end:
                raise TimeoutError(f"waiting for {token!r}; got {bytes(self.rx[-200:])!r}")
            await asyncio.sleep(0.01)

    async def take(self, n, timeout=5.0):
        end = time.time() + timeout
        while len(self.rx) < n:
            if time.time() > end:
                raise TimeoutError(f"wanted {n} bytes; got {bytes(self.rx)!r}")
            await asyncio.sleep(0.005)
        out = bytes(self.rx[:n])
        del self.rx[:n]
        return out

    async def exec_raw(self, code):
        """SerialService.execRaw over raw-paste. Returns (window, stdout, stderr)."""
        await self.send(b"\x03\x03")
        await asyncio.sleep(0.2)
        self.rx.clear()
        await self.send(b"\x01")
        await self.wait_for(b"raw REPL; CTRL-B to exit\r\n>")
        self.rx.clear()
        await self.send(b"\x05A\x01")
        if await self.take(2) != b"R\x01":
            raise RuntimeError("raw-paste not supported")
        w = await self.take(2)
        win = remain = w[0] | (w[1] << 8)
        i = 0
        while i < len(code):
            while remain == 0 or self.rx:
                b = (await self.take(1))[0]
                if b == 1:
                    remain += win
                else:
                    raise RuntimeError(f"device sent {b} during paste")
            chunk = code[i : i + remain]
            await self.send(chunk)
            remain -= len(chunk)
            i += len(chunk)
        await self.send(b"\x04")
        while await self.take(1) != b"\x04":  # skip late window increments
            pass
        end = time.time() + 10
        while self.rx.count(b"\x04") < 2:
            if time.time() > end:
                raise TimeoutError(bytes(self.rx))
            await asyncio.sleep(0.01)
        out, err = bytes(self.rx).split(b"\x04")[:2]
        await self.send(b"\x02")
        return win, out.decode(), err.decode()


async def scan_link(timeout=8.0):
    """Boards advertising the link service -> [(device, advertised name)]."""
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    return [(d, ad.local_name) for d, ad in found.values() if SVC in [u.lower() for u in ad.service_uuids]]


async def bluetooth_checks():
    print("\n-- 2. over Bluetooth --")
    t = time.time()
    found = await scan_link()
    check("board found by the link's service UUID", bool(found), f"{found[0][1]} in {time.time()-t:.1f}s" if found else "")
    if not found:
        return
    dev, name = found[0]
    check("advertised name is Bloq-XXXX", bool(name) and name.startswith("Bloq-"), repr(name))
    link = Link()
    await link.connect(dev)
    await asyncio.sleep(2.5)
    ticks = [l for l in bytes(link.rx).decode(errors="replace").splitlines() if l.startswith("tick")]
    check("program output streams while it runs", len(ticks) >= 2, f"{ticks}")
    link.rx.clear()
    await link.send(b"\x03")
    await link.wait_for(b">>> ")
    check("Ctrl-C stops the running program", b"KeyboardInterrupt" in link.rx)

    code = "".join(f"x{i} = {i} * 2  # padding to make the upload a few KB\n" for i in range(60))
    code = (code + "print('last', x59)\n").encode()
    t = time.time()
    win, out, err = await link.exec_raw(code)
    dt = time.time() - t
    check(
        "raw-paste upload: stdout/stderr split right",
        out.strip() == "last 118" and err == "",
        f"{len(code)} B in {dt:.2f}s = {len(code)/dt/1024:.1f} KB/s, window {win}",
    )

    link.rx.clear()
    await link.send(b"\x04")  # soft reboot, as Run does
    t = time.time()
    while link.c.is_connected and time.time() - t < 10:
        await asyncio.sleep(0.05)
    check("soft reboot drops the link", not link.c.is_connected)
    t, back = time.time(), False
    while time.time() - t < 30 and not back:
        try:
            d = await BleakScanner.find_device_by_address(dev.address, timeout=5)
            if d:
                await link.connect(d)
                back = True
        except Exception:
            await asyncio.sleep(0.3)
    check("link comes back after the reboot", back, f"{time.time()-t:.2f}s")
    if back:
        link.rx.clear()
        await asyncio.sleep(2.2)
        ticks = [l for l in bytes(link.rx).decode(errors="replace").splitlines() if l.startswith("tick")]
        check("rebooted program's output arrives", len(ticks) >= 1, f"{ticks}")
        await link.c.disconnect()


async def pad_checks():
    print("\n-- 3. a program's Bluetooth UART alongside the link --")
    found = await scan_link()
    check("advertises under the program's name", bool(found) and found[0][1] == "EspBot", f"{[n for _, n in found]}")
    if not found:
        return
    link = Link()
    await link.connect(found[0][0])
    await asyncio.sleep(2.5)
    lines = [l for l in bytes(link.rx).decode(errors="replace").splitlines() if l.startswith("pad")]
    check("program runs, IDE not counted as a gamepad", bool(lines) and all(l.startswith("pad False") for l in lines), f"{lines}")
    link.rx.clear()
    await link.send(b"\x03")
    await link.wait_for(b">>> ")
    check("Ctrl-C still stops it", b"KeyboardInterrupt" in link.rx)
    await link.c.disconnect()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", required=True, help="the board's USB serial port")
    port = ap.parse_args().port

    tmp = tempfile.mkdtemp(prefix="bloq-blehw-")
    usb = Usb(port, tmp)
    backup = {}
    for f in ("main.py", "boot.py"):
        if usb.exists("/" + f):
            usb.mp("cp", ":/" + f, os.path.join(tmp, f))
            backup[f] = os.path.join(tmp, f)
    print(f"backed up {sorted(backup) or 'nothing'} to {tmp}")

    try:
        print("\n-- 1. link on, over USB --")
        for lib in LIBS:
            usb.mp("cp", os.path.join(ROOT, lib), ":/lib/" + os.path.basename(lib))
        usb.boot_link(True)
        usb.put(TICK_MAIN, "/main.py")
        out = usb.reboot_and_read(3)
        banner = next((l.strip() for l in out.splitlines() if "upload link on" in l), "")
        check("boot.py starts the link", bool(banner), banner)
        check("main.py still runs after it", "tick 1" in out)

        asyncio.run(bluetooth_checks())

        usb.put(PAD_MAIN, "/main.py")
        usb.reboot_and_read(3)
        asyncio.run(pad_checks())

        print("\n-- 4. link off, over USB --")
        usb.boot_link(False)
        usb.put(TICK_MAIN, "/main.py")
        out = usb.reboot_and_read(3)
        check("boots without the link", "Bluetooth upload link on" not in out and "tick 1" in out)
        check("not advertising", not asyncio.run(scan_link(6)))
    finally:
        undone = []
        for f in ("main.py", "boot.py"):
            try:
                if f in backup:
                    usb.mp("cp", backup[f], ":/" + f)
                else:
                    usb.mp("rm", ":/" + f, check_rc=False)
            except RuntimeError as e:
                undone.append(f"{f} ({e})")
        if undone:
            print(f"\nRESTORE FAILED for {', '.join(undone)}; backups are in {tmp}")
            check.failed += 1
        else:
            usb.reboot_and_read(0.5)
            print(f"\nrestored {sorted(backup) or 'nothing'}" + (", removed the test's boot.py" if "boot.py" not in backup else ""))

    print()
    if check.failed:
        print(f"{check.failed} FAILED")
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
