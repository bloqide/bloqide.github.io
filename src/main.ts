import * as Blockly from "blockly";
import "@fortawesome/fontawesome-free/css/all.min.css";
import "./style.css";

import { getBoard } from "./core/registry";
import { registerBlocks, buildToolbox } from "./core/blocks";
import { CodeGen } from "./core/codegen";
import type { GenResult } from "./core/types";
import { SerialService } from "./serial/serialService";
import { TerminalView } from "./ui/terminal";
import { initLibrary } from "./ui/library";
import { projectStore } from "./project/store";
import { newRecord, download } from "./project/serde";
import type { ProjectRecord } from "./project/types";
import type { Board } from "./core/types";
import mbruntimeSource from "./runtime/mbruntime.py?raw";

const DEFAULT_BOARD = "esp32-c3";

// ---- Board + blocks (mutable so a loaded project can switch board) ----
let board: Board = getBoard(DEFAULT_BOARD)!;
let codegen: CodeGen;

// Report the flyout as occupying no layout space so a pinned-open flyout
// (autoClose = false) overlays the canvas instead of pushing it aside.
class OverlayMetricsManager extends Blockly.MetricsManager {
  getFlyoutMetrics(getWorkspaceCoordinates?: boolean) {
    const m = super.getFlyoutMetrics(getWorkspaceCoordinates);
    return { ...m, width: 0, height: 0 };
  }
}

// ---- Blockly workspace ----
const workspace = Blockly.inject("blockly", {
  toolbox: buildToolbox(board),
  renderer: "zelos",
  grid: { spacing: 24, length: 3, colour: "#313244", snap: true },
  zoom: { controls: true, wheel: true, startScale: 0.9, maxScale: 3, minScale: 0.3 },
  move: { scrollbars: true, drag: true, wheel: true },
  trashcan: true,
  plugins: { metricsManager: OverlayMetricsManager },
});

// Keep the block flyout pinned open (don't auto-close after dragging a block).
const flyout = workspace.getFlyout();
if (flyout) (flyout as unknown as { autoClose: boolean }).autoClose = false;

// Undo / redo.
document.getElementById("btn-undo")!.addEventListener("click", () => workspace.undo(false));
document.getElementById("btn-redo")!.addEventListener("click", () => workspace.undo(true));

function useBoard(id: string): void {
  const next = getBoard(id);
  if (!next) {
    alert(`Unknown board "${id}" — keeping ${board.name}.`);
    return;
  }
  board = next;
  registerBlocks(board);
  workspace.updateToolbox(buildToolbox(board));
  codegen = new CodeGen(board);
  document.getElementById("board-label")!.textContent = `${board.name} · ${board.meta.mcu}`;
}
useBoard(DEFAULT_BOARD);

// ---- Codegen (live) ----
let lastResult: GenResult | null = null;
let detached = false;

const codeView = document.getElementById("code-view")!;
const codeEdit = document.getElementById("code-edit") as HTMLTextAreaElement;
const modeBadge = document.getElementById("mode-badge")!;

function regenerate(): void {
  if (detached) return;
  lastResult = codegen.generate(workspace);
  renderCode(lastResult);
  modeBadge.textContent = lastResult.schedulerMode ? "scheduler mode" : "simple mode";
  autosave();
}

function renderCode(result: GenResult): void {
  codeView.innerHTML = "";
  const lines = result.code.replace(/\n$/, "").split("\n");
  lines.forEach((text, i) => {
    const lineNo = i + 1;
    const div = document.createElement("div");
    div.className = "code-line";
    div.dataset.line = String(lineNo);
    const blockId = result.lineToBlock.get(lineNo);
    if (blockId) {
      div.dataset.blockId = blockId;
      div.classList.add("mapped");
    }
    div.innerHTML = `<span class="ln">${lineNo}</span><span class="src"></span>`;
    div.querySelector(".src")!.textContent = text || " ";
    div.addEventListener("click", () => blockId && selectBlock(blockId));
    codeView.appendChild(div);
  });
}

// ---- Bidirectional highlight (source map) ----
function selectBlock(id: string): void {
  const block = workspace.getBlockById(id);
  if (block) {
    block.select();
    workspace.centerOnBlock(id);
  }
}

function highlightLinesFor(blockId: string | null): void {
  codeView.querySelectorAll(".code-line.hot").forEach((el) => el.classList.remove("hot"));
  if (!blockId || !lastResult) return;
  const lines = lastResult.blockToLines.get(blockId) ?? [];
  for (const ln of lines) {
    const el = codeView.querySelector(`.code-line[data-line="${ln}"]`);
    el?.classList.add("hot");
  }
  if (lines.length) {
    codeView.querySelector(`.code-line[data-line="${lines[0]}"]`)?.scrollIntoView({ block: "nearest" });
  }
}

workspace.addChangeListener((e: Blockly.Events.Abstract) => {
  if (e.type === Blockly.Events.SELECTED) {
    highlightLinesFor((e as Blockly.Events.Selected).newElementId ?? null);
  }
  if (
    e.type === Blockly.Events.BLOCK_MOVE ||
    e.type === Blockly.Events.BLOCK_CHANGE ||
    e.type === Blockly.Events.BLOCK_CREATE ||
    e.type === Blockly.Events.BLOCK_DELETE
  ) {
    regenerate();
  }
});

// ---- Detach / revert ----
const detachToggle = document.getElementById("detach-toggle") as HTMLInputElement;
const revertBtn = document.getElementById("revert-blocks")!;

detachToggle.addEventListener("change", () => {
  detached = detachToggle.checked;
  if (detached) {
    codeEdit.value = lastResult?.code ?? "";
    codeEdit.classList.remove("hidden");
    codeView.classList.add("hidden");
    revertBtn.classList.remove("hidden");
    modeBadge.textContent = "detached (blocks read-only)";
    workspace.options.readOnly = true;
  } else {
    revert();
  }
});
revertBtn.addEventListener("click", revert);

function revert(): void {
  detached = false;
  detachToggle.checked = false;
  codeEdit.classList.add("hidden");
  codeView.classList.remove("hidden");
  revertBtn.classList.add("hidden");
  workspace.options.readOnly = false;
  regenerate();
}

// ---- View switching ----
const blocklyPane = document.getElementById("blockly")!;
const codePane = document.getElementById("code-pane")!;
document.querySelectorAll<HTMLButtonElement>(".view-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".view-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const view = btn.dataset.view;
    blocklyPane.classList.toggle("hidden", view === "code");
    codePane.classList.toggle("hidden", view === "blocks");
    codePane.classList.toggle("split", view === "split");
    blocklyPane.classList.toggle("split", view === "split");
    Blockly.svgResize(workspace);
  });
});

// ---- Terminal + serial ----
const drawer = document.getElementById("terminal-drawer")!;
const terminal = new TerminalView(document.getElementById("terminal")!);

const serial = new SerialService({
  onData: (text) => terminal.write(text),
  onStatus: (connected) => {
    (["btn-run", "btn-save-board", "btn-stop"] as const).forEach((id) => {
      (document.getElementById(id) as HTMLButtonElement).disabled = !connected;
    });
    document.getElementById("btn-connect")!.innerHTML = connected
      ? '<i class="fa-solid fa-plug-circle-xmark"></i> Disconnect'
      : '<i class="fa-solid fa-plug"></i> Connect';
  },
});
terminal.onKey((data) => void serial.sendKey(data));

function openTerminal(): void {
  drawer.classList.remove("hidden");
  Blockly.svgResize(workspace); // canvas shrinks to make room, no overlap
  terminal.refit();
}
function closeTerminal(): void {
  drawer.classList.add("hidden");
  Blockly.svgResize(workspace);
}

document.getElementById("btn-terminal")!.addEventListener("click", () =>
  drawer.classList.contains("hidden") ? openTerminal() : closeTerminal()
);
document.getElementById("btn-terminal-close")!.addEventListener("click", closeTerminal);

document.getElementById("btn-connect")!.addEventListener("click", async () => {
  try {
    if (serial.connected) {
      await serial.disconnect();
    } else {
      openTerminal();
      await serial.connect(board);
    }
  } catch (err) {
    terminal.write(`\r\n[error] ${(err as Error).message}\r\n`);
  }
});

// Files this program needs on the device (runtime lib only when scheduler used).
function requiredFiles(): { dest: string; content: string }[] {
  const files: { dest: string; content: string }[] = [];
  if (lastResult?.requiredLibraries.has("/lib/mbruntime.py")) {
    files.push({ dest: "/lib/mbruntime.py", content: mbruntimeSource });
  }
  return files;
}

document.getElementById("btn-run")!.addEventListener("click", async () => {
  const code = currentCode();
  try {
    await serial.syncLibraries(requiredFiles());
    await serial.run(code);
  } catch (err) {
    terminal.write(`\r\n[error] ${(err as Error).message}\r\n`);
  }
});

document.getElementById("btn-save-board")!.addEventListener("click", async () => {
  const code = currentCode();
  try {
    await serial.syncLibraries(requiredFiles());
    await serial.saveToBoard(code);
  } catch (err) {
    terminal.write(`\r\n[error] ${(err as Error).message}\r\n`);
  }
});

document.getElementById("btn-stop")!.addEventListener("click", () => serial.stop());

function currentCode(): string {
  return detached ? codeEdit.value : lastResult?.code ?? "";
}

// ---- Project management (IndexedDB library + file import/export) ----
const LAST_OPEN_KEY = "microblock:lastOpen";
let current: ProjectRecord = newRecord("Untitled", board.id);
let loading = false; // suppress autosave while applying a loaded project

const nameEl = document.getElementById("project-name")!;

function setName(name: string): void {
  current.name = name;
  nameEl.textContent = name;
}

// autosave() is called by regenerate() on every workspace change.
function autosave(): void {
  if (loading) return;
  current.blocks = Blockly.serialization.workspaces.save(workspace);
  current.board = board.id;
  current.detached = detached;
  current.editedCode = detached ? codeEdit.value : undefined;
  current.updatedAt = Date.now();
  void projectStore.put(current);
  localStorage.setItem(LAST_OPEN_KEY, current.id);
}

function applyProject(rec: ProjectRecord): void {
  loading = true;
  current = rec;
  setName(rec.name);
  if (rec.board !== board.id) useBoard(rec.board);
  workspace.clear();
  try {
    Blockly.serialization.workspaces.load(rec.blocks as object, workspace);
  } catch {
    /* ignore corrupt block data */
  }
  loading = false;

  // Restore detached state / edited code.
  if (rec.detached) {
    detached = true;
    detachToggle.checked = true;
    codeEdit.value = rec.editedCode ?? "";
    codeEdit.classList.remove("hidden");
    codeView.classList.add("hidden");
    revertBtn.classList.remove("hidden");
    workspace.options.readOnly = true;
    modeBadge.textContent = "detached (blocks read-only)";
  } else {
    detached = false;
    detachToggle.checked = false;
    codeEdit.classList.add("hidden");
    codeView.classList.remove("hidden");
    revertBtn.classList.add("hidden");
    workspace.options.readOnly = false;
    regenerate();
  }
  localStorage.setItem(LAST_OPEN_KEY, current.id);
}

const library = initLibrary({
  onOpen: async (id) => {
    const rec = await projectStore.get(id);
    if (rec) applyProject(rec);
  },
  currentId: () => current.id,
});

document.getElementById("btn-open")!.addEventListener("click", () => library.open());

document.getElementById("btn-new")!.addEventListener("click", () => {
  applyProject(newRecord("Untitled", DEFAULT_BOARD));
});

document.getElementById("btn-export")!.addEventListener("click", () => {
  autosave();
  download(current);
});

nameEl.addEventListener("click", () => {
  const name = prompt("Project name:", current.name);
  if (name && name.trim()) {
    setName(name.trim());
    autosave();
  }
});

// ---- Boot: reopen last project, else start fresh ----
async function boot(): Promise<void> {
  const lastId = localStorage.getItem(LAST_OPEN_KEY);
  const rec = lastId ? await projectStore.get(lastId) : undefined;
  if (rec) {
    applyProject(rec);
  } else {
    setName(current.name);
    regenerate();
  }
}
void boot();
