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

// One tail slice of a JSONL transcript, handed entry-by-entry to `onEntry` —
// the read both scanners here share, a callback rather than an array so no
// caller holds every parsed entry alive at once. `ok`: false on a read
// failure, so a caching caller can skip it.
async function readTailEntries(path: string, onEntry: (e: any) => void) {
  try {
    const file = Bun.file(path);
    const size = file.size;
    // Bun.file reports size 0 for a missing file instead of throwing, so an
    // empty read only counts as ok when the file actually exists
    if (!size) return { ok: await file.exists() };
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
      onEntry(e);
    }
  } catch {
    return { ok: false }; // unreadable, possibly transiently
  }
  return { ok: true };
}

// An agent transcript's turns are all marked isSidechain, so the main scanner
// skips them; read the tail for the latest model, context size, activity, and
// whether the agent is mid-flight. Async like transcriptDetails. `ok` false
// means an empty result is a failed read, not a finished agent — don't cache.
export async function agentContext(path: string) {
  const out: {
    model?: string;
    ctx?: number;
    activity?: string | null;
    running: boolean;
    ok: boolean;
  } = { running: false, ok: true };
  // the two entries the fields below are derived from, picked as the tail
  // streams past so no pass holds every parsed entry alive at once
  let lastUsage: any; // newest assistant message carrying usage
  let last: any; // newest entry of any kind
  const { ok } = await readTailEntries(path, (e) => {
    if (e?.type === "assistant" && e.message?.usage) lastUsage = e.message;
    last = e;
  });
  out.ok = ok;
  // a malformed entry must not escape: this runs inside collectRows, whose
  // caller drives it as a floating promise, so a throw here would take the
  // whole TUI down over one bad line. Whatever was read stays usable.
  try {
    // mid-flight: a tool call was issued (awaiting its result) or a result
    // just arrived (awaiting the next turn). A final text-only assistant turn
    // means the agent finished, so the mtime window alone governs it. Derived
    // before the message contents below, which walk arbitrary blocks: a
    // malformed one there must not cost a live agent its row.
    out.running =
      !!last &&
      ((last.type === "assistant" && hasBlock(last.message, "tool_use")) ||
        (last.type === "user" && hasBlock(last.message, "tool_result")));
    if (lastUsage) {
      out.model = lastUsage.model;
      out.ctx = contextTokens(lastUsage.usage);
      out.activity = describeAssistant(lastUsage);
    }
  } catch {
    // malformed entry, like a partial tail: keep what was derived so far
  }
  return out;
}

// Sub-agent names as the parent transcript records them: a toolUseResult
// pairs agentId directly with agentType (present at launch for background
// agents, at completion for synchronous ones). The pairing is exact, so it
// can name an agent but never mis-name one. One tail slice, like
// agentContext, is enough — no need for the chunked backward scan.
async function parentAgentNames(path: string) {
  const byId = new Map<string, string>();
  const { ok } = await readTailEntries(path, (e) => {
    if (e?.type === "user") {
      const r = e.toolUseResult;
      if (
        typeof r?.agentId === "string" &&
        typeof r?.agentType === "string" &&
        r.agentType
      )
        byId.set(r.agentId, r.agentType);
    }
  });
  return { byId, ok };
}

// The agent's own type, from the metadata sidecar Claude Code writes next to
// the transcript (<agent>.meta.json, at launch). The only name source for a
// workflow-launched agent, whose parent transcript records the Workflow call
// rather than the agent, and the more direct one for the rest: it names the
// agent itself instead of a launch that has to be matched back to it.
async function agentMetaName(path: string) {
  try {
    const meta = await Bun.file(path.replace(/\.jsonl$/, ".meta.json")).json();
    const type = meta?.agentType;
    return typeof type === "string" && type ? type : null;
  } catch {
    return null; // absent, unreadable, or not JSON — the parent still answers
  }
}

// Cached per parent transcript path, keyed by mtime + size so an unresolved
// agent (no toolUseResult yet) doesn't force a re-scan (and re-parse of every
// tail line) on every refresh. An active session's transcript changes on
// nearly every refresh, which would defeat that key while an unresolvable
// agent stays live, so re-scans are also throttled. Serving a stale map only
// ever delays a name: an agentId -> agentType pairing never changes once
// written, so it can't turn into a wrong one.
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

// The result of a scan that never happened — the shape parentAgentNames
// produces for an unreadable file, shared with the stat-failure path below so
// the two can't drift. Only ever read, never mutated.
const NO_NAMES: Awaited<ReturnType<typeof parentAgentNames>> = {
  byId: new Map(),
  ok: false,
};

async function cachedParentAgentNames(path: string, nowMs: number) {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return NO_NAMES; // gone or unreadable; nothing to scan
  }
  const cached = parentNamesCache.get(path);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size)
    return cached.names; // file unchanged since scan
  if (cached && nowMs - cached.scannedAtMs < PARENT_RESCAN_MS)
    return cached.names;
  const names = await parentAgentNames(path);
  // a failed read is never keyed by the current mtime+size — that would serve
  // it forever with no retry. Throttle-stamping it instead retries once per
  // PARENT_RESCAN_MS. An older successful scan keeps its own key and is served
  // meanwhile: strictly more information, same staleness.
  if (!names.ok) {
    const served = cached ?? {
      mtimeMs: -1, // matches no stat, so only the throttle serves this entry
      size: -1,
      names,
    };
    parentNamesCache.set(path, {
      mtimeMs: served.mtimeMs,
      size: served.size,
      scannedAtMs: nowMs,
      names: served.names,
    });
    return served.names;
  }
  parentNamesCache.set(path, {
    mtimeMs: st.mtimeMs,
    size: st.size,
    scannedAtMs: nowMs,
    names,
  });
  return names;
}

// Drop cached parent-transcript name lookups for transcripts that are no
// longer live. `transcripts` is the set of still-live session transcript
// paths; `agents` the agent paths seen this cycle, whose derived parents
// (nested agents' launching transcripts among them) are also cache keys.
export function pruneParentNamesCache(
  transcripts: Set<string>,
  agents: Set<string>,
) {
  const keep = new Set(transcripts);
  for (const a of agents) {
    const p = parentTranscript(a);
    if (p) keep.add(p);
  }
  for (const path of parentNamesCache.keys()) {
    if (!keep.has(path)) parentNamesCache.delete(path);
  }
}

// Pulls the agentId out of an agent transcript's filename (agent-<id>.jsonl);
// the filename shape is the only contract, so this accepts whatever the id is
// — but never a path separator, since the match runs against the full path
// and an ancestor directory could itself start with "agent-".
const AGENT_ID_RE = /agent-([^/]+)\.jsonl$/;

// The transcript that launched an agent, from the agent's own path:
// <parent>/subagents/agent-<id>.jsonl was launched by <parent>.jsonl — the
// session transcript for a top-level agent, the launching agent's for a
// nested one, which is the only place a nested agent's name lives.
const AGENT_FILE_RE = /\/subagents\/agent-[^/]+\.jsonl$/;
function parentTranscript(agentPath: string): string | null {
  return AGENT_FILE_RE.test(agentPath)
    ? agentPath.replace(AGENT_FILE_RE, ".jsonl")
    : null;
}

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
      // rebuilds rather than losing it (and re-scanning the parent transcript);
      // same for the sidecar verdict
      const prev = info;
      const { ok, ...ctx } = await agentContext(path);
      if (!ok) {
        // a failed read must not be cached under this mtime: the empty info
        // (running:false) would be served until the next append and drop a
        // quiet mid-tool-call agent. Keep the previous snapshot (its stale
        // mtime retries next refresh); with none, serve an uncached empty
        // context presumed running, so a transient failure can't drop the row.
        info = prev ?? { mtimeMs, name: null, ...ctx, running: true };
      } else {
        info = { mtimeMs, name: prev?.name ?? null, ...ctx };
        info.metaChecked = prev?.metaChecked ?? false;
        agentCache.set(path, info);
      }
    }
    // live if it wrote a turn recently, or it is quietly running a tool call
    if (age > SUBAGENT_LIVE_MS && !info.running) continue;
    live.push({ path, info, birthMs });
  }
  // resolve names for whichever live agents still lack one: the agent's own
  // metadata sidecar first, then its parent transcript (the session's for
  // top-level agents, the launching agent's for nested ones) — scanned at
  // most once per call — for agents launched without one. A name can
  // arrive late — a synchronous agent's toolUseResult lands only at
  // completion — so this retries on later refreshes for as long as it stays
  // unresolved.
  const parents = new Map<
    string,
    Awaited<ReturnType<typeof cachedParentAgentNames>>
  >();
  for (const { path, info } of live) {
    if (info.name != null) continue;
    // the sidecar is written at launch and never appears later, so one miss
    // is final: remember it rather than paying a failed file open here on
    // every refresh for as long as the agent stays nameless
    if (!info.metaChecked) {
      info.metaChecked = true;
      info.name = await agentMetaName(path);
      if (info.name) continue;
    }
    // the launching transcript: the agent's own parent where the path gives
    // one (a nested agent's launcher, whose transcript is the only place its
    // name lives), the session's otherwise
    const lookupPath = parentTranscript(path) ?? transcript;
    let parent = parents.get(lookupPath);
    if (!parent) {
      parent = await cachedParentAgentNames(lookupPath, nowMs);
      parents.set(lookupPath, parent);
    }
    const agentId = path.match(AGENT_ID_RE)?.[1];
    info.name = (agentId && parent.byId.get(agentId)) || null;
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
