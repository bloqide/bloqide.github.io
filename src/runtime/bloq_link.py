# Bloq — offline block-based MicroPython IDE
# Copyright (C) 2026 Benjamin Balga
# SPDX-License-Identifier: GPL-3.0-or-later

# Bluetooth upload link: mirrors the REPL onto a GATT service with os.dupterm,
# so the IDE drives it with exactly the same raw-REPL protocol it uses over USB
# (raw-paste uploads, Ctrl-C to stop, Ctrl-D to soft-reboot).
#
# Started from boot.py, in a block the IDE manages (see SerialService.setBootLink),
# so it is up before main.py runs and survives the program stopping or crashing.
# Bluetooth events are serviced in the background between bytecodes, so the link
# keeps answering — and Ctrl-C keeps interrupting — while a program runs.
#
# Same idea as MicroPython's examples/bluetooth/ble_uart_repl.py, but on the
# shared bloq_ble manager so user programs can still use Bluetooth alongside it.
import io
import os
import time
from micropython import const
import bloq_ble

_MP_STREAM_POLL = const(3)
_MP_STREAM_POLL_RD = const(0x0001)
_RX_BUF = const(512)  # > the raw-paste window, so a full window always fits
_NOTIFY_TIMEOUT_MS = const(1000)


class _LinkStream(io.IOBase):
    def __init__(self, m):
        self._m = m
        self._rx_handle, self._tx_handle = m.link_handles
        self._rx = bytearray()
        m.ble.gatts_set_buffer(self._rx_handle, _RX_BUF, True)
        m.on_write[self._rx_handle] = self._on_write

    def _on_write(self, conn, handle):
        # Any write (the IDE sends an empty one on connect) marks the connection
        # as the IDE's: output goes to it, and user code stops counting it.
        self._m.link_conns.add(conn)
        data = self._m.ble.gatts_read(handle)
        if data:
            self._rx += data
            # Feed the REPL now. dupterm_notify stops at a Ctrl-C (raising the
            # KeyboardInterrupt), leaving the bytes after it here until the next
            # write, so a "stop, then do X" in one write would lose the X. Keep
            # going while it makes progress (it won't if dupterm was detached).
            n = -1
            while self._rx and len(self._rx) != n:
                n = len(self._rx)
                os.dupterm_notify(None)

    def readinto(self, buf):
        n = min(len(buf), len(self._rx))
        if not n:
            return None
        for i in range(n):
            buf[i] = self._rx[i]
        self._rx = self._rx[n:]
        return n

    def ioctl(self, op, arg):
        if op == _MP_STREAM_POLL and self._rx:
            return _MP_STREAM_POLL_RD
        return 0

    def write(self, buf):
        # Notify in MTU-sized pieces. When the stack's queue is full, notify
        # raises; wait for it to drain (like a blocking UART) instead of dropping
        # output, but give up on a connection that stalls or goes away.
        m = self._m
        mv = memoryview(buf)
        for conn in tuple(m.link_conns):
            size = m.conns.get(conn, 23) - 3
            deadline = time.ticks_add(time.ticks_ms(), _NOTIFY_TIMEOUT_MS)
            i = 0
            while i < len(mv):
                try:
                    m.ble.gatts_notify(conn, self._tx_handle, mv[i : i + size])
                    i += size
                except OSError:
                    if conn not in m.conns or time.ticks_diff(deadline, time.ticks_ms()) < 0:
                        break
                    time.sleep_ms(2)
        return len(buf)


_stream = None


def start():
    global _stream
    if _stream:
        return
    m = bloq_ble.start(link=True)
    _stream = _LinkStream(m)
    os.dupterm(_stream)
    m.advertise()
    print("Bluetooth upload link on, as", m.name or m.default_name())
