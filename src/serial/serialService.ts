import type { Board } from "../core/types";

// Web Serial + MicroPython raw-REPL driver.
//
// - connect():  user-gesture port pick + open, then a single read loop feeds the
//               terminal and buffers bytes for command responses.
// - run():      raw REPL -> paste program -> Ctrl-D -> execute in RAM.
// - saveToBoard(): write program as /main.py, then soft-reboot so it runs on boot.
// - syncLibraries(): upload only changed device files (session hash cache).
//
// NB: this implements plain raw REPL (no raw-paste flow control). Fine for the
// modest programs the block editor produces; large uploads would want raw-paste.

const CTRL_A = "\x01";
const CTRL_B = "\x02";
const CTRL_C = "\x03";
const CTRL_D = "\x04";

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
        this.rx += text;
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
    if (!this.writer) throw new Error("Not connected");
    await this.writer.write(this.encoder.encode(s));
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
   * Send code through raw REPL and execute it.
   *
   * `OK` is only the *compile* acknowledgment — the device sends it before the
   * code actually runs. For finite scripts (file writes) pass awaitCompletion so
   * we block until execution truly finishes, otherwise the next execRaw's Ctrl-C
   * would interrupt a still-running write before it commits to flash. Programs
   * that loop forever (run()) must NOT wait — there is no completion marker.
   */
  private async execRaw(code: string, awaitCompletion = false): Promise<void> {
    await this.write(CTRL_C + CTRL_C); // interrupt anything running
    this.rx = "";
    await this.write(CTRL_A); // enter raw REPL
    await this.waitFor("raw REPL");
    this.rx = "";
    await this.write(code);
    await this.write(CTRL_D); // execute
    await this.waitFor("OK"); // compiled ok
    if (awaitCompletion) {
      // Raw REPL frames a finished submission as: OK<stdout>\x04<stderr>\x04>
      // Two 0x04 markers means execution (not just compilation) is complete.
      await this.waitForCount("\x04", 2);
      const stderr = this.rx.split("\x04")[1]?.trim();
      if (stderr) {
        await this.write(CTRL_B);
        throw new Error(stderr.split("\r\n").pop() || stderr);
      }
    }
    await this.write(CTRL_B); // back to friendly REPL
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
   * Run the program. This is a flash + soft-reboot (same as Save), NOT an
   * in-RAM exec: a fresh reboot guarantees a clean peripheral state, avoiding
   * the RAM-run quirk where leftover hardware config (e.g. a pin left as a plain
   * GPIO output) blocked a later PWM. Trying to soft-reset before an in-RAM run
   * couldn't win the race against a saved main.py re-initializing peripherals.
   */
  async run(code: string): Promise<void> {
    this.cb.onData("\r\n[run] uploading + reboot…\r\n");
    await this.flashAndReboot(code);
  }

  /** Persist the program as /main.py and soft-reboot so it runs on power-up. */
  async saveToBoard(code: string): Promise<void> {
    this.cb.onData("\r\n[save] writing main.py…\r\n");
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
   * Upload only device files whose content changed since the last upload this
   * session. Real sync would read a device-side manifest; the session cache is
   * enough to keep repeated Runs fast.
   */
  async syncLibraries(files: { dest: string; content: string }[]): Promise<void> {
    for (const f of files) {
      const h = hash(f.content);
      if (this.libHashes.get(f.dest) === h) continue;
      this.cb.onData(`[sync] ${f.dest}\r\n`);
      await this.writeFile(f.dest, f.content);
      this.libHashes.set(f.dest, h);
    }
  }

  /** Write a text file to the device filesystem via raw REPL. */
  private async writeFile(path: string, content: string): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf("/"));
    const b64 = btoa(unescape(encodeURIComponent(content)));
    const script = [
      "import ubinascii, uos",
      dir && dir !== "" ? mkdirs(dir) : "",
      `_f = open(${py(path)}, 'wb')`,
      `_f.write(ubinascii.a2b_base64(${py(b64)}))`,
      "_f.close()",
    ]
      .filter(Boolean)
      .join("\n");
    await this.execRaw(script, true); // wait for the write to commit before returning
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
