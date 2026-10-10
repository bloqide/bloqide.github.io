# Bloq — offline block-based MicroPython IDE
# Copyright (C) 2026 Benjamin Balga
# SPDX-License-Identifier: GPL-3.0-or-later

# Shared Bluetooth LE manager.
#
# MicroPython has ONE Bluetooth stack with ONE event handler, and
# gatts_register_services() replaces every service registered before it. So two
# modules can't each own the radio: whichever starts second silently cuts the
# first one off. Everything Bloq does over Bluetooth goes through this module
# instead, which registers all services in one go and routes events to their
# owners:
#
#   - bloq_link: the IDE's upload link (a REPL over its own GATT service). Only
#     present when the board's boot.py starts it.
#   - bleuart:   the Nordic UART service user programs talk to (phone gamepad…).
#
# Connections are shared too: the IDE marks its own connection by writing to the
# link service, and user-facing code only sees the others (user_conns()), so a
# connected IDE doesn't look like a connected phone.
import bluetooth
import struct
from micropython import const

_IRQ_CENTRAL_CONNECT = const(1)
_IRQ_CENTRAL_DISCONNECT = const(2)
_IRQ_GATTS_WRITE = const(3)
_IRQ_MTU_EXCHANGED = const(21)

_FLAG_WRITE_NO_RESPONSE = const(0x0004)
_FLAG_WRITE = const(0x0008)
_FLAG_NOTIFY = const(0x0010)

# Bloq upload link: host writes REPL input to RX, device notifies output on TX.
LINK_UUID = bluetooth.UUID("41f20001-bd16-41bb-bf93-e98d477f33a8")
_LINK_SERVICE = (
    LINK_UUID,
    (
        (bluetooth.UUID("41f20002-bd16-41bb-bf93-e98d477f33a8"), _FLAG_WRITE | _FLAG_WRITE_NO_RESPONSE),
        (bluetooth.UUID("41f20003-bd16-41bb-bf93-e98d477f33a8"), _FLAG_NOTIFY),
    ),
)

# Nordic UART service (what phone apps like Bluefruit Connect speak).
NUS_UUID = bluetooth.UUID("6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
_NUS_SERVICE = (
    NUS_UUID,
    (
        (bluetooth.UUID("6E400003-B5A3-F393-E0A9-E50E24DCCA9E"), _FLAG_NOTIFY),
        (bluetooth.UUID("6E400002-B5A3-F393-E0A9-E50E24DCCA9E"), _FLAG_WRITE),
    ),
)

_APPEARANCE_GENERIC_COMPUTER = const(128)
_ADV_INTERVAL_US = const(200000)


def _field(adv_type, value):
    return struct.pack("BB", len(value) + 1, adv_type) + value


class _Manager:
    def __init__(self, link):
        self.link = link
        self.name = None  # set by a user program; else the default "Bloq-XXXX"
        self.conns = {}  # conn_handle -> negotiated MTU
        self.link_conns = set()  # connections that belong to the IDE
        self.on_write = {}  # value handle -> fn(conn, handle)
        self.on_conn = {}  # owner key -> fn(conn, connected)
        ble = bluetooth.BLE()
        ble.active(True)
        try:
            ble.config(mtu=256)  # let the central negotiate bigger packets
        except Exception:
            pass
        ble.irq(self._irq)
        if link:
            self.link_handles, self.nus_handles = ble.gatts_register_services((_LINK_SERVICE, _NUS_SERVICE))
        else:
            self.link_handles = None
            (self.nus_handles,) = ble.gatts_register_services((_NUS_SERVICE,))
        self.ble = ble

    def default_name(self):
        mac = self.ble.config("mac")[1]
        return "Bloq-%02X%02X" % (mac[-2], mac[-1])

    def set_name(self, name):
        self.name = name
        self.advertise()

    def user_conns(self):
        return [c for c in self.conns if c not in self.link_conns]

    def advertise(self):
        name = (self.name or self.default_name()).encode()
        try:
            self.ble.config(gap_name=name)
        except Exception:
            pass
        flags = _field(0x01, b"\x06")  # general discoverable, BLE only
        if self.link:
            # The 128-bit link UUID fills most of the 31-byte advertisement, so
            # the name goes in the scan response. The IDE's device chooser
            # filters on that UUID.
            adv = flags + _field(0x07, bytes(LINK_UUID))
            resp = _field(0x09, name)
        else:
            adv = flags + _field(0x09, name) + _field(0x19, struct.pack("<h", _APPEARANCE_GENERIC_COMPUTER))
            resp = None
        try:
            self.ble.gap_advertise(_ADV_INTERVAL_US, adv_data=adv, resp_data=resp)
        except OSError:
            pass  # e.g. all connection slots taken; retried on the next disconnect

    def _irq(self, event, data):
        try:
            if event == _IRQ_CENTRAL_CONNECT:
                conn = data[0]
                self.conns[conn] = 23
                self.advertise()  # stay discoverable so a phone and the IDE can both connect
                for fn in self.on_conn.values():
                    fn(conn, True)
            elif event == _IRQ_CENTRAL_DISCONNECT:
                conn = data[0]
                self.conns.pop(conn, None)
                self.advertise()
                for fn in self.on_conn.values():
                    fn(conn, False)  # still in link_conns here, so owners can tell it was the IDE
                self.link_conns.discard(conn)
            elif event == _IRQ_GATTS_WRITE:
                conn, handle = data
                fn = self.on_write.get(handle)
                if fn:
                    fn(conn, handle)
            elif event == _IRQ_MTU_EXCHANGED:
                conn, mtu = data
                if conn in self.conns:
                    self.conns[conn] = mtu
        except Exception as e:
            print("bloq_ble:", e)


_manager = None


def start(link=False):
    """Bring Bluetooth up once and return the shared manager. Only the first call
    decides the service table, so bloq_link (run from boot.py) must come first."""
    global _manager
    if _manager is None:
        _manager = _Manager(link)
    return _manager
