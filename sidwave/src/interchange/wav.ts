// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// Minimal RIFF/WAVE writer for 16-bit PCM.

/** Writes interleaved 16-bit PCM as a canonical 44-byte-header WAV file. */
export function writeWav(samples: Int16Array, sampleRate: number, channels: 1 | 2 = 1): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 0x7fffffff) throw new RangeError("invalid sample rate");
  const dataBytes = samples.length * 2;
  if (dataBytes > 0xffffffff - 36) throw new RangeError("the audio is too long for a WAV file");
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const tag = (at: number, text: string) => { for (let i = 0; i < 4; i++) out[at + i] = text.charCodeAt(i); };
  tag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + 2 * i, samples[i]!, true);
  return out;
}
