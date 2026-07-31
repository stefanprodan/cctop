// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Persisted TUI preferences — the refresh interval, sort mode, and the
// notifications toggle — in ~/.claude/cctop/settings.json, next to the usage
// cache. Alongside that cache this is cctop's only other write, and it is
// best-effort on both sides: a missing or invalid file simply means defaults,
// and a failed write is silently dropped (a preference is never worth
// disrupting the TUI).

import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { CLAUDE_DIR } from "./paths.ts";

export interface Settings {
  watchSecs: number | null; // refresh interval in seconds
  sort: string | null; // sort-mode name (matches SORTS in app.ts)
  notify: boolean | null; // ring when a busy session needs input (null = off)
  // Visible optional columns, in display order (null = default set). Hand-edited
  // — no TUI action writes it, but the save merge preserves it. Only checked to
  // be strings here: the known column names live in render.ts (importing them
  // would cycle render → collect → settings), and buildFrame dropping unknown
  // names keeps a file written for a newer cctop working on an older one.
  columns: string[] | null;
}

const SETTINGS_FILE = `${CLAUDE_DIR}/cctop/settings.json`;

// Defensive parse: the file is ours, but it may be from a newer/older version
// or hand-edited, so any missing or ill-typed field becomes null (= default).
export function parseSettings(raw: any): Settings {
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
  // an explicit [] is kept (= hide every optional column), unlike a missing or
  // ill-typed value which means "default set"
  const strArr = (v: unknown) =>
    Array.isArray(v)
      ? v.filter((s): s is string => typeof s === "string" && s !== "")
      : null;
  return {
    watchSecs: num(raw?.watchSecs),
    sort: str(raw?.sort),
    notify: bool(raw?.notify),
    columns: strArr(raw?.columns),
  };
}

export async function readSettings(
  file: string = SETTINGS_FILE,
): Promise<Settings> {
  try {
    return parseSettings(await Bun.file(file).json());
  } catch {
    // absent, unreadable, or corrupt
    return { watchSecs: null, sort: null, notify: null, columns: null };
  }
}

// Merge the patch over what's on disk (so saving the sort never clobbers a
// persisted interval, and vice versa) and swap the file in atomically — the
// same temp-sibling + rename dance as captureUsage, for the same reason:
// concurrent cctop instances must not corrupt it (last writer wins). Fields
// left at null are omitted from the file. `file` is overridable for tests.
export async function saveSettings(
  patch: Partial<Settings>,
  file: string = SETTINGS_FILE,
): Promise<void> {
  try {
    const merged = { ...(await readSettings(file)), ...patch };
    const out: Record<string, number | string | boolean | string[]> = {};
    if (merged.watchSecs != null) out.watchSecs = merged.watchSecs;
    if (merged.sort != null) out.sort = merged.sort;
    if (merged.notify != null) out.notify = merged.notify;
    if (merged.columns != null) out.columns = merged.columns;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await Bun.write(tmp, JSON.stringify(out));
    renameSync(tmp, file);
  } catch {
    // best-effort: a read-only home or full disk must not break the TUI
  }
}
