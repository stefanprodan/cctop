// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Live sub-agents (Task / Workflow). They run in-process, so they never appear
// in the process table; each writes its own transcript under the session's
// subagents/ directory and liveness is inferred from that transcript. The
// second, sequential pass of collectRows attaches these to their rows so two
// sessions falling back to the same transcript can't both claim the agents.

import { type Dirent, readdirSync, statSync } from "node:fs";
import { contextTokens, describeAssistant } from "./entry.ts";
import { MAX_TAIL_BYTES } from "./transcript.ts";
import type { Instance, InstanceBase, SubAgent } from "./types.ts";

const hasBlock = (msg: any, type: string) =>
  Array.isArray(msg?.content) && msg.content.some((b: any) => b?.type === type);

// An agent transcript's turns are all marked isSidechain, so the main scanner
// skips them; read the tail for the latest model, context size, activity, and
// whether the agent is mid-flight. Async like transcriptDetails.
export async function agentContext(path: string) {
  const out: {
    model?: string;
    ctx?: number;
    activity?: string | null;
    running: boolean;
  } = { running: false };
  try {
    const file = Bun.file(path);
    const size = file.size;
    if (!size) return out;
    const start = size > MAX_TAIL_BYTES ? size - MAX_TAIL_BYTES : 0;
    const buf = Buffer.from(await file.slice(start, size).bytes());
    const tail = buf.toString("utf8");
    const entries: any[] = [];
    for (const line of tail.split("\n")) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {} // partial line at the slice boundary or being appended
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "assistant" && e.message?.usage) {
        out.model = e.message.model;
        out.ctx = contextTokens(e.message.usage);
        out.activity = describeAssistant(e.message);
        break;
      }
    }
    // mid-flight: a tool call was issued (awaiting its result) or a result
    // just arrived (awaiting the next turn). A final text-only assistant turn
    // means the agent finished, so the mtime window alone governs it.
    const last = entries.at(-1);
    out.running =
      !!last &&
      ((last.type === "assistant" && hasBlock(last.message, "tool_use")) ||
        (last.type === "user" && hasBlock(last.message, "tool_result")));
  } catch {
    // unreadable
  }
  return out;
}

// Sub-agent names as the parent transcript records them: a toolUseResult
// pairs agentId with agentType (present at launch for background agents, at
// completion for synchronous ones). The pairing is exact, so it can name an
// agent but never mis-name one. One tail slice, like agentContext, is
// enough — no need for the chunked backward scan.
async function parentAgentNames(path: string) {
  const byId = new Map<string, string>();
  try {
    const file = Bun.file(path);
    const size = file.size;
    if (!size) return { byId };
    const start = size > MAX_TAIL_BYTES ? size - MAX_TAIL_BYTES : 0;
    const buf = Buffer.from(await file.slice(start, size).bytes());
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue; // partial line at the slice boundary or being appended
      }
      if (e.type === "user") {
        const r = e.toolUseResult;
        if (
          typeof r?.agentId === "string" &&
          typeof r?.agentType === "string" &&
          r.agentType
        )
          byId.set(r.agentId, r.agentType);
      }
    }
  } catch {
    // unreadable
  }
  return { byId };
}

// Cached per parent transcript path, keyed by mtime + size so an unresolved
// agent (no toolUseResult yet) doesn't force a re-scan (and re-parse of every
// tail line) on every refresh. An
// active session's transcript changes on nearly every refresh, which would
// defeat that key while an unresolvable agent stays live, so re-scans are
// also throttled: a stale result only delays a late-arriving name, never
// shows a wrong one.
const PARENT_RESCAN_MS = 10_000;
const parentNamesCache = new Map<
  string,
  {
    mtimeMs: number;
    size: number;
    scannedAtMs: number;
    names: Awaited<ReturnType<typeof parentAgentNames>>;
  }
>();

async function cachedParentAgentNames(path: string, nowMs: number) {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return { byId: new Map<string, string>() }; // gone or unreadable; nothing to scan
  }
  const cached = parentNamesCache.get(path);
  if (
    cached &&
    ((cached.mtimeMs === st.mtimeMs && cached.size === st.size) ||
      nowMs - cached.scannedAtMs < PARENT_RESCAN_MS)
  )
    return cached.names;
  const names = await parentAgentNames(path);
  parentNamesCache.set(path, {
    mtimeMs: st.mtimeMs,
    size: st.size,
    scannedAtMs: nowMs,
    names,
  });
  return names;
}

// Drop cached parent-transcript name lookups for transcripts that are no
// longer live. `keep` is the set of still-live transcript paths.
export function pruneParentNamesCache(keep: Set<string>) {
  for (const path of parentNamesCache.keys()) {
    if (!keep.has(path)) parentNamesCache.delete(path);
  }
}

// Pulls the agentId out of an agent transcript's filename (agent-<id>.jsonl);
// the filename shape is the only contract, so this accepts whatever the id is
// — but never a path separator, since the match runs against the full path
// and an ancestor directory could itself start with "agent-".
const AGENT_ID_RE = /agent-([^/]+)\.jsonl$/;

const SUBAGENT_LIVE_MS = 20_000; // wrote a turn this recently
const SUBAGENT_BUSY_MS = 180_000; // quiet but mid tool-call
const agentCache = new Map<string, any>(); // agent path -> { mtimeMs, model, ctx, ... }

// Drop cached agent context for sub-agents that are no longer live. `keep` is
// the set of agent paths seen this cycle.
export function pruneAgentCache(keep: Set<string>) {
  for (const path of agentCache.keys()) {
    if (!keep.has(path)) agentCache.delete(path);
  }
}

function listAgentFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // no subagents directory for this session
  }
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...listAgentFiles(p));
    else if (e.name.startsWith("agent-") && e.name.endsWith(".jsonl"))
      out.push(p);
  }
  return out;
}

// The session's currently-running sub-agents: agent transcripts touched within
// the live window, each with its own context size (cached by mtime). The
// subagents directory sits next to the transcript: <...>/<id>.jsonl ->
// <...>/<id>/subagents (works whether or not the session has a registry entry).
export async function liveSubagents(
  transcript: string | null,
  nowMs: number,
  seen: Set<string>,
  seenDirs: Set<string>,
): Promise<SubAgent[]> {
  if (!transcript) return [];
  const dir = `${transcript.replace(/\.jsonl$/, "")}/subagents`;
  // two sessions in one project can fall back to the same transcript; only
  // the first to claim a subagents dir lists its agents, so they show once
  if (seenDirs.has(dir)) return [];
  seenDirs.add(dir);
  const out: SubAgent[] = [];
  const live: { path: string; info: any; birthMs: number }[] = [];
  for (const path of listAgentFiles(dir)) {
    let mtimeMs: number;
    let birthMs: number;
    try {
      const st = statSync(path);
      mtimeMs = st.mtimeMs;
      // the transcript is created when the agent starts and only appended to,
      // so its birthtime is the agent's start; fall back to mtime where the
      // filesystem has no birthtime (uptime then reads ~0 rather than bogus)
      birthMs = st.birthtimeMs || st.mtimeMs;
    } catch {
      continue;
    }
    const age = nowMs - mtimeMs;
    if (age > SUBAGENT_BUSY_MS) continue; // long gone
    seen.add(path);
    let info = agentCache.get(path);
    if (!info || info.mtimeMs !== mtimeMs) {
      // a resolved name never changes, so carry it forward across mtime-driven
      // rebuilds rather than losing it (and re-scanning the parent transcript)
      const prev = info;
      info = {
        mtimeMs,
        name: prev?.name ?? null,
        ...(await agentContext(path)),
      };
      agentCache.set(path, info);
    }
    // live if it wrote a turn recently, or it is quietly running a tool call
    if (age > SUBAGENT_LIVE_MS && !info.running) continue;
    live.push({ path, info, birthMs });
  }
  // resolve names for whichever live agents still lack one, from the parent
  // transcript, at most once per call. A name can arrive late — a synchronous
  // agent's toolUseResult lands only at completion — so this retries on later
  // refreshes for as long as it stays unresolved.
  if (live.some(({ info }) => info.name == null)) {
    const parent = await cachedParentAgentNames(transcript, nowMs);
    for (const { path, info } of live) {
      if (info.name != null) continue;
      const agentId = path.match(AGENT_ID_RE)?.[1];
      info.name = (agentId && parent.byId.get(agentId)) || null;
    }
  }
  for (const { info, birthMs } of live) {
    out.push({
      name: info.name ?? null,
      model: info.model ?? null,
      ctx: info.ctx ?? null,
      activity: info.activity ?? null,
      uptimeSec: Math.max(0, (nowMs - birthMs) / 1000),
    });
  }
  return out.sort((a, b) => (b.ctx ?? 0) - (a.ctx ?? 0));
}

// Attach live sub-agents to each row sequentially (not via Promise.all): the
// subagents directory claims in liveSubagents() depend on candidate order, so
// running them in order keeps two sessions sharing a transcript from racing
// over which row owns the agents.
export async function attachSubagentsInOrder(
  rowBases: (InstanceBase | null)[],
  nowMs: number,
  seenAgents: Set<string>,
): Promise<Instance[]> {
  const seenAgentDirs = new Set<string>();
  const rows: Instance[] = [];
  for (const row of rowBases) {
    if (!row) continue;
    rows.push({
      ...row,
      subagents: await liveSubagents(
        row.transcript,
        nowMs,
        seenAgents,
        seenAgentDirs,
      ),
    });
  }
  return rows;
}
