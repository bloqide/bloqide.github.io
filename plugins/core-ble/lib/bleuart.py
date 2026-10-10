# Bloq — offline block-based MicroPython IDE
# Copyright (C) 2026 Benjamin Balga
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This file is part of Bloq and, as a combined work, is distributed under the
# GNU General Public License v3 or later; see LICENSE at the repository root.
#
# ---------------------------------------------------------------------------
# The advertising helpers (advertising_payload, decode_field, decode_name,
# decode_services) and the BleUart class are derived from the MicroPython BLE
# examples ble_advertising.py and ble_uart_peripheral.py:
#   https://github.com/micropython/micropython/tree/master/examples/bluetooth
#
# Those portions remain available under their original MIT terms:
#
#   The MIT License (MIT)
#
#   Copyright (c) 2013-2026 Damien P. George
#
#   Permission is hereby granted, free of charge, to any person obtaining a
#   copy of this software and associated documentation files (the "Software"),
#   to deal in the Software without restriction, including without limitation
#   the rights to use, copy, modify, merge, publish, distribute, sublicense,
#   and/or sell copies of the Software, and to permit persons to whom the
#   Software is furnished to do so, subject to the following conditions:
#
#   The above copyright notice and this permission notice shall be included in
#   all copies or substantial portions of the Software.
#
#   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
#   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
#   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
#   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
#   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
#   FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
#   DEALINGS IN THE SOFTWARE.
#
# The BleControlPad class is original Bloq code; the "!B" packet format it
# parses is the Adafruit Bluefruit LE Connect controller wire protocol.
# ---------------------------------------------------------------------------

import bluetooth
from micropython import const
import struct
import bloq_ble

# org.bluetooth.characteristic.gap.appearance.xml
_ADV_APPEARANCE_GENERIC_COMPUTER = const(128)


# Advertising payloads are repeated packets of the following form:
#   1 byte data length (N + 1)
#   1 byte type (see constants below)
#   N bytes type-specific data

_ADV_TYPE_FLAGS = const(0x01)
_ADV_TYPE_NAME = const(0x09)
_ADV_TYPE_UUID16_COMPLETE = const(0x3)
_ADV_TYPE_UUID32_COMPLETE = const(0x5)
_ADV_TYPE_UUID128_COMPLETE = const(0x7)
_ADV_TYPE_UUID16_MORE = const(0x2)
_ADV_TYPE_UUID32_MORE = const(0x4)
_ADV_TYPE_UUID128_MORE = const(0x6)
_ADV_TYPE_APPEARANCE = const(0x19)

_ADV_MAX_PAYLOAD = const(31)


# Generate a payload to be passed to gap_advertise(adv_data=...).
def advertising_payload(limited_disc=False, br_edr=False, name=None, services=None, appearance=0):
    payload = bytearray()

    def _append(adv_type, value):
        nonlocal payload
        payload += struct.pack("BB", len(value) + 1, adv_type) + value

    _append(
        _ADV_TYPE_FLAGS,
        struct.pack("B", (0x01 if limited_disc else 0x02) + (0x18 if br_edr else 0x04)),
    )

    if name:
        _append(_ADV_TYPE_NAME, name)

    if services:
        for uuid in services:
            b = bytes(uuid)
            if len(b) == 2:
                _append(_ADV_TYPE_UUID16_COMPLETE, b)
            elif len(b) == 4:
                _append(_ADV_TYPE_UUID32_COMPLETE, b)
            elif len(b) == 16:
                _append(_ADV_TYPE_UUID128_COMPLETE, b)

    # See org.bluetooth.characteristic.gap.appearance.xml
    if appearance:
        _append(_ADV_TYPE_APPEARANCE, struct.pack("<h", appearance))

    if len(payload) > _ADV_MAX_PAYLOAD:
        raise ValueError("advertising payload too large")

    return payload


def decode_field(payload, adv_type):
    i = 0
    result = []
    while i + 1 < len(payload):
        if payload[i + 1] == adv_type:
            result.append(payload[i + 2 : i + payload[i] + 1])
        i += 1 + payload[i]
    return result


def decode_name(payload):
    n = decode_field(payload, _ADV_TYPE_NAME)
    return str(n[0], "utf-8") if n else ""


def decode_services(payload):
    services = []
    for u in decode_field(payload, _ADV_TYPE_UUID16_COMPLETE):
        services.append(bluetooth.UUID(struct.unpack("<h", u)[0]))
    for u in decode_field(payload, _ADV_TYPE_UUID32_COMPLETE):
        services.append(bluetooth.UUID(struct.unpack("<d", u)[0]))
    for u in decode_field(payload, _ADV_TYPE_UUID128_COMPLETE):
        services.append(bluetooth.UUID(u))
    return services


class BleUart:
    # Runs on the shared bloq_ble manager rather than owning the radio, so it
    # coexists with the IDE's Bluetooth upload link. Connections the IDE owns are
    # invisible here: they don't count as connected and get no notifications.
    def __init__(self, name="EspBotUart", rxbuf=32):
        self._m = bloq_ble.start()
        self._ble = self._m.ble
        self._tx_handle, self._rx_handle = self._m.nus_handles
        # Increase the size of the rx buffer and enable append mode.
        self._ble.gatts_set_buffer(self._rx_handle, rxbuf, True)
        self._rx_buffer = bytearray()
        self._rxHandler = None
        self._cntHandler = None
        self._m.on_write[self._rx_handle] = self._on_write
        self._m.on_conn["bleuart"] = self._on_conn
        self._m.set_name(name)  # (re)advertises under this name

    def _on_conn(self, conn_handle, connected):
        if conn_handle in self._m.link_conns:
            return  # the IDE, not a user central
        if self._cntHandler:
            self._cntHandler(connected)

    def _on_write(self, conn_handle, value_handle):
        self._rx_buffer = self._ble.gatts_read(value_handle)
        #self._rx_buffer += self._ble.gatts_read(value_handle)
        if self._rxHandler:
            self._rxHandler(self._rx_buffer)

    def callOnRx(self, handler):
        self._rxHandler = handler

    def callOnConnectChanged(self, handler):
        self._cntHandler = handler

    def hasData(self):
        return len(self._rx_buffer) > 0

    def isConnected(self):
        return len(self._m.user_conns()) > 0

    def clearData(self):
        self._rx_buffer = bytearray()

    def read(self, sz=None):
        if not sz:
            sz = len(self._rx_buffer)
        #return self._rx_buffer[0:sz]
        result = self._rx_buffer[0:sz]
        self._rx_buffer = self._rx_buffer[sz:]
        return result

    def write(self, data):
        try:
            for conn_handle in self._m.user_conns():
                self._ble.gatts_notify(conn_handle, self._tx_handle, data)
        except:
            print("BLE write exception")
            pass

    def close(self):
        # Only drop user centrals; the IDE's upload link stays connected.
        for conn_handle in self._m.user_conns():
            self._ble.gap_disconnect(conn_handle)


class BleControlPad:
    ButtonUp    = const(1)
    ButtonDown  = const(2)
    ButtonLeft  = const(3)
    ButtonRight = const(4)
    Button1     = const(5)
    Button2     = const(6)
    Button3     = const(7)
    Button4     = const(8)

    class Values: 
        class ButtonUp:
            Press   = bytearray(b'!B516')
            Release = bytearray(b'!B507')
        class ButtonDown:
            Press   = bytearray(b'!B615')
            Release = bytearray(b'!B606')
        class ButtonLeft:
            Press   = bytearray(b'!B714')
            Release = bytearray(b'!B705')
        class ButtonRight:
            Press   = bytearray(b'!B813')
            Release = bytearray(b'!B804')
        class Button1:
            Press   = bytearray(b'!B11:')
            Release = bytearray(b'!B10;')
        class Button2:
            Press   = bytearray(b'!B219')
            Release = bytearray(b'!B20:')
        class Button3:
            Press   = bytearray(b'!B318')
            Release = bytearray(b'!B309')
        class Button4:
            Press   = bytearray(b'!B417')
            Release = bytearray(b'!B408')


    def begin(self, name="EspBot"):
        print("Using BLE name: " + name)
        self._bleuart = BleUart(name, 8)
        self._bleuart.callOnRx(handler=self._process)
        self._bleuart.callOnConnectChanged(handler=self._processConnectChange)
        self._btn_flags = 0

    def _processButton(self, data, button, value):
        if   data == value.Press:
            self._btn_flags |= (1<<button)
        elif data == value.Release:
            self._btn_flags &= ~(1<<button)

        #print("but:" + str(button))
        #print(self._btn_flags & (1<<button))
        #print((self._btn_flags & (1<<button)) != 0)

    def _processConnectChange(self, connected):
        if not connected:
            self._btn_flags = 0

    def _process(self, data):
        self._processButton(data, ButtonUp, self.Values.ButtonUp())
        self._processButton(data, ButtonDown, self.Values.ButtonDown())
        self._processButton(data, ButtonLeft, self.Values.ButtonLeft())
        self._processButton(data, ButtonRight, self.Values.ButtonRight())
        self._processButton(data, Button1, self.Values.Button1())
        self._processButton(data, Button2, self.Values.Button2())
        self._processButton(data, Button3, self.Values.Button3())
        self._processButton(data, Button4, self.Values.Button4())


    def close(self):
        self._bleuart.close()

    def isConnected(self):
        return self._bleuart.isConnected()

    def clear(self):
        return self._bleuart.clearData()

    def write(self, data):
        self._bleuart.write(data)

    def read(self):
        self._bleuart.read()

    def isButtonPressed(self, button):
        if (self._btn_flags & (1<<button)) != 0:
            return True
        return False


controlPad = BleControlPad()
