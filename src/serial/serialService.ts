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

import type { Board } from "../core/types";
import { BlePort } from "./blePort";

// Web Serial + MicroPython raw-REPL driver.
//
// - connect():  user-gesture port pick + open, then a single read loop feeds the
//               terminal and buffers bytes for command responses. The port is
//               either a USB serial port or a BlePort (Bluetooth upload link),
//               which looks the same from here: one protocol for both.
// - run():      write program as /main.py, then soft-reboot so it runs fresh.
// - syncLibraries(): upload only changed device files, using a device-side
//               manifest so change detection survives reconnects.
//
// Program submission uses MicroPython raw-paste mode (flow-controlled) when the
// board advertises it (connection.replMode === "raw-paste"), so large uploads
// can't overrun the device's input buffer; it falls back to plain chunked raw
// REPL on boards/firmware that don't support it.

const CTRL_A = "\x01";
const CTRL_B = "\x02";
const CTRL_C = "\x03";
const CTRL_D = "\x04";

// Raw-paste handshake: Ctrl-E, 'A', 0x01. The device replies "R\x01" (supported),
// "R\x00" (understood but unsupported), or something else (too old to understand).
const RAW_PASTE_REQ = new Uint8Array([0x05, 0x41, 0x01]);
const EOT = new Uint8Array([0x04]); // end-of-data / execute marker
const MANIFEST_PATH = "/lib/.bloq_manifest.json";
// Largest file written in one raw-REPL script; bigger ones go in pieces of this
// size. Its base64 (~4 KB) plus the decoded bytes stay small next to the
// ~24 KB that a whole library (BloqStepper.py) needs, which fails on an
// ESP32-C3 with Bluetooth running.
const WRITE_CHUNK = 3072;

// The boot.py block that starts the Bluetooth upload link (src/runtime/bloq_link.py).
// setBootLink() adds or strips it by these marker lines, leaving the rest of the
// user's boot.py alone.
const LINK_BEGIN = "# >>> bloq-ble-link";
const LINK_END = "# <<< bloq-ble-link";
const LINK_BLOCK = [
  LINK_BEGIN,
  "# Bluetooth upload link, managed by Bloq: a Run over USB removes it unless",
  "# the device's Bluetooth toggle is on.",
  "try:",
  "    import bloq_link",
  "    bloq_link.start()",
  "except Exception as e:",
  "    print('bloq_link:', e)",
  LINK_END,
].join("\n");

export interface SerialCallbacks {
  onData: (text: string) => void;
  onStatus: (connected: boolean) => void;
}

// Friendly names for common USB-serial vendors (Web Serial exposes no port path).
const VENDORS: Record<number, string> = {
  0x303a: "Espressif",
  0x2e8a: "Raspberry Pi",
  0x10c4: "CP210x",
  0x1a86: "CH34x",
  0x0403: "FTDI",
  0x2341: "Arduino",
};

export class SerialService {
  private port: SerialPort | null = null;
  private board: Board | null = null; // remembered so we can reopen after close
  private open = false;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private rx = ""; // rolling receive buffer for command parsing
  private buffer = ""; // full-ish scrollback for reprint
  private forwardToTerminal = true;
  private libHashes = new Map<string, string>();
  private latin1 = new TextDecoder("latin1"); // byte-exact rx view for protocol parsing
  private useRawPaste = false; // set from board.connection.replMode on open
  private manifestLoaded = false; // seeded libHashes from the device manifest yet?
  /** Keep the Bluetooth upload link on through USB Runs (session toggle, default off). */
  keepBleLink = false;

  constructor(private cb: SerialCallbacks) {}

  get connected(): boolean {
    return this.open;
  }

  static get supported(): boolean {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  static get bluetoothSupported(): boolean {
    return BlePort.supported;
  }

  /** Connected over the Bluetooth upload link rather than USB? */
  get bluetooth(): boolean {
    return this.port instanceof BlePort;
  }

  /** Known vendor name for this port (USB vendor id), or the Bluetooth device name. */
  vendorName(): string | undefined {
    if (this.port instanceof BlePort) return `${this.port.device.name ?? "board"} (Bluetooth)`;
    const vid = this.port?.getInfo().usbVendorId;
    return vid != null ? VENDORS[vid] : undefined;
  }

  getBuffer(): string {
    return this.buffer;
  }

  /** Drop the scrollback so a re-created pane doesn't resurrect old output. */
  clearBuffer(): void {
    this.buffer = "";
  }

  /** Pick a port (user gesture) and open it. */
  async attach(board: Board): Promise<void> {
    if (!SerialService.supported) throw new Error("Web Serial not supported (use Chrome/Edge).");
    this.board = board;
    this.port = await navigator.serial.requestPort();
    await this.openPort();
  }

  /** Pick a board running the Bluetooth upload link (user gesture) and connect. */
  async attachBluetooth(board: Board): Promise<void> {
    if (!BlePort.supported) throw new Error("Web Bluetooth not supported (use Chrome/Edge).");
    this.board = board;
    this.port = await BlePort.request((t) => this.cb.onData(t));
    await this.openPort();
  }

  /** Reopen the same port after a close() (no picker). */
  async reopen(board?: Board): Promise<void> {
    if (board) this.board = board;
    if (!this.port || !this.board) throw new Error("No port to reopen");
    await this.openPort();
  }

  private async openPort(): Promise<void> {
    const board = this.board!;
    await this.port!.open({ baudRate: board.connection.baud });
    // Leave DTR/RTS untouched on connect so we don't reset the board. On ESP32-C3
    // native USB (USB Serial/JTAG) any setSignals() call pokes the controller's
    // reset logic, so we only pulse it when the board explicitly asks for a reset
    // on connect (connection.resetOnConnect) or when the user hits Reset.
    if (board.connection.resetOnConnect) {
      try {
        await this.pulseReset();
      } catch {
        /* signals unsupported on this platform */
      }
    }
    this.writer = this.port!.writable!.getWriter();
    this.libHashes.clear();
    this.manifestLoaded = false;
    this.useRawPaste = board.connection.replMode === "raw-paste";
    this.open = true;
    this.startReadLoop();
    this.cb.onStatus(true);
    // Connect is passive: don't send anything, so we neither interrupt a running
    // program nor emit stray prompts. Use Stop/Run for an explicit interrupt.
  }

  /** Pulse RTS (EN) low->high with GPIO0 high, so the board reboots into main.py. */
  private async pulseReset(): Promise<void> {
    const setSignals = this.port?.setSignals?.bind(this.port);
    if (!setSignals) return;
    await setSignals({ dataTerminalReady: false, requestToSend: true });
    await delay(120);
    await setSignals({ dataTerminalReady: false, requestToSend: false });
  }

  /** Hardware-reset the connected board. */
  async reset(): Promise<void> {
    if (!this.open) return;
    if (this.port?.setSignals) {
      await this.pulseReset();
    } else {
      // No reset line over Bluetooth: interrupt, leave raw REPL, reset in software.
      await this.write(CTRL_C + CTRL_C + CTRL_B + "\r\nimport machine; machine.reset()\r\n");
    }
  }

  /** Disconnect but keep the port so it can be reopened. */
  async close(): Promise<void> {
    try {
      await this.reader?.cancel();
      this.writer?.releaseLock();
      if (this.open) await this.port?.close();
    } catch {
      /* already closing */
    } finally {
      this.writer = null;
      this.reader = null;
      this.open = false;
      this.cb.onStatus(false);
    }
  }

  private async startReadLoop(): Promise<void> {
    if (!this.port?.readable) return;
    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        const text = this.decoder.decode(value, { stream: true });
        // Command/protocol parsing needs byte-exact chars: raw-paste sends
        // control + window bytes that aren't valid UTF-8, which the streaming
        // decoder above would mangle. Buffer rx as latin1 (each byte -> charCode
        // 0x00-0xFF); ASCII tokens like "raw REPL"/"OK" still match.
        this.rx += this.latin1.decode(value);
        if (this.rx.length > 8192) this.rx = this.rx.slice(-4096);
        this.buffer += text;
        if (this.buffer.length > 100000) this.buffer = this.buffer.slice(-80000);
        if (this.forwardToTerminal) this.cb.onData(text);
      }
    } catch {
      /* reader cancelled on disconnect */
    }
    // The port went away underneath us (USB unplugged, Bluetooth board out of
    // reach): show it as disconnected rather than leave a dead "connected" pane.
    if (this.open && !this.port?.readable) await this.close();
  }

  private async write(s: string): Promise<void> {
    await this.writeBytes(this.encoder.encode(s));
  }

  private async writeBytes(bytes: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error("Not connected");
    await this.writer.write(bytes);
  }

  /** Wait until `token` appears in the receive buffer (or timeout). */
  private async waitFor(token: string, timeoutMs = 4000): Promise<void> {
    const start = performance.now();
    while (!this.rx.includes(token)) {
      if (performance.now() - start > timeoutMs) throw new Error(`Timeout waiting for "${token}"`);
      await delay(15);
    }
  }

  /**
   * Send `code` through the raw REPL, execute it, and return its stdout.
   *
   * Always blocks until execution truly finishes (both 0x04 frames), so callers
   * can rely on side effects — a file write committed to flash — before the next
   * command's Ctrl-C could interrupt it, and can read back printed output.
   * Throws if the device reports an exception on stderr.
   *
   * Every use here is a finite script (file writes, manifest reads); run() never
   * routes an infinite program through execRaw — it writes main.py then reboots.
   */
  private async execRaw(code: string): Promise<string> {
    const wasForwarding = this.forwardToTerminal;
    this.forwardToTerminal = false; // hide raw-REPL framing + flow-control bytes
    try {
      await this.write(CTRL_C + CTRL_C); // interrupt anything running
      this.rx = "";
      await this.write(CTRL_A); // enter raw REPL
      // The whole prompt, not "raw REPL" then any ">": over Bluetooth the
      // prompt's text and its ">" arrive in separate notifications, and a ">"
      // from an earlier ">>> " would let us clear rx before the real one lands,
      // which then gets read as the raw-paste reply.
      await this.waitFor("raw REPL; CTRL-B to exit\r\n>");
      this.rx = "";

      const codeBytes = this.encoder.encode(code);
      const usedRawPaste = await this.submitProgram(codeBytes);
      if (!usedRawPaste) {
        // Plain raw REPL: 256 bytes every 10ms, then execute.
        for (let i = 0; i < codeBytes.length; i += 256) {
          await this.writeBytes(codeBytes.subarray(i, i + 256));
          await delay(10);
        }
        await this.writeBytes(EOT); // execute
        await this.waitFor("OK"); // compiled ok
      }

      // Both paths now stream: <stdout>\x04<stderr>\x04>. (Raw-paste already
      // consumed its end-of-data ack inside submitProgram; the plain path
      // consumed the "OK" above.) Two 0x04 markers means execution is done.
      await this.waitForCount("\x04", 2);
      const parts = this.rx.split("\x04");
      let stdout = parts[0] ?? "";
      if (!usedRawPaste && stdout.startsWith("OK")) stdout = stdout.slice(2);
      const stderr = (parts[1] ?? "").trim();
      await this.write(CTRL_B); // back to friendly REPL
      if (stderr) throw new Error(friendlyDeviceError(stderr));
      return stdout;
    } finally {
      this.forwardToTerminal = wasForwarding;
    }
  }

  /**
   * Submit the program to a device already at the raw-REPL prompt. Returns true
   * if it went out via raw-paste mode (flow-controlled, and the end-of-data ack
   * already consumed); false means the caller should send it the plain way.
   *
   * Protocol per MicroPython's mpremote: request raw-paste, read a 2-byte reply,
   * and on "R\x01" stream the code within the device's advertised flow-control
   * window. On "R\x00" (understood, unsupported) or an unrecognised reply, give
   * up on raw-paste for this connection and fall back.
   */
  private async submitProgram(codeBytes: Uint8Array): Promise<boolean> {
    if (!this.useRawPaste) return false;
    await this.writeBytes(RAW_PASTE_REQ);
    const resp = await this.takeBytes(2);
    if (resp === "R\x01") {
      await this.rawPasteWrite(codeBytes);
      return true;
    }
    this.useRawPaste = false; // learned once; don't probe again this connection
    if (resp !== "R\x00") {
      // Firmware too old to understand the request — it echoed our bytes; resync
      // to a fresh prompt before the caller sends code the plain way.
      await this.waitFor(">");
      this.rx = "";
    }
    return false;
  }

  /**
   * Stream code in raw-paste mode. The device sends a 2-byte little-endian window
   * size, then a 0x01 each time it can accept another window's worth; 0x04 means
   * it wants us to stop. We finish by sending 0x04 and consuming the device's ack.
   */
  private async rawPasteWrite(codeBytes: Uint8Array): Promise<void> {
    const win = await this.takeBytes(2);
    const windowSize = win.charCodeAt(0) | (win.charCodeAt(1) << 8);
    let windowRemain = windowSize;
    let i = 0;
    while (i < codeBytes.length) {
      while (windowRemain === 0 || this.rx.length > 0) {
        const b = (await this.takeBytes(1)).charCodeAt(0);
        if (b === 0x01) windowRemain += windowSize;
        else if (b === 0x04) {
          await this.writeBytes(EOT); // device asked us to stop; acknowledge
          return;
        } else throw new Error("raw-paste: unexpected byte from device");
      }
      const end = Math.min(i + windowRemain, codeBytes.length);
      const chunk = codeBytes.subarray(i, end);
      await this.writeBytes(chunk);
      windowRemain -= chunk.length;
      i += chunk.length;
    }
    await this.writeBytes(EOT); // end of data
    // Device acks with 0x04, but a flow-control 0x01 for the last window can
    // still be in flight ahead of it; skip those (as mpremote does), else the
    // ack is left in rx and shifts the stdout/stderr split that follows.
    while ((await this.takeBytes(1)) !== "\x04") {
      /* late window increment */
    }
  }

  /** Consume the first `n` chars (= bytes, rx is latin1) from the receive buffer. */
  private async takeBytes(n: number, timeoutMs = 4000): Promise<string> {
    const start = performance.now();
    while (this.rx.length < n) {
      if (performance.now() - start > timeoutMs) throw new Error("Timeout (raw-paste)");
      await delay(5);
    }
    const s = this.rx.slice(0, n);
    this.rx = this.rx.slice(n);
    return s;
  }

  /** Wait until `token` has appeared at least `n` times in the receive buffer. */
  private async waitForCount(token: string, n: number, timeoutMs = 8000): Promise<void> {
    const start = performance.now();
    while ((this.rx.split(token).length - 1) < n) {
      if (performance.now() - start > timeoutMs) throw new Error(`Timeout waiting for device`);
      await delay(15);
    }
  }

  /** Write the program as /main.py and soft-reboot so it runs on a fresh board. */
  private async flashAndReboot(code: string): Promise<void> {
    await this.writeFile("/main.py", code);
    await this.write(CTRL_D); // soft reboot -> peripherals reset, main.py runs
  }

  /**
   * Run the program: write /main.py and soft-reboot (so it also persists and
   * runs on power-up). A flash + reboot, NOT an in-RAM exec — a fresh reboot
   * guarantees a clean peripheral state, avoiding the RAM-run quirk where
   * leftover hardware config (e.g. a pin left as a plain GPIO output) blocked a
   * later PWM. (Soft-resetting before an in-RAM run couldn't win the race
   * against a saved main.py re-initializing peripherals.)
   */
  async run(code: string): Promise<void> {
    this.cb.onData("\r\n[run] uploading + reboot…\r\n");
    await this.flashAndReboot(code);
  }

  /**
   * Add or remove the boot.py block that starts the Bluetooth upload link. Only
   * writes when something changes, so it's cheap to call on every Run. Takes
   * effect at the next boot; the link's libraries must already be synced.
   */
  async setBootLink(enable: boolean): Promise<void> {
    await this.execRaw(bootLinkScript(enable));
  }

  /** Soft-reboot (boot.py, then main.py), e.g. after toggling the Bluetooth link. */
  async softReboot(): Promise<void> {
    await this.write(CTRL_C + CTRL_C + CTRL_B + CTRL_D);
  }

  async stop(): Promise<void> {
    await this.write(CTRL_C + CTRL_C);
    this.cb.onData("\r\n[stopped]\r\n");
  }

  /** Forward an interactive keystroke to the board's REPL. */
  async sendKey(data: string): Promise<void> {
    if (this.connected) await this.write(data);
  }

  /**
   * Upload only device files whose content changed. Change detection is backed by
   * a device-side manifest (dest -> content hash) written under /lib, so it
   * survives disconnects and page reloads: on the first sync of a session we seed
   * the in-memory cache from the device, then re-upload only what actually
   * differs. The manifest is rewritten whenever something changed.
   */
  async syncLibraries(files: { dest: string; content: string }[]): Promise<void> {
    await this.loadManifest();
    let changed = false;
    for (const f of files) {
      const h = hash(f.content);
      if (this.libHashes.get(f.dest) === h) continue;
      this.cb.onData(`[sync] ${f.dest}\r\n`);
      await this.writeFile(f.dest, f.content);
      this.libHashes.set(f.dest, h);
      changed = true;
    }
    if (changed) await this.saveManifest();
  }

  /** Seed the hash cache from the device manifest once per session (best-effort). */
  private async loadManifest(): Promise<void> {
    if (this.manifestLoaded) return;
    this.manifestLoaded = true; // even on failure: don't re-probe every Run
    try {
      const out = await this.execRaw(
        `try:\n f=open('${MANIFEST_PATH}')\n print(f.read())\n f.close()\nexcept OSError:\n print('{}')`
      );
      const data = JSON.parse(out.trim() || "{}");
      if (data && typeof data.files === "object" && data.files) {
        for (const [dest, h] of Object.entries(data.files)) {
          if (typeof h === "string") this.libHashes.set(dest, h);
        }
      }
    } catch {
      // No/unreadable manifest: fall back to re-hashing everything this session.
    }
  }

  /** Persist the current dest->hash map to the device so the next session can skip. */
  private async saveManifest(): Promise<void> {
    const files: Record<string, string> = {};
    for (const [dest, h] of this.libHashes) files[dest] = h;
    try {
      await this.writeFile(MANIFEST_PATH, JSON.stringify({ v: 1, files }));
    } catch {
      // Best-effort: a missing manifest just means we re-sync next session.
    }
  }

  /**
   * Write a text file to the device filesystem via raw REPL.
   *
   * The script first checks free space (statvfs) against the new size, crediting
   * the existing file's bytes since `open('wb')` truncates it. If it can't fit it
   * raises ENOSPC *before* truncating, so a full device never corrupts the old
   * file — and the friendly error path reports "storage full" rather than leaving
   * a half-written file behind. The check is skipped where statvfs is missing.
   *
   * Files bigger than WRITE_CHUNK go in pieces instead (see writeFileChunked):
   * one script holding a whole library as base64 doesn't fit in RAM once
   * Bluetooth is running, which takes a big share of the heap.
   */
  private async writeFile(path: string, content: string): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf("/"));
    const bytes = this.encoder.encode(content);
    if (bytes.length > WRITE_CHUNK) return this.writeFileChunked(path, dir, bytes);
    const preflight =
      "try:\n" +
      " _s=uos.statvfs('/')\n" +
      " try:\n  _e=uos.stat(" +
      py(path) +
      ")[6]\n except OSError:\n  _e=0\n" +
      " if " +
      bytes.length +
      ">_s[0]*_s[3]+_e:\n  raise OSError(28)\n" +
      "except AttributeError:\n pass";
    const script = [
      "import ubinascii, uos",
      preflight,
      dir && dir !== "" ? mkdirs(dir) : "",
      `_f = open(${py(path)}, 'wb')`,
      `_f.write(ubinascii.a2b_base64(${py(base64(bytes))}))`,
      "_f.close()",
    ]
      .filter(Boolean)
      .join("\n");
    await this.execRaw(script); // blocks until the write commits to flash
  }

  /**
   * Large-file write: stream WRITE_CHUNK-sized pieces into `<path>.tmp`, one raw
   * REPL exec each, then rename it over the target. The old file stays intact
   * until the very end, so an interrupted upload never leaves a half-written
   * library. The space check can't credit the old file here (both exist until
   * the rename), so it needs the full new size free.
   */
  private async writeFileChunked(path: string, dir: string, bytes: Uint8Array): Promise<void> {
    const tmp = path + ".tmp";
    for (let i = 0; i < bytes.length; i += WRITE_CHUNK) {
      const piece = `_f.write(ubinascii.a2b_base64(${py(base64(bytes.subarray(i, i + WRITE_CHUNK)))}))`;
      const script =
        i === 0
          ? [
              "import ubinascii, uos",
              "try:",
              " _s=uos.statvfs('/')",
              ` if ${bytes.length}>_s[0]*_s[3]:`,
              "  raise OSError(28)",
              "except AttributeError:",
              " pass",
              dir && dir !== "" ? mkdirs(dir) : "",
              `_f = open(${py(tmp)}, 'wb')`,
              piece,
              "_f.close()",
            ]
          : ["import ubinascii", `_f = open(${py(tmp)}, 'ab')`, piece, "_f.close()"];
      await this.execRaw(script.filter(Boolean).join("\n"));
    }
    // Rename replaces the target on littlefs; FAT refuses an existing target.
    await this.execRaw(
      [
        "import uos",
        "try:",
        ` uos.rename(${py(tmp)}, ${py(path)})`,
        "except OSError:",
        ` uos.remove(${py(path)})`,
        ` uos.rename(${py(tmp)}, ${py(path)})`,
      ].join("\n")
    );
  }

  /**
   * Erase every file and directory on the device filesystem. Destructive — the
   * caller must confirm with the user first. Clears the sync caches so the next
   * Run re-uploads everything against the now-empty manifest.
   */
  async wipeFiles(): Promise<void> {
    const script = [
      "import uos",
      "def _rm(p):",
      " try:",
      "  for e in uos.ilistdir(p):",
      "   fp=(p+'/'+e[0]) if p!='/' else '/'+e[0]",
      "   if e[1]&0x4000:",
      "    _rm(fp)",
      "    try:",
      "     uos.rmdir(fp)",
      "    except OSError:",
      "     pass",
      "   else:",
      "    try:",
      "     uos.remove(fp)",
      "    except OSError:",
      "     pass",
      " except OSError:",
      "  pass",
      "_rm('/')",
    ].join("\n");
    await this.execRaw(script);
    this.libHashes.clear();
    this.manifestLoaded = false; // manifest is gone; re-read (empty) on next sync
  }
}

/**
 * Device script that adds (enable) or strips the Bluetooth-link block in
 * /boot.py, keeping every other line, and rewrites the file only on a change.
 * Exported for the host-side test, which runs it under CPython.
 */
export function bootLinkScript(enable: boolean, path = "/boot.py"): string {
  return [
    "try:",
    ` _f=open(${py(path)});_s=_f.read();_f.close()`,
    "except OSError:",
    " _s=''",
    "_o=[];_k=0",
    "for _l in _s.split('\\n'):",
    ` if _l.strip()==${py(LINK_BEGIN)}:`,
    "  _k=1",
    "  if _o and not _o[-1]:_o.pop()", // the blank line we put before the block
    ` elif _l.strip()==${py(LINK_END)}:_k=0`,
    " elif not _k:_o.append(_l)",
    "_t='\\n'.join(_o).rstrip('\\n')",
    enable ? `_t=(_t+'\\n\\n' if _t else '')+${py(LINK_BLOCK).replace(/\n/g, "\\n")}` : "",
    "_t=_t+'\\n' if _t else ''",
    "if _t!=_s:",
    ` _f=open(${py(path)},'w');_f.write(_t);_f.close()`,
  ]
    .filter(Boolean)
    .join("\n");
}

// Build code that creates intermediate directories, ignoring "already exists".
function mkdirs(dir: string): string {
  const parts = dir.split("/").filter(Boolean);
  let acc = "";
  const lines: string[] = [];
  for (const p of parts) {
    acc += "/" + p;
    lines.push(`try:\n uos.mkdir(${py(acc)})\nexcept OSError:\n pass`);
  }
  return lines.join("\n");
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function py(s: string): string {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Small non-cryptographic content hash for change detection.
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h.toString(16);
}

// Plain-language messages for the device faults an upload can realistically hit.
// Keyed by POSIX errno, matching MicroPython's `OSError: <n>` tracebacks.
const OSERROR_MESSAGES: Record<number, string> = {
  1: "Operation not permitted on the device (EPERM).",
  2: "File or directory not found on the device (ENOENT).",
  5: "Device I/O error (EIO) — check the connection.",
  9: "Bad file descriptor on the device (EBADF).",
  12: "Out of memory on the device (ENOMEM) — the program or file is too large.",
  13: "Permission denied on the device (EACCES).",
  16: "Device or resource busy (EBUSY).",
  17: "File already exists on the device (EEXIST).",
  19: "No such device (ENODEV).",
  21: "Path is a directory, not a file (EISDIR).",
  22: "Invalid argument (EINVAL).",
  28: "Device storage is full (ENOSPC) — free space or wipe files, then retry.",
  30: "Device filesystem is read-only (EROFS).",
};

// Turn a device stderr traceback into a plain-language message. Keys off the last
// line (the exception); falls back to that line verbatim when unrecognised.
function friendlyDeviceError(stderr: string): string {
  const last =
    stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? stderr.trim();
  const os = last.match(/OSError:\s*(?:\[Errno\s*)?(-?\d+)/);
  if (os) {
    const code = Math.abs(Number(os[1]));
    return OSERROR_MESSAGES[code] ?? `Device OS error ${code}.`;
  }
  if (/MemoryError/.test(last)) return "Out of memory on the device — the program or file is too large.";
  if (/SyntaxError/.test(last)) return `Device rejected the code (SyntaxError): ${last}`;
  return last;
}
