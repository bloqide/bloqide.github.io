// Project persistence model.
//
// A ProjectRecord is what lives in the IndexedDB library (has an id + timestamp).
// A ProjectFile is the portable .mbproj shape written to / read from disk — no
// library-local fields, plus a formatVersion so older files keep loading as the
// schema grows.

export interface ProjectRecord {
  id: string;
  name: string;
  board: string; // board id
  blocks: unknown; // Blockly.serialization.workspaces.save() output
  detached: boolean;
  editedCode?: string; // present only when detached
  view?: { scale: number; x: number; y: number }; // per-tab zoom + scroll
  updatedAt: number;
}

export interface ProjectFile {
  formatVersion: number;
  name: string;
  board: string;
  blocks: unknown;
  detached: boolean;
  editedCode?: string;
}

export const FORMAT_VERSION = 1;
