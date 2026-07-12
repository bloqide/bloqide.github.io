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
