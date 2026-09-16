# Bloq — offline block-based MicroPython IDE
# Copyright (C) 2026 Benjamin Balga
# SPDX-License-Identifier: GPL-3.0-or-later

# BloqServo — hobby servos (positional and continuous-rotation) on machine.PWM.
#
# A hobby servo is commanded by the *width* of a pulse repeated at ~50 Hz, not
# by a duty cycle: ~500 µs is one end of the travel, ~2500 µs the other, and the
# servo holds whatever angle the last pulse asked for. This driver keeps the
# pulse-width arithmetic (and the per-servo calibration it needs) out of the
# generated program, which then reads as `servo.angle(90)`.
#
# Two things a beginner hits, handled here:
#
#  * **Calibration.** No two servos agree on what pulse means "0°". The default
#    500–2500 µs over 180° suits most, and `set_range()` trims it for the rest —
#    narrowing the range is also how you stop a servo buzzing against its own
#    end stop, which is what eventually strips the gears.
#  * **Speed.** A servo snaps to a new angle as fast as it can. `move_to()`
#    spreads the travel over a duration by stepping the pulse a little at a
#    time; `update()` advances it from the clock, so the caller polls (simple
#    mode) or yields (scheduler mode) exactly like every other Bloq wait, and
#    one slow servo never blocks another stack.
#
# A continuous-rotation servo is the same hardware with the feedback pot
# disconnected: pulse width then sets speed and direction, not position, with
# the middle of the range meaning "stop". That is `speed()`.

import time

from machine import PWM, Pin

# Widest pulse either side of centre that a continuous-rotation servo responds
# to. Beyond ±500 µs from stop they are already at full speed, so scaling the
# percentage over a wider span would just waste the top of the range.
_MAX_SPEED_SPAN_US = 500


class Servo:
    def __init__(self, pin, freq=50, min_us=500, max_us=2500, max_angle=180):
        self._pwm = PWM(Pin(pin))
        self._pwm.freq(freq)
        self._pwm.duty_u16(0)  # stay quiet (and limp) until commanded
        self._period_us = 1000000 // freq
        self._on = False
        self._started = False  # True once a pulse has actually been commanded
        self._moving = False
        self._from_us = 0
        self._to_us = 0
        self._t0 = 0
        self._ms = 0
        self.set_range(min_us, max_us, max_angle)

    # ---- calibration ----

    def set_range(self, min_us, max_us, max_angle=180):
        """Pulse widths for the two ends of the travel, and the angle between."""
        self._min_us = int(min_us)
        self._max_us = int(max_us)
        self._max_angle = max_angle
        self._stop_us = (self._min_us + self._max_us) // 2
        span = (self._max_us - self._min_us) // 2
        self._speed_span_us = span if span < _MAX_SPEED_SPAN_US else _MAX_SPEED_SPAN_US
        if not self._started:
            # Nothing has been commanded yet, so where the horn actually sits is
            # unknown. Assume mid-travel, which is what `read_angle()` reports
            # and what a first timed move interpolates from.
            self._us = self._stop_us

    # ---- pulse width (the primitive every other method goes through) ----

    def write_us(self, us):
        """Command a pulse width, clamped to the calibrated range."""
        us = int(us)
        if us < self._min_us:
            us = self._min_us
        elif us > self._max_us:
            us = self._max_us
        self._us = us
        self._started = True
        self._on = True
        self._pwm.duty_u16(us * 65535 // self._period_us)
        return us

    def read_us(self):
        """The pulse width last commanded (kept across a release)."""
        return self._us

    def us_for_angle(self, deg):
        if deg < 0:
            deg = 0
        elif deg > self._max_angle:
            deg = self._max_angle
        return self._min_us + (self._max_us - self._min_us) * deg / self._max_angle

    # ---- position ----

    def angle(self, deg):
        """Go to an angle as fast as the servo can. Cancels a timed move."""
        self._moving = False
        self.write_us(self.us_for_angle(deg))

    def read_angle(self):
        """The angle last commanded (mid-travel before the first command)."""
        span = self._max_us - self._min_us
        if span <= 0:
            return 0
        return (self._us - self._min_us) * self._max_angle / span

    def move_to(self, deg, ms):
        """Start a timed move to `deg` spread over `ms`.

        Returns immediately; call `update()` until it returns True.
        """
        self._from_us = self._us
        self._to_us = self.us_for_angle(deg)
        self._ms = int(ms)
        self._t0 = time.ticks_ms()
        self._moving = self._ms > 0
        if not self._moving:
            self.write_us(self._to_us)

    def update(self):
        """Advance a timed move. True once it has finished (or none is running)."""
        if not self._moving:
            return True
        t = time.ticks_diff(time.ticks_ms(), self._t0)
        if t >= self._ms:
            self.write_us(self._to_us)
            self._moving = False
            return True
        self.write_us(self._from_us + (self._to_us - self._from_us) * t / self._ms)
        return False

    def is_moving(self):
        return self._moving

    # ---- continuous rotation ----

    def speed(self, percent):
        """Continuous-rotation servo: -100 (full reverse) … 0 (stop) … 100."""
        if percent > 100:
            percent = 100
        elif percent < -100:
            percent = -100
        self._moving = False
        self.write_us(self._stop_us + self._speed_span_us * percent / 100)

    # ---- power ----

    def release(self):
        """Stop pulsing: the servo stops holding and the horn turns freely."""
        self._moving = False
        self._on = False
        self._pwm.duty_u16(0)

    def hold(self):
        """Resume pulsing at the last commanded position."""
        self.write_us(self._us)

    def is_holding(self):
        return self._on

    def deinit(self):
        self.release()
        self._pwm.deinit()
