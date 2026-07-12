from machine import Pin
import onewire

class EspBot:
  MotorLeftAndRight  = const(1)
  MotorLeft   = const(2)
  MotorRight  = const(3)

  Forward     = const(0)
  Backward    = const(3)
  Stop        = const(6)
  Brake       = const(9)

  class Command:
    AllForward = const(1)
    LeftForward = const(2)
    RightForward = const(3)
    AllBackward = const(4)
    LeftBackward = const(5)
    RightBackward = const(6)
    AllStop = const(7)
    LeftStop = const(8)
    RightStop = const(9)
    AllBrake = const(10)
    LeftBrake = const(11)
    RightBrake = const(12)


class Motors:
  def __init__(self):
    self.ow = onewire.OneWire(Pin(2))

  def spin(self, motor, direction, speed):
    if direction < Forward or direction > Brake:
      return
    if motor < MotorLeftAndRight or motor > MotorRight:
      return

    speed = max(0, min(255, speed*255/100))
    command = motor + direction

    self.ow.reset()
    self.ow.writebyte(int(command))
    #if command < AllStop:
    self.ow.writebyte(int(speed)) # will be ignored if not needed


  def stop(self, motor):
    self.spin(motor, Stop, 0)

  def brake(self, motor):
    self.spin(motor, Brake, 0)

  def spinFromText(self, command_text):
    # Parse: RIGHT FORWARD 50
    values = command_text.split(" ")
    #print("EspBot: values:",values)
    if len(values) < 2:
      print("EspBot: Invalid command (1):",command_text)
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
      print("EspBot: Invalid command (2):",command_text)
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
      print("EspBot: Invalid command (3):",command_text)


motors = Motors()
