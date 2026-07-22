# core-stepper

STEP/DIR stepper motors (A4988, DRV8825, TMC2209 in step/dir mode, …) with
trapezoidal acceleration, position and continuous-speed control, soft travel
limits and endstop homing.

Backed by `lib/BloqStepper.py`, derived from
[redoxcode/micropython-stepper](https://github.com/redoxcode/micropython-stepper)
(MIT — see the header of that file). The upstream driver is a clean
`machine.Timer`-per-stepper design that works on any port but steps at a fixed
rate; this version adds the ramp without giving up the portability.

## One shared timer for every motor

Hardware timers are scarce and their numbering isn't portable: an **ESP32-C3
has only two**, and on at least some firmware asking for a third *silently
aliases* onto an existing one instead of raising — so "one timer per motor"
quietly breaks the moment you add a second stepper (the first symptom is "only
one motor moves"). So every stepper is driven from a **single** module-level
timer owned by an engine inside the driver. It works the same whether the board
has 2 timers or 16, there's nothing per-motor to run out of, and the timer is
torn down whenever nothing is moving so no state bleeds across runs.

Each motor carries a phase accumulator (a DDA): every tick it adds its own
current step rate and emits a step whenever the accumulator crosses the tick
rate. That gives every motor its own speed and its own independent ramp off one
clock, and it's lighter on the scheduler queue than N separate timers would be.

### Ramp smoothness (the tick oversamples)

The tick runs at an integer *multiple* of the fastest active motor's speed, not
exactly its speed. Ticking at exactly the top speed makes cruise smooth (one
step per tick) but leaves accel/decel jagged: a ramp level whose speed doesn't
divide the tick rate produces uneven step intervals (1, 2, 1, 2 ticks…), which
is audible. Oversampling by *k* keeps the fastest motor's cruise perfectly even
(a step every *k* ticks) while cutting that jitter *k*-fold.

*k* scales down as motors and speed rise, so the callback rate stays within
budget, and the tick is never slower than the top speed, so it never caps a
motor. Two knobs at the top of `BloqStepper.py`:

- `_SMOOTH_TICK` (default 3000) — the tick rate the oversampler aims for. Raise
  it for smoother ramps if your board has callback headroom; lower it if fast
  multi-motor moves start dropping steps (`achieved_sps()` falling below the
  commanded speed is the tell).
- `ramp_levels` (default 32) — how many discrete speed steps the trapezoid uses.
  More = smaller speed jumps.

## How the ramp works

The trapezoid is a **staircase of constant-rate segments**. A short speed table
is precomputed whenever speed or acceleration changes, and a motor only changes
its step rate when a segment's step budget runs out — tens of times per move
instead of thousands.

Every step is still counted in software, so **position is exact regardless of
how coarse the staircase is**. Deceleration begins as soon as the remaining
distance drops to the stopping distance for the current speed level, which is
what makes moves land on target rather than overshoot.

Acceleration `0` collapses the table to one level, giving constant speed.

## Step rate ceiling — the thing to actually test

`machine.Timer` callbacks are dispatched through `mp_sched_schedule()` on both
the esp32 and rp2 ports, not from the ISR. That queue is **8 deep and shared**
with pin IRQs and UART, and when it overflows **callbacks are silently
dropped** — no error, no counter.

The saving grace is that a dropped callback emits no pulse *and* increments no
counter, so the software position still matches the shaft. **Overload costs
speed, not accuracy**: moves take longer than the profile predicts and the ramp
shape distorts, but the motor still ends up where it was told to go.

Because the failure is invisible, the driver measures itself. `achieved_sps()`
(the *"stepper … measured speed"* block) reports the fastest rate actually
delivered during the last move, timed per segment so the ramps don't drag the
figure down. **Compare it against the speed you asked for and lower the speed
until they agree.**

Expect somewhere around 1–2 kHz as a starting guess — that figure is an estimate
from the dispatch design, not a measurement, and it depends on the board, the
clock and everything else competing for the scheduler queue. Measure it on your
hardware. Because all motors share the one engine tick, that ceiling is a
**budget for the whole set**: the engine runs at the fastest active motor's rate,
so two motors at 800 steps/s cost about the same as one, but one motor at
2 kHz alongside others pushes the shared tick toward the limit.

If you need materially more than that, no portable option exists: it takes a
port-specific pulse generator (rp2 PIO, esp32 RMT). That would be a different
driver behind the same block set.

## Which timer the engine uses

The engine claims exactly one `machine.Timer` for the whole program, on demand,
and releases it when every motor is idle:

- **esp32** (including C3): `Timer(0)` — a concrete id, because `Timer(-1)`
  raises on esp32. If your own code also uses timer 0, pass a different motor
  count or coordinate; in practice Bloq programs don't touch it directly.
- **everything else** (rp2, etc.): `Timer(-1)`, the virtual timer.

This is why you can now set up as many steppers as you have pins without running
out of timers or hitting the silent-aliasing bug.

## Wiring

- **STEP** and **DIR** to any output pins; the setup block identifies the motor
  by its STEP pin.
- **ENABLE** is optional (choose *none*). Most driver boards treat it as active
  low, which `invert_enable` handles if yours doesn't.
- **Endstop** for homing: wire the switch to ground and leave the default
  *active low*; the driver enables the internal pull-up.
- **Steps per turn** must include microstepping — a 200-step motor on a driver
  set to 1/16 is `3200`. Every degree and turn conversion depends on this being
  right.

## Tests

`python3 scripts/stepper.test.py` runs the motion state machine on the host with
`machine` stubbed, checking that moves land exactly on target, speed never
exceeds the commanded top, reversals ramp down before turning around, soft
limits and homing land on the right position, and dropped callbacks degrade
speed without corrupting position. No board required.

Block codegen is covered in `scripts/codegen.test.ts`.
