// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Historical aggregation across every session transcript under
// ~/.claude/projects. Unlike the live collector, which reads only each running
// session's transcript tail, this full-scans all *.jsonl files and rolls every
// assistant turn up into per-day token buckets plus model/tool/project/activity
// tallies for the history dashboard.
//
// Read-only, like everything under collect/: directory listing and stat use sync
// node:fs (metadata only); file *contents* go through Bun.file's async stream so
// the scan overlaps reads without holding many large files in memory at once.
// Nothing here writes to disk — the in-memory per-file cache below lives only for
// the process lifetime, so the read-only contract (one write, usage.json) holds.
//
// Both session transcripts and the sub-agent transcripts under <id>/subagents/
// are scanned, so tokens/turns/model-mix/tool-use reflect total usage. Only
// top-level files count as "sessions"; sub-agent files contribute their turns
// (which are isSidechain) but never bump the session tally.

import { type Dirent, readdirSync, statSync } from "node:fs";
import { CLAUDE_DIR } from "./paths.ts";

// One calendar day (local time) of aggregated usage. Token classes are kept
// separate (fresh vs cache-read vs cache-create vs output) for the Tokens row;
// turns drives the per-day activity bar chart; sessionsStarted counts
// transcripts whose first turn falls on this day.
export interface DayBucket {
  date: string; // YYYY-MM-DD (local)
  inputFresh: number;
  cacheRead: number;
  cacheCreate: number;
  output: number;
  turns: number;
  sessionsStarted: number;
}

export interface Tally {
  tokens: number;
  turns: number;
}

// Per-project rollup for the Projects table: like a Tally, plus how many session
// transcripts started in that project (sub-agent files add tokens/turns but no
// session).
export interface ProjectStat extends Tally {
  sessions: number;
}

// One top-level session for the Sessions list, with tokens/turns folded in from
// its sub-agent transcripts (matched by the shared <id>).
export interface SessionRow {
  id: string;
  project: string; // full cwd (renderer shortens it)
  model: string; // dominant model of the main session
  startTs: number; // first turn timestamp (ms)
  endTs: number; // last turn timestamp (ms), for duration
  tokens: number;
  turns: number;
  tools: number; // total tool calls (built-in + MCP + web)
}

export interface History {
  days: DayBucket[]; // ascending, contiguous (gaps zero-filled)
  byModel: Map<string, Tally>;
  byTool: Map<string, number>; // tool_use name -> count; + web_search/web_fetch
  byProject: Map<string, ProjectStat>; // key = full cwd (renderer shortens it)
  sessions: SessionRow[]; // top-level sessions, newest first
  totals: {
    tokens: number;
    turns: number;
    sessions: number; // top-level session transcripts
    subAgents: number; // sub-agent transcripts folded into the totals
    firstDay: string | null;
    lastDay: string | null;
  };
}

// A single transcript's contribution, before contiguous-day gap filling and the
// sessionsStarted fold-in. Cached per file so an unchanged transcript is never
// re-parsed.
interface Contrib {
  days: Map<string, Omit<DayBucket, "date" | "sessionsStarted">>;
  byModel: Map<string, Tally>;
  byTool: Map<string, number>;
  byProject: Map<string, Tally>;
  firstTs: number | null; // earliest entry timestamp (ms), for sessionsStarted
  lastTs: number | null; // latest entry timestamp (ms), for session duration
  project: string | null; // this session's project (cwd); null for sub-agent files
}

// Local-time YYYY-MM-DD. Local (not UTC) so the day/heatmap buckets line up with
// the user's own clock — "yesterday" means their yesterday.
const dateKey = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const addTally = (
  m: Map<string, Tally>,
  key: string,
  tokens: number,
  turns = 1,
) => {
  const t = m.get(key);
  if (t) {
    t.tokens += tokens;
    t.turns += turns;
  } else {
    m.set(key, { tokens, turns });
  }
};

// Roll one transcript's lines into a Contrib. Every assistant turn with a usage
// block contributes tokens. For a session file we skip isSidechain turns (those
// are counted from the sub-agent files instead, avoiding double counting) and
// record the first-seen day for the session tally; a sub-agent file (session
// false) counts its sidechain turns and starts no session.
function aggregateLines(lines: Iterable<string>, session = true): Contrib {
  const c: Contrib = {
    days: new Map(),
    byModel: new Map(),
    byTool: new Map(),
    byProject: new Map(),
    firstTs: null,
    lastTs: null,
    project: null,
  };
  // Claude Code writes each content block of a message (thinking, text,
  // tool_use) as its own entry, and every one repeats the message's usage:
  // the input side verbatim, output_tokens growing to its final count. Keyed
  // by message id, this holds the output already counted, so a message is one
  // turn whose input counts once and whose output counts to its largest value.
  const outputSeen = new Map<string, number>();
  for (const line of lines) {
    if (!line) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // half-written or malformed line
    }
    const ts = e.timestamp ? Date.parse(e.timestamp) : Number.NaN;
    if (session && !Number.isNaN(ts)) {
      if (c.firstTs === null || ts < c.firstTs) c.firstTs = ts;
      if (c.lastTs === null || ts > c.lastTs) c.lastTs = ts;
    }

    if (e.type !== "assistant") continue;
    if (session && e.isSidechain) continue; // counted from the sub-agent file
    const msg = e.message;
    const u = msg?.usage;
    if (!u || !msg.model || msg.model === "<synthetic>") continue;
    if (Number.isNaN(ts)) continue; // can't bucket a turn with no timestamp

    const id = typeof msg.id === "string" ? msg.id : null;
    const prevOutput = id === null ? undefined : outputSeen.get(id);
    const repeat = prevOutput !== undefined;
    const turn = repeat ? 0 : 1;
    const inputFresh = repeat ? 0 : (u.input_tokens ?? 0);
    const cacheRead = repeat ? 0 : (u.cache_read_input_tokens ?? 0);
    const cacheCreate = repeat ? 0 : (u.cache_creation_input_tokens ?? 0);
    const output = Math.max(0, (u.output_tokens ?? 0) - (prevOutput ?? 0));
    if (id !== null) outputSeen.set(id, (prevOutput ?? 0) + output);
    const total = inputFresh + cacheRead + cacheCreate + output;

    const d = new Date(ts);
    const key = dateKey(d);
    const day = c.days.get(key);
    if (day) {
      day.inputFresh += inputFresh;
      day.cacheRead += cacheRead;
      day.cacheCreate += cacheCreate;
      day.output += output;
      day.turns += turn;
    } else {
      c.days.set(key, {
        inputFresh,
        cacheRead,
        cacheCreate,
        output,
        turns: turn,
      });
    }

    addTally(c.byModel, msg.model, total, turn);
    // key by full cwd; the renderer shortens to the last path segments
    const proj = e.cwd ?? "?";
    addTally(c.byProject, proj, total, turn);
    // a session belongs to the project of its first counted turn
    if (session && c.project === null) c.project = proj;

    const blocks = msg.content;
    if (Array.isArray(blocks))
      for (const b of blocks)
        if (b?.type === "tool_use" && b.name)
          c.byTool.set(b.name, (c.byTool.get(b.name) ?? 0) + 1);
    const st = u.server_tool_use;
    if (st?.web_search_requests)
      c.byTool.set(
        "web_search",
        (c.byTool.get("web_search") ?? 0) + st.web_search_requests,
      );
    if (st?.web_fetch_requests)
      c.byTool.set(
        "web_fetch",
        (c.byTool.get("web_fetch") ?? 0) + st.web_fetch_requests,
      );
  }
  return c;
}

// Stream a file line by line through Bun.file (async), so the scan never holds a
// whole multi-MB transcript as one string and many files can read concurrently.
async function readLines(path: string): Promise<string[]> {
  const out: string[] = [];
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.file(path).stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      out.push(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
  buf += decoder.decode();
  if (buf) out.push(buf);
  return out;
}

// Per-file cache: an unchanged transcript (same mtime + size) reuses its parsed
// Contrib, so a rescan only re-reads files that grew or are new. In-memory only.
const fileCache = new Map<
  string,
  { mtimeMs: number; size: number; contrib: Contrib }
>();

async function contribFor(
  path: string,
  mtimeMs: number,
  size: number,
  session: boolean,
): Promise<Contrib> {
  const hit = fileCache.get(path);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.contrib;
  const contrib = aggregateLines(await readLines(path), session);
  fileCache.set(path, { mtimeMs, size, contrib });
  return contrib;
}

// Run `fn` over `items` with at most `limit` in flight, preserving order. Caps
// memory: we never decode more than `limit` transcripts at once.
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

interface TFile {
  path: string;
  mtimeMs: number;
  size: number;
  session: boolean; // top-level transcript (vs a sub-agent file under subagents/)
}

// Recursively collect every *.jsonl under a project dir. A file directly in the
// project dir is a session transcript; anything deeper (the <id>/subagents/ tree,
// including nested workflow dirs) is a sub-agent transcript. Directory/stat ops
// are sync node:fs (metadata only).
function walkProject(dir: string, projDir: string, out: TFile[]) {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // not a directory, or unreadable
  }
  for (const ent of entries) {
    const full = `${dir}/${ent.name}`;
    if (ent.isDirectory()) {
      walkProject(full, projDir, out);
    } else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
      try {
        const st = statSync(full);
        out.push({
          path: full,
          mtimeMs: st.mtimeMs,
          size: st.size,
          session: dir === projDir,
        });
      } catch {} // vanished between listing and stat
    }
  }
}

// List every transcript (session + sub-agent) across all project dirs.
function listTranscripts(): TFile[] {
  const files: TFile[] = [];
  let projects: string[];
  try {
    projects = readdirSync(`${CLAUDE_DIR}/projects`);
  } catch {
    return files; // no projects dir yet
  }
  for (const proj of projects) {
    const projDir = `${CLAUDE_DIR}/projects/${proj}`;
    walkProject(projDir, projDir, files);
  }
  return files;
}

// Fold every file's Contrib into the final History: merge the tallies, then
// build a contiguous ascending day array (gaps zero-filled) and add each
// session's start to its first day.
function merge(
  contribs: Contrib[],
  subAgents: number,
  sessions: SessionRow[] = [],
): History {
  const days = new Map<string, DayBucket>();
  const byModel = new Map<string, Tally>();
  const byTool = new Map<string, number>();
  const byProjectTally = new Map<string, Tally>();
  const sessionsByDay = new Map<string, number>();
  const sessionsByProject = new Map<string, number>();

  const mergeTally = (into: Map<string, Tally>, from: Map<string, Tally>) => {
    for (const [k, v] of from) {
      const t = into.get(k);
      if (t) {
        t.tokens += v.tokens;
        t.turns += v.turns;
      } else into.set(k, { tokens: v.tokens, turns: v.turns });
    }
  };

  for (const c of contribs) {
    for (const [key, d] of c.days) {
      const into = days.get(key);
      if (into) {
        into.inputFresh += d.inputFresh;
        into.cacheRead += d.cacheRead;
        into.cacheCreate += d.cacheCreate;
        into.output += d.output;
        into.turns += d.turns;
      } else {
        days.set(key, { date: key, sessionsStarted: 0, ...d });
      }
    }
    mergeTally(byModel, c.byModel);
    mergeTally(byProjectTally, c.byProject);
    for (const [k, n] of c.byTool) byTool.set(k, (byTool.get(k) ?? 0) + n);
    if (c.firstTs !== null) {
      const key = dateKey(new Date(c.firstTs));
      sessionsByDay.set(key, (sessionsByDay.get(key) ?? 0) + 1);
    }
    if (c.project !== null)
      sessionsByProject.set(
        c.project,
        (sessionsByProject.get(c.project) ?? 0) + 1,
      );
  }

  // A session's working directory is fixed at launch, but its sub-agents can run
  // in a subdirectory (e.g. flux-operator/web under flux-operator), so their
  // turns land under a child path with no session of its own. Fold each such
  // child path into its nearest ancestor project that has activity, so one repo
  // shows as one row instead of splitting into a parent plus 0-session subdirs.
  // A child with sessions of its own is a project in its own right and stays:
  // one session launched in a parent directory (an org dir holding every repo)
  // must not swallow all the repos beneath it.
  const nearestAncestor = (k: string): string | null => {
    let p = k;
    for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/")) {
      p = p.slice(0, i);
      if (byProjectTally.has(p)) return p;
    }
    return null;
  };
  // Longest paths first, so a deep child (/repo/web/x) folds into /repo/web
  // before that in turn folds into /repo — chains collapse the whole way up.
  for (const k of [...byProjectTally.keys()].sort(
    (a, b) => b.length - a.length,
  )) {
    if (sessionsByProject.get(k)) continue;
    const par = nearestAncestor(k);
    if (!par) continue;
    const src = byProjectTally.get(k)!;
    const dst = byProjectTally.get(par)!;
    dst.tokens += src.tokens;
    dst.turns += src.turns;
    byProjectTally.delete(k);
  }

  // fold the session counts into the per-project tallies
  const byProject = new Map<string, ProjectStat>();
  for (const [k, t] of byProjectTally)
    byProject.set(k, { ...t, sessions: sessionsByProject.get(k) ?? 0 });

  const keys = [...days.keys()].sort();
  const first = keys[0] ?? null;
  const last = keys[keys.length - 1] ?? null;

  const filled: DayBucket[] = [];
  let totalTokens = 0;
  let totalTurns = 0;
  if (first && last) {
    const [fy, fm, fd] = first.split("-").map(Number);
    const cursor = new Date(fy, fm - 1, fd); // local; setDate handles DST/rollover
    while (dateKey(cursor) <= last) {
      const key = dateKey(cursor);
      const d = days.get(key) ?? {
        date: key,
        inputFresh: 0,
        cacheRead: 0,
        cacheCreate: 0,
        output: 0,
        turns: 0,
        sessionsStarted: 0,
      };
      d.sessionsStarted = sessionsByDay.get(key) ?? 0;
      filled.push(d);
      totalTokens += d.inputFresh + d.cacheRead + d.cacheCreate + d.output;
      totalTurns += d.turns;
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  let totalSessions = 0;
  for (const n of sessionsByDay.values()) totalSessions += n;

  return {
    days: filled,
    byModel,
    byTool,
    byProject,
    sessions,
    totals: {
      tokens: totalTokens,
      turns: totalTurns,
      sessions: totalSessions,
      subAgents,
      firstDay: first,
      lastDay: last,
    },
  };
}

// The parent session id of a transcript: the file's basename for a session file,
// or the <id> directory above the subagents/ tree for a sub-agent file. Both
// share it, so sub-agent usage folds back onto its session.
function sessionIdOf(f: TFile): string {
  if (f.session)
    return f.path.slice(f.path.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
  const head = f.path.split("/subagents/")[0]; // .../projects/<proj>/<id>
  return head.slice(head.lastIndexOf("/") + 1);
}

// One row per top-level session, newest first, with tokens/turns summed across
// the main transcript and its sub-agents (grouped by the shared id). The main
// file fixes the session's start, project, and dominant model.
function buildSessions(files: TFile[], contribs: Contrib[]): SessionRow[] {
  const byId = new Map<string, SessionRow>();
  files.forEach((f, i) => {
    const c = contribs[i];
    const id = sessionIdOf(f);
    let s = byId.get(id);
    if (!s) {
      s = {
        id,
        project: "?",
        model: "?",
        startTs: 0,
        endTs: 0,
        tokens: 0,
        turns: 0,
        tools: 0,
      };
      byId.set(id, s);
    }
    for (const t of c.byModel.values()) {
      s.tokens += t.tokens;
      s.turns += t.turns;
    }
    for (const n of c.byTool.values()) s.tools += n;
    if (f.session) {
      s.startTs = c.firstTs ?? 0;
      s.endTs = c.lastTs ?? 0;
      s.project = c.project ?? "?";
      let bestTokens = -1;
      for (const [m, t] of c.byModel)
        if (t.tokens > bestTokens) {
          bestTokens = t.tokens;
          s.model = m;
        }
    }
  });
  return [...byId.values()]
    .filter((s) => s.startTs > 0 && s.turns > 0) // skip orphans and empty sessions
    .sort((a, b) => b.startTs - a.startTs);
}

// Read concurrency for the full scan: enough overlap to hide I/O latency without
// decoding the whole corpus at once.
const SCAN_CONCURRENCY = 8;

// Full-scan every transcript and aggregate into a History. Cheap on a rescan:
// only files whose mtime/size changed are re-read.
export async function collectHistory(): Promise<History> {
  const files = listTranscripts();
  const live = new Set(files.map((f) => f.path));
  for (const path of fileCache.keys())
    if (!live.has(path)) fileCache.delete(path); // drop deleted transcripts
  const contribs = await mapPool(files, SCAN_CONCURRENCY, (f) =>
    contribFor(f.path, f.mtimeMs, f.size, f.session),
  );
  const subAgents = files.reduce((n, f) => n + (f.session ? 0 : 1), 0);
  return merge(contribs, subAgents, buildSessions(files, contribs));
}

// Exported for tests only.
export const __test = { aggregateLines, merge, dateKey, buildSessions };
