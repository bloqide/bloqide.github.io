/*
 * Bloq — offline block-based MicroPython IDE
 * Copyright (C) 2026 Benjamin Balga
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// A Web Bluetooth connection to a board's upload link (src/runtime/bloq_link.py),
// shaped like a Web Serial port — open / close / readable / writable / getInfo —
// so SerialService drives it with exactly the raw-REPL protocol it uses over USB.
//
// The link drops whenever the board reboots (a Run soft-reboots it, and a
// MicroPython soft reset shuts Bluetooth down). The port hides that: it keeps
// its streams open, reconnects in the background, and holds writes until the
// link is back. Only if the board stays unreachable does the readable end,
// which SerialService takes as a disconnect.

const LINK_SERVICE = "41f20001-bd16-41bb-bf93-e98d477f33a8";
const LINK_RX = "41f20002-bd16-41bb-bf93-e98d477f33a8"; // host -> device (REPL input)
const LINK_TX = "41f20003-bd16-41bb-bf93-e98d477f33a8"; // device -> host (REPL output)

// Bytes per GATT write. Fits one packet at the MTU desktop Chrome usually
// negotiates (185 on macOS, more elsewhere); a smaller MTU still works because
// the OS splits longer writes (the device accepts up to 512 bytes per write).
const CHUNK = 180;
const CONNECT_TIMEOUT_MS = 10000; // per attempt; a board mid-reboot isn't advertising yet
const SETUP_TIMEOUT_MS = 8000; // service discovery + notifications, once connected
const DROP_SETTLE_MS = 400; // after a drop or a fresh connect, before trusting the link state
const OPEN_WINDOW_MS = 15000; // first connect: retry transient failures this long
const RECONNECT_WINDOW_MS = 30000; // give up (and report disconnected) after this
const WRITE_WAIT_MS = 15000; // how long a write waits for a dropped link to return

export class BlePort implements SerialPort {
  // Chrome hands back the same BluetoothDevice (and connection) for the same
  // board, and every port listening on it reacts to its disconnects. So one port
  // owns a device at a time: opening the board again (a new pane, or reconnecting
  // an old one) takes the connection over from the previous owner without
  // dropping it, and a port that closes or gives up stops reacting entirely.
  private static owners = new Map<string, BlePort>();

  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  private rx: BluetoothRemoteGATTCharacteristic | null = null;
  private tx: BluetoothRemoteGATTCharacteristic | null = null;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private closing = true; // until opened: ignore the device's events
  private linkUp = false;
  private connecting = false; // an open() or reconnect loop is running
  private pendingConnect: Promise<BluetoothRemoteGATTServer> | null = null;

  static get supported(): boolean {
    return typeof navigator !== "undefined" && "bluetooth" in navigator;
  }

  /** Show the browser's device chooser, listing boards with the link running. */
  static async request(notice: (text: string) => void): Promise<BlePort> {
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [LINK_SERVICE] }] });
    return new BlePort(device, notice);
  }

  private constructor(readonly device: BluetoothDevice, private notice: (text: string) => void) {
    device.addEventListener("gattserverdisconnected", () => void this.onDrop());
  }

  getInfo(): SerialPortInfo {
    return {};
  }

  async open(_options: { baudRate: number }): Promise<void> {
    BlePort.owners.get(this.device.id)?.release();
    BlePort.owners.set(this.device.id, this);
    this.closing = false;
    this.connecting = true; // our own retries; a drop meanwhile mustn't start a second loop
    try {
      await this.connectRetrying(OPEN_WINDOW_MS);
    } catch (err) {
      await this.close(); // also cancels any connect() still pending, so it can't land orphaned
      throw err;
    } finally {
      this.connecting = false;
    }
    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.controller = c;
      },
    });
    this.writable = new WritableStream<Uint8Array>({ write: (chunk) => this.send(chunk) });
  }

  async close(): Promise<void> {
    const owner = BlePort.owners.get(this.device.id) === this;
    this.release();
    if (owner) this.device.gatt?.disconnect(); // only the owner may drop the shared connection
  }

  /** Stop using the device (streams end, events ignored) but leave the connection up. */
  private release(): void {
    this.closing = true;
    this.linkUp = false;
    this.tx?.removeEventListener("characteristicvaluechanged", this.onNotify);
    if (BlePort.owners.get(this.device.id) === this) BlePort.owners.delete(this.device.id);
    this.endReadable();
    this.writable = null;
  }

  /** Connection attempts until one succeeds or `windowMs` runs out (then throws the last error). */
  private async connectRetrying(windowMs: number): Promise<void> {
    const until = performance.now() + windowMs;
    for (;;) {
      try {
        await this.connectGatt();
        return;
      } catch (err) {
        if (this.closing || performance.now() + 500 > until) throw err;
        console.warn("[bluetooth] connect attempt failed:", err);
        await delay(500);
      }
    }
  }

  // One connection attempt, in two timed phases:
  //  - connect(): only ONE is ever pending, and a timeout just stops waiting for
  //    it; the next attempt waits on the same one. Cancelling pending connects
  //    with disconnect() and starting new ones wedges Chrome on macOS: connects
  //    then fail for minutes even once the board is back (until a page reload),
  //    whereas a connect left pending completes as soon as the board advertises.
  //  - discovery + notifications: these can hang after an abrupt drop (the board
  //    hard-reset); then the connection is up but unusable, so drop it and retry.
  private async connectGatt(): Promise<void> {
    const gatt = this.device.gatt!;
    if (!this.pendingConnect) {
      const p = gatt.connect();
      this.pendingConnect = p;
      const clear = () => {
        if (this.pendingConnect === p) this.pendingConnect = null;
      };
      p.then(clear, clear);
    }
    const server = await withTimeout(this.pendingConnect, CONNECT_TIMEOUT_MS, "Bluetooth connect timed out");
    // Never start discovery on a connection that's already going away: connect()
    // can resolve against a board that is shutting down, and a discovery that
    // fails that way leaves Chrome's discovery for this device hanging for good
    // (every later getPrimaryService() never settles, until a page reload).
    await delay(DROP_SETTLE_MS);
    if (!gatt.connected) throw new Error("link dropped right after connecting");
    try {
      await withTimeout(this.setupGatt(server), SETUP_TIMEOUT_MS, "Bluetooth service discovery timed out");
    } catch (err) {
      if (BlePort.owners.get(this.device.id) === this) gatt.disconnect();
      throw err;
    }
    this.linkUp = true;
  }

  private async setupGatt(server: BluetoothRemoteGATTServer): Promise<void> {
    const service = await server.getPrimaryService(LINK_SERVICE);
    const rx = await service.getCharacteristic(LINK_RX);
    const tx = await service.getCharacteristic(LINK_TX);
    this.tx?.removeEventListener("characteristicvaluechanged", this.onNotify);
    tx.addEventListener("characteristicvaluechanged", this.onNotify);
    await tx.startNotifications();
    // Announce ourselves: the board routes REPL output only to connections that
    // have written to the link, and an empty write adds no REPL input. Not fatal
    // if refused: the first real write (a Run's Ctrl-C) announces us anyway.
    try {
      await rx.writeValueWithResponse(new Uint8Array(0));
    } catch {
      /* platform rejects empty writes */
    }
    this.rx = rx;
    this.tx = tx;
  }

  private onNotify = (e: Event): void => {
    const v = (e.target as BluetoothRemoteGATTCharacteristic).value;
    if (v) this.controller?.enqueue(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
  };

  private async onDrop(): Promise<void> {
    this.linkUp = false;
    if (this.closing || this.connecting) return;
    this.connecting = true;
    this.notice("\r\n[bluetooth] link dropped, reconnecting…\r\n");
    try {
      await delay(DROP_SETTLE_MS); // a board that's shutting down can still accept a connect
      await this.connectRetrying(RECONNECT_WINDOW_MS);
      this.notice("[bluetooth] reconnected\r\n");
    } catch {
      if (!this.closing) {
        this.notice("[bluetooth] board not reachable\r\n");
        await this.close(); // stream ends -> SerialService marks us disconnected
      }
    } finally {
      this.connecting = false;
    }
  }

  private endReadable(): void {
    try {
      this.controller?.close();
    } catch {
      /* already closed */
    }
    this.controller = null;
    this.readable = null;
  }

  // WritableStream sink. Never throws: an errored WritableStream stays dead, and
  // this one has to outlive reconnects. Data that can't be delivered is dropped;
  // the raw-REPL caller then times out waiting for the reply and reports it.
  private async send(data: Uint8Array): Promise<void> {
    for (let i = 0; i < data.length; i += CHUNK) {
      if (!(await this.waitForLink())) return;
      try {
        await this.rx!.writeValueWithResponse(data.slice(i, i + CHUNK));
      } catch {
        return;
      }
    }
  }

  private async waitForLink(): Promise<boolean> {
    const until = performance.now() + WRITE_WAIT_MS;
    while (!this.linkUp) {
      if (this.closing || !this.readable || performance.now() > until) return false;
      await delay(50);
    }
    return true;
  }
}

/** Rejects after `ms` if `p` hasn't settled; `p` itself keeps running. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
