import { allBoards } from "../core/registry";
import { faClass } from "../core/blocks";
import type { Board, Capability } from "../core/types";

// Board photos, resolved to bundled URLs and keyed by filename (icon.imageRef).
const boardImages = import.meta.glob<string>("../../boards/images/*.{jpg,jpeg,png,svg,webp}", {
  query: "?url",
  import: "default",
  eager: true,
});
const imageByName = new Map<string, string>(
  Object.entries(boardImages).map(([path, url]) => [path.split("/").pop()!, url])
);

// The board picker dialog: a grid of board cards (icon, name, MCU, feature
// chips). Mirrors the project library dialog. Selecting a board is delegated to
// the caller (it owns the workspace/project); this module just renders + closes.

export interface BoardPickerHandlers {
  onSelect: (id: string) => void;
  currentId: () => string;
}

// Accent colour per vendor for the icon tile.
const VENDOR_COLOUR: Record<string, string> = {
  Espressif: "#e7352c",
  "Raspberry Pi": "#c51a4a",
};

const FEATURE_LABEL: Record<Capability, string> = {
  gpio: "GPIO",
  adc: "ADC",
  pwm: "PWM",
  dac: "DAC",
  i2c: "I²C",
  spi: "SPI",
  uart: "UART",
  wifi: "Wi-Fi",
  ble: "BLE",
  neopixel: "NeoPixel",
};

export function initBoardPicker(handlers: BoardPickerHandlers): { open: () => void } {
  const dialog = document.getElementById("board-dialog") as HTMLDialogElement;
  const grid = dialog.querySelector(".board-grid") as HTMLElement;

  function render(): void {
    const current = handlers.currentId();
    grid.innerHTML = "";
    for (const b of allBoards()) grid.appendChild(card(b, b.id === current));
  }

  function card(b: Board, isCurrent: boolean): HTMLElement {
    const el = document.createElement("button");
    el.className = "board-card" + (isCurrent ? " current" : "");
    const accent = VENDOR_COLOUR[b.meta.vendor] ?? "var(--accent)";
    const feats = b.capabilities
      .map((c) => `<span class="feat">${FEATURE_LABEL[c] ?? c}</span>`)
      .join("");
    const glyph = faClass(b.icon?.faIcon ?? "fa-microchip");
    const iconTile = `<div class="board-icon" style="background:${accent}"><i class="${glyph}"></i></div>`;
    const imgUrl = b.icon?.imageRef ? imageByName.get(b.icon.imageRef) : undefined;
    const visual = imgUrl
      ? `<img class="board-img" src="${imgUrl}" alt="">`
      : iconTile;
    el.innerHTML = `
      <div class="board-visual">${visual}</div>
      <div class="board-name"></div>
      <div class="board-mcu"></div>
      <div class="board-feats">${feats}</div>`;
    // If the photo fails to load, fall back to the icon tile.
    const img = el.querySelector<HTMLImageElement>(".board-img");
    if (img) {
      img.addEventListener("error", () => {
        img.closest(".board-visual")!.innerHTML = iconTile;
      });
    }
    el.querySelector(".board-name")!.textContent = b.name + (isCurrent ? " ✓" : "");
    el.querySelector(".board-mcu")!.textContent = `${b.meta.vendor} · ${b.meta.mcu}`;
    el.addEventListener("click", () => {
      handlers.onSelect(b.id);
      dialog.close();
    });
    return el;
  }

  dialog
    .querySelectorAll('[data-act="close"]')
    .forEach((btn) => btn.addEventListener("click", () => dialog.close()));

  return {
    open: () => {
      render();
      dialog.showModal();
    },
  };
}
