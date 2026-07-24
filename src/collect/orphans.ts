// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Stateless orphan-port detection. A listening server reparented to init (ppid
// 1, so its starting parent has exited) whose cwd sits inside a live session's
// project is a dev server a (possibly already-gone) run left behind. Derived
// from one process snapshot and attributed to the owning session(s) by cwd —
// the only stateless link back, and a filter that also screens out unrelated
// daemons. Read-only; spawns nothing.

import { cwdOf, listeningPorts, type Proc } from "../proc.ts";
import { isClaudeHelper } from "./process-tree.ts";
import type { Instance } from "./types.ts";

// The tracked project dir that contains `cwd` — an exact match or an ancestor
// with a path-segment boundary (so /a/foo never matches /a/foobar). null if none.
export const projectForCwd = (cwd: string, dirs: string[]): string | null =>
  dirs.find((d) => cwd === d || cwd.startsWith(`${d}/`)) ?? null;

// Could this process be a dev server someone left behind? The uid gate is the
// cheap one — init (ppid 1) reparents most of the host's daemons and they belong
// to other users, so dropping them on a field compare avoids a cwdOf syscall per
// daemon on every refresh. A dev server we left behind shares our uid and
// survives to the cwd check.
//
// Claude Code's own helpers have to be named explicitly. They are
// init-reparented, ours, and run in the session's project dir, so they clear
// every other gate; candidatePids covered them back when they were rows. They
// hold no listening TCP socket today, but an orphan is offered up for SIGTERM
// (`f`), and offering to kill Claude Code's pty host is not a mistake worth
// leaving one syscall away.
export const isOrphanCandidate = (
  p: Proc,
  ownUid: number,
  candidatePids: Set<number>,
) =>
  p.ppid === 1 &&
  p.uid === ownUid &&
  !candidatePids.has(p.pid) &&
  !isClaudeHelper(p);

// Find orphaned listening servers among `procs` (the full process table) and
// attach each to the session row(s) whose project contains its cwd, excluding
// the session pids in `candidatePids`. Mutates each matched row's orphanPorts.
export function attachOrphanPorts(
  rows: Instance[],
  procs: Proc[],
  candidatePids: Set<number>,
): void {
  const byProject = new Map<string, Instance[]>();
  for (const r of rows)
    if (r.project) {
      const arr = byProject.get(r.project);
      if (arr) arr.push(r);
      else byProject.set(r.project, [r]);
    }
  if (!byProject.size) return;
  const dirs = [...byProject.keys()];

  const ownUid = process.getuid?.() ?? -1;
  const matched: { pid: number; name: string; project: string }[] = [];
  for (const p of procs) {
    if (!isOrphanCandidate(p, ownUid, candidatePids)) continue;
    const cwd = cwdOf(p.pid);
    const project = cwd ? projectForCwd(cwd, dirs) : null;
    if (project) matched.push({ pid: p.pid, name: p.name, project });
  }
  if (!matched.length) return;

  // one port scan over the matched pids, then attach the ones that listen
  const ports = listeningPorts(matched.map((m) => m.pid));
  for (const m of matched) {
    const open = ports.get(m.pid);
    if (!open?.length) continue;
    const orphan = { pid: m.pid, name: m.name, ports: open };
    for (const r of byProject.get(m.project)!) r.orphanPorts.push(orphan);
  }
}
