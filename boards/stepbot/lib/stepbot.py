# Bloq — offline block-based MicroPython IDE
# Copyright (C) 2026 Benjamin Balga
# SPDX-License-Identifier: GPL-3.0-or-later

# Driver for the StepBot dual stepper co-processor (CH32V003 + 2x STSPIN220) over OneWire.
#
# Units: distances in mm, speeds in mm/s, accelerations in mm/s², angles in degrees.
# Positive distances and speeds move the robot forward, positive turn angles turn left (counter-clockwise).
# Moves are synchronized: both wheels start, accelerate and stop together.

from machine import Pin
from micropython import const
import onewire
import math
import struct
import time

_CMD_STOP = const(0x01)
_CMD_HALT = const(0x02)
_CMD_RELEASE = const(0x03)
_CMD_ENABLE = const(0x04)
_CMD_RESET_POSITION = const(0x05)
_CMD_SPEED = const(0x10)
_CMD_MOVE = const(0x11)
_CMD_SET_ACCELERATION = const(0x20)
_CMD_SET_MICROSTEP = const(0x21)
_CMD_SET_CURRENT = const(0x22)
_CMD_SET_TIMEOUT = const(0x23)
_CMD_GET_STATUS = const(0x30)
_CMD_GET_INFO = const(0x31)

_ST_MOVING = const(0x01)
_ST_BUSY = const(0x02)
_ST_ENABLED = const(0x04)
_ST_FAULT = const(0x18)
_ST_VALID = const(0x80)

_ACK_INVALID = const(0x40)
_RETRIES = const(5)
_BOOT_MS = const(500) # the board boots faster than the ESP32, this only covers a slow first answer
_POLL_MS = const(10)

_MICROSTEPS = (1, 2, 4, 8, 16, 32, 64, 128, 256)

class StepBot:
  MotorLeftAndRight = const(1)
  MotorLeft = const(2)
  MotorRight = const(3)

  Forward = const(0)
  Backward = const(3)
  Stop = const(6)
  Brake = const(9)


class Motors:
  def __init__(self, pin=2):
    self.ow = onewire.OneWire(Pin(pin))
    self._seq = time.ticks_ms() & 0xFF
    self._ready = False
    self._velocity = [0.0, 0.0] # last commanded speeds (mm/s), to change one motor at a time

    # Mechanics
    self.steps_per_rev = 200   # full steps per motor revolution
    self.microsteps = 16
    self.wheel_diameter = 65.0 # mm
    self.wheel_track = 120.0   # mm, distance between the two wheels (for turns)
    self.invert_left = False   # motors are mirrored: one of them turns the other way
    self.invert_right = True

    # Motion
    self.speed = 100.0         # mm/s, default speed of moves and turns
    self.max_speed = 200.0     # mm/s, 100% for spin()
    self.acceleration = 400.0  # mm/s², 0 = no ramp
    self.run_current = 50      # % of the REF full scale while moving (1 ohm sense: 100% ~ 0.52A peak)
    self.hold_current = 25     # % when stopped (after 0.5s)
    self.timeout = 0           # ms without communication before an automatic stop, 0 = off

    self.max_step_rate = 80000 # updated from the board

  # ---------------------------------------------------------------- Settings

  def set_wheel(self, diameter, track=None):
    """Wheel diameter and distance between the wheels, in mm."""
    self.wheel_diameter = float(diameter)
    if track is not None:
      self.wheel_track = float(track)
    if self._ready:
      self._send_acceleration()

  def set_steps_per_rev(self, steps):
    """Full steps per motor revolution (200 for 1.8° motors)."""
    self.steps_per_rev = int(steps)
    if self._ready:
      self._send_acceleration()

  def set_microsteps(self, microsteps):
    """1, 2, 4, 8, 16, 32, 64, 128 or 256. The motors are stopped first.

    Set it once at the start of a program: each change resets the drivers, the wheels snap
    up to 2 full steps (~2mm, ~2° of heading) and distance() does not count that snap.
    Setting the value already in use does nothing."""
    if microsteps not in _MICROSTEPS:
      raise ValueError("StepBot: microsteps must be one of %s" % (_MICROSTEPS,))
    previous = self.microsteps
    self.microsteps = microsteps
    if self._ready:
      self.stop()
      self.wait()
      try:
        self._send_microsteps()
      except ValueError:
        self.microsteps = previous
        raise
      self._send_acceleration()

  def set_speed(self, speed):
    """Default speed of moves and turns, in mm/s."""
    self.speed = abs(float(speed))

  def set_max_speed(self, speed):
    """Speed for spin() at 100%, in mm/s."""
    self.max_speed = abs(float(speed))

  def set_acceleration(self, acceleration):
    """In mm/s², 0 to start and stop instantly."""
    self.acceleration = abs(float(acceleration))
    if self._ready:
      self._send_acceleration()

  def set_current(self, run, hold=None):
    """Motor current in % of the maximum, while moving and when stopped."""
    self.run_current = max(0, min(100, run))
    if hold is not None:
      self.hold_current = max(0, min(100, hold))
    if self._ready:
      self._send_current()

  def set_timeout(self, ms):
    """Stop the motors if the board receives nothing for ms milliseconds (0 = never)."""
    self.timeout = max(0, min(65535, int(ms)))
    if self._ready:
      self._command(_CMD_SET_TIMEOUT, struct.pack('<H', self.timeout))

  def set_inverted(self, left, right):
    """Reverse the direction of a motor."""
    self.invert_left = bool(left)
    self.invert_right = bool(right)

  # ---------------------------------------------------------------- Continuous motion

  def drive(self, left, right):
    """Turn both wheels continuously, speeds in mm/s (negative = backward)."""
    self._velocity = [float(left), float(right)]
    l, r = self._oriented(self._rate(left), self._rate(right))
    self._command(_CMD_SPEED, struct.pack('<ii', l, r))

  def run(self, motor, speed):
    """Turn one motor (or both) continuously at speed mm/s, the other keeps its speed."""
    left, right = self._velocity
    if motor in (MotorLeft, MotorLeftAndRight):
      left = speed
    if motor in (MotorRight, MotorLeftAndRight):
      right = speed
    self.drive(left, right)

  def forward(self, speed=None):
    self.drive(*(2 * [self._speed(speed)]))

  def backward(self, speed=None):
    self.drive(*(2 * [-self._speed(speed)]))

  def spin(self, motor, direction, speed):
    """EspBot compatible: speed in % of max_speed."""
    if direction == Stop:
      return self.stop(motor)
    if direction == Brake:
      return self.brake(motor)
    if direction not in (Forward, Backward) or motor not in (MotorLeftAndRight, MotorLeft, MotorRight):
      return
    speed = max(0, min(100, speed)) * self.max_speed / 100
    self.run(motor, -speed if direction == Backward else speed)

  # ---------------------------------------------------------------- Moves

  def move(self, distance, speed=None, wait=True):
    """Drive straight for distance mm (negative = backward)."""
    self.move_motors(distance, distance, speed, wait)

  def turn(self, angle, speed=None, wait=True):
    """Turn in place by angle degrees, positive = left. speed is the wheel speed in mm/s."""
    arc = math.pi * self.wheel_track * angle / 360
    self.move_motors(-arc, arc, speed, wait)

  def turn_left(self, angle, speed=None, wait=True):
    self.turn(abs(angle), speed, wait)

  def turn_right(self, angle, speed=None, wait=True):
    self.turn(-abs(angle), speed, wait)

  def arc(self, radius, angle, speed=None, wait=True):
    """Drive along a circle of radius mm (center on the left if positive, right if negative)
    for angle degrees (negative = backward). speed is the outer wheel speed in mm/s."""
    theta = math.radians(angle)
    inner = theta * (abs(radius) - self.wheel_track / 2)
    outer = theta * (abs(radius) + self.wheel_track / 2)
    if radius >= 0:
      self.move_motors(inner, outer, speed, wait)
    else:
      self.move_motors(outer, inner, speed, wait)

  def rotate(self, motor, degrees, speed=None, wait=True):
    """Rotate one wheel (or both) by degrees, the other one stays still."""
    distance = math.pi * self.wheel_diameter * degrees / 360
    left = distance if motor in (MotorLeft, MotorLeftAndRight) else 0
    right = distance if motor in (MotorRight, MotorLeftAndRight) else 0
    self.move_motors(left, right, speed, wait)

  def move_motors(self, left, right, speed=None, wait=True):
    """Move each wheel by its own distance in mm, synchronized.
    speed (mm/s) applies to the wheel with the longest distance."""
    spm = self._steps_per_mm()
    self._move(round(left * spm), round(right * spm), self._rate(self._speed(speed)), wait)

  def move_steps(self, left, right, speed=None, wait=True):
    """Move each motor by a number of full steps (fractions use microsteps), speed in full steps/s."""
    ms = self.microsteps
    if speed is None:
      rate = self._rate(self.speed)
    else:
      rate = min(round(abs(speed) * ms), self.max_step_rate)
    self._move(round(left * ms), round(right * ms), rate, wait)

  # ---------------------------------------------------------------- Stopping

  def stop(self, motor=MotorLeftAndRight):
    """Slow down and stop (the motors keep holding their position)."""
    if motor == MotorLeftAndRight:
      self._velocity = [0.0, 0.0]
      self._command(_CMD_STOP)
    else:
      self.run(motor, 0)

  def brake(self, motor=MotorLeftAndRight):
    """Stop now, without slowing down (one motor alone slows down)."""
    if motor == MotorLeftAndRight:
      self._velocity = [0.0, 0.0]
      self._command(_CMD_HALT)
    else:
      self.run(motor, 0)

  def release(self):
    """Stop and power off the motors: the wheels turn freely."""
    self._velocity = [0.0, 0.0]
    self._command(_CMD_RELEASE)

  def hold(self):
    """Power the motors to hold their position."""
    self._command(_CMD_ENABLE)

  # ---------------------------------------------------------------- State

  def busy(self):
    """True while a move (or a stop) is in progress."""
    return bool(self._status()[0] & _ST_BUSY)

  def moving(self):
    """True while any motor turns."""
    return bool(self._status()[0] & _ST_MOVING)

  def wait(self, timeout=None):
    """Wait for the current move to finish. Returns False on timeout (ms)."""
    start = time.ticks_ms()
    while True:
      flags = self._status()[0]
      if flags & _ST_FAULT:
        raise OSError("StepBot: motor driver fault (short circuit or overheating)")
      if not flags & _ST_BUSY:
        return True
      if timeout is not None and time.ticks_diff(time.ticks_ms(), start) >= timeout:
        return False
      time.sleep_ms(_POLL_MS)

  def fault(self):
    """True if a driver detected a short circuit or overheating (cleared by the next move)."""
    return bool(self._status()[0] & _ST_FAULT)

  def steps(self, motor):
    """Full steps done by a motor since the last reset."""
    _, left, right = self._positions()
    return (left if motor == MotorLeft else right) / self.microsteps

  def distance(self, motor=MotorLeftAndRight):
    """Distance in mm driven by a wheel, or the robot (average), since the last reset."""
    _, left, right = self._positions()
    spm = self._steps_per_mm()
    if motor == MotorLeft:
      return left / spm
    if motor == MotorRight:
      return right / spm
    return (left + right) / 2 / spm

  def reset_distance(self):
    self._command(_CMD_RESET_POSITION)

  def info(self):
    """(firmware version, all microsteps available, max step rate)"""
    b = self._query(_CMD_GET_INFO, 8)
    return b[2], bool(b[3] & 1), self._max_rate(b)

  # ---------------------------------------------------------------- Text commands

  def spinFromText(self, command_text):
    # Parse: RIGHT FORWARD 50
    values = command_text.split(" ")
    if len(values) < 2:
      print("StepBot: Invalid command (1):", command_text)
      return

    def getMotor(text):
      if text == "LEFT" or text == "L":
        return MotorLeft
      elif text == "RIGHT" or text == "R":
        return MotorRight
      elif text == "BOTH" or text == "LEFTRIGHT" or text == "LR":
        return MotorLeftAndRight
      else:
        return -1

    if values[1] == "STOP":
      self.stop(getMotor(values[0]))
      return

    if values[1] == "BRAKE":
      self.brake(getMotor(values[0]))
      return

    if len(values) < 3:
      print("StepBot: Invalid command (2):", command_text)
      return

    def getDirection(text):
      if text == "FORWARD":
        return Forward
      elif text == "BACKWARD":
        return Backward
      else:
        return -1

    try:
      self.spin(getMotor(values[0]), getDirection(values[1]), int(values[2]))
    except:
      print("StepBot: Invalid command (3):", command_text)

  # ---------------------------------------------------------------- Internals

  def _steps_per_mm(self):
    return self.steps_per_rev * self.microsteps / (math.pi * self.wheel_diameter)

  def _speed(self, speed):
    return self.speed if speed is None else abs(speed)

  def _rate(self, speed):
    """mm/s -> (micro)steps/s, limited to what the board can do"""
    rate = round(speed * self._steps_per_mm())
    return max(-self.max_step_rate, min(self.max_step_rate, rate))

  def _oriented(self, left, right):
    return (-left if self.invert_left else left), (-right if self.invert_right else right)

  def _move(self, left, right, rate, wait):
    l, r = self._oriented(left, right)
    self._velocity = [0.0, 0.0]
    self._command(_CMD_MOVE, struct.pack('<iiI', l, r, max(1, abs(rate))))
    if wait:
      self.wait()

  def _positions(self):
    b = self._status()
    left, right = struct.unpack_from('<ii', b, 2)
    left, right = self._oriented(left, right)
    # The board scales its counters when the resolution changes
    return b[1], left, right

  def _status(self):
    b = self._query(_CMD_GET_STATUS, 10)
    if not b[0] & _ST_VALID:
      raise OSError("StepBot: invalid status")
    return b

  def _max_rate(self, info):
    if info[2] < 2: # version 1: u16 tick rate, u16 max step rate
      return info[6] | info[7] << 8
    return struct.unpack_from('<I', info, 4)[0]

  def _send_microsteps(self):
    self._command(_CMD_SET_MICROSTEP, bytes((_MICROSTEPS.index(self.microsteps),)))

  def _send_acceleration(self):
    accel = round(self.acceleration * self._steps_per_mm())
    self._command(_CMD_SET_ACCELERATION, struct.pack('<I', accel))

  def _send_current(self):
    run = round(self.run_current * 255 / 100)
    hold = round(self.hold_current * 255 / 100)
    self._command(_CMD_SET_CURRENT, bytes((run, hold)))

  def _setup(self):
    # Settings are sent on first use: the board may have been reset, or configured by a previous program
    if self._ready:
      return
    self._ready = True
    try:
      deadline = time.ticks_add(time.ticks_ms(), _BOOT_MS)
      while True:
        try:
          b = self._query(_CMD_GET_INFO, 8)
          break
        except OSError:
          if time.ticks_diff(deadline, time.ticks_ms()) <= 0:
            raise
          time.sleep_ms(50)
      if b[0] != 0x53 or b[1] != 0x42: # 'SB'
        raise OSError("StepBot: not a stepper motor board")
      self.max_step_rate = self._max_rate(b)
      self._send_microsteps()
      self._send_acceleration()
      self._send_current()
      self._command(_CMD_SET_TIMEOUT, struct.pack('<H', self.timeout))
    except:
      self._ready = False
      raise

  def _frame(self, cmd, payload):
    frame = bytearray((cmd, self._seq)) + payload
    frame.append(self.ow.crc8(frame))
    return frame

  def _command(self, cmd, payload=b''):
    self._setup()
    self._seq = (self._seq + 1) & 0xFF
    frame = self._frame(cmd, payload)
    present = False
    for _ in range(_RETRIES):
      if self.ow.reset():
        present = True
        self.ow.write(frame)
        ack = self.ow.readbyte()
        if ack == (~cmd & 0xFF):
          return
        if ack == cmd | _ACK_INVALID:
          raise ValueError("StepBot: setting not supported by the board")
        # cmd: command queue full, anything else: transmission error
      time.sleep_ms(2)
    self._fail(present)

  def _query(self, cmd, length):
    if cmd != _CMD_GET_INFO:
      self._setup()
    frame = self._frame(cmd, b'')
    buf = bytearray(length + 1)
    present = False
    for _ in range(_RETRIES):
      if self.ow.reset():
        present = True
        self.ow.write(frame)
        self.ow.readinto(buf)
        if self.ow.crc8(buf) == 0:
          return buf
      time.sleep_ms(2)
    self._fail(present, buf)

  def _fail(self, present, answer=None):
    if not present:
      raise OSError("StepBot: motor board not found (no presence pulse)")
    if answer is None:
      raise OSError("StepBot: motor board does not acknowledge")
    raise OSError("StepBot: bad answer from the motor board: " + ' '.join('%02x' % x for x in answer))


motors = Motors()
