// ---------------------------------------------------------------------------
// Core contracts shared by boards, plugins, codegen and the UI.
// Everything (file plugins, wizard blocks, reusable blocks, raw-code blocks,
// board overrides) ultimately produces the same (BlockDef, BlockGenerator) pair
// and flows through the same GenContext.
// ---------------------------------------------------------------------------

import type * as Blockly from "blockly";

/** A hardware capability a board declares and a block may require. */
export type Capability =
  | "gpio"
  | "adc"
  | "pwm"
  | "dac"
  | "i2c"
  | "spi"
  | "uart"
  | "wifi"
  | "ble"
  | "neopixel";

// ------------------------------- Board -------------------------------------

export interface BoardLibrary {
  /** Source path (bundled) of a MicroPython file to ship to the device. */
  src: string;
  /** Destination path on the device filesystem, e.g. "/lib/foo.py". */
  dest: string;
}

export interface BoardExampleRef {
  id: string;
  name: string;
  /** Path to a separate .bloq file — lazy-loaded only when opened. */
  file: string;
}

export interface BoardOverride {
  /** Extra imports this dialect needs for the overridden block. */
  imports?: string[];
  /** Template string with {ARG} placeholders — replaces the block's generator. */
  template: string;
}

export interface Board {
  id: string;
  name: string;
  meta: { vendor: string; mcu: string };
  icon?: { preset?: string; imageRef?: string; faIcon?: string };

  connection: {
    baud: number;
    replMode: "raw" | "raw-paste" | "normal";
    resetOnConnect: boolean;
    eol: string;
  };

  runtime: {
    dialect: string; // selects the default template set for core blocks
    imports: string[]; // seed of the program header import set
  };

  pins: {
    digital: number[];
    analog: number[];
    pwm: number[];
    dac?: number[];
    touch?: number[];
    /** Friendly name -> pin expression (e.g. LED -> 8, or "\"LED\""). */
    aliases: Record<string, string | number>;
  };

  buses?: {
    i2c?: { id: number; scl: number; sda: number; freq: number }[];
    spi?: { id: number; sck: number; mosi: number; miso: number }[];
    uart?: { id: number; tx: number; rx: number }[];
  };

  constraints?: {
    adcBits?: number;
    adcVref?: number;
    pwmFreqHz?: [number, number];
    logicVoltage?: number;
  };

  onboard?: { type: string; pin: number | string; name: string }[];

  capabilities: Capability[];
  plugins: string[]; // plugin ids auto-enabled for this board

  libraries?: BoardLibrary[];
  examples?: BoardExampleRef[];

  /** Per-block-type codegen overrides for this dialect. */
  overrides?: Record<string, BoardOverride>;
}

// ------------------------------- Plugin ------------------------------------

/**
 * A statement/hat generator writes lines into the GenContext (no return).
 * Writing (rather than returning a string) is what makes precise line->block
 * source maps possible for the side-by-side view.
 *
 * A generator may instead be a template string (Tier A: wizard/reusable blocks)
 * with {ARG} placeholders — the engine wraps it into an emit call.
 */
export type BlockGenerator =
  | ((block: Blockly.Block, ctx: GenContext) => void)
  | string;

/** A value generator returns a MicroPython expression string. */
export type ValueGenerator = (block: Blockly.Block, ctx: GenContext) => string;

export interface BlockDef {
  /** Blockly JSON block definition (message0, args0, colour, ...). */
  json: Record<string, unknown>;
  /**
   * True for hat blocks (`when started`, `when X`) — program entry points.
   * Multiple hats force scheduler mode.
   */
  hat?: boolean;
  /**
   * A setup hat: its body runs once at module scope before the stacks start
   * (not as a scheduler task), and does NOT count toward the >1-hat scheduler
   * trigger. Variables it assigns become the program's globals.
   */
  setup?: boolean;
  /**
   * Value blocks produce an expression; statement/hat blocks emit lines.
   */
  kind?: "statement" | "value" | "hat";
  /**
   * Explicit scheduler opt-in. A block that needs cooperative background
   * behaviour sets this true; its presence forces scheduler mode even with a
   * single hat. Core control blocks do NOT set this — they adapt to the mode.
   */
  requiresScheduler?: boolean;
  /**
   * Extra props merged into this block's toolbox flyout entry — chiefly `inputs`
   * with shadow blocks (default plugged-in literals) and `fields` (preset field
   * values). An ARRAY produces several flyout entries of the same block type —
   * e.g. one preset variant per operator of a dropdown block.
   */
  toolbox?: Record<string, unknown> | Record<string, unknown>[];
}

export interface BloqPlugin {
  id: string;
  name: string;
  version: string;
  requires?: Capability[]; // capability gate — hidden if board lacks these
  dependencies?: string[]; // other plugin ids

  toolbox: {
    category: string;
    colour: number;
    order: number;
    faIcon?: string;
    /** Blockly dynamic-flyout key (e.g. "VARIABLE") — blocks are supplied by a
     *  registered category callback instead of a static list. */
    custom?: string;
  };
  icon?: { preset?: string; file?: string };

  libraries?: BoardLibrary[]; // device .py deps, merged into the sync set
  examples?: BoardExampleRef[];

  /** Block type -> definition. */
  blocks: Record<string, BlockDef>;
  /** Block type -> generator (statement/hat: BlockGenerator, value: ValueGenerator). */
  generators: Record<string, BlockGenerator | ValueGenerator>;

  onBoardChange?: (board: Board) => void;
}

// --------------------------- Generation context ----------------------------

export interface GenContext {
  /** True when cooperative-scheduler code is being emitted. */
  readonly schedulerMode: boolean;
  readonly board: Board;

  // Header management (deduped across the whole program):
  ensureImport(line: string): void;
  addSetup(line: string): void;
  defineFunction(name: string, body: string): void;
  requireLibrary(dest: string): void;

  // Safe naming:
  reserveVariable(base: string): string;

  // Emitting statement lines (attributed to a block for the source map):
  line(text: string, blockId?: string): void;
  indented(fn: () => void): void;
  /** Recurse into a statement input, emitting nested lines with mapping. */
  statement(block: Blockly.Block, inputName: string): void;
  /** Evaluate a value input to a MicroPython expression string. */
  value(block: Blockly.Block, inputName: string, fallback?: string): string;

  /** Marks that the current stack emitted a yield (scheduler mode bookkeeping). */
  markYield(): void;

  /** Record that a variable name is assigned here (drives `global` decls when
   *  the name is a setup-declared global used inside a scheduler stack). */
  assign(name: string): void;

  /** Count of lines emitted so far — used to detect empty loop bodies. */
  linesEmitted(): number;
}

// ------------------------------- Codegen out -------------------------------

export interface GenResult {
  code: string;
  /** 1-based line number -> block id. */
  lineToBlock: Map<number, string>;
  /** block id -> sorted 1-based line numbers. */
  blockToLines: Map<string, number[]>;
  /** Device files required by this program (dest paths). */
  requiredLibraries: Set<string>;
  schedulerMode: boolean;
  /** Ids of blocks with no generator (rendered as `# [unknown block]`), so the
   *  UI can flag them on the canvas. */
  unknownBlocks: string[];
}
