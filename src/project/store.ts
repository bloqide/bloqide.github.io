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

import type { ProjectRecord } from "./types";

// Minimal IndexedDB-backed project library (no dependency). One object store
// keyed by project id.

const DB_NAME = "bloq";
const STORE = "projects";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

export const projectStore = {
  async list(): Promise<ProjectRecord[]> {
    const all = await tx<ProjectRecord[]>("readonly", (s) => s.getAll() as IDBRequest<ProjectRecord[]>);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },
  get(id: string): Promise<ProjectRecord | undefined> {
    return tx<ProjectRecord | undefined>("readonly", (s) => s.get(id) as IDBRequest<ProjectRecord | undefined>);
  },
  async put(rec: ProjectRecord): Promise<void> {
    await tx("readwrite", (s) => s.put(rec));
  },
  async delete(id: string): Promise<void> {
    await tx("readwrite", (s) => s.delete(id));
  },
};
