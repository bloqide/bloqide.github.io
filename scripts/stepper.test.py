# Bloq — offline block-based MicroPython IDE
# Copyright (C) 2026 Benjamin Balga
# SPDX-License-Identifier: GPL-3.0-or-later

"""Headless motion check for plugins/core-stepper/lib/BloqStepper.py.

Stubs `machine` and MicroPython's tick functions, then drives the shared
engine's timer callback by hand so the whole ramp/limit/homing state machine
can be exercised on the host with no board attached. Verifies the properties
that actually matter on hardware: every move lands exactly on target, the
profile never exceeds the commanded speed, direction reversals ramp down first,
several motors run independently off the one shared timer, and dropped callbacks
degrade speed without corrupting position.

Run: python3 scripts/stepper.test.py
"""
import sys, types, math

# ---- fake machine module -------------------------------------------------
machine = types.ModuleType("machine")


class Pin:
    OUT = 1
    IN = 2
    PULL_UP = 3

    def __init__(self, id, mode=None, pull=None):
        self.id = id
        self._v = 0
        self.edges = 0

    def value(self, v=None):
        if v is None:
            return self._v
        if v != self._v:
            self.edges += 1
        self._v = v


class Timer:
    instances = []

    def __init__(self, id=-1):
        self.id = id
        self.freq = None
        self.cb = None
        self.running = False
        Timer.instances.append(self)

    def init(self, freq=None, callback=None):
        self.freq = freq
        self.cb = callback
        self.running = True

    def deinit(self):
        self.running = False


machine.Pin = Pin
machine.Timer = Timer
sys.modules["machine"] = machine

# MicroPython tick functions over a virtual clock the test harness advances,
# so achieved_sps() measures simulated time rather than wall time.
import time as _time

CLOCK = {"ms": 0.0}
_time.ticks_ms = lambda: int(CLOCK["ms"])
_time.ticks_diff = lambda a, b: a - b

import os
sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugins", "core-stepper", "lib")
)
from BloqStepper import Stepper, _engine  # noqa: E402


def run(s, max_ticks=2_000_000, endstop=None, hit_at=None, on_tick=None):
    """Drive the shared engine until stepper `s` is idle. Each sample records
    that motor's commanded rate (`_sps`), so the ramp is visible even though the
    engine timer ticks at a fixed rate. Returns (elapsed_seconds, samples)."""
    elapsed = 0.0
    samples = []
    for i in range(max_ticks):
        t = _engine.timer
        if t is None or not t.running or t.cb is None:
            break
        if s._mode == 0:  # this motor idle -> done
            break
        if endstop is not None and hit_at is not None and abs(s.pos) >= hit_at:
            endstop._v = 0  # active low
        base = _engine.base_hz
        samples.append((elapsed, s.pos, s._sps))
        elapsed += 1.0 / base
        CLOCK["ms"] += 1000.0 / base
        t.cb(t)
        if on_tick:
            on_tick(s, i)
    return elapsed, samples


def run_all(steps, max_ticks=2_000_000, on_tick=None):
    """Drive the engine until every motor in `steps` is idle. Returns
    (elapsed_seconds, {stepper: samples})."""
    elapsed = 0.0
    per = {}
    for s in steps:
        per[s] = []
    for i in range(max_ticks):
        t = _engine.timer
        if t is None or not t.running:
            break
        if all(s._mode == 0 for s in steps):
            break
        base = _engine.base_hz
        for s in steps:
            per[s].append((elapsed, s.pos, s._sps))
        elapsed += 1.0 / base
        CLOCK["ms"] += 1000.0 / base
        t.cb(t)
        if on_tick:
            on_tick(i)
    return elapsed, per


def reset_engine():
    """Forget every motor from prior tests and tear the timer down, so a test
    that counts timers or motors starts from a clean engine."""
    _engine._halt()
    _engine.steppers = []
    Timer.instances.clear()


def check(name, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + name + (("  -- " + detail) if detail else ""))
    if not cond:
        check.failed += 1


check.failed = 0


def profile_stats(samples):
    freqs = [f for _, _, f in samples]
    return min(freqs), max(freqs)


print("== 1. long move, trapezoid ==")
s = Stepper(0, 1, speed_sps=800, accel_sps2=1600)
s.target(1000)
el, sm = run(s)
lo, hi = profile_stats(sm)
check("lands exactly on target", s.pos == 1000, f"pos={s.pos}")
check("target_reached set", s.is_target_reached())
check("never exceeds top speed", hi <= 800, f"max={hi}")
check("reaches (near) top speed", hi >= 750, f"max={hi}")
freqs = [f for _, _, f in sm]
peak = freqs.index(max(freqs))
check("speed rises then falls", all(freqs[i] <= freqs[i + 1] for i in range(peak)) and
      all(freqs[i] >= freqs[i + 1] for i in range(peak, len(freqs) - 1)),
      f"peak at step {peak}/{len(freqs)}")
# ideal trapezoid time: accel/decel 800/1600 = 0.5s each covering 200 steps each,
# cruise 600 steps at 800sps = 0.75s -> ~1.75s
check("elapsed near ideal trapezoid", 1.4 < el < 2.2, f"{el:.3f}s (ideal ~1.75s)")

print("== 2. short move, triangle (never reaches top) ==")
s = Stepper(0, 1, speed_sps=2000, accel_sps2=1000)
s.target(20)
el, sm = run(s)
lo, hi = profile_stats(sm)
check("lands exactly on target", s.pos == 20, f"pos={s.pos}")
check("stayed well under top speed", hi < 2000, f"max={hi}")

print("== 3. single step ==")
s = Stepper(0, 1, speed_sps=500, accel_sps2=1000)
s.target(1)
run(s)
check("pos == 1", s.pos == 1, f"pos={s.pos}")

print("== 4. negative move ==")
s = Stepper(0, 1, speed_sps=800, accel_sps2=1600)
s.target(-500)
run(s)
check("pos == -500", s.pos == -500, f"pos={s.pos}")

print("== 5. acceleration disabled (upstream behaviour) ==")
s = Stepper(0, 1, speed_sps=600, accel_sps2=0)
s.target(300)
el, sm = run(s)
lo, hi = profile_stats(sm)
check("lands exactly on target", s.pos == 300, f"pos={s.pos}")
check("constant frequency", lo == hi == 600, f"lo={lo} hi={hi}")
check("time == steps/speed", abs(el - 0.5) < 0.01, f"{el:.4f}s")

print("== 6. soft limits clamp the target ==")
s = Stepper(0, 1, speed_sps=800, accel_sps2=1600)
s.set_limits(0, 100)
s.target(5000)
run(s)
check("clamped to max limit", s.pos == 100, f"pos={s.pos}")
s.target(-5000)
run(s)
check("clamped to min limit", s.pos == 0, f"pos={s.pos}")

print("== 7. free run stops at a soft limit with a ramp ==")
s = Stepper(0, 1, speed_sps=1000, accel_sps2=2000)
s.set_limits(None, 400)
s.free_run(1)
el, sm = run(s)
check("stopped exactly on the limit", s.pos == 400, f"pos={s.pos}")
lo, hi = profile_stats(sm)
check("ramped down (last speed low)", sm[-1][2] < hi, f"last={sm[-1][2]} max={hi}")

print("== 8. free run + ramped stop() ==")
s = Stepper(0, 1, speed_sps=1000, accel_sps2=2000)
s.free_run(1)
stopped_at = {}


def tick(st, i):
    if i == 600 and "p" not in stopped_at:
        stopped_at["p"] = st.pos
        st.stop()


el, sm = run(s, on_tick=tick)
check("came to rest", s.is_target_reached(), f"mode={s._mode}")
check("stopped after the stop() call", s.pos > stopped_at["p"], f"{stopped_at['p']} -> {s.pos}")
check("decel distance is bounded", s.pos - stopped_at["p"] < 300, f"overrun={s.pos - stopped_at['p']}")
check("monotonic forward", all(sm[i][1] <= sm[i + 1][1] for i in range(len(sm) - 1)))

print("== 9. free run backwards ==")
s = Stepper(0, 1, speed_sps=800, accel_sps2=1600)
s.free_run(-1)


_stopped9 = {"v": False}


def tick2(st, i):
    # Trigger on position, not tick index: with tick oversampling there are
    # several ticks per step, so `i` is no longer a step count.
    if not _stopped9["v"] and st.pos <= -300:
        _stopped9["v"] = True
        st.stop()


run(s, on_tick=tick2)
check("moved backwards", s.pos < -300, f"pos={s.pos}")
check("came to rest", s.is_target_reached())

print("== 10. homing zeroes at the endstop ==")
es = Pin(9)
es._v = 1  # inactive (active-low)
s = Stepper(0, 1, speed_sps=200, accel_sps2=400)
s.overwrite_pos(1234)
s.home(es, direction=-1, speed_sps=100)
el, sm = run(s, endstop=es, hit_at=None)
# endstop trips after 150 steps of travel
s2 = Stepper(0, 1, speed_sps=200, accel_sps2=400)
es2 = Pin(9)
es2._v = 1
s2.overwrite_pos(1234)
start = s2.pos
s2.home(es2, direction=-1, speed_sps=100)


def tick3(st, i):
    if start - st.pos >= 150:
        es2._v = 0


el, sm = run(s2, on_tick=tick3)
check("position zeroed at endstop", s2.pos == 0, f"pos={s2.pos}")
check("homing finished", s2.is_target_reached())
check("restored the pre-homing speed", s2.steps_per_sec == 200, f"{s2.steps_per_sec}")

print("== 11. homing with a set_pos offset ==")
es3 = Pin(9)
es3._v = 1
s3 = Stepper(0, 1, speed_sps=200, accel_sps2=400)
s3.home(es3, direction=-1, speed_sps=100, set_pos=-10)
n = {"i": 0}


def tick4(st, i):
    n["i"] += 1
    if n["i"] > 50:
        es3._v = 0


run(s3, on_tick=tick4)
check("position set to the offset", s3.pos == -10, f"pos={s3.pos}")

print("== 12. relative moves compose ==")
s = Stepper(0, 1, speed_sps=800, accel_sps2=1600)
s.target(100)
run(s)
s.move(-30)
run(s)
check("100 then -30 == 70", s.pos == 70, f"pos={s.pos}")

print("== 13. degree / turn units ==")
s = Stepper(0, 1, steps_per_rev=200, speed_sps=800, accel_sps2=1600)
s.target_deg(90)
run(s)
check("90 deg == 50 steps", s.pos == 50, f"pos={s.pos}")
check("get_pos_deg round-trips", abs(s.get_pos_deg() - 90) < 0.01, f"{s.get_pos_deg()}")
s.target_turns(2)
run(s)
check("2 turns == 400 steps", s.pos == 400, f"pos={s.pos}")

print("== 14. changing speed mid-move keeps the target exact ==")
s = Stepper(0, 1, speed_sps=1000, accel_sps2=2000)
s.target(2000)


def tick5(st, i):
    if i == 400:
        st.speed(300)


run(s, on_tick=tick5)
check("still lands on target", s.pos == 2000, f"pos={s.pos}")

print("== 15. enable(False) hard-stops and disables stepping ==")
s = Stepper(0, 1, speed_sps=800, accel_sps2=1600)
s.target(1000)


def tick6(st, i):
    if i == 100:
        st.enable(False)


run(s, on_tick=tick6)
check("stopped early", s.pos < 1000, f"pos={s.pos}")
check("reports disabled", not s.is_enabled())

print("== 16. step-pulse count matches position ==")
sp = Pin(0)
dp = Pin(1)
s = Stepper(sp, dp, speed_sps=800, accel_sps2=1600)
s.target(250)
run(s)
check("one rising+falling edge pair per step", sp.edges == 250 * 2, f"edges={sp.edges}")

print("== 17. re-target mid-move (no speed discontinuity, exact landing) ==")
s = Stepper(0, 1, speed_sps=1000, accel_sps2=2000)
s.target(3000)
seen = []


def tick7(st, i):
    seen.append(st._sps)
    if i == 500:
        st.target(1500)


el, sm = run(s, on_tick=tick7)
check("lands on the new target", s.pos == 1500, f"pos={s.pos}")
check("no drop to minimum speed at re-target", min(seen[500:520]) > 400, f"{seen[498:512]}")
check("never overshot", max(p for _, p, _ in sm) <= 1500, f"max={max(p for _, p, _ in sm)}")

print("== 18. reversal mid-move ramps down before turning around ==")
s = Stepper(0, 1, speed_sps=1000, accel_sps2=2000)
s.target(3000)
turn = {}


def tick8(st, i):
    if i == 800:
        turn["p"] = st.pos
        st.target(-200)


el, sm = run(s, on_tick=tick8)
check("lands on the reversed target", s.pos == -200, f"pos={s.pos}")
positions = [p for _, p, _ in sm]
peak = max(positions)
check("overshot while ramping down, then came back", peak > turn["p"], f"turn@{turn['p']} peak={peak}")
check("overshoot is bounded by the decel distance", peak - turn["p"] < 300, f"overshoot={peak - turn['p']}")
pk = positions.index(peak)
check("single direction change", all(positions[i] <= positions[i + 1] for i in range(pk)) and
      all(positions[i] >= positions[i + 1] for i in range(pk, len(positions) - 1)))

print("== 19. stop() during a position move ==")
s = Stepper(0, 1, speed_sps=1000, accel_sps2=2000)
s.target(5000)


def tick9(st, i):
    if i == 700:
        st.stop()


el, sm = run(s, on_tick=tick9)
check("came to rest early", s.is_target_reached() and s.pos < 5000, f"pos={s.pos}")
positions = [p for _, p, _ in sm]
check("monotonic (no reversal)", all(positions[i] <= positions[i + 1] for i in range(len(positions) - 1)))

print("== 20. achieved_sps() reports the delivered rate ==")
s = Stepper(0, 1, speed_sps=800, accel_sps2=1600)
s.target(4000)
run(s)
check("measured rate matches the commanded top speed", abs(s.achieved_sps() - 800) < 40,
      f"achieved={s.achieved_sps():.0f} commanded=800")

# A board that can only service ~300 callbacks/s: the timer fires late, so the
# virtual clock advances more than the requested period per step.
print("== 21. dropped callbacks slow the move but keep the position exact ==")
s = Stepper(0, 1, speed_sps=2000, accel_sps2=4000)
s.target(2000)
elapsed = 0.0
CEILING = 300.0
while True:
    t = _engine.timer
    if t is None or s._mode == 0:
        break
    base = _engine.base_hz
    period = max(1.0 / base, 1.0 / CEILING)  # can't service faster than CEILING
    elapsed += period
    CLOCK["ms"] += period * 1000.0
    t.cb(t)
check("position still exact despite drops", s.pos == 2000, f"pos={s.pos}")
check("measured rate reveals the ceiling", s.achieved_sps() < 400,
      f"achieved={s.achieved_sps():.0f} commanded=2000")
check("move simply took longer", elapsed > 2000 / 400.0, f"{elapsed:.2f}s")

print("== 22. one shared timer, whatever the motor count ==")
reset_engine()
a = Stepper(0, 1, speed_sps=400, accel_sps2=800)
b = Stepper(2, 3, speed_sps=400, accel_sps2=800)
c = Stepper(4, 5, speed_sps=400, accel_sps2=800)
d = Stepper(6, 7, speed_sps=400, accel_sps2=800)
check("construction allocates no timer", len(Timer.instances) == 0, f"{len(Timer.instances)}")
a.target(200)
check("the first move allocates exactly one timer", len(Timer.instances) == 1, f"{len(Timer.instances)}")
b.target(200)
c.target(200)
d.target(200)
check("four motors still share that one timer", len(Timer.instances) == 1, f"{len(Timer.instances)}")
run_all([a, b, c, d])
check("all four land on target", a.pos == 200 and b.pos == 200 and c.pos == 200 and d.pos == 200,
      f"{a.pos},{b.pos},{c.pos},{d.pos}")
check("timer torn down when everything is idle", _engine.timer is None)

print("== 23. two motors run independently off the shared tick ==")
reset_engine()
a = Stepper(0, 1, speed_sps=800, accel_sps2=1600)
b = Stepper(2, 3, speed_sps=800, accel_sps2=1600)
a.target(1000)
b.target(-600)
run_all([a, b])
check("motor A lands forward", a.pos == 1000, f"a={a.pos}")
check("motor B lands backward, independent target", b.pos == -600, f"b={b.pos}")

print("== 24. a slow motor keeps going after a fast one finishes ==")
reset_engine()
fast = Stepper(0, 1, speed_sps=1600, accel_sps2=3200)
slow = Stepper(2, 3, speed_sps=200, accel_sps2=400)
fast.target(2000)
slow.target(2000)
# base starts at 1600 (the fast motor); when it finishes, base must drop to 200
# so the slow motor still completes rather than stalling.
saw_base_drop = {"v": False}


def tick_watch(i):
    if fast.is_target_reached() and _engine.base_hz <= 200:
        saw_base_drop["v"] = True


run_all([fast, slow], on_tick=tick_watch)
check("fast motor lands", fast.pos == 2000, f"fast={fast.pos}")
check("slow motor lands after the tick rate dropped", slow.pos == 2000, f"slow={slow.pos}")
check("engine re-based to the slow motor once the fast one finished", saw_base_drop["v"])

print("== 25. starting a motor mid-move doesn't disturb one already running ==")
reset_engine()
a = Stepper(0, 1, speed_sps=600, accel_sps2=1200)
b = Stepper(2, 3, speed_sps=600, accel_sps2=1200)
a.target(3000)
started = {"done": False}


def tick_add(i):
    if a.pos >= 1000 and not started["done"]:
        started["done"] = True
        b.target(800)


run_all([a, b], on_tick=tick_add)
check("the running motor still lands exactly", a.pos == 3000, f"a={a.pos}")
check("the late-started motor lands exactly", b.pos == 800, f"b={b.pos}")

print("== 26. every timer re-arm passes a callback ==")
# init(freq=...) without a callback silently clears it on both ports.
reset_engine()


class StrictTimer(Timer):
    def init(self, freq=None, callback=None):
        if callback is None:
            raise AssertionError("init() called without a callback — would go deaf")
        Timer.init(self, freq=freq, callback=callback)


machine.Timer = StrictTimer
try:
    s = Stepper(0, 1, speed_sps=900, accel_sps2=1800)
    s.target(1500)
    run(s)
    check("no bare init() during a full ramped move", s.pos == 1500, f"pos={s.pos}")
    s.free_run(1)

    def tick10(st, i):
        if i == 400:
            st.stop()

    run(s, on_tick=tick10)
    check("no bare init() during rotate + stop", s.is_target_reached())
finally:
    machine.Timer = Timer

print("== 27. tick oversamples a lone slow motor, backs off as motors join ==")
reset_engine()


def pump(n=5):
    for _ in range(n):
        t = _engine.timer
        if t is not None:
            t.cb(t)


a = Stepper(0, 1, speed_sps=300, accel_sps2=600)
a.target(1_000_000)  # long move so it's still running while we inspect the tick
pump()
check("lone slow motor is oversampled (tick > top speed)", _engine.base_hz > 300,
      f"base={_engine.base_hz}")
check("tick is an exact multiple of top speed (cruise stays even)",
      _engine.base_hz % 300 == 0, f"base={_engine.base_hz}")
k_solo = _engine.base_hz // 300
b = Stepper(2, 3, speed_sps=300, accel_sps2=600)
b.target(1_000_000)
pump()
check("oversample backs off when a second motor joins",
      _engine.base_hz // 300 <= k_solo, f"k {k_solo} -> {_engine.base_hz // 300}")
check("tick is never slower than top speed (never caps the motor)",
      _engine.base_hz >= 300, f"base={_engine.base_hz}")
a.hard_stop()
b.hard_stop()

# A fast motor already at/above the smoothing target isn't oversampled — k=1.
reset_engine()
f = Stepper(0, 1, speed_sps=4000, accel_sps2=8000)
f.target(1_000_000)
pump()
check("a motor at/above the smoothing target ticks 1:1 (no wasted callbacks)",
      _engine.base_hz == 4000, f"base={_engine.base_hz}")
f.hard_stop()

print()
print("FAILURES:", check.failed)
sys.exit(1 if check.failed else 0)
