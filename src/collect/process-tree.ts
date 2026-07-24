// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Process-table derived columns: which process is a Claude session, the host
// app that owns it, the sub-process tree it spawned, and per-process %CPU
// (sampled across refreshes). Pure over the Proc table plus a small CPU-sample
// cache; read-only.

import type { Proc } from "../proc.ts";

// Claude Code ships processes that are not sessions but are indistinguishable
// from one by name and executable: the background daemon and the pty/spare
// hosts it spawns (`claude daemon run`, `claude bg-pty-host`, `claude
// bg-spare`), plus management commands like `claude mcp`. They are named
// "claude" and exec the same versioned binary a session does.
//
// Letting one through is worse than an extra row: a helper writes no session
// registry entry, so its row falls back to the newest transcript in its cwd —
// and a bg-pty-host sits in the *session's* project directory, so it adopts the
// live session's transcript and renders as its exact duplicate.
//
// The subcommand is what tells them apart. `bg-` as a prefix rather than a list
// of names, so a helper added later is excluded by default; a session is either
// bare `claude` or takes flags (`claude -p …`), never one of these.
//
// Both halves matter. The subcommand alone is not Claude's — plenty of CLIs take
// a `daemon` or an `mcp` subcommand — so a helper is a claude *executable*
// running one. Callers outside candidate selection depend on that: the
// orphan-port scan runs this over the whole process table, and without the
// executable half it would mistake someone else's `mcp` server for one of ours.
const CLAUDE_COMMANDS = new Set(["daemon", "mcp"]);

// The version-named executable lives under .../claude/versions/2.1.176
const isClaudeExe = (p: Proc) =>
  p.name === "claude" || /\/claude\/versions\/\d/.test(p.path ?? "");

export const isClaudeHelper = (p: Proc) =>
  isClaudeExe(p) &&
  !!p.sub &&
  (p.sub.startsWith("bg-") || CLAUDE_COMMANDS.has(p.sub));

export const isClaudeProc = (p: Proc) => isClaudeExe(p) && !isClaudeHelper(p);

export const versionFromPath = (path: string | null) =>
  path
    ?.split("/")
    .pop()
    ?.match(/^\d+\.\d+(\.\d+)?/)?.[0] ?? null;

// First ancestor past shells and wrappers identifies what hosts the
// session: a macOS app bundle (iTerm, Ghostty, GoLand, Visual Studio
// Code, Claude...), tmux, or sshd.
const HOST_SKIP = new Set([
  "op",
  "sudo",
  "env",
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "login",
  "script",
  "direnv",
]);

// Shells that wrap a tool command; the sub-process tree descends through
// these to show the real command rather than the shell (see subprocsOf).
const SHELL_NAMES = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh"]);

// Build/task runners that exec another command to do the real work. Like
// shells the tree descends through them, but unlike shells each one stays in
// the chain: `make test` running `go test` shows `bash › make › go`, not just
// `bash › make`, so the runner and the command it drives are both visible.
// Unlike an idle shell, a wrapper with nothing under it is still shown — it's
// doing the work itself (compiling, resolving) between spawning children.
const WRAPPER_NAMES = new Set([
  "make",
  "gmake",
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "xargs",
  "timeout",
  "time",
  "watch",
]);

// Cross-provider AI coding agents running as sub-processes (a session
// delegating to another agent CLI). A sub-process whose resolved command is
// one of these is an agent at work, not a background tool — the renderers
// mark it live (green dot) and paint the row cyan like the Claude sub-agent
// rows, so delegated agents stand out from the process noise.
const AGENT_CLIS = new Set([
  "copilot",
  "kiro",
  "kiro-cli",
  "gemini",
  "codex",
  "opencode",
  "aider",
  "goose",
  "amp",
  "cursor-agent",
  "droid",
  "crush",
  "auggie",
  "qwen",
  "openhands",
  "cline",
  "jules",
  "devin",
  "plandex",
  "codebuff",
]);

// Whether a resolved sub-process command (possibly a "bash › copilot" chain)
// is a known agent CLI: only the leaf segment counts — that's the command
// actually doing the work; wrappers/shells ahead of it are just plumbing.
export const isAgentCmd = (chain: string) =>
  AGENT_CLIS.has(chain.split(" › ").at(-1)?.toLowerCase() ?? "");

// Join a command onto the running prefix, collapsing a consecutive duplicate
// (recursive `make › make`, or `npm › npm`) into a single segment.
const appendSegment = (prefix: string | null, name: string): string => {
  if (!prefix) return name;
  if (prefix === name || prefix.endsWith(` › ${name}`)) return prefix;
  return `${prefix} › ${name}`;
};

export function hostApp(proc: Proc, byPid: Map<number, Proc>): string {
  let p: Proc | undefined = proc;
  for (let i = 0; i < 20; i++) {
    p = byPid.get(p.ppid);
    if (!p || p.pid <= 1) break;
    const app = p.path?.match(/\/([^/]+)\.app\//); // outermost bundle
    if (app) return app[1];
    // a session spawned by another Claude (a bg job / sub-session) is hosted by
    // that parent; report it as "claude" rather than the versioned exec name
    // ("2.1.177") the nested process carries
    if (isClaudeProc(p)) return "claude";
    const base = (p.name ?? "").toLowerCase();
    if (base.startsWith("tmux")) return "tmux";
    if (base.startsWith("sshd")) return "ssh";
    if (!HOST_SKIP.has(base)) return p.name;
  }
  return "?";
}

// index every process by its parent so each session can list the
// sub-processes it spawned (tool shells, MCP servers, caffeinate...)
export function indexChildren(procs: Proc[]): Map<number, Proc[]> {
  const childrenOf = new Map<number, Proc[]>();
  for (const c of procs) {
    const arr = childrenOf.get(c.ppid);
    if (arr) arr.push(c);
    else childrenOf.set(c.ppid, [c]);
  }
  return childrenOf;
}

// A session's effective sub-processes: descend through shells and build/task
// runners (claude's Bash tool spawns `bash -c '...'`, occasionally nested)
// down to the real command. Repeated shells collapse to a single outermost
// prefix so context is preserved without piling up layers ("bash › go", not
// "bash › bash › go"); a wrapper instead stays in the chain ("bash › make › go")
// since the runner and the command it drives are both informative. A shell
// with nothing under it is just an idle wrapper between commands and is
// dropped; a childless runner is kept (it's working itself). The depth cap
// guards cycles.
function resolveProc(
  proc: Proc,
  prefix: string | null,
  depth: number,
  childrenOf: Map<number, Proc[]>,
  candidatePids: Set<number>,
): Proc[] {
  // A nested session (a bg job or sub-session spawned by this one) is itself a
  // top-level candidate and gets its own row, so it must not also appear here
  // as a sub-process: its versioned exec name ("2.1.177") would land in the
  // name slot — the CTX column on a session row — reading like a stray
  // version where the context should be. Its own children hang off its row.
  // We key off the candidate set rather than isClaudeProc alone so sessions
  // found only via the registry (and missed by the executable heuristic) are
  // excluded too — otherwise they would still double-list.
  if (candidatePids.has(proc.pid)) return [];
  const kids = childrenOf.get(proc.pid) ?? [];
  const isShell = SHELL_NAMES.has(proc.name);
  const isWrapper = WRAPPER_NAMES.has(proc.name);
  if (depth < 8 && kids.length && (isShell || isWrapper)) {
    // shells collapse onto the outermost prefix; wrappers extend the chain
    const label = isShell
      ? (prefix ?? proc.name)
      : appendSegment(prefix, proc.name);
    return kids.flatMap((k) =>
      resolveProc(k, label, depth + 1, childrenOf, candidatePids),
    );
  }
  if (isShell) return []; // childless shell, just an idle wrapper — skip
  return [{ ...proc, name: appendSegment(prefix, proc.name) }];
}

export function subprocsOf(
  pid: number,
  childrenOf: Map<number, Proc[]>,
  candidatePids: Set<number>,
): Proc[] {
  return (childrenOf.get(pid) ?? []).flatMap((c) =>
    resolveProc(c, null, 0, childrenOf, candidatePids),
  );
}

// Every pid in the subtree rooted at `root` (inclusive), without crossing into
// a nested session (candidatePids) — those get their own rows, so their
// listeners must not roll up here. Used for port attribution: a displayed
// sub-process should own the ports of the descendants it spawned, since
// subprocsOf shows the wrapper (`npm run dev`) while a deeper child (node/vite)
// holds the actual listening socket. The counter caps a pathological cycle.
export function descendants(
  root: number,
  childrenOf: Map<number, Proc[]>,
  candidatePids: Set<number>,
): number[] {
  const out: number[] = [];
  const stack = [root];
  for (let guard = 0; stack.length && guard < 10_000; guard++) {
    const pid = stack.pop()!;
    out.push(pid);
    for (const c of childrenOf.get(pid) ?? [])
      if (!candidatePids.has(c.pid)) stack.push(c.pid);
  }
  return out;
}

// %CPU: like top, the delta between two samples (watch refreshes); on the
// first sample it falls back to the average since the process started.
const cpuSamples = new Map<number, { cpuSec: number; atMs: number }>();
export function cpuPercent(p: Proc, nowMs: number) {
  const prev = cpuSamples.get(p.pid);
  cpuSamples.set(p.pid, { cpuSec: p.cpuSec, atMs: nowMs });
  if (prev && nowMs - prev.atMs > 200) {
    // clamp: cpuSec can drop after PID reuse, yielding a negative delta
    return Math.max(
      0,
      ((p.cpuSec - prev.cpuSec) / ((nowMs - prev.atMs) / 1000)) * 100,
    );
  }
  const elapsed = nowMs / 1000 - p.startSec;
  return elapsed > 0 ? (p.cpuSec / elapsed) * 100 : 0;
}

// Drop samples of processes that left the table, so the map stays small.
// `keep` is the set of pids still shown (sessions and their sub-processes).
export function pruneCpuSamples(keep: Set<number>) {
  for (const pid of cpuSamples.keys()) {
    if (!keep.has(pid)) cpuSamples.delete(pid);
  }
}
