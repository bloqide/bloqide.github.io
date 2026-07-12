import * as Blockly from "blockly";

// A multi-line text field rendered as a real HTML <textarea> inside the block,
// resizable by its bottom-right corner (CSS `resize: both`). The chosen width /
// height are stored alongside the text so the size persists with the project.
// Used by the comment block and the raw-MicroPython block.

const DEFAULT_W = 240;
const DEFAULT_H = 72;
const MIN_W = 60;
const MIN_H = 28;
// Margin between the textarea and its field box, so the textarea (and its resize
// handle) sits cleanly inside the block chrome instead of under the border.
const PAD = 6;

interface TextAreaConfig extends Blockly.FieldConfig {
  width?: number;
  height?: number;
}

// Resizing changes the field's serialized size but fires no Blockly event, so
// nothing would persist it. The app registers a handler here to autosave.
let onResize: (() => void) | null = null;
export function setTextAreaResizeHandler(cb: () => void): void {
  onResize = cb;
}

export class FieldTextArea extends Blockly.Field<string> {
  private ta: HTMLTextAreaElement | null = null;
  private fo: SVGForeignObjectElement | null = null;
  private w = DEFAULT_W;
  private h = DEFAULT_H;
  private ro: ResizeObserver | null = null;

  constructor(value?: string, config?: TextAreaConfig) {
    super(value ?? "", null, config);
    this.SERIALIZABLE = true;
    if (config?.width) this.w = config.width;
    if (config?.height) this.h = config.height;
  }

  static fromJson(options: TextAreaConfig & { text?: string }): FieldTextArea {
    return new FieldTextArea(
      Blockly.utils.parsing.replaceMessageReferences(options.text ?? ""),
      options
    );
  }

  protected override initView(): void {
    this.fo = Blockly.utils.dom.createSvgElement(
      "foreignObject",
      { x: 0, y: 0, width: this.w, height: this.h },
      this.fieldGroup_ as SVGGElement
    ) as unknown as SVGForeignObjectElement;

    const ta = document.createElement("textarea");
    ta.className = "bloq-textarea";
    ta.style.margin = `${PAD}px`;
    ta.value = this.getValue() ?? "";
    ta.spellcheck = false;
    ta.addEventListener("input", () => this.setValue(ta.value));
    // Stop block/workspace gestures from hijacking clicks, text selection, and
    // the corner-drag resize.
    for (const t of ["pointerdown", "mousedown", "touchstart", "wheel"]) {
      ta.addEventListener(t, (e) => e.stopPropagation());
    }
    this.fo.appendChild(ta);
    this.ta = ta;
    this.applySize();

    this.ro = new ResizeObserver(() => this.syncFromTextarea());
    this.ro.observe(ta);
  }

  // Size the foreignObject to the field box and the textarea to the box minus
  // the inset margin on all sides.
  private applySize(): void {
    this.fo?.setAttribute("width", String(this.w));
    this.fo?.setAttribute("height", String(this.h));
    if (this.ta) {
      this.ta.style.width = `${this.w - 2 * PAD}px`;
      this.ta.style.height = `${this.h - 2 * PAD}px`;
    }
  }

  // Pick a field size so the BLOCK outline (field + fixed chrome) lands on the
  // grid. `overhead` is the constant block-vs-field size difference; `ignore`
  // removes the bottom connection knob from the height so the block *body*
  // aligns and the knob hangs below the line.
  private snapOuter(fieldPx: number, overhead: number, ignore: number, min: number, step: number): number {
    const body = Math.round((fieldPx + overhead - ignore) / step) * step;
    return Math.max(min, body - overhead + ignore);
  }

  // Corner-drag changed the textarea size → snap the block to the grid, adopt
  // the result, and re-lay-out. Writing the snapped size back makes the drag
  // "click" into grid steps.
  private syncFromTextarea(): void {
    if (!this.ta) return;
    const block = this.getSourceBlock() as Blockly.BlockSvg | null;
    const step = block?.workspace?.getGrid?.()?.getSpacing?.() || 24;
    // Fixed chrome around the field (block outline minus field), measured live.
    const oW = block ? Math.max(0, block.width - this.w) : 0;
    const oH = block ? Math.max(0, block.height - this.h) : 0;
    const knob = block ? block.workspace.getRenderer().getConstants().NOTCH_HEIGHT : 0;

    // offsetWidth/Height are the textarea box; the field box is that plus the
    // inset margin on both sides. Snap the field box (via the block outline).
    const w = this.snapOuter(this.ta.offsetWidth + 2 * PAD, oW, 0, MIN_W, step);
    const h = this.snapOuter(this.ta.offsetHeight + 2 * PAD, oH, knob, MIN_H, step);
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.applySize();
    this.forceRerender();
    onResize?.(); // persist the new size (fires only on an actual grid step)
  }

  protected override updateSize_(): void {
    this.size_.width = this.w;
    this.size_.height = this.h;
  }

  protected override render_(): void {
    if (this.ta && this.ta.value !== this.getValue()) this.ta.value = this.getValue() ?? "";
    this.applySize();
    this.updateSize_();
  }

  // The textarea is always editable in place — no popup editor.
  protected override showEditor_(): void {}

  protected override doClassValidation_(newValue?: string): string | null {
    return newValue == null ? "" : String(newValue);
  }

  override saveState(): unknown {
    return { text: this.getValue(), width: this.w, height: this.h };
  }
  override loadState(state: { text?: string; width?: number; height?: number }): void {
    this.setValue(state?.text ?? "");
    this.w = state?.width ?? DEFAULT_W;
    this.h = state?.height ?? DEFAULT_H;
    if (this.ta) this.ta.value = this.getValue() ?? "";
    this.applySize();
    this.forceRerender();
  }

  override dispose(): void {
    this.ro?.disconnect();
    this.ro = null;
    super.dispose();
  }
}

// Register once (guard against dev HMR re-import).
if (!Blockly.registry.hasItem(Blockly.registry.Type.FIELD, "field_textarea")) {
  Blockly.fieldRegistry.register("field_textarea", FieldTextArea);
}
