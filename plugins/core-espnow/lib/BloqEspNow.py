# ESP-NOW helper for Bloq. Wraps MicroPython's espnow radio so the generated
# main.py stays readable: the program brings up the WLAN and creates one
# BloqEspNow(wlan), then calls its methods. All the fiddly bits (peer
# registration, MAC <-> bytes, error handling, decoding) live here.
import espnow

BROADCAST = b"\xff" * 6  # the all-FF address every device receives


class BloqEspNow:
    def __init__(self, wlan):
        self._wlan = wlan
        self._now = espnow.ESPNow()
        self._now.active(True)
        self.sender = ""  # MAC of the last received message ("" before any)

    def _to_bytes(self, mac):
        # Accept "AA:BB:CC:DD:EE:FF" or an already-raw 6-byte address.
        if isinstance(mac, str):
            return bytes(int(part, 16) for part in mac.split(":"))
        return mac

    def add_peer(self, mac):
        mac = self._to_bytes(mac)
        try:
            self._now.get_peer(mac)
        except OSError:  # not registered yet
            self._now.add_peer(mac)

    def add_broadcast_peer(self):
        self.add_peer(BROADCAST)

    def send(self, mac, msg):
        try:
            self._now.send(self._to_bytes(mac), str(msg))
        except OSError as e:  # peer not added, or no ACK
            print("ESP-NOW send failed (peer added?):", e)

    def broadcast(self, msg):
        self.send(BROADCAST, msg)

    def receive(self, timeout):
        # Wait up to `timeout` ms for a message; remember the sender; return text.
        host, msg = self._now.recv(timeout)
        self.sender = ":".join("%02X" % b for b in host) if host else ""
        return msg.decode() if msg else ""

    def my_mac(self):
        return ":".join("%02X" % b for b in self._wlan.config("mac"))
