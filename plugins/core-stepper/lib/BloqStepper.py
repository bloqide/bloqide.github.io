# BloqStepper — STEP/DIR stepper driver with trapezoidal acceleration.
#
# Derived from micropython-stepper by redoxcode:
#   https://github.com/redoxcode/micropython-stepper
# Original work Copyright (c) 2023 redoxcode
# Modifications Copyright (c) 2026 Benjamin Balga
# SPDX-License-Identifier: MIT
#
# The upstream driver steps once per `machine.Timer` tick at a fixed frequency —
# non-blocking and portable, but no acceleration, and one timer per motor. This
# version adds ramping and multi-motor support without giving up portability.
#
# One shared timer for every motor
# --------------------------------
# Hardware timers are scarce and their numbering is not portable: an ESP32-C3
# has only two, and (on at least some firmware) asking for a third silently
# aliases onto an existing one rather than raising — so "one Timer per motor"
# quietly breaks the moment you add a second stepper. So all steppers are driven
# from a *single* module-level timer owned by the engine below. It works the
# same whether the board has 2 timers or 16, and the timer is torn down whenever
# nothing is moving, so no state bleeds across runs.
#
# Each motor carries a phase accumulator (a DDA): every tick it adds its own
# current step rate, and emits a step whenever the accumulator crosses the tick
# rate. That gives every motor its own speed and its own independent ramp off
# one clock.
#
# The tick runs at an integer *multiple* of the fastest active motor's step
# rate, not exactly its rate. Ticking at exactly the top speed makes cruise
# smooth (a step every tick) but leaves accel/decel jagged, because a ramp level
# whose speed doesn't divide the tick rate produces uneven step intervals
# (1,2,1,2 ticks…). Oversampling by k keeps the fastest motor's cruise exactly
# even (a step every k ticks) while cutting that jitter k-fold. k scales down as
# motors and speed rise so the callback rate stays under the scheduler's budget,
# and the tick is never slower than the top speed, so it never caps a motor.
#
# How the ramp works
# ------------------
# The trapezoid is a *staircase of constant-rate segments*: a small speed table
# is precomputed whenever speed or acceleration changes, and a motor only
# changes its step rate when a segment's step budget runs out — tens of times
# per move, not thousands. Every step is counted in software, so position stays
# exact no matter how coarse the staircase.
#
# Level i is entered at speed _speeds[i]. _seg[i] is the number of steps spent
# at that level while ramping (from v² = v₀² + 2·a·d), and _cum[i] is the total
# distance needed to come to rest from level i. Deceleration begins as soon as
# the remaining distance drops to _cum[current level], which is what guarantees
# the move ends exactly on target rather than overshooting.
#
# Setting acceleration to 0 collapses the table to one level, restoring constant
# speed.
#
# Step rate ceiling — read this before blaming the motor
# ------------------------------------------------------
# machine.Timer callbacks are dispatched through mp_sched_schedule() on both the
# esp32 and rp2 ports, not from the ISR. That queue is 8 deep and shared with
# pin IRQs and UART, and when it overflows callbacks are *silently dropped*. So
# above roughly 1–2 kHz (measure it — the real figure depends on the board, the
# clock and what else is running) the motor simply steps slower than commanded.
# With several motors sharing the one engine tick, that ceiling is a budget for
# the whole set, not per motor.
#
# What that does NOT do is corrupt the position: a dropped tick emits no pulse
# and counts no step, so the software position still matches the shaft. Moves
# just take longer than the profile predicts. Call achieved_sps() after a move
# to see the rate actually delivered, and lower the speed until it matches.
#
# For step rates beyond that, a port-specific pulse generator is the only real
# answer (rp2 PIO, esp32 RMT). This driver deliberately trades peak rate for
# running unmodified on any port with machine.Timer.
import machine
import math
import sys
import time

_IDLE = 0
_POSITION = 1
_FREE = 2
_HOMING = 3

# Steps between re-plans while free-running at top speed. Only affects how
# promptly a stop() or a speed change is noticed; costs one branch per segment.
_CRUISE_CHUNK = 256

# Engine tick tuning. The tick rate is chosen as top_speed × k, where k is the
# largest oversample that keeps the tick near _SMOOTH_TICK once shared across
# the active motors (higher k = smoother accel, but more callbacks). Keep
# _SMOOTH_TICK comfortably below the board's callback ceiling — the point where
# achieved_sps stops tracking the commanded speed. Raise it for smoother ramps
# if your board has headroom; lower it if fast multi-motor moves start dropping.
_SMOOTH_TICK = 3000
_OVERSAMPLE_MAX = 16


def _alloc_shared_timer():
    """The one timer the engine drives. esp32 wants a concrete id (Timer(-1)
    raises there); everything else uses the virtual timer."""
    if sys.platform == "esp32":
        return machine.Timer(0)
    try:
        return machine.Timer(-1)
    except (ValueError, TypeError):
        return machine.Timer(0)


class _Engine:
    """Owns the single machine.Timer and multiplexes every active stepper onto
    it. All methods run either in user context or in the timer callback; on both
    the esp32 and rp2 ports the callback is dispatched cooperatively (via the
    scheduler, not the ISR), so the two never truly overlap and no locking is
    needed — the same assumption Bloq's own scheduler runs on."""

    def __init__(self):
        self.timer = None
        self.steppers = []
        self.base_hz = 0

    def add(self, s):
        for existing in self.steppers:
            if existing is s:
                return
        self.steppers.append(s)

    def _tick_rate(self):
        """Chosen tick rate: fastest active motor's speed, oversampled by as
        much as the callback budget allows once split across the active motors.
        Returns 0 when nothing is moving."""
        top = 0
        n = 0
        for s in self.steppers:
            if s._mode != _IDLE:
                n += 1
                if s.steps_per_sec > top:
                    top = s.steps_per_sec
        top = int(top)
        if top < 1 or n == 0:
            return 0
        k = _SMOOTH_TICK // (top * n)
        if k < 1:
            k = 1
        elif k > _OVERSAMPLE_MAX:
            k = _OVERSAMPLE_MAX
        return top * k

    def wake(self):
        """Recompute the tick rate and make sure the timer is running. Called
        whenever a motor starts, changes speed, or stops."""
        base = self._tick_rate()
        if base < 1:
            self._halt()
            return
        changed = base != self.base_hz
        if changed:
            self.base_hz = base
            # The accumulators are scaled to the tick rate, so rebase them.
            for s in self.steppers:
                s._acc = 0
        if self.timer is None:
            self.timer = _alloc_shared_timer()
            self.timer.init(freq=base, callback=self._tick)
        elif changed:
            self.timer.init(freq=base, callback=self._tick)

    def _halt(self):
        if self.timer is not None:
            self.timer.deinit()
            self.timer = None
        self.base_hz = 0

    def _tick(self, t):
        base = self.base_hz
        active = False
        for s in self.steppers:
            if s._mode != _IDLE:
                s._dda_tick(base)
            if s._mode != _IDLE:
                active = True
        if not active:
            self._halt()


# One engine for the whole program.
_engine = _Engine()


class Stepper:
    def __init__(
        self,
        step_pin,
        dir_pin,
        en_pin=None,
        steps_per_rev=200,
        speed_sps=400,
        accel_sps2=0,
        invert_dir=False,
        invert_enable=False,
        min_speed_sps=0,
        ramp_levels=32,
    ):
        if not isinstance(step_pin, machine.Pin):
            step_pin = machine.Pin(step_pin, machine.Pin.OUT)
        if not isinstance(dir_pin, machine.Pin):
            dir_pin = machine.Pin(dir_pin, machine.Pin.OUT)
        if (en_pin is not None) and (not isinstance(en_pin, machine.Pin)):
            en_pin = machine.Pin(en_pin, machine.Pin.OUT)

        # Bound methods cached as attributes: the DDA tick runs per step, so
        # every attribute lookup saved there is worth it.
        self.step_value_func = step_pin.value
        self.dir_value_func = dir_pin.value
        self.en_pin = en_pin
        self.invert_dir = invert_dir
        self.invert_enable = invert_enable

        self.enabled = True

        self.pos = 0
        self.target_pos = 0
        self.target_reached = True
        self.steps_per_rev = steps_per_rev
        self.steps_per_sec = speed_sps
        self.accel = accel_sps2

        self._mode = _IDLE
        self._dir = 1
        self._level = 0
        self._seg_left = 0

        # DDA state: _sps is this motor's current step rate; _acc accumulates it
        # against the engine tick rate and emits a step on each crossing.
        self._sps = 0
        self._acc = 0

        self._min_speed = min_speed_sps
        self._ramp_levels = max(2, ramp_levels)

        # Soft limits, in steps. None = unlimited on that side.
        self._min_limit = None
        self._max_limit = None

        # Homing state
        self._home_pin = None
        self._home_active = 0
        self._home_offset = 0

        # Rate measurement (see the ceiling note at the top of this file).
        self._seg_t0 = 0
        self._seg_pos0 = 0
        self._peak_sps = 0.0

        self._build_ramp()
        _engine.add(self)

    # ---------------------------------------------------------------- config

    def _build_ramp(self):
        """Recompute the speed staircase. Never called from the tick."""
        top = self.steps_per_sec
        a = self.accel
        if a <= 0 or top <= 0:
            # No acceleration: one level, unlimited segment length.
            self._speeds = [max(1, int(top))]
            self._seg = [0]
            self._cum = [0]
            self._top = 0
            return

        n = self._ramp_levels
        vmin = self._min_speed if self._min_speed > 0 else top / n
        if vmin > top:
            vmin = top
        if vmin < 1:
            vmin = 1

        speeds = []
        for i in range(n):
            speeds.append(vmin + (top - vmin) * i / (n - 1))

        # _seg[i] = steps to cross from level i to level i+1 under accel a.
        seg = []
        for i in range(n - 1):
            d = (speeds[i + 1] ** 2 - speeds[i] ** 2) / (2.0 * a)
            seg.append(max(1, int(d + 0.5)))
        seg.append(0)  # top level cruises; length decided per move

        # _cum[i] = steps needed to come to rest from level i.
        cum = [0]
        for i in range(n - 1):
            cum.append(cum[i] + seg[i])

        self._speeds = [max(1, int(s + 0.5)) for s in speeds]
        self._seg = seg
        self._cum = cum
        self._top = n - 1

    def speed(self, sps):
        self.steps_per_sec = sps
        self._build_ramp()
        if self._mode != _IDLE:
            if self._level > self._top:
                self._level = self._top
            self._next_segment()
            _engine.wake()  # the shared tick rate may need to change

    def speed_rps(self, rps):
        self.speed(rps * self.steps_per_rev)

    def speed_dps(self, dps):
        self.speed(dps * self.steps_per_rev / 360.0)

    def acceleration(self, sps2):
        """Acceleration in steps/s². 0 disables ramping (instant speed)."""
        self.accel = sps2
        self._build_ramp()
        if self._level > self._top:
            self._level = self._top

    def acceleration_rps2(self, rps2):
        self.acceleration(rps2 * self.steps_per_rev)

    def acceleration_dps2(self, dps2):
        self.acceleration(dps2 * self.steps_per_rev / 360.0)

    def set_limits(self, min_steps=None, max_steps=None):
        """Soft travel limits in steps. None clears that side."""
        self._min_limit = None if min_steps is None else int(min_steps)
        self._max_limit = None if max_steps is None else int(max_steps)

    def set_limits_deg(self, min_deg=None, max_deg=None):
        spr = self.steps_per_rev
        self.set_limits(
            None if min_deg is None else round(min_deg * spr / 360.0),
            None if max_deg is None else round(max_deg * spr / 360.0),
        )

    def set_limits_turns(self, min_turns=None, max_turns=None):
        spr = self.steps_per_rev
        self.set_limits(
            None if min_turns is None else round(min_turns * spr),
            None if max_turns is None else round(max_turns * spr),
        )

    def _clamp(self, t):
        if self._min_limit is not None and t < self._min_limit:
            return self._min_limit
        if self._max_limit is not None and t > self._max_limit:
            return self._max_limit
        return t

    # ------------------------------------------------------------- position

    def target(self, t):
        t = self._clamp(int(t))
        at_rest = self._mode == _IDLE
        if t == self.pos and at_rest:
            return
        self.target_pos = t
        self.target_reached = False
        self._mode = _POSITION
        self._home_pin = None
        # Re-targeting mid-move keeps the current speed level: dropping back to
        # level 0 would command an instant speed change and drop steps.
        self._start(at_rest)

    def target_deg(self, deg):
        self.target(round(self.steps_per_rev * deg / 360.0))

    def target_rad(self, rad):
        self.target(round(self.steps_per_rev * rad / (2.0 * math.pi)))

    def target_turns(self, turns):
        self.target(round(self.steps_per_rev * turns))

    def move(self, steps):
        """Relative move from the current *target* (so queued moves compose)."""
        base = self.target_pos if self._mode == _POSITION else self.pos
        self.target(base + int(steps))

    def move_deg(self, deg):
        self.move(round(self.steps_per_rev * deg / 360.0))

    def move_turns(self, turns):
        self.move(round(self.steps_per_rev * turns))

    def get_pos(self):
        return self.pos

    def get_pos_deg(self):
        return self.pos * 360.0 / self.steps_per_rev

    def get_pos_rad(self):
        return self.pos * (2.0 * math.pi) / self.steps_per_rev

    def get_pos_turns(self):
        return self.pos / self.steps_per_rev

    def overwrite_pos(self, p):
        self.pos = int(p)

    def overwrite_pos_deg(self, deg):
        self.overwrite_pos(round(deg * self.steps_per_rev / 360.0))

    def overwrite_pos_rad(self, rad):
        self.overwrite_pos(round(rad * self.steps_per_rev / (2.0 * math.pi)))

    def overwrite_pos_turns(self, turns):
        self.overwrite_pos(round(turns * self.steps_per_rev))

    # ------------------------------------------------------------ free run

    def free_run(self, d):
        """Rotate continuously: d>0 forward, d<0 back, 0 stops (ramped)."""
        if d == 0:
            self.stop()
            return
        at_rest = self._mode == _IDLE
        self._dir = 1 if d > 0 else -1
        self._home_pin = None
        # A soft limit in the direction of travel turns this into a position
        # move, so the ramp still lands exactly on the limit.
        stop_at = self._max_limit if self._dir > 0 else self._min_limit
        if stop_at is not None:
            self.target(stop_at)
            return
        self.target_reached = False
        self._mode = _FREE
        self._start(at_rest)

    # -------------------------------------------------------------- homing

    def home(self, endstop_pin, direction=-1, speed_sps=None, active_low=True, set_pos=0):
        """Seek an endstop, then zero the position there.

        Non-blocking like every other move: poll is_target_reached(). The
        endstop is read once per tick, so keep the homing speed low enough that
        one step of overshoot is acceptable.
        """
        if not isinstance(endstop_pin, machine.Pin):
            endstop_pin = machine.Pin(endstop_pin, machine.Pin.IN, machine.Pin.PULL_UP)
        self._home_pin = endstop_pin.value
        self._home_active = 0 if active_low else 1
        self._home_offset = set_pos

        self._saved_speed = self.steps_per_sec
        if speed_sps:
            self.speed(speed_sps)

        self._dir = 1 if direction > 0 else -1
        self.target_reached = False
        self._mode = _HOMING
        self._start()

    def is_homed(self):
        return self._mode != _HOMING and self._home_pin is None

    # --------------------------------------------------------------- motion

    def stop(self):
        """Ramped stop: aim at the nearest point we can decelerate into."""
        if self._mode == _IDLE:
            return
        if self.accel <= 0:
            self.hard_stop()
            return
        self._home_pin = None
        self.target_pos = self.pos + self._dir * self._cum[self._level]
        self._mode = _POSITION
        # Re-plan now: the current segment could otherwise run past the new
        # target before the next planning point and force a reversal.
        self._next_segment()
        _engine.wake()

    def hard_stop(self):
        """Stop immediately. Loses steps on a loaded motor — prefer stop()."""
        self._mode = _IDLE
        self._home_pin = None
        self.target_pos = self.pos
        self.target_reached = True
        self._level = 0
        self._sps = 0
        _engine.wake()  # recompute the tick rate, or halt if this was the last

    def enable(self, e):
        self.enabled = e
        if self.en_pin:
            self.en_pin.value(bool(e) ^ self.invert_enable)
        if not e:
            self.hard_stop()

    def is_enabled(self):
        return self.enabled

    def is_target_reached(self):
        return self.target_reached

    def is_moving(self):
        return not self.target_reached

    def achieved_sps(self):
        """Fastest step rate actually delivered during the last move.

        Timed per segment, so it reflects the cruise phase rather than being
        dragged down by the ramps. If this comes back well below the speed you
        asked for, the shared tick could not keep up — the position is still
        correct, but the move ran slow. Lower the speed until the two agree.
        """
        return self._peak_sps

    # ----------------------------------------------------------- internals

    def _start(self, from_rest=True):
        if self._mode == _IDLE:
            return
        if from_rest:
            self._level = 0
            self._peak_sps = 0.0
        self._next_segment()
        _engine.add(self)
        _engine.wake()

    def _finish(self):
        """Movement complete. May run in tick context — no timer touching here;
        the engine notices all-idle on its next pass and halts itself."""
        self._mode = _IDLE
        self._level = 0
        self._seg_left = 0
        self._sps = 0
        self.target_reached = True

    def _next_segment(self):
        """Pick the next constant-speed segment. May run in tick context."""
        # Time the segment just finished. Once per segment, so it costs nothing
        # per step, and it is the only way to notice dropped ticks.
        now = time.ticks_ms()
        dt = time.ticks_diff(now, self._seg_t0)
        if dt > 0:
            done = self.pos - self._seg_pos0
            if done < 0:
                done = -done
            if done > 0:
                rate = done * 1000.0 / dt
                if rate > self._peak_sps:
                    self._peak_sps = rate
        self._seg_t0 = now
        self._seg_pos0 = self.pos

        m = self._mode
        lvl = self._level
        top = self._top

        if m == _POSITION:
            delta = self.target_pos - self.pos
            if delta == 0:
                self._finish()
                return
            new_dir = 1 if delta > 0 else -1
            if new_dir != self._dir and lvl > 0:
                # Reversing at speed would drop steps. Keep going the old way
                # and ramp down first; the reversal happens once we hit level 0.
                lvl -= 1
                self._level = lvl
                self._seg_left = self._seg[lvl]
                self._sps = self._speeds[lvl]
                return
            self._dir = new_dir
            remaining = delta if delta > 0 else -delta

            if lvl > 0 and remaining <= self._cum[lvl]:
                lvl -= 1                      # too fast to stop in time
                count = self._seg[lvl]
            elif lvl < top and remaining > self._seg[lvl] + self._cum[lvl + 1]:
                lvl += 1                      # room to go faster and still stop
                count = self._seg[lvl - 1]
            else:
                count = remaining - self._cum[lvl]
                if count < 1:
                    count = 1
        else:
            # Free run and homing: ramp to top speed and hold there.
            if lvl < top:
                lvl += 1
                count = self._seg[lvl - 1]
            else:
                count = _CRUISE_CHUNK

        self._level = lvl
        self._seg_left = count
        self._sps = self._speeds[lvl]

    def _on_endstop(self):
        """Endstop hit while homing. Tick context."""
        self.pos = self._home_offset
        self.target_pos = self._home_offset
        self._home_pin = None
        if hasattr(self, "_saved_speed"):
            self.steps_per_sec = self._saved_speed
            self._build_ramp()
        self._finish()

    def step(self, d):
        """One step in direction d. Also usable standalone for manual jogging."""
        if d > 0:
            if self.enabled:
                self.dir_value_func(1 ^ self.invert_dir)
                self.step_value_func(1)
                self.step_value_func(0)
            self.pos += 1
        elif d < 0:
            if self.enabled:
                self.dir_value_func(0 ^ self.invert_dir)
                self.step_value_func(1)
                self.step_value_func(0)
            self.pos -= 1

    def _dda_tick(self, base):
        """One engine tick for this motor: emit a step when the phase
        accumulator crosses the tick rate. Runs in the timer callback."""
        if self._mode == _HOMING and self._home_pin() == self._home_active:
            self._on_endstop()
            return

        self._acc += self._sps
        if self._acc >= base:
            self._acc -= base
            d = self._dir
            if self.enabled:
                self.dir_value_func((1 if d > 0 else 0) ^ self.invert_dir)
                self.step_value_func(1)
                self.step_value_func(0)
            self.pos += d
            self._seg_left -= 1
            if self._seg_left <= 0:
                self._next_segment()
