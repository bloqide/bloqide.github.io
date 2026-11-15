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

import type { BloqPlugin, GenContext } from "../../../../src/core/types";
import type * as Blockly from "blockly";
import { type Activity, callAndWait, driver, waitField, waitIdle } from "../motors/index";

// Sound blocks for the StepBot: the co-processor plays notes by vibrating the
// motors in place, also while they drive (a note never changes a distance).
// Same driver and the same "and wait" / "in background" handling as the motor
// blocks, polling playing() instead of busy().

const COLOUR = 230; // blue, to tell the sound blocks from the motion ones they sit with

const NUM = (n: number) => ({ shadow: { type: "math_number", fields: { NUM: n } } });
const TEXT = (t: string) => ({ shadow: { type: "text_literal", fields: { TEXT: t } } });

const MUSIC: Activity = { busy: "playing", wait: "wait_sound" };

// RTTTL ringtone text: name:defaults:notes (d = note length, o = octave, b = tempo).
const FANFARE = "tune:d=8,o=6,b=160:g5,c,e,4.g,p,2c7";

export const plugin: BloqPlugin = {
  id: "stepbot-sound",
  name: "Sound",
  version: "1.0.0",
  // Shares the Motors category, between the StepBot motor blocks (order 70)
  // and the Servo blocks (75).
  toolbox: { category: "Motors", colour: COLOUR, order: 71, faIcon: "fa-music", section: "StepBot Motor Sound" },

  // Snippet: music while driving.
  presets: [
    {
      kind: "block",
      type: "stepbot_play_tune",
      fields: { WAIT: "0" },
      inputs: { TUNE: TEXT(FANFARE) },
      next: {
        block: {
          type: "stepbot_move",
          fields: { DIR: "1", WAIT: "1" },
          inputs: { DIST: NUM(300) },
        },
      },
    },
  ],

  blocks: {
    stepbot_play_note: {
      kind: "statement",
      json: {
        type: "stepbot_play_note",
        message0: "play note %1 for %2 ms %3",
        args0: [{ type: "input_value", name: "NOTE" }, { type: "input_value", name: "MS" }, waitField],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip:
          "A note name like C4, F#5 or Bb3 (A4 is the 440 Hz A), or a MIDI number (60 = C4). " +
          "'in background' lets the next blocks run during the note.",
      },
      toolbox: { inputs: { NOTE: TEXT("C5"), MS: NUM(250) } },
    },

    stepbot_play_tone: {
      kind: "statement",
      json: {
        type: "stepbot_play_tone",
        message0: "play tone %1 Hz for %2 ms %3",
        args0: [{ type: "input_value", name: "HZ" }, { type: "input_value", name: "MS" }, waitField],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip: "A frequency in Hz (0 is a silence).",
      },
      toolbox: { inputs: { HZ: NUM(440), MS: NUM(500) } },
    },

    stepbot_play_tune: {
      advanced: true,
      kind: "statement",
      json: {
        type: "stepbot_play_tune",
        message0: "play tune %1 %2",
        args0: [{ type: "input_value", name: "TUNE" }, waitField],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip:
          "A ringtone in RTTTL text: name:d=4,o=5,b=120:notes, where d is the default note " +
          "length, o the octave and b the tempo; 'p' is a rest. The board holds 63 notes: " +
          "a longer tune keeps this block busy until the rest fits, even in background.",
      },
      toolbox: { inputs: { TUNE: TEXT(FANFARE) } },
    },

    stepbot_wait_sound: {
      kind: "statement",
      json: {
        type: "stepbot_wait_sound",
        message0: "wait until the music ends",
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip: "Pause here until a background note or tune finishes.",
      },
    },

    stepbot_stop_sound: {
      kind: "statement",
      json: {
        type: "stepbot_stop_sound",
        message0: "stop the music",
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip: "Stop now, and drop the notes not played yet.",
      },
    },

    stepbot_is_playing: {
      kind: "value",
      json: {
        type: "stepbot_is_playing",
        message0: "music is playing?",
        output: "Boolean",
        colour: COLOUR,
        tooltip: "True while notes are playing or waiting to play.",
      },
    },

    stepbot_set_volume: {
      advanced: true,
      kind: "statement",
      json: {
        type: "stepbot_set_volume",
        message0: "set volume %1 %% gap between notes %2 ms",
        args0: [
          { type: "input_value", name: "VOLUME" },
          { type: "input_value", name: "GAP" },
        ],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip:
          "Volume 0 (mute) to 100; 50 sounds best, more is not much louder. The gap is a short " +
          "silence at the end of each note (0 ties the notes together).",
      },
      toolbox: { inputs: { VOLUME: NUM(50), GAP: NUM(20) } },
    },

    stepbot_set_tempo: {
      advanced: true,
      kind: "statement",
      json: {
        type: "stepbot_set_tempo",
        message0: "set tempo %1 beats per minute",
        args0: [{ type: "input_value", name: "BPM" }],
        inputsInline: true,
        previousStatement: null,
        nextStatement: null,
        colour: COLOUR,
        tooltip: "Speed of the tunes that don't set their own (no b= in the text).",
      },
      toolbox: { inputs: { BPM: NUM(120) } },
    },
  },

  generators: {
    stepbot_play_note: (block: Blockly.Block, ctx: GenContext) => {
      // A MIDI number typed into the text slot ("60") goes out as a number:
      // the driver reads a string as a note name.
      const note = ctx.value(block, "NOTE", '"C5"').replace(/^"(\d+)"$/, "$1");
      const args = [note, ctx.value(block, "MS", "250")];
      callAndWait(ctx, block, "note", args, MUSIC);
    },
    stepbot_play_tone: (block: Blockly.Block, ctx: GenContext) => {
      const args = [ctx.value(block, "HZ", "440"), ctx.value(block, "MS", "500")];
      callAndWait(ctx, block, "tone", args, MUSIC);
    },
    stepbot_play_tune: (block: Blockly.Block, ctx: GenContext) => {
      callAndWait(ctx, block, "play", [ctx.value(block, "TUNE", '""')], MUSIC);
    },
    stepbot_wait_sound: (block: Blockly.Block, ctx: GenContext) => {
      waitIdle(ctx, block, MUSIC);
    },
    stepbot_stop_sound: (block: Blockly.Block, ctx: GenContext) => {
      ctx.line(`${driver(ctx)}.stop_sound()`, block.id);
    },
    stepbot_is_playing: (_block: Blockly.Block, ctx: GenContext) => `${driver(ctx)}.playing()`,
    stepbot_set_volume: (block: Blockly.Block, ctx: GenContext) => {
      const volume = ctx.value(block, "VOLUME", "50");
      ctx.line(`${driver(ctx)}.set_volume(${volume}, gap=${ctx.value(block, "GAP", "20")})`, block.id);
    },
    stepbot_set_tempo: (block: Blockly.Block, ctx: GenContext) => {
      ctx.line(`${driver(ctx)}.set_tempo(${ctx.value(block, "BPM", "120")})`, block.id);
    },
  },
};
