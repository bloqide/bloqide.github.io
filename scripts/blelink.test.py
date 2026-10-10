# Bloq — offline block-based MicroPython IDE
# Copyright (C) 2026 Benjamin Balga
# SPDX-License-Identifier: GPL-3.0-or-later

"""Headless check for the Bluetooth upload link (src/runtime/bloq_link.py) and
the shared radio manager it and bleuart.py both run on (src/runtime/bloq_ble.py).

Stubs `bluetooth`, `micropython`, os.dupterm and the tick functions, then drives
the manager's IRQ handler the way the stack would. Verifies that REPL bytes
flow both ways, output is split to the MTU and survives a full notify queue,
and — the point of the shared manager — that a user program's Bluetooth UART
keeps working next to the link without seeing the IDE's connection.

Run: python3 scripts/blelink.test.py
"""
import os
import sys
import time
import types

# ---- fakes -----------------------------------------------------------------
mp = types.ModuleType("micropython")
mp.const = lambda x: x
sys.modules["micropython"] = mp

bt = types.ModuleType("bluetooth")


class UUID:
    def __init__(self, s):
        self.s = s.lower()

    def __bytes__(self):
        return bytes.fromhex(self.s.replace("-", ""))[::-1]  # little-endian, as on device

    def __eq__(self, other):
        return isinstance(other, UUID) and other.s == self.s


class BLE:
    instances = []

    def __init__(self):
        BLE.instances.append(self)
        self.registered = []  # one entry per gatts_register_services call
        self.buffers = {}  # handle -> pending written bytes
        self.notified = []  # (conn, handle, bytes)
        self.adv = None  # (adv_data, resp_data) of the last gap_advertise
        self.disconnected = []
        self.fail_notifies = 0  # raise OSError(ENOMEM) for this many notifies
        self.cfg = {"mac": (0, b"\x24\x0a\xc4\x12\x3f\x2a")}

    def active(self, on=None):
        return True

    def config(self, *args, **kw):
        if args:
            return self.cfg[args[0]]
        self.cfg.update(kw)

    def irq(self, fn):
        self.handler = fn

    def gatts_register_services(self, services):
        self.registered.append(services)
        h, out = 10, []
        for _uuid, chars in services:
            handles = []
            for _c in chars:
                handles.append(h)
                h += 1
            out.append(tuple(handles))
        return tuple(out)

    def gatts_set_buffer(self, handle, size, append=False):
        self.buffers[handle] = b""

    def gatts_read(self, handle):
        data, self.buffers[handle] = self.buffers.get(handle, b""), b""
        return data

    def gatts_notify(self, conn, handle, data):
        if self.fail_notifies:
            self.fail_notifies -= 1
            raise OSError(12)
        # MicroPython takes any buffer, str included (bleuart writes str)
        self.notified.append((conn, handle, data.encode() if isinstance(data, str) else bytes(data)))

    def gap_advertise(self, interval_us, adv_data=None, resp_data=None):
        self.adv = (adv_data, resp_data)

    def gap_disconnect(self, conn):
        self.disconnected.append(conn)


bt.UUID = UUID
bt.BLE = BLE
sys.modules["bluetooth"] = bt

DUPTERM = {"stream": None, "notified": 0, "stdin": bytearray(), "interrupts": 0}
os.dupterm = lambda s: DUPTERM.__setitem__("stream", s)


def _dupterm_notify(_):
    # As extmod/os_dupterm.c does it: pull bytes one at a time into the REPL's
    # stdin ring buffer, and on the interrupt char schedule a KeyboardInterrupt
    # and STOP, leaving whatever follows in the stream.
    DUPTERM["notified"] += 1
    stream, buf = DUPTERM["stream"], bytearray(1)
    while stream and stream.readinto(buf):
        if buf[0] == 0x03:
            DUPTERM["interrupts"] += 1
            return
        DUPTERM["stdin"] += buf


os.dupterm_notify = _dupterm_notify

CLOCK = {"ms": 0}
time.ticks_ms = lambda: CLOCK["ms"]
time.ticks_add = lambda a, b: a + b
time.ticks_diff = lambda a, b: a - b


def _sleep_ms(ms):
    CLOCK["ms"] += ms


time.sleep_ms = _sleep_ms

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src", "runtime"))
sys.path.insert(0, os.path.join(HERE, "..", "plugins", "core-ble", "lib"))
import bloq_ble  # noqa: E402
import bloq_link  # noqa: E402
import bleuart  # noqa: E402

# MicroPython's const() folds the BleControlPad.Button* names module-wide, which
# bleuart relies on; CPython doesn't, so supply them for the gamepad parsing.
for i, n in enumerate(["ButtonUp", "ButtonDown", "ButtonLeft", "ButtonRight", "Button1", "Button2", "Button3", "Button4"]):
    setattr(bleuart, n, i + 1)

CONNECT, DISCONNECT, WRITE, MTU = 1, 2, 3, 21


def check(name, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + name + (("  -- " + detail) if detail else ""))
    if not cond:
        check.failed += 1


check.failed = 0


def fresh():
    bloq_ble._manager = None
    bloq_link._stream = None
    DUPTERM.update(stream=None, notified=0, stdin=bytearray(), interrupts=0)


def write(m, conn, handle, data):
    m.ble.buffers[handle] = m.ble.buffers.get(handle, b"") + data
    m.ble.handler(WRITE, (conn, handle))


IDE, PHONE = 1, 2

print("\n-- link start --")
fresh()
bloq_link.start()
m = bloq_ble._manager
ble = m.ble
s = DUPTERM["stream"]
check("REPL mirrored onto the link stream", s is bloq_link._stream and s is not None)
check("link + Nordic UART registered in ONE call", len(ble.registered) == 1 and len(ble.registered[0]) == 2)
adv, resp = ble.adv
check("advertises the link UUID (the IDE's chooser filter)", bytes(bloq_ble.LINK_UUID) in adv)
check("advertisement fits in 31 bytes", len(adv) <= 31, f"{len(adv)}")
check("name 'Bloq-XXXX' from the MAC, in the scan response", b"Bloq-3F2A" in resp, repr(resp))
bloq_link.start()
check("start() is idempotent", len(BLE.instances) == 1 and len(ble.registered) == 1)

print("\n-- REPL input --")
rx, tx = m.link_handles
ble.handler(CONNECT, (IDE, 0, b""))
write(m, IDE, rx, b"")
check("empty hello write marks the IDE connection", IDE in m.link_conns)
check("…and feeds nothing to the REPL", DUPTERM["notified"] == 0 and s.ioctl(3, 0) == 0)
write(m, IDE, rx, b"\x01print(1)\x04")
check("bytes written to the link reach the REPL, in order", DUPTERM["stdin"] == b"\x01print(1)\x04")
check("nothing left behind in the link", s.readinto(bytearray(1)) is None and s.ioctl(3, 0) == 0)
DUPTERM["stdin"].clear()
write(m, IDE, rx, b"\x03\x03\x02\r\nimport machine; machine.reset()\r\n")  # the IDE's Reset
check("Ctrl-Cs raise KeyboardInterrupt", DUPTERM["interrupts"] == 2)
check(
    "bytes after a Ctrl-C in the same write still reach the REPL",
    DUPTERM["stdin"] == b"\x02\r\nimport machine; machine.reset()\r\n",
    repr(bytes(DUPTERM["stdin"])),
)
s._rx += b"ab"
check("poll reports pending input", s.ioctl(3, 0) == 1)
buf = bytearray(1)
check("readinto hands it over a byte at a time", s.readinto(buf) == 1 and buf == b"a" and s.ioctl(3, 0) == 1)
s._rx = bytearray()
DUPTERM["stdin"].clear()

print("\n-- REPL output --")
out = bytes(range(50))
s.write(out)
sent = [d for c, h, d in ble.notified if c == IDE and h == tx]
check("default MTU: 20-byte notifications", [len(d) for d in sent] == [20, 20, 10], f"{[len(d) for d in sent]}")
check("output arrives intact", b"".join(sent) == out)
ble.handler(MTU, (IDE, 185))
ble.notified.clear()
s.write(bytes(400))
check("after MTU exchange: 182-byte notifications", [len(d) for _, _, d in ble.notified] == [182, 182, 36])
ble.notified.clear()
ble.fail_notifies = 3
s.write(b"hello")
check("a full notify queue is waited out, not dropped", [d for _, _, d in ble.notified] == [b"hello"])

print("\n-- user program's Bluetooth UART alongside the link --")
pad = bleuart.controlPad
pad.begin(name="EspBot")
check("no second service registration (it would cut the link off)", len(ble.registered) == 1)
check("one radio: no second BLE() object", len(BLE.instances) == 1)
check("advertises under the program's name, link UUID kept", b"EspBot" in ble.adv[1] and bytes(bloq_ble.LINK_UUID) in ble.adv[0])
check("IDE alone doesn't count as 'Bluetooth connected'", not pad.isConnected())
ble.handler(CONNECT, (PHONE, 0, b""))
check("phone counts as connected", pad.isConnected())
nus_tx, nus_rx = m.nus_handles
write(m, PHONE, nus_rx, b"!B516")
check("phone gamepad press reaches the program", pad.isButtonPressed(bleuart.ButtonUp))
check("…and none of it leaks into the REPL", DUPTERM["stdin"] == b"" and s.readinto(bytearray(1)) is None)
ble.notified.clear()
pad.write("hi\n")
check("program output goes to the phone only", [(c, h) for c, h, _ in ble.notified] == [(PHONE, nus_tx)])
ble.notified.clear()
s.write(b">>> ")
check("REPL output goes to the IDE only", [(c, h) for c, h, _ in ble.notified] == [(IDE, tx)])
pad.close()
check("program's close() drops the phone, not the IDE", ble.disconnected == [PHONE])
ble.handler(DISCONNECT, (IDE, 0, b""))
check("IDE dropping doesn't release the phone's buttons", pad.isButtonPressed(bleuart.ButtonUp))
check("IDE connection forgotten", IDE not in m.link_conns and IDE not in m.conns)
ble.notified.clear()
s.write(b"lost")
check("output with no IDE connected is dropped, not blocking", ble.notified == [])
ble.handler(DISCONNECT, (PHONE, 0, b""))
check("phone dropping releases its buttons", not pad.isButtonPressed(bleuart.ButtonUp))

print("\n-- a stalled IDE connection can't hang the program --")
ble.handler(CONNECT, (IDE, 0, b""))
write(m, IDE, rx, b"")
ble.fail_notifies = 10**9
t0 = CLOCK["ms"]
s.write(b"x" * 100)
waited = CLOCK["ms"] - t0
check("gives up after the notify timeout", 1000 <= waited <= 1010, f"{waited} ms")
ble.fail_notifies = 0

print("\n-- Bluetooth UART without the link (link off: unchanged behaviour) --")
fresh()
BLE.instances.clear()
pad = bleuart.BleControlPad()
pad.begin(name="EspBot")
ble = bloq_ble._manager.ble
check("only the Nordic UART is registered", len(ble.registered) == 1 and len(ble.registered[0]) == 1)
check("no REPL mirroring", DUPTERM["stream"] is None)
adv, resp = ble.adv
check("name in the advertisement itself, no link UUID", b"EspBot" in adv and resp is None and bytes(bloq_ble.LINK_UUID) not in adv)
ble.handler(CONNECT, (PHONE, 0, b""))
check("phone counts as connected", pad.isConnected())

print()
if check.failed:
    print(f"{check.failed} FAILED")
    sys.exit(1)
print("ALL PASS")
