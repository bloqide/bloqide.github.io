import type { Board } from "../core/types";

// Web Serial + MicroPython raw-REPL driver.
//
// - connect():  user-gesture port pick + open, then a single read loop feeds the
//               terminal and buffers bytes for command responses.
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

  constructor(private cb: SerialCallbacks) {}

  get connected(): boolean {
    return this.open;
  }

  static get supported(): boolean {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  /** Known vendor name for this port, if the USB vendor id is recognised. */
  vendorName(): string | undefined {
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
    if (!this.open || !this.port?.setSignals) return;
    await this.pulseReset();
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
      await this.waitFor("raw REPL");
      await this.waitFor(">"); // full "raw REPL; CTRL-B to exit\r\n>" prompt received
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
    await this.takeBytes(1); // device acks with 0x04
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
   */
  private async writeFile(path: string, content: string): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf("/"));
    const need = this.encoder.encode(content).length;
    const b64 = btoa(unescape(encodeURIComponent(content)));
    const preflight =
      "try:\n" +
      " _s=uos.statvfs('/')\n" +
      " try:\n  _e=uos.stat(" +
      py(path) +
      ")[6]\n except OSError:\n  _e=0\n" +
      " if " +
      need +
      ">_s[0]*_s[3]+_e:\n  raise OSError(28)\n" +
      "except AttributeError:\n pass";
    const script = [
      "import ubinascii, uos",
      preflight,
      dir && dir !== "" ? mkdirs(dir) : "",
      `_f = open(${py(path)}, 'wb')`,
      `_f.write(ubinascii.a2b_base64(${py(b64)}))`,
      "_f.close()",
    ]
      .filter(Boolean)
      .join("\n");
    await this.execRaw(script); // blocks until the write commits to flash
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
