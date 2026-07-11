import type { ProjectFile, ProjectRecord } from "./types";
import { FORMAT_VERSION } from "./types";

// Serialize projects to/from the portable .mbproj file format, and helpers for
// creating fresh records and downloading/importing files.

export function newId(): string {
  return crypto.randomUUID();
}

export function newRecord(name: string, board: string): ProjectRecord {
  return {
    id: newId(),
    name,
    board,
    blocks: { languageVersion: 0, blocks: [] },
    detached: false,
    updatedAt: Date.now(),
  };
}

export function toFile(rec: ProjectRecord): ProjectFile {
  return {
    formatVersion: FORMAT_VERSION,
    name: rec.name,
    board: rec.board,
    blocks: rec.blocks,
    detached: rec.detached,
    editedCode: rec.editedCode,
  };
}

/** Adopt an imported file as a new library record (fresh id + timestamp). */
export function fromFile(file: ProjectFile): ProjectRecord {
  return {
    id: newId(),
    name: file.name || "Imported project",
    board: file.board,
    blocks: file.blocks,
    detached: !!file.detached,
    editedCode: file.editedCode,
    updatedAt: Date.now(),
  };
}

export function download(rec: ProjectRecord): void {
  const blob = new Blob([JSON.stringify(toFile(rec), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitizeName(rec.name)}.mbproj`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Prompt the user for a .mbproj file and parse it. Returns null if cancelled. */
export function pickFile(): Promise<ProjectFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".mbproj,application/json";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      try {
        const parsed = JSON.parse(await f.text()) as ProjectFile;
        if (typeof parsed !== "object" || !parsed.board || !parsed.blocks) {
          throw new Error("Not a valid .mbproj file");
        }
        resolve(parsed);
      } catch (err) {
        alert(`Could not open file: ${(err as Error).message}`);
        resolve(null);
      }
    };
    input.click();
  });
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "project";
}
