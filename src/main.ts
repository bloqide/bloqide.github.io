import * as Blockly from "blockly";
import "@fortawesome/fontawesome-free/css/all.min.css";
import "./style.css";

import { getBoard } from "./core/registry";
import { registerBlocks, buildToolbox } from "./core/blocks";
import { CodeGen } from "./core/codegen";
import type { GenResult } from "./core/types";
import { ConnectionPool } from "./serial/connectionManager";
import type { SerialService } from "./serial/serialService";
import { TerminalPanel } from "./ui/terminal";
import { initLibrary } from "./ui/library";
import { setTextAreaResizeHandler } from "./ui/fieldTextArea";
import { projectStore } from "./project/store";
import { newRecord, download } from "./project/serde";
import type { ProjectRecord } from "./project/types";
import type { Board } from "./core/types";
import bloqSource from "./runtime/bloq.py?raw";

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

// Custom zelos renderer: cap how round tall value/reporter block ends get.
// Zelos rounds reporter ends to min(height/2, MAX_DYNAMIC_CONNECTION_SHAPE_WIDTH),
// which defaults to 12*GRID_UNIT (48px) — too bulbous on tall blocks like the
// variadic text join. Halve the cap so tall value blocks match short ones.
class BloqConstantProvider extends Blockly.zelos.ConstantProvider {
  constructor() {
    super();
    this.MAX_DYNAMIC_CONNECTION_SHAPE_WIDTH = 6 * this.GRID_UNIT;
  }
}
class BloqRenderer extends Blockly.zelos.Renderer {
  protected override makeConstants_(): BloqConstantProvider {
    return new BloqConstantProvider();
  }
}
Blockly.blockRendering.register("bloq-zelos", BloqRenderer);

// ---- Blockly workspace ----
const workspace = Blockly.inject("blockly", {
  toolbox: buildToolbox(board),
  renderer: "bloq-zelos",
  grid: { spacing: 24, length: 3, colour: "#313244", snap: true },
  zoom: { controls: true, wheel: true, startScale: 0.9, maxScale: 3, minScale: 0.3 },
  move: { scrollbars: true, drag: true, wheel: true },
  trashcan: true,
  plugins: { metricsManager: OverlayMetricsManager },
});

// Keep the block flyout pinned open (don't auto-close after dragging a block).
const flyout = workspace.getFlyout();
if (flyout) (flyout as unknown as { autoClose: boolean }).autoClose = false;

// Supply the Variables category flyout (get/set blocks + "Create variable"
// button). Blockly registers this by default, but do it explicitly so the
// custom category in buildToolbox always resolves.
if (Blockly.Variables?.flyoutCategory) {
  workspace.registerToolboxCategoryCallback("VARIABLE", Blockly.Variables.flyoutCategory);
}

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
  highlightUnknownBlocks(lastResult.unknownBlocks);
  autosave();
}

// Blocks with no generator are filled red on the canvas, with the error in
// their tooltip (hover) and a warning bubble. Tracks the previous set (and each
// block's original tooltip) so marks can be cleared when the block is fixed.
const UNKNOWN_MSG = "⚠ This block has no code generator — it won't run. Delete or replace it.";
let markedUnknown: string[] = [];
const savedTooltips = new Map<string, unknown>();
function highlightUnknownBlocks(ids: string[]): void {
  const next = new Set(ids);
  for (const id of markedUnknown) {
    if (next.has(id)) continue;
    const b = workspace.getBlockById(id) as Blockly.BlockSvg | null;
    if (b) {
      b.getSvgRoot()?.classList.remove("bloq-unknown-block");
      b.setWarningText(null);
      if (savedTooltips.has(id)) b.setTooltip(savedTooltips.get(id) as string);
    }
    savedTooltips.delete(id);
  }
  for (const id of ids) {
    const b = workspace.getBlockById(id) as Blockly.BlockSvg | null;
    if (!b) continue;
    b.getSvgRoot()?.classList.add("bloq-unknown-block");
    if (!savedTooltips.has(id)) savedTooltips.set(id, b.tooltip);
    b.setTooltip(UNKNOWN_MSG);
    b.setWarningText(UNKNOWN_MSG);
  }
  markedUnknown = ids;
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

// Keep free-floating value blocks (unconnected reporters) drawn on top of other
// blocks, so raising a selected/dragged block doesn't hide the small ones behind
// it. Moving an SVG group to be its parent's last child renders it in front.
function raiseFloatingValueBlocks(): void {
  if (workspace.isDragging()) return;
  for (const b of workspace.getTopBlocks(false)) {
    if (!b.outputConnection) continue; // reporters only; leave statement stacks
    const g = (b as Blockly.BlockSvg).getSvgRoot();
    g.parentNode?.appendChild(g);
  }
}

workspace.addChangeListener((e: Blockly.Events.Abstract) => {
  if (e.type === Blockly.Events.SELECTED) {
    highlightLinesFor((e as Blockly.Events.Selected).newElementId ?? null);
    raiseFloatingValueBlocks();
  }
  if (
    e.type === Blockly.Events.BLOCK_MOVE ||
    e.type === Blockly.Events.BLOCK_CHANGE ||
    e.type === Blockly.Events.BLOCK_CREATE ||
    e.type === Blockly.Events.BLOCK_DELETE
  ) {
    regenerate();
  }
  if (e.type === Blockly.Events.BLOCK_MOVE || e.type === Blockly.Events.BLOCK_CREATE) {
    raiseFloatingValueBlocks();
  }
});

// Persist a text-area field resize (it fires no Blockly event of its own).
setTextAreaResizeHandler(() => autosave());

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
const splitResizer = document.getElementById("split-resizer")!;
document.querySelectorAll<HTMLButtonElement>(".view-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".view-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const view = btn.dataset.view;
    blocklyPane.classList.toggle("hidden", view === "code");
    codePane.classList.toggle("hidden", view === "blocks");
    codePane.classList.toggle("split", view === "split");
    blocklyPane.classList.toggle("split", view === "split");
    splitResizer.classList.toggle("hidden", view !== "split");
    Blockly.svgResize(workspace);
  });
});

// Drag the split handle to resize the code pane (grows leftward from the right).
splitResizer.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const work = document.getElementById("work")!;
  const onMove = (ev: MouseEvent) => {
    const rect = work.getBoundingClientRect();
    const codeWidth = rect.right - ev.clientX;
    const clamped = Math.max(200, Math.min(rect.width - 200, codeWidth));
    codePane.style.flex = `0 0 ${clamped}px`;
    Blockly.svgResize(workspace);
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

// ---- Terminal + connection pool (shared across projects) ----
const drawer = document.getElementById("terminal-drawer")!;
const connectBtn = document.getElementById("btn-connect")!;

// Project -> last device id it ran/saved on (session only; ports aren't
// re-grantable across reloads, so there's nothing to persist).
const projectLink = new Map<string, string>();

const pool = new ConnectionPool({
  onData: (id, text) => panel.writeTo(id, text),
  onStatus: () => syncPool(),
});

const panel = new TerminalPanel(document.getElementById("term-container")!, {
  onSelect: (id) => pool.highlight(id),
  onToggle: (id) => void toggleDevice(id),
  onStop: (id) => {
    const s = pool.get(id);
    if (s?.connected) void s.stop();
  },
  onReset: (id) => {
    const s = pool.get(id);
    if (s?.connected) void s.reset();
  },
  onClose: (id) => void pool.remove(id),
  onKey: (id, data) => void pool.get(id)?.sendKey(data),
  onRename: (id, name) => pool.rename(id, name),
});

// Reconcile the terminal panes + toolbar with the pool state.
function syncPool(): void {
  for (const e of pool.list()) {
    if (!panel.has(e.id)) {
      panel.addPane(e.id, pool.labelFor(e.id), e.service.connected, e.service.getBuffer());
    } else {
      panel.setLabel(e.id, pool.labelFor(e.id));
      panel.setConnected(e.id, e.service.connected);
    }
  }
  panel.retain(pool.list().map((e) => e.id));
  panel.highlight(pool.highlighted);
  const svc = pool.highlightedService();
  const active = !!svc?.connected;
  (["btn-run", "btn-save-board"] as const).forEach((id) => {
    (document.getElementById(id) as HTMLButtonElement).disabled = !active;
  });
  if (pool.isEmpty()) closeTerminal();
}

// On tab switch: re-highlight the device this project last used, if it's still open.
function activateConnection(): void {
  const linked = projectLink.get(current.id);
  if (linked && pool.has(linked)) pool.highlight(linked);
  else syncPool();
}

async function toggleDevice(id: string): Promise<void> {
  const svc = pool.get(id);
  if (!svc) return;
  try {
    if (svc.connected) await svc.close();
    else await svc.reopen(board);
  } catch (err) {
    alert(`Connection error: ${(err as Error).message}`);
  }
}

function openTerminal(): void {
  drawer.classList.remove("hidden");
  Blockly.svgResize(workspace); // canvas shrinks to make room, no overlap
  panel.refit();
}
function closeTerminal(): void {
  drawer.classList.add("hidden");
  Blockly.svgResize(workspace);
}

document.getElementById("btn-terminal")!.addEventListener("click", () =>
  drawer.classList.contains("hidden") ? openTerminal() : closeTerminal()
);

// The top Connect button always opens a NEW device.
connectBtn.addEventListener("click", async () => {
  try {
    const id = await pool.openNew(board);
    if (id) openTerminal();
  } catch (err) {
    alert(`Could not open device: ${(err as Error).message}`);
  }
});

// Files this program needs on the device (runtime lib only when scheduler used).
function requiredFiles(): { dest: string; content: string }[] {
  const files: { dest: string; content: string }[] = [];
  if (lastResult?.requiredLibraries.has("/lib/bloq.py")) {
    files.push({ dest: "/lib/bloq.py", content: bloqSource });
  }
  return files;
}

// While a flash write is in progress, disable controls that could interrupt it
// (reset/stop/disconnect/close and Run/Save) — an interrupted write corrupts the
// device filesystem.
function setBusy(id: string, busy: boolean): void {
  panel.setBusy(id, busy);
  if (busy) {
    (["btn-run", "btn-save-board"] as const).forEach((b) => {
      (document.getElementById(b) as HTMLButtonElement).disabled = true;
    });
  } else {
    syncPool();
  }
}

// Run / Save use the highlighted device, and link it to the current project.
async function sendToDevice(action: (svc: SerialService) => Promise<void>): Promise<void> {
  const svc = pool.highlightedService();
  const id = pool.highlighted;
  if (!svc || !svc.connected || !id) return;
  projectLink.set(current.id, id); // remember for this project's next tab visit
  setBusy(id, true);
  try {
    await svc.syncLibraries(requiredFiles());
    await action(svc);
  } catch (err) {
    panel.writeTo(id, `\r\n[error] ${(err as Error).message}\r\n`);
  } finally {
    setBusy(id, false);
  }
}

document.getElementById("btn-run")!.addEventListener("click", () =>
  void sendToDevice((svc) => svc.run(currentCode()))
);
document.getElementById("btn-save-board")!.addEventListener("click", () =>
  void sendToDevice((svc) => svc.saveToBoard(currentCode()))
);

// Drag the drawer's left edge to resize the whole terminal panel.
document.getElementById("term-width-resizer")!.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const onMove = (ev: MouseEvent) => {
    drawer.style.width = `${Math.max(280, Math.min(900, window.innerWidth - ev.clientX))}px`;
    Blockly.svgResize(workspace);
    panel.refit();
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

function currentCode(): string {
  return detached ? codeEdit.value : lastResult?.code ?? "";
}

// ---- Project management (IndexedDB library + file import/export) ----
const LAST_OPEN_KEY = "bloq:lastOpen";
let current: ProjectRecord = newRecord("Untitled", board.id);
let loading = false; // suppress autosave while applying a loaded project

const nameEl = document.getElementById("project-name")!;

// Ids that have been committed to the store. A brand-new project stays an
// in-memory draft (a tab, but not in the library) until it's actually edited.
const persistedIds = new Set<string>();

function setName(name: string): void {
  current.name = name;
  nameEl.textContent = name;
}

function isDraft(): boolean {
  return workspace.getAllBlocks(false).length === 0 && !detached;
}

// autosave() is called by regenerate() on every workspace change, and on flush.
function autosave(): void {
  if (loading) return;
  current.blocks = Blockly.serialization.workspaces.save(workspace);
  current.board = board.id;
  current.detached = detached;
  current.editedCode = detached ? codeEdit.value : undefined;
  current.view = { scale: workspace.getScale(), x: workspace.scrollX, y: workspace.scrollY };
  current.updatedAt = Date.now();
  localStorage.setItem(LAST_OPEN_KEY, current.id);
  // Don't write empty, never-saved drafts to the library.
  if (isDraft() && !persistedIds.has(current.id)) return;
  persistedIds.add(current.id);
  void projectStore.put(current);
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
  workspace.clearUndo(); // don't let undo cross project boundaries
  // Restore this tab's own zoom + scroll.
  if (rec.view) {
    workspace.setScale(rec.view.scale);
    workspace.scroll(rec.view.x, rec.view.y);
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
  activateConnection(); // rebind terminal + toolbar to this project's connection
  localStorage.setItem(LAST_OPEN_KEY, current.id);
}

// ---- Open project tabs (multi-project) ----
// One workspace instance whose content is swapped on tab switch. Non-active tabs
// are flushed to the store when left, so their in-memory records stay current.
// Blockly's clipboard is module-global, so copy in one tab / paste in another
// works across a switch.
const OPEN_TABS_KEY = "bloq:openTabs";
const tabbar = document.getElementById("tabbar")!;
let openTabs: ProjectRecord[] = [];

function persistTabs(): void {
  localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(openTabs.map((t) => t.id)));
  localStorage.setItem(LAST_OPEN_KEY, current.id);
}

// Offset the tab strip so tabs line up with the left edge of the canvas
// (i.e. past the toolbox category rail).
function alignTabbar(): void {
  const toolbox = document.querySelector<HTMLElement>(".blocklyToolbox, .blocklyToolboxDiv");
  tabbar.style.paddingLeft = `${(toolbox?.offsetWidth ?? 0) + 8}px`;
}

function renderTabs(): void {
  tabbar.innerHTML = "";
  alignTabbar();
  for (const t of openTabs) {
    const tab = document.createElement("div");
    tab.className = "tab" + (t.id === current.id ? " active" : "");
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = t.name;
    label.title = t.name;
    label.addEventListener("click", () => openProject(t));
    const close = document.createElement("button");
    close.className = "tab-close";
    close.title = "Close tab";
    close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(t.id);
    });
    tab.append(label, close);
    tabbar.appendChild(tab);
  }
  const add = document.createElement("button");
  add.className = "tab-new";
  add.title = "New project";
  add.innerHTML = '<i class="fa-solid fa-plus"></i>';
  add.addEventListener("click", () => openProject(newRecord("Untitled", DEFAULT_BOARD)));
  tabbar.appendChild(add);
}

function openProject(rec: ProjectRecord): void {
  const existing = openTabs.find((t) => t.id === rec.id);
  if (existing) {
    if (existing.id !== current.id) switchTo(existing);
    return;
  }
  openTabs.push(rec);
  switchTo(rec);
}

function switchTo(rec: ProjectRecord): void {
  if (current && current.id !== rec.id) autosave(); // flush the tab we're leaving
  applyProject(rec);
  renderTabs();
  persistTabs();
  // Focus the workspace so keyboard paste works immediately (no canvas click).
  workspace.markFocused();
}

function closeTab(id: string): void {
  const idx = openTabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const wasActive = current.id === id;
  if (wasActive) autosave(); // flush before closing
  openTabs.splice(idx, 1);
  if (openTabs.length === 0) {
    openProject(newRecord("Untitled", DEFAULT_BOARD));
  } else if (wasActive) {
    switchTo(openTabs[Math.min(idx, openTabs.length - 1)]);
  } else {
    renderTabs();
    persistTabs();
  }
}

const library = initLibrary({
  onOpen: async (id) => {
    const rec = await projectStore.get(id);
    if (rec) {
      persistedIds.add(rec.id); // came from the store, so it's already saved
      openProject(rec);
    }
  },
  currentId: () => current.id,
});

document.getElementById("btn-open")!.addEventListener("click", () => library.open());
document.getElementById("btn-new")!.addEventListener("click", () =>
  openProject(newRecord("Untitled", DEFAULT_BOARD))
);
document.getElementById("btn-export")!.addEventListener("click", () => {
  autosave();
  download(current);
});

nameEl.addEventListener("click", () => {
  const name = prompt("Project name:", current.name);
  if (name && name.trim()) {
    setName(name.trim());
    persistedIds.add(current.id); // naming a project is intent to keep it
    renderTabs();
    autosave();
  }
});

// ---- Boot: reopen previously open tabs, else start fresh ----
async function boot(): Promise<void> {
  let ids: string[] = [];
  try {
    ids = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) ?? "[]");
  } catch {
    /* ignore corrupt tab list */
  }
  for (const id of ids) {
    const rec = await projectStore.get(id);
    if (rec) {
      persistedIds.add(rec.id); // restored from the store => already saved
      openTabs.push(rec);
    }
  }
  if (openTabs.length === 0) openTabs.push(newRecord("Untitled", DEFAULT_BOARD));
  const activeId = localStorage.getItem(LAST_OPEN_KEY);
  const active = openTabs.find((t) => t.id === activeId) ?? openTabs[0];
  applyProject(active);
  renderTabs();
  persistTabs();
}
void boot();
