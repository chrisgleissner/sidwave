// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2025-2026 Christian Gleissner
// See LICENSE-EXCEPTION.md for the SIDWave Player Exception.
// The Ultimate target (Ultimate 64, C64 Ultimate, Ultimate-II family) through its REST API. Requests go to the host the
// caller names and nowhere else: there is no default host, and redirects are refused so that the password is never sent
// to another server.

import { SidwaveOperationError, UsageError } from "../cliCore.js";
import { deferred, type Playback } from "./types.js";

/** The environment variable that holds the network password of the device. */
export const ULTIMATE_PASSWORD_VARIABLE = "SIDWAVE_U64_PASSWORD";

export interface UltimateDevice {
  /** Host name or address, optionally with a port: "u64", "192.168.1.20", "u64.local:8080", "[fe80::1]". */
  host: string;
  password?: string;
  timeoutMs?: number;
}

export function ultimateBaseUrl(host: string): string {
  if (!/^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?\.?)(?::\d{1,5})?$/.test(host)) {
    throw new UsageError("--host needs a host name or address, optionally with :port (no scheme, path, user or password)");
  }
  return `http://${host}`;
}

async function request(device: UltimateDevice, method: "POST" | "PUT", path: string, body: FormData | Uint8Array<ArrayBuffer> | undefined, signal?: AbortSignal): Promise<void> {
  const base = ultimateBaseUrl(device.host);
  const hide = (text: string) => (device.password ? text.split(device.password).join("<password>") : text);
  const headers: Record<string, string> = {};
  if (device.password) headers["X-Password"] = device.password;
  if (body instanceof Uint8Array) headers["Content-Type"] = "application/octet-stream";
  const timeout = AbortSignal.timeout(device.timeoutMs ?? 10_000);
  const fail = (message: string) => new SidwaveOperationError("engine_unavailable", hide(`${device.host}: ${message}`), { host: device.host });
  let status: number;
  let text: string;
  try {
    const response = await fetch(`${base}${path}`, {
      method, headers, redirect: "manual", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      ...(body === undefined ? {} : { body }),
    });
    status = response.status;
    text = (await response.text()).slice(0, 2000);
  } catch (error) {
    if (signal?.aborted) throw new SidwaveOperationError("aborted", "The operation was aborted");
    const cause = (error as { cause?: { code?: string; message?: string }; code?: string }).cause;
    const reason = timeout.aborted ? `no answer within ${(device.timeoutMs ?? 10_000) / 1000} s`
      : cause?.code ?? cause?.message ?? (error as { code?: string }).code ?? (error as Error).message;
    throw fail(`${method} ${path} failed: ${reason}`);
  }
  if (status === 401 || status === 403) throw fail(`the device refused the request (HTTP ${status}); set ${ULTIMATE_PASSWORD_VARIABLE} to its network password`);
  let errors: string[] = [];
  try {
    const parsed = JSON.parse(text) as { errors?: unknown };
    if (Array.isArray(parsed?.errors)) errors = parsed.errors.map(String).filter((e) => e.trim() !== "");
  } catch {
    // Not JSON; the status decides.
  }
  if (status < 200 || status >= 300) throw fail(`${method} ${path} returned HTTP ${status}${errors.length ? `: ${errors.join("; ")}` : ""}`);
  if (errors.length) throw fail(`${method} ${path} failed: ${errors.join("; ")}`);
}

/** Uploads a SID file and starts its player, or uploads a PRG and runs it. */
export async function ultimatePlay(device: UltimateDevice, tune: { kind: "sid" | "prg"; bytes: Uint8Array; song?: number }, signal?: AbortSignal): Promise<void> {
  const bytes = Uint8Array.from(tune.bytes);
  if (tune.kind === "prg") return request(device, "POST", "/v1/runners:run_prg", bytes, signal);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/octet-stream" }), "upload.sid");
  const query = tune.song === undefined ? "" : `?songnr=${tune.song}`;
  return request(device, "POST", `/v1/runners:sidplay${query}`, form, signal);
}

/** Resets the C64, which ends the music. */
export async function ultimateReset(device: UltimateDevice, signal?: AbortSignal): Promise<void> {
  return request(device, "PUT", "/v1/machine:reset", undefined, signal);
}

export interface UltimatePlaybackOptions {
  device: UltimateDevice;
  tune: { kind: "sid" | "prg"; bytes: Uint8Array; song?: number };
  /** Seconds after which the machine is reset; without it the music runs until stop(). */
  seconds?: number;
  /** Leave the machine playing: playback is done once the upload was accepted, and stop() sends nothing. */
  detach?: boolean;
}

export function startUltimatePlayback(options: UltimatePlaybackOptions): Playback {
  const { device } = options;
  ultimateBaseUrl(device.host);
  const started = deferred();
  const done = deferred();
  const upload = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let ending: Promise<void> | undefined;
  const uploaded = ultimatePlay(device, options.tune, upload.signal).then(
    () => {
      started.resolve();
      if (options.detach) done.resolve();
      else if (options.seconds !== undefined) timer = setTimeout(() => { void end().catch(() => {}); }, Math.min(2_147_000_000, (options.seconds + 1) * 1000));
    },
    (error: unknown) => {
      if (upload.signal.aborted) { started.resolve(); return; }
      started.reject(error);
      done.reject(error);
    },
  );
  const end = (): Promise<void> => (ending ??= (async () => {
    clearTimeout(timer);
    try {
      await ultimateReset(device);
      done.resolve();
    } catch (error) {
      done.reject(error);
      throw error;
    }
  })());
  return {
    started: started.promise,
    done: done.promise,
    detail: `Ultimate at ${device.host}`,
    async stop(reason = "end") {
      clearTimeout(timer);
      upload.abort();
      await uploaded;
      // An upload that was cut off may still have started the tune, so the reset is sent in that case too.
      const failedBeforeStop = await started.promise.then(() => false, () => true);
      if (reason === "replace" || options.detach || failedBeforeStop) {
        done.resolve();
        return;
      }
      await end();
    },
  };
}
