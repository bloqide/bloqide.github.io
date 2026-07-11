import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// Thin xterm wrapper. Renders serial output and (optionally) forwards keystrokes
// back to the board for an interactive REPL.
export class TerminalView {
  private term: Terminal;
  private fit = new FitAddon();
  private onKeyCb: ((data: string) => void) | null = null;

  constructor(container: HTMLElement) {
    this.term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: "monospace",
      fontSize: 12,
      theme: { background: "#11111b" },
    });
    this.term.loadAddon(this.fit);
    this.term.open(container);
    this.fit.fit();
    this.term.onData((d) => this.onKeyCb?.(d));
    window.addEventListener("resize", () => this.safeFit());
  }

  write(text: string): void {
    this.term.write(text);
  }

  onKey(cb: (data: string) => void): void {
    this.onKeyCb = cb;
  }

  refit(): void {
    this.safeFit();
  }

  private safeFit(): void {
    try {
      this.fit.fit();
    } catch {
      /* container hidden */
    }
  }
}
