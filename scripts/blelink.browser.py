# Bloq — offline block-based MicroPython IDE
# Copyright (C) 2026 Benjamin Balga
# SPDX-License-Identifier: GPL-3.0-or-later

"""In-browser check of the Bluetooth upload link: the app's own Web Bluetooth
code (src/serial/blePort.ts) against a real board.

The bugs this covers only showed up in a real browser: reconnects after a Reset
or a Run, giving up when the board goes away, connecting again afterwards
without a page reload, and two panes taking the same board over from each
other. It launches a separate Chrome/Brave (throwaway profile, so your own
browser is untouched), drives the running dev server over the DevTools protocol
(including picking the board in the Bluetooth chooser), and uses the board's
USB port to turn the link on and off.

Needs: the board on USB, `npm run dev` running, and in some venv
  pip install mpremote bleak pyserial websockets
Run:   python3 scripts/blelink.browser.py --port /dev/cu.usbmodem101
       [--browser "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"]
       [--url http://localhost:5173/]
Close the app's Bluetooth panes in your own browser first: two browsers on one
computer share the OS's Bluetooth connection to the board and disturb each other.
Keep the launched window in front: the Bluetooth chooser closes when it loses
focus (e.g. to a firewall prompt about the new browser instance).

The board's main.py and boot.py are backed up first and restored at the end
(the scenario's Run uploads the stepper example, stopped right after; it drives
IO2-IO4 briefly, so don't leave a stepper driver wired there). The IDE's sync
manifest is deleted, so its libraries are re-sent on the next Run.
"""
import argparse
import asyncio
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
# USB helpers (mpremote, boot.py link edit, soft reboot) come from the hardware test.
_spec = importlib.util.spec_from_file_location("blelink_hw", os.path.join(HERE, "blelink.hw.py"))
hw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hw)
check = hw.check

BROWSERS = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "google-chrome",
    "chromium",
]
DEBUG_PORT = 9333


class Page:
    """Just enough DevTools protocol for this test."""

    def __init__(self, ws):
        self.ws, self.n, self.pending, self.events = ws, 0, {}, []

    async def start(self):
        self.reader = asyncio.create_task(self._read())
        await self.call("Runtime.enable")
        await self.call("Page.enable")
        await self.call("DeviceAccess.enable")

    async def _read(self):
        async for msg in self.ws:
            m = json.loads(msg)
            if "id" in m and m["id"] in self.pending:
                self.pending.pop(m["id"]).set_result(m)
                continue
            self.events.append(m)
            if m.get("method") == "Page.javascriptDialogOpening":  # e.g. "Could not open device"
                print(f"        (alert: {m['params']['message']})")
                asyncio.ensure_future(self.call("Page.handleJavaScriptDialog", accept=True))

    async def call(self, method, **params):
        self.n += 1
        fut = asyncio.get_running_loop().create_future()
        self.pending[self.n] = fut
        await self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        r = await asyncio.wait_for(fut, 30)
        if "error" in r:
            raise RuntimeError(f"{method}: {r['error']}")
        return r["result"]

    async def js(self, expr):
        r = await self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        return r["result"].get("value")

    async def until(self, expr, timeout):
        end = time.time() + timeout
        while time.time() < end:
            if await self.js(expr):
                return True
            await asyncio.sleep(0.3)
        return False

    async def real_click(self, selector):
        """A trusted click (user activation), which requestDevice() requires."""
        x, y = await self.js(
            f"(()=>{{const r=document.querySelector({json.dumps(selector)}).getBoundingClientRect();"
            "return [r.x+r.width/2, r.y+r.height/2]})()"
        )
        for t in ("mousePressed", "mouseReleased"):
            await self.call("Input.dispatchMouseEvent", type=t, x=x, y=y, button="left", clickCount=1)

    async def connect_bluetooth(self, timeout=20):
        """Click the toolbar's Bluetooth button and pick the first Bloq board."""
        self.events.clear()
        await self.real_click("#btn-connect-ble")
        end = time.time() + timeout
        while time.time() < end:
            for e in self.events:
                if e.get("method") == "DeviceAccess.deviceRequestPrompted":
                    devs = [d for d in e["params"]["devices"] if d["name"].startswith("Bloq-")]
                    if devs:
                        await self.call("DeviceAccess.selectPrompt", id=e["params"]["id"], deviceId=devs[0]["id"])
                        return devs[0]["name"]
            await asyncio.sleep(0.2)
        prompts = [e["params"] for e in self.events if e.get("method") == "DeviceAccess.deviceRequestPrompted"]
        seen = sorted({d["name"] for p in prompts for d in p["devices"]})
        print(f"        (chooser {'opened, listing ' + str(seen) if prompts else 'never opened'})")
        if prompts:
            await self.call("DeviceAccess.cancelPrompt", id=prompts[-1]["id"])
        return None


# Pane helpers (pane i = i-th terminal pane, in creation order).
def pane(i):
    return f"document.querySelectorAll('.term-pane')[{i}]"


def connected(i):
    return f"!!{pane(i)} && !{pane(i)}.classList.contains('disconnected')"


def text(i):
    return f"{pane(i)}.querySelector('.xterm-rows').textContent"


def click(i, btn):
    return f"({pane(i)}.querySelector('.term-{btn}').click(), true)"


async def scenario(page, usb):
    await page.call("Page.reload")
    # The button starts hidden and appears once Web Bluetooth support is detected.
    ready = "(b => !!b && !b.classList.contains('hidden') && b.getBoundingClientRect().width > 0)(document.querySelector('#btn-connect-ble'))"
    if not await page.until(ready, 15):
        raise SystemExit("the app's Bluetooth button never appeared (Web Bluetooth disabled in this browser?)")
    await asyncio.sleep(1)

    print("\n-- connect --")
    name = await page.connect_bluetooth()
    check("board listed in the Bluetooth chooser", bool(name), name or "")
    if not name:
        # Nothing below means anything without this pane. A chooser that never
        # opens usually lost focus to another app's popup (it closes on blur).
        print("        stopping: keep this browser window in front while the test runs")
        return
    check("pane connects", await page.until(connected(0), 20))
    check("program output streams", await page.until(f"{text(0)}.includes('tick')", 6))

    print("\n-- Reset reconnects --")
    await page.js(click(0, "clear"))
    await page.js(click(0, "reset"))
    check("link comes back after the hard reset", await page.until(f"{text(0)}.includes('reconnected')", 15))
    check("…with the program running again", await page.until(f"/tick \\d/.test({text(0)})", 6))

    print("\n-- Run with a big library: uploads, reboots, reconnects --")
    # The stepper example needs BloqStepper.py (23 KB): too big to send as one
    # script while Bluetooth eats the heap, so this exercises chunked writes.
    card = "[...document.querySelectorAll('.example-card')].find(c => c.querySelector('.example-name').textContent === 'Stepper shuttle')"
    await page.js("(document.querySelector('#btn-examples').click(), true)")
    if not await page.until(f"!!{card}", 5):
        check("stepper example available", False)
        return
    await page.js(f"({card}.click(), true)")
    await asyncio.sleep(2)
    await page.js(click(0, "clear"))
    await page.js("(document.querySelector('#btn-run').click(), true)")
    ok = await page.until(
        f"{text(0)}.includes('[error]') || ({text(0)}.includes('[run] uploading') && {text(0)}.includes('reconnected'))", 120
    )
    out = await page.js(text(0))
    check("23 KB library synced over Bluetooth", ok and "[sync] /lib/BloqStepper.py" in out and "[error]" not in out,
          out[out.find("[error]"):][:90] if "[error]" in out else "")
    check("Run completes and the link returns", ok and "reconnected" in out.split("[run] uploading")[-1])
    check("pane still connected", await page.js(connected(0)))
    await page.js(click(0, "stop"))  # don't leave the example stepping pins

    print("\n-- board gone: give up, then connect again without a reload --")
    usb.boot_link(False)
    usb.reboot_and_read(1)
    check("app gives up on the vanished board", await page.until(f"{text(0)}.includes('board not reachable')", 45))
    check("…and shows the pane disconnected", await page.until(f"!({connected(0)})", 5))
    usb.boot_link(True)
    usb.reboot_and_read(2)
    name = await page.connect_bluetooth()
    check("board can be picked again", bool(name))
    check("new pane connects (no page reload)", await page.until(connected(1), 20))

    print("\n-- two panes, one board --")
    await page.js(click(0, "conn"))
    check("old pane reconnects, taking the board over", await page.until(connected(0), 20))
    check("…and the other pane lets go", await page.until(f"!({connected(1)})", 5))
    await page.js(click(1, "conn"))
    check("and back again", await page.until(f"{connected(1)} && !({connected(0)})", 20))

    print("\n-- disconnect / reconnect --")
    await page.js(click(1, "conn"))
    check("disconnect", await page.until(f"!({connected(1)})", 5))
    await page.js(click(1, "conn"))
    check("reconnect", await page.until(connected(1), 20))


async def drive(url):
    end = time.time() + 15
    while True:
        try:
            targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json"))
            ws_url = next(t["webSocketDebuggerUrl"] for t in targets if t["type"] == "page" and t["url"].startswith(url))
            break
        except Exception:
            if time.time() > end:
                raise SystemExit("browser/page didn't come up (is `npm run dev` running?)")
            await asyncio.sleep(0.5)
    async with websockets.connect(ws_url, max_size=2**24) as ws:
        page = Page(ws)
        await page.start()
        try:
            await scenario(page, drive.usb)
        finally:
            page.reader.cancel()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", required=True, help="the board's USB serial port")
    ap.add_argument("--browser", help="Chrome/Brave binary (default: first found)")
    ap.add_argument("--url", default="http://localhost:5173/")
    args = ap.parse_args()
    browser = args.browser or next((b for b in BROWSERS if os.path.exists(b) or shutil.which(b)), None)
    if not browser:
        raise SystemExit("no Chrome/Brave found; pass --browser")

    tmp = tempfile.mkdtemp(prefix="bloq-blebrowser-")
    usb = hw.Usb(args.port, tmp)
    backup = {}
    for f in ("main.py", "boot.py"):
        if usb.exists("/" + f):
            usb.mp("cp", ":/" + f, os.path.join(tmp, f))
            backup[f] = os.path.join(tmp, f)
    print(f"backed up {sorted(backup) or 'nothing'}; browser: {os.path.basename(browser)}")

    proc = None
    try:
        # Board ready: link on, a program that prints, so output can be checked.
        for lib in hw.LIBS:
            usb.mp("cp", os.path.join(hw.ROOT, lib), ":/lib/" + os.path.basename(lib))
        # Forget what the IDE synced before, so the Run below really re-sends its libraries.
        usb.mp("rm", ":/lib/.bloq_manifest.json", check_rc=False)
        usb.boot_link(True)
        usb.put(hw.TICK_MAIN, "/main.py")
        usb.reboot_and_read(2)

        proc = subprocess.Popen(
            [
                browser,
                f"--user-data-dir={os.path.join(tmp, 'profile')}",
                f"--remote-debugging-port={DEBUG_PORT}",
                "--enable-features=BraveWebBluetoothAPI",  # Brave keeps Web Bluetooth off by default
                "--no-first-run",
                "--no-default-browser-check",
                args.url,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        drive.usb = usb
        asyncio.run(drive(args.url))
    finally:
        if proc:
            proc.terminate()
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
            print(f"\nrestored {sorted(backup) or 'nothing'}")

    print()
    if check.failed:
        print(f"{check.failed} FAILED")
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
