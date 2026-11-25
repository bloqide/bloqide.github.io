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

// App status slot (left of the tab bar, under the logo). Shows one thing:
//   1. "Update" — a new version was downloaded by the service worker and is
//      waiting; clicking asks to restart into it.
//   2. "Install" — the browser says the PWA is installable (Chromium fires
//      `beforeinstallprompt`; other browsers never do, so it stays hidden).
//   3. otherwise the build date code, so users can tell which deploy they run.

import { registerSW } from "virtual:pwa-register";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// A long-lived IDE tab never navigates, so the browser would only look for a
// new service worker on the next load; poll so open sessions notice deploys.
const UPDATE_CHECK_MS = 60 * 60 * 1000;

export interface AppStatusOptions {
  /** Flush unsaved state right before the page reloads into the new version. */
  beforeRestart: () => void;
}

export function initAppStatus(opts: AppStatusOptions): void {
  const installBtn = document.getElementById("btn-install") as HTMLButtonElement;
  const updateBtn = document.getElementById("btn-update") as HTMLButtonElement;
  const versionEl = document.getElementById("app-version")!;
  const dialog = document.getElementById("update-dialog") as HTMLDialogElement;

  versionEl.textContent = `v${__BUILD_DATE__}`;
  versionEl.title =
    `Bloq build ${__BUILD_DATE__}` +
    (__BUILD_COMMIT__ ? ` (${__BUILD_COMMIT__})` : "") +
    `\nBuilt ${__BUILD_TIME__.replace("T", " ").slice(0, 16)} UTC`;

  let installEvent: BeforeInstallPromptEvent | null = null;
  let updateReady = false;
  let registration: ServiceWorkerRegistration | undefined;

  const render = (): void => {
    updateBtn.classList.toggle("hidden", !updateReady);
    installBtn.classList.toggle("hidden", updateReady || !installEvent);
    versionEl.classList.toggle("hidden", updateReady || !!installEvent);
  };

  // ---- Install ----
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // suppress the browser's own mini-infobar; we offer the button
    installEvent = e as BeforeInstallPromptEvent;
    render();
  });
  window.addEventListener("appinstalled", () => {
    installEvent = null;
    render();
  });
  installBtn.addEventListener("click", async () => {
    const ev = installEvent;
    if (!ev) return;
    installEvent = null; // a prompt event is single-use; if dismissed, the
    render(); //            browser fires a fresh one later, re-showing the button
    await ev.prompt();
    await ev.userChoice;
  });

  // ---- Update ----
  // In dev there's no service worker (devOptions off), so this is a no-op.
  const updateSW = registerSW({
    onNeedRefresh() {
      updateReady = true;
      render();
    },
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      registration = reg;
      setInterval(() => {
        // Skip while offline / mid-install; update() rejects on network errors.
        if (navigator.onLine && !reg.installing) reg.update().catch(() => {});
      }, UPDATE_CHECK_MS);
    },
  });

  // Activate the waiting service worker, then reload into it. The plugin only
  // reloads on `controllerchange`, which never fires for a page that isn't
  // controlled yet (first visit, still open when the update landed), so wait
  // for the worker to reach "activated" ourselves — reloading before that
  // would be served by the old worker's cache.
  let restarting = false;
  const restart = (): void => {
    if (restarting) return;
    restarting = true;
    opts.beforeRestart();
    const waiting = registration?.waiting;
    const reload = (): void => window.location.reload();
    if (!waiting) return reload();
    waiting.addEventListener("statechange", () => {
      if (waiting.state === "activated") reload();
    });
    setTimeout(reload, 5000); // safety net if the state change never arrives
    void updateSW(true); // posts SKIP_WAITING to the waiting worker
  };

  updateBtn.addEventListener("click", () => dialog.showModal());
  dialog.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "close") dialog.close();
    if (act === "restart") restart();
  });

  render();
}
