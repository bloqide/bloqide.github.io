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

import { projectStore } from "../project/store";
import { fromFile, pickFile, newId } from "../project/serde";
import type { ProjectRecord } from "../project/types";

// The "Open…" project library dialog: lists saved projects with open/duplicate/
// delete, and imports .bloq files. Uses a native <dialog>. Opening a project
// is delegated to the caller (it owns the workspace); everything else is handled
// here against the store, then the list re-renders.

export interface LibraryHandlers {
  onOpen: (id: string) => void | Promise<void>;
  currentId: () => string | null;
}

export function initLibrary(handlers: LibraryHandlers): { open: () => void } {
  const dialog = document.getElementById("library-dialog") as HTMLDialogElement;
  const listEl = dialog.querySelector(".lib-list") as HTMLElement;

  async function render(): Promise<void> {
    const records = await projectStore.list();
    const current = handlers.currentId();
    listEl.innerHTML = "";
    if (records.length === 0) {
      listEl.innerHTML = `<p class="lib-empty">No saved projects yet.</p>`;
      return;
    }
    for (const rec of records) {
      listEl.appendChild(row(rec, rec.id === current));
    }
  }

  function row(rec: ProjectRecord, isCurrent: boolean): HTMLElement {
    const el = document.createElement("div");
    el.className = "lib-row" + (isCurrent ? " current" : "");
    el.innerHTML = `
      <div class="lib-meta">
        <span class="lib-name"></span>
        <span class="lib-sub"></span>
      </div>
      <div class="lib-actions">
        <button data-act="open">Open</button>
        <button data-act="dup">Duplicate</button>
        <button data-act="del" class="danger">Delete</button>
      </div>`;
    el.querySelector(".lib-name")!.textContent = rec.name + (isCurrent ? " (current)" : "");
    el.querySelector(".lib-sub")!.textContent = `${rec.board} · ${timeAgo(rec.updatedAt)}`;

    el.querySelector('[data-act="open"]')!.addEventListener("click", async () => {
      await handlers.onOpen(rec.id);
      dialog.close();
    });
    el.querySelector('[data-act="dup"]')!.addEventListener("click", async () => {
      await projectStore.put({ ...rec, id: newId(), name: rec.name + " copy", updatedAt: Date.now() });
      await render();
    });
    el.querySelector('[data-act="del"]')!.addEventListener("click", async () => {
      if (confirm(`Delete "${rec.name}"? This cannot be undone.`)) {
        await projectStore.delete(rec.id);
        await render();
      }
    });
    return el;
  }

  dialog.querySelector('[data-act="import"]')!.addEventListener("click", async () => {
    const file = await pickFile();
    if (!file) return;
    const rec = fromFile(file);
    await projectStore.put(rec);
    await handlers.onOpen(rec.id);
    dialog.close();
  });
  dialog
    .querySelectorAll('[data-act="close"]')
    .forEach((b) => b.addEventListener("click", () => dialog.close()));

  return {
    open: () => {
      void render();
      dialog.showModal();
    },
  };
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
