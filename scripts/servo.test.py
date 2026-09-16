# Bloq — offline block-based MicroPython IDE
# Copyright (C) 2026 Benjamin Balga
# SPDX-License-Identifier: GPL-3.0-or-later

"""Headless check for plugins/core-servo/lib/BloqServo.py.

Stubs `machine` and MicroPython's tick functions, so the pulse-width arithmetic
the whole plugin rests on can be verified on the host with no board attached:
angles map onto the calibrated range, a timed move interpolates over the clock
and lands exactly on target, continuous-rotation speeds sit around the stop
pulse, and releasing really does stop the pulses.

Run: python3 scripts/servo.test.py
"""
import os
import sys
import types

# ---- fake machine module -------------------------------------------------
machine = types.ModuleType("machine")


class Pin:
    OUT = 1

    def __init__(self, id, mode=None, pull=None):
        self.id = id


class PWM:
    def __init__(self, pin):
        self.pin = pin
        self._freq = None
        self.duty = None
        self.writes = []
        self.alive = True

    def freq(self, f=None):
        if f is None:
            return self._freq
        self._freq = f

    def duty_u16(self, d=None):
        if d is None:
            return self.duty
        self.duty = d
        self.writes.append(d)

    def deinit(self):
        self.alive = False


machine.Pin = Pin
machine.PWM = PWM
sys.modules["machine"] = machine

# MicroPython tick functions over a virtual clock the test advances by hand, so
# a timed move can be stepped instantly instead of in real time.
import time as _time  # noqa: E402

CLOCK = {"ms": 0}
_time.ticks_ms = lambda: int(CLOCK["ms"])
_time.ticks_diff = lambda a, b: a - b

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "core-servo", "lib")
)
from BloqServo import Servo  # noqa: E402


def check(name, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + name + (("  -- " + detail) if detail else ""))
    if not cond:
        check.failed += 1


check.failed = 0


def duty_for(us, freq=50):
    """The duty_u16 value a pulse of `us` should produce — the driver's own
    arithmetic, spelled out independently here."""
    return us * 65535 // (1000000 // freq)


print("\n-- construction: quiet until commanded --")
s = Servo(4)
check("PWM opened on the given pin at 50 Hz", s._pwm.pin.id == 4 and s._pwm.freq() == 50)
check("no pulse until commanded (servo stays limp)", s._pwm.duty == 0)
check("assumes mid-travel before the first command", s.read_angle() == 90, f"{s.read_angle()}")
check("not holding yet", not s.is_holding())

print("\n-- angles map onto the calibrated range --")
s = Servo(0)
s.angle(0)
check("0° = shortest pulse", s.read_us() == 500 and s._pwm.duty == duty_for(500))
s.angle(180)
check("180° = longest pulse", s.read_us() == 2500 and s._pwm.duty == duty_for(2500))
s.angle(90)
check("90° = mid pulse", s.read_us() == 1500 and s._pwm.duty == duty_for(1500))
check("read_angle round-trips", abs(s.read_angle() - 90) < 0.01, f"{s.read_angle()}")
s.angle(400)
check("angles past the end clamp to the end", s.read_us() == 2500, f"{s.read_us()}")
s.angle(-50)
check("angles below zero clamp to zero", s.read_us() == 500, f"{s.read_us()}")

print("\n-- calibration --")
s = Servo(0)
s.set_range(1000, 2000, 270)
check("re-centres the assumed rest position while uncommanded", s.read_us() == 1500)
s.angle(270)
check("angle maps onto the new range", s.read_us() == 2000, f"{s.read_us()}")
s.set_range(500, 2500, 180)
check("recalibrating does not move a servo already commanded", s.read_us() == 2000)
s = Servo(0)
s.set_range(1000, 2000)
s.write_us(4000)
check("a direct pulse is clamped to the calibrated range", s.read_us() == 2000, f"{s.read_us()}")

print("\n-- timed move --")
s = Servo(0)
s.angle(0)
CLOCK["ms"] = 10_000
s.move_to(180, 1000)
check("move_to returns immediately, still at the start", s.read_us() == 500 and s.is_moving())
seen = []
for t in range(0, 1001, 50):
    CLOCK["ms"] = 10_000 + t
    done = s.update()
    seen.append(s.read_us())
check("lands exactly on target", s.read_us() == 2500 and done, f"{s.read_us()}")
check("no longer moving", not s.is_moving())
check("update() keeps returning True once finished", s.update())
check("pulse rises monotonically", all(b >= a for a, b in zip(seen, seen[1:])), f"{seen[:4]}")
check(
    "half way through the move is half way through the travel",
    abs(seen[len(seen) // 2] - 1500) < 60,
    f"{seen[len(seen) // 2]}",
)
check("no overshoot", max(seen) <= 2500)

s.move_to(0, 0)
check("a zero-length move jumps straight there", s.read_us() == 500 and not s.is_moving())

s.angle(0)
CLOCK["ms"] = 20_000
s.move_to(180, 1000)
s.angle(45)
check("a direct angle cancels a running move", not s.is_moving() and s.read_us() == 1000)

print("\n-- continuous rotation --")
s = Servo(0)
s.speed(0)
check("0% = the stop pulse", s.read_us() == 1500, f"{s.read_us()}")
s.speed(100)
check("100% = full forward", s.read_us() == 2000, f"{s.read_us()}")
s.speed(-100)
check("-100% = full reverse", s.read_us() == 1000, f"{s.read_us()}")
s.speed(50)
check("50% is half way to full speed", s.read_us() == 1750, f"{s.read_us()}")
s.speed(500)
check("speeds past full clamp to full", s.read_us() == 2000, f"{s.read_us()}")
s = Servo(0)
s.set_range(1300, 1700)
s.speed(100)
check(
    "a narrow calibration scales the speed span down with it",
    s.read_us() == 1700,
    f"{s.read_us()}",
)

print("\n-- power --")
s = Servo(0)
s.angle(120)
held = s.read_us()
s.release()
check("releasing stops the pulses", s._pwm.duty == 0 and not s.is_holding())
# Pulse widths are whole microseconds, so a round-tripped angle lands within
# the quantisation step (1 µs over 2000 µs of travel is under a tenth of a degree).
check(
    "but remembers where it was",
    s.read_us() == held and abs(s.read_angle() - 120) < 0.1,
    f"{s.read_angle()}",
)
s.hold()
check("holding resumes the same pulse", s._pwm.duty == duty_for(held) and s.is_holding())
CLOCK["ms"] = 30_000
s.move_to(0, 1000)
s.release()
check("releasing cancels a running move", not s.is_moving())
s.deinit()
check("deinit releases and frees the PWM", not s._pwm.alive)

print()
print("FAILURES:", check.failed)
sys.exit(1 if check.failed else 0)
