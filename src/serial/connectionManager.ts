import type { Board } from "../core/types";
import { SerialService } from "./serialService";

// A pool of serial connections shared across all projects. Projects don't own a
// connection; instead the user opens devices here and one is "highlighted" at a
// time. Run / Save target the highlighted device, and a project remembers (for
// the session) which device it last used so switching tabs re-highlights it.
//
// No auto-reattach: opening a device always prompts, because Web Serial can't
// expose a serial number and identical boards are indistinguishable — silently
// binding the wrong one would be worse than one extra click.

export interface PoolCallbacks {
  onData: (id: string, text: string) => void; // output from a specific device
  onStatus: () => void; // pool/list/highlight/connection changed
}

export interface PoolEntry {
  id: string;
  service: SerialService;
  index: number; // stable "Device N" number, assigned at open
  name?: string; // user-assigned override for the label
}

export class ConnectionPool {
  private entries: PoolEntry[] = [];
  private highlightedId: string | null = null;
  private counter = 0; // monotonic, so labels don't renumber when one closes

  constructor(private cb: PoolCallbacks) {}

  static get supported(): boolean {
    return SerialService.supported;
  }

  list(): PoolEntry[] {
    return this.entries;
  }
  isEmpty(): boolean {
    return this.entries.length === 0;
  }
  has(id: string): boolean {
    return this.entries.some((e) => e.id === id);
  }
  get(id: string): SerialService | undefined {
    return this.entries.find((e) => e.id === id)?.service;
  }
  private entry(id: string): PoolEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  labelFor(id: string): string {
    const e = this.entry(id);
    if (!e) return id;
    if (e.name) return e.name;
    const vendor = e.service.vendorName();
    return `Device ${e.index}${vendor ? ` - ${vendor}` : ""}`;
  }
  rename(id: string, name: string): void {
    const e = this.entry(id);
    if (e) {
      e.name = name;
      this.cb.onStatus();
    }
  }

  get highlighted(): string | null {
    return this.highlightedId;
  }
  highlightedService(): SerialService | undefined {
    return this.highlightedId ? this.get(this.highlightedId) : undefined;
  }
  highlight(id: string): void {
    if (this.has(id) && id !== this.highlightedId) {
      this.highlightedId = id;
      this.cb.onStatus();
    }
  }

  /** Open a brand-new device (always prompts). Returns its id, or null if cancelled. */
  async openNew(board: Board): Promise<string | null> {
    const id = crypto.randomUUID();
    const service = new SerialService({
      onData: (t) => this.cb.onData(id, t),
      onStatus: () => this.cb.onStatus(),
    });
    try {
      await service.attach(board);
    } catch (err) {
      if ((err as Error).name === "NotFoundError") return null; // picker cancelled
      throw err;
    }
    this.entries.push({ id, service, index: ++this.counter });
    this.highlightedId = id;
    this.cb.onStatus();
    return id;
  }

  /** Disconnect + drop a device entirely. */
  async remove(id: string): Promise<void> {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return;
    await this.entries[idx].service.close();
    this.entries.splice(idx, 1);
    if (this.highlightedId === id) {
      this.highlightedId = this.entries[Math.min(idx, this.entries.length - 1)]?.id ?? null;
    }
    this.cb.onStatus();
  }
}
