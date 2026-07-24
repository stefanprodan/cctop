// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Session transcript parsing: the tail of ~/.claude/projects/<dir>/<id>.jsonl
// yields the newest model + context size, git branch, and last user prompt.
// Parsed details are cached by path+mtime so an idle session is not re-scanned
// every refresh. Read-only.

import { readdirSync, statSync } from "node:fs";
import { truncate } from "../format.ts";
import { contextTokens, describeAssistant } from "./entry.ts";

// The last prompt is a preview, not a faithful copy (the detail view shows the
// transcript path for the real thing). Cap it so a pasted blob can't bloat the
// row, the per-frame sanitize, or the detail wrap. ~25 lines at 80 cols.
const PROMPT_MAX = 2048;

// Without a registry entry, fall back to the project's most recently
// modified transcript that has been written since the process started.
//
// `claimed` holds the transcripts that registry-backed sessions already own, and
// they are skipped: a process with no entry of its own must never adopt a live
// session's transcript, or it renders as a perfect duplicate of that session —
// same branch, context, model and prompt. Guarding it here means an unrecognized
// claude-named process degrades into an empty row instead of a convincing clone.
// Takes the project directory rather than the cwd it is derived from, so it can
// be exercised against a temp dir like the other transcript readers.
export function latestTranscript(
  dir: string,
  startSec: number,
  claimed: ReadonlySet<string> = new Set(),
) {
  let best: { path: string; mtimeMs: number } | null = null;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const path = `${dir}/${f}`;
      if (claimed.has(path)) continue;
      const mtimeMs = statSync(path).mtimeMs;
      if (mtimeMs < startSec * 1000 - 60_000) continue;
      if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
    }
  } catch {} // no transcripts for this project
  return best?.path ?? null;
}

// The fallback pick together with the claim that has to follow it: a pick is
// added to `claimed` too, so a second registry-less process in the same project
// cannot adopt the same transcript and render as a duplicate of the first. The
// pair lives here rather than at the call site so the claim can't drift away
// from the pick — and so the invariant is testable on a temp dir.
export function claimLatestTranscript(
  dir: string,
  startSec: number,
  claimed: Set<string>,
) {
  const path = latestTranscript(dir, startSec, claimed);
  if (path) claimed.add(path);
  return path;
}

export interface Details {
  branch?: string;
  model?: string;
  ctx?: number;
  prompt?: string;
  promptAt?: number; // unix ms of the last user prompt (from its timestamp)
  lastTurn?: string;
}

// Note what a transcript entry contributes: the newest model + context
// size (last main-thread assistant turn), the action that turn took, git
// branch, and the last user prompt with its timestamp. Returns true once all
// details are known.
export function noteEntry(details: Details, e: any) {
  details.branch ??= e.gitBranch || undefined;
  // synthetic turns (interrupts, errors, injected notices) carry a
  // "<synthetic>" model and zeroed usage; skip them for the real last turn
  if (
    !details.model &&
    e.type === "assistant" &&
    !e.isSidechain &&
    e.message?.usage &&
    e.message.model &&
    e.message.model !== "<synthetic>"
  ) {
    details.model = e.message.model;
    details.ctx = contextTokens(e.message.usage);
    // the action that same (most recent real) turn took: its tool call or a
    // text snippet; may be null for an empty turn, which leaves it unset
    details.lastTurn = describeAssistant(e.message) ?? undefined;
  }
  if (!details.prompt && e.type === "user" && !e.isMeta && !e.isSidechain) {
    const c = e.message?.content;
    let text =
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.find((b: any) => b.type === "text")?.text
          : null;
    if (text) {
      // slash commands arrive wrapped in <command-name>/<command-args>
      const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
      if (cmd) {
        const cmdArgs = text.match(/<command-args>([^<]*)<\/command-args>/);
        text = `${cmd[1]} ${cmdArgs?.[1] ?? ""}`;
      }
      text = text.replace(/\s+/g, " ").trim();
      // skip other harness wrappers like <local-command-stdout>
      if (text && !text.startsWith("<")) {
        details.prompt = truncate(text, PROMPT_MAX);
        const t = Date.parse(e.timestamp); // ISO 8601; absent/invalid → NaN
        if (!Number.isNaN(t)) details.promptAt = t;
      }
    }
  }
  return Boolean(details.model && details.prompt && details.branch);
}

// Scan a transcript backwards in chunks from the end, stopping as soon
// as every detail is found. Long sessions grow to tens of MB, and big
// tool results can push the last user prompt far from the tail, so a
// fixed tail window is not enough; the scan is still bounded.
const TAIL_CHUNK = 256 * 1024;
export const MAX_TAIL_BYTES = 4 * 1024 * 1024;

// Reads the tail through Bun.file's async API, so collectRows can scan many
// sessions' transcripts concurrently. This used node:fs readSync until Bun
// fixed a bug where async file I/O stalled while the process held the TTY in
// raw mode on the alternate screen — which is exactly the live TUI's state.
export async function transcriptDetails(path: string): Promise<Details> {
  const details: Details = {};
  try {
    const file = Bun.file(path);
    const size = file.size;
    if (!size) return details; // gone, empty, or unreadable
    // bytes (not text: chunk cuts can split multibyte chars) of the line
    // straddling the current chunk boundary, completed by the next chunk
    let carry = Buffer.alloc(0);
    let end = size;
    while (end > 0 && size - end < MAX_TAIL_BYTES) {
      const start = Math.max(0, end - TAIL_CHUNK);
      const buf = Buffer.from(await file.slice(start, end).bytes());
      const block = Buffer.concat([buf, carry]);
      let parseFrom = 0;
      if (start > 0) {
        const nl = block.indexOf(10);
        if (nl < 0) {
          carry = block; // one line larger than the whole chunk
          end = start;
          continue;
        }
        carry = block.subarray(0, nl);
        parseFrom = nl + 1;
      }
      const lines = block.subarray(parseFrom).toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        let entry: any;
        try {
          entry = JSON.parse(lines[i]);
        } catch {
          continue; // line being appended right now
        }
        if (noteEntry(details, entry)) return details;
      }
      end = start;
    }
  } catch {
    // gone or unreadable (permissions)
  }
  return details;
}

// Parsed transcript details cached by path; reused while the file's mtime is
// unchanged so an idle session is not re-scanned (up to MAX_TAIL_BYTES) every
// refresh. Stale paths are pruned each cycle by the orchestrator.
const transcriptCache = new Map<
  string,
  { mtimeMs: number; details: Details }
>();

// transcriptDetails, but served from the cache while the file's mtime is
// unchanged. The orchestrator passes the mtime it already stat()ed.
export async function transcriptDetailsCached(
  path: string,
  mtimeMs: number,
): Promise<Details> {
  const cached = transcriptCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.details;
  const details = await transcriptDetails(path);
  transcriptCache.set(path, { mtimeMs, details });
  return details;
}

// Drop cached details for transcripts that are no longer live, so the map
// does not grow without bound. `keep` is the set of still-live paths.
export function pruneTranscriptCache(keep: Set<string>) {
  for (const path of transcriptCache.keys()) {
    if (!keep.has(path)) transcriptCache.delete(path);
  }
}
