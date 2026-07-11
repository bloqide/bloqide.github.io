import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// A vertical split of terminal panes, one per open serial device. Each pane has
// a header (device name, connect/disconnect toggle, close), its own xterm, and
// forwards keystrokes to its device. Clicking a pane selects (highlights) it.

export interface PaneHandlers {
  onSelect: (id: string) => void;
  onToggle: (id: string) => void; // reconnect / disconnect (keeps the device)
  onStop: (id: string) => void; // stop the running program
  onClose: (id: string) => void; // remove the device
  onKey: (id: string, data: string) => void;
  onRename: (id: string, name: string) => void;
}

interface Pane {
  id: string;
  root: HTMLElement;
  nameEl: HTMLElement;
  connBtn: HTMLButtonElement;
  term: Terminal;
  fit: FitAddon;
  grow: number; // flex-grow, adjusted by split resizers
}

export class TerminalPanel {
  private panes = new Map<string, Pane>();

  constructor(private container: HTMLElement, private h: PaneHandlers) {
    window.addEventListener("resize", () => this.refit());
  }

  has(id: string): boolean {
    return this.panes.has(id);
  }

  addPane(id: string, label: string, connected: boolean, buffer: string): void {
    if (this.panes.has(id)) return;

    const root = document.createElement("div");
    root.className = "term-pane";
    root.style.flexGrow = "1";
    const head = document.createElement("div");
    head.className = "term-head";
    const nameEl = document.createElement("span");
    nameEl.className = "term-name";
    nameEl.textContent = label;
    nameEl.title = "Click to rename";
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    const stopBtn = document.createElement("button");
    stopBtn.className = "term-stop";
    stopBtn.title = "Stop program";
    stopBtn.innerHTML = '<i class="fa-solid fa-stop"></i>';
    const connBtn = document.createElement("button");
    connBtn.className = "term-conn";
    const closeBtn = document.createElement("button");
    closeBtn.className = "term-close";
    closeBtn.title = "Close device";
    closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    head.append(nameEl, spacer, stopBtn, connBtn, closeBtn);

    const body = document.createElement("div");
    body.className = "term-body";
    root.append(head, body);
    this.container.appendChild(root);

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: "monospace",
      fontSize: 12,
      theme: { background: "#11111b" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(body);
    term.onData((d) => this.h.onKey(id, d));
    if (buffer) term.write(buffer);

    root.addEventListener("mousedown", () => this.h.onSelect(id));
    stopBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.h.onStop(id);
    });
    connBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.h.onToggle(id);
    });
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.h.onClose(id);
    });
    nameEl.addEventListener("click", (e) => {
      e.stopPropagation();
      const name = prompt("Device name:", nameEl.textContent ?? "");
      if (name && name.trim()) this.h.onRename(id, name.trim());
    });

    const pane: Pane = { id, root, nameEl, connBtn, term, fit, grow: 1 };
    this.panes.set(id, pane);
    this.setConnected(id, connected);
    this.refreshSplits();
    this.refit();
  }

  removePane(id: string): void {
    const p = this.panes.get(id);
    if (!p) return;
    p.term.dispose();
    p.root.remove();
    this.panes.delete(id);
  }

  /** Drop any panes whose device id is no longer present. */
  retain(ids: string[]): void {
    const keep = new Set(ids);
    let changed = false;
    for (const id of [...this.panes.keys()]) {
      if (!keep.has(id)) {
        this.removePane(id);
        changed = true;
      }
    }
    if (changed) {
      this.refreshSplits();
      this.refit();
    }
  }

  // Insert a drag handle between each pair of panes so their heights resize.
  private refreshSplits(): void {
    this.container.querySelectorAll(".term-split").forEach((el) => el.remove());
    const panes = [...this.panes.values()];
    for (let i = 0; i < panes.length - 1; i++) {
      const bar = document.createElement("div");
      bar.className = "term-split";
      this.container.insertBefore(bar, panes[i + 1].root);
      this.attachSplitDrag(bar, panes[i], panes[i + 1]);
    }
  }

  private attachSplitDrag(bar: HTMLElement, above: Pane, below: Pane): void {
    bar.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const total = [...this.panes.values()].reduce((s, p) => s + p.grow, 0);
      const pxPerGrow = (this.container.clientHeight || 1) / total;
      const startY = e.clientY;
      const sumAB = above.grow + below.grow;
      const startAbove = above.grow;
      const onMove = (ev: MouseEvent) => {
        let na = startAbove + (ev.clientY - startY) / pxPerGrow;
        na = Math.max(0.2, Math.min(sumAB - 0.2, na));
        above.grow = na;
        below.grow = sumAB - na;
        above.root.style.flexGrow = String(above.grow);
        below.root.style.flexGrow = String(below.grow);
        this.refit();
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  writeTo(id: string, text: string): void {
    this.panes.get(id)?.term.write(text);
  }
  setLabel(id: string, label: string): void {
    const p = this.panes.get(id);
    if (p) p.nameEl.textContent = label;
  }
  setConnected(id: string, connected: boolean): void {
    const p = this.panes.get(id);
    if (!p) return;
    p.connBtn.innerHTML = connected
      ? '<i class="fa-solid fa-plug-circle-xmark"></i>'
      : '<i class="fa-solid fa-plug"></i>';
    p.connBtn.title = connected ? "Disconnect" : "Reconnect";
    p.root.classList.toggle("disconnected", !connected);
  }
  highlight(id: string | null): void {
    for (const p of this.panes.values()) p.root.classList.toggle("selected", p.id === id);
  }

  refit(): void {
    for (const p of this.panes.values()) this.refitPane(p);
  }
  private refitPane(p: Pane): void {
    try {
      p.fit.fit();
    } catch {
      /* container hidden */
    }
  }
}
