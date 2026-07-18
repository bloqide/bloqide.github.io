/*
 * Bloq — offline block-based MicroPython IDE
 * Copyright (C) 2026 Benjamin Balga
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { getBoard, activePlugins } from "../core/registry";
import { newId } from "../project/serde";
import type { ProjectRecord } from "../project/types";
import type { BoardExampleRef } from "../core/types";

// The Examples dialog: full-project templates for the current board (and its
// active plugins). Opening one loads its bundled .bloq into a fresh project.

// Example .bloq files -> bundled URLs, keyed by filename. Plugins keep theirs in
// plugins/<id>/examples/; boards in boards/<id>/examples/.
const exampleFiles = import.meta.glob<string>(
  ["../../plugins/*/examples/*.bloq", "../../boards/*/examples/*.bloq"],
  { query: "?url", import: "default", eager: true }
);
const urlByFile = new Map<string, string>(
  Object.entries(exampleFiles).map(([p, url]) => [p.split("/").pop()!, url])
);

export interface ExamplesHandlers {
  currentBoardId: () => string;
  onOpen: (rec: ProjectRecord) => void;
}

export function initExamplesPicker(handlers: ExamplesHandlers): { open: () => void } {
  const dialog = document.getElementById("examples-dialog") as HTMLDialogElement;
  const grid = dialog.querySelector(".examples-grid") as HTMLElement;

  function examplesForCurrent(): BoardExampleRef[] {
    const board = getBoard(handlers.currentBoardId());
    if (!board) return [];
    const fromPlugins = activePlugins(board).flatMap((p) => p.examples ?? []);
    return [...(board.examples ?? []), ...fromPlugins];
  }

  async function openExample(ref: BoardExampleRef): Promise<void> {
    const url = urlByFile.get(ref.file);
    if (!url) {
      alert(`Example file not found: ${ref.file}`);
      return;
    }
    const file = await (await fetch(url)).json();
    handlers.onOpen({
      id: newId(),
      name: ref.name,
      board: file.board ?? handlers.currentBoardId(),
      blocks: file.blocks,
      detached: !!file.detached,
      editedCode: file.editedCode,
      updatedAt: Date.now(),
    });
  }

  function card(ref: BoardExampleRef): HTMLElement {
    const el = document.createElement("button");
    el.className = "example-card";
    el.innerHTML = `
      <div class="example-icon"><i class="fa-solid fa-puzzle-piece"></i></div>
      <div class="example-meta">
        <span class="example-name"></span>
        <span class="example-desc"></span>
      </div>`;
    el.querySelector(".example-name")!.textContent = ref.name;
    el.querySelector(".example-desc")!.textContent = ref.description ?? "";
    el.addEventListener("click", async () => {
      await openExample(ref);
      dialog.close();
    });
    return el;
  }

  function render(): void {
    const items = examplesForCurrent();
    grid.innerHTML = "";
    if (!items.length) {
      grid.innerHTML = `<p class="lib-empty">No examples for this board yet.</p>`;
      return;
    }
    for (const ref of items) grid.appendChild(card(ref));
  }

  dialog
    .querySelectorAll('[data-act="close"]')
    .forEach((b) => b.addEventListener("click", () => dialog.close()));

  return {
    open: () => {
      render();
      dialog.showModal();
    },
  };
}
