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

// Project persistence model.
//
// A ProjectRecord is what lives in the IndexedDB library (has an id + timestamp).
// A ProjectFile is the portable .bloq shape written to / read from disk — no
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
