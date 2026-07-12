import * as Blockly from "blockly";

// A multi-line text field rendered as a real HTML <textarea> inside the block.
// The block is resized by a custom bottom-right grip that WE drive from the
// pointer drag (rather than the textarea's native CSS resize), so the gesture
// is smooth and snaps cleanly to the workspace grid. The chosen width / height
// are stored with the text so the size persists with the project.

const DEFAULT_W = 240;
const DEFAULT_H = 72;
const MIN_W = 60;
const MIN_H = 28;
const PAD = 3; // textarea inset within the field box
const GRIP = 14; // resize-grip hit/visual size

// Resizing changes the field's serialized size but fires no Blockly event, so
// nothing would persist it. The app registers a handler here to autosave.
let onResize: (() => void) | null = null;
export function setTextAreaResizeHandler(cb: () => void): void {
  onResize = cb;
}

interface TextAreaConfig extends Blockly.FieldConfig {
  width?: number;
  height?: number;
}

export class FieldTextArea extends Blockly.Field<string> {
  private ta: HTMLTextAreaElement | null = null;
  private fo: SVGForeignObjectElement | null = null;
  private handle: SVGGElement | null = null;
  private w = DEFAULT_W;
  private h = DEFAULT_H;

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
    const group = this.fieldGroup_ as SVGGElement;
    this.fo = Blockly.utils.dom.createSvgElement(
      "foreignObject",
      { x: 0, y: 0, width: this.w, height: this.h },
      group
    ) as unknown as SVGForeignObjectElement;

    const ta = document.createElement("textarea");
    ta.className = "bloq-textarea";
    ta.style.margin = `${PAD}px`;
    ta.value = this.getValue() ?? "";
    ta.spellcheck = false;
    ta.addEventListener("input", () => this.setValue(ta.value));
    // Keep block/workspace gestures from hijacking clicks and text selection.
    for (const t of ["pointerdown", "mousedown", "touchstart", "wheel"]) {
      ta.addEventListener(t, (e) => e.stopPropagation());
    }
    this.fo.appendChild(ta);
    this.ta = ta;

    // Bottom-right resize grip (drawn on top of the text area corner).
    this.handle = Blockly.utils.dom.createSvgElement(
      "g",
      { class: "bloq-resize-handle" },
      group
    ) as SVGGElement;
    Blockly.utils.dom.createSvgElement(
      "path",
      { class: "bloq-resize-grip", d: `M${GRIP - 1},4 L4,${GRIP - 1} M${GRIP - 1},${GRIP - 6} L${GRIP - 6},${GRIP - 1}` },
      this.handle
    );
    Blockly.utils.dom.createSvgElement(
      "rect",
      { x: 0, y: 0, width: GRIP, height: GRIP, fill: "transparent" },
      this.handle
    );
    this.handle.addEventListener("pointerdown", (e) => this.startResize(e as PointerEvent));

    this.applySize();
  }

  // Size the foreignObject to the field box, the textarea to the box minus the
  // inset margin, and place the grip at the bottom-right corner.
  private applySize(): void {
    this.fo?.setAttribute("width", String(this.w));
    this.fo?.setAttribute("height", String(this.h));
    if (this.ta) {
      this.ta.style.width = `${this.w - 2 * PAD}px`;
      this.ta.style.height = `${this.h - 2 * PAD}px`;
    }
    this.handle?.setAttribute("transform", `translate(${this.w - GRIP},${this.h - GRIP})`);
  }

  private startResize(e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const block = this.getSourceBlock() as Blockly.BlockSvg | null;
    const handle = this.handle;
    if (!block || !handle) return;
    const ws = block.workspace as Blockly.WorkspaceSvg;
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = this.w;
    const startH = this.h;
    handle.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      ev.stopPropagation();
      const scale = ws.scale || 1;
      this.resizeTo(startW + (ev.clientX - startX) / scale, startH + (ev.clientY - startY) / scale);
    };
    const up = (ev: PointerEvent) => {
      ev.stopPropagation();
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      onResize?.(); // persist on release
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  // Pick a field size so the BLOCK outline (field + fixed chrome) lands on the
  // grid. `overhead` is the constant block-vs-field size difference; `ignore`
  // removes the bottom connection knob from the height so the body aligns and
  // the knob hangs below the line.
  private snapOuter(fieldPx: number, overhead: number, ignore: number, min: number, step: number): number {
    const body = Math.round((fieldPx + overhead - ignore) / step) * step;
    return Math.max(min, body - overhead + ignore);
  }

  // Snap the requested field-box size to the grid (via the block outline) and
  // apply it live.
  private resizeTo(fieldW: number, fieldH: number): void {
    const block = this.getSourceBlock() as Blockly.BlockSvg | null;
    const step = block?.workspace?.getGrid?.()?.getSpacing?.() || 24;
    const oW = block ? Math.max(0, block.width - this.w) : 0;
    const oH = block ? Math.max(0, block.height - this.h) : 0;
    const knob = block ? block.workspace.getRenderer().getConstants().NOTCH_HEIGHT : 0;
    const w = this.snapOuter(fieldW, oW, 0, MIN_W, step);
    const h = this.snapOuter(fieldH, oH, knob, MIN_H, step);
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.applySize();
    this.forceRerender();
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
}

// Register once (guard against dev HMR re-import).
if (!Blockly.registry.hasItem(Blockly.registry.Type.FIELD, "field_textarea")) {
  Blockly.fieldRegistry.register("field_textarea", FieldTextArea);
}
