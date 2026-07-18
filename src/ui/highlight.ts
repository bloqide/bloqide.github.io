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

// Minimal Python (MicroPython) syntax highlighter — regex-based, per line, no
// dependency. The generated code has no multi-line strings, so per-line is safe.
// Output is HTML-escaped and wraps tokens in <span class="tok-*">.

const KEYWORDS = new Set([
  "def", "class", "return", "if", "elif", "else", "for", "while", "in", "is",
  "not", "and", "or", "import", "from", "as", "pass", "break", "continue",
  "with", "yield", "lambda", "global", "nonlocal", "try", "except", "finally",
  "raise", "assert", "del", "await", "async",
]);
const CONSTS = new Set(["True", "False", "None"]);
const BUILTINS = new Set([
  "print", "range", "int", "str", "float", "bool", "len", "abs", "min", "max",
  "round", "bytes", "bytearray", "list", "dict", "tuple", "set", "enumerate",
  "map", "filter", "open", "hex", "ord", "chr", "super",
]);

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Order matters: comment, then string, then number, then identifier.
const TOKEN = /(#.*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d+\.?\d*\b)|([A-Za-z_]\w*)/g;

export function highlightPython(line: string): string {
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(line)) !== null) {
    out += esc(line.slice(last, m.index));
    const [full, comment, str, num, word] = m;
    let cls = "";
    if (comment) cls = "tok-comment";
    else if (str) cls = "tok-string";
    else if (num) cls = "tok-num";
    else if (word) {
      if (KEYWORDS.has(word)) cls = "tok-kw";
      else if (CONSTS.has(word)) cls = "tok-const";
      else if (BUILTINS.has(word)) cls = "tok-builtin";
    }
    out += cls ? `<span class="${cls}">${esc(full)}</span>` : esc(full);
    last = m.index + full.length;
    if (full.length === 0) TOKEN.lastIndex++; // guard against zero-width loops
  }
  out += esc(line.slice(last));
  return out;
}

export function highlightCode(code: string): string {
  return code.split("\n").map(highlightPython).join("\n");
}
