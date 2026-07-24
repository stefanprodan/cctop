// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Shared, platform-agnostic contract for the process table. The per-OS
// implementations (darwin.ts, linux.ts) satisfy ProcSource; the facade
// (../proc.ts) picks one at startup. Types only — no runtime code, so any
// module can import these without dragging in FFI or /proc reads.

export interface Proc {
  pid: number;
  ppid: number;
  rss: number; // resident memory, bytes
  cpuSec: number; // total CPU time consumed, seconds
  startSec: number; // process start, unix seconds
  path: string | null; // executable path
  // The program's name: argv[0]'s basename, or the leading token when argv[0] is
  // a rewritten process title ("tmux: server" → "tmux") — see parseCommand,
  // which derives this and `sub` from the one parse. Best-effort; "?" when argv
  // is unreadable.
  name: string;
  // argv[1], when it is a bare subcommand rather than a flag or absent. It is
  // what separates a Claude Code session (`claude`, `claude -p …`) from one of
  // the helper processes that share its name and executable (`claude
  // bg-pty-host`, `claude daemon run`) — see isClaudeProc.
  sub: string | null;
  uid: number; // owning user id; -1 when unreadable (a proc we don't own)
}

export interface IfCounters {
  name: string;
  rx: number; // cumulative bytes received on this interface
  tx: number; // cumulative bytes transmitted on this interface
}

// One platform implementation per OS. The facade resolves a single instance at
// startup. Members are plain functions (not this-bound methods): callers may
// capture them detached — e.g. collect/network.ts does
// makeNetSampler(netCounters) — so the implementations return closures over
// their own state rather than methods relying on `this`.
export interface ProcSource {
  // List every process on the host (best-effort; entries we can't fully read
  // are still included with zeroed fields so ancestry walks keep working).
  listAllProcesses: () => Proc[];
  // Current working directory of a pid, or null if it can't be read.
  cwdOf: (pid: number) => string | null;
  // Listening TCP ports owned by each of the given pids: pid -> sorted, unique
  // ports. Surfaces forgotten dev servers a session left running. Read-only:
  // Linux maps /proc/net/tcp[6] LISTEN inodes to /proc/<pid>/fd sockets; macOS
  // walks each pid's socket fds via libproc. Scoped to `pids` (a session's
  // sub-processes) rather than every pid on the host. Pids with no listening
  // socket are absent from the map.
  listeningPorts: (pids: Iterable<number>) => Map<number, number[]>;
  // Per-interface cumulative byte counters for every real (non-loopback)
  // interface, machine-wide — not per-process (no read-only per-pid network
  // counter exists on either platform). Returned per-interface (not pre-summed)
  // so the rate sampler can delta each interface and clamp wraps independently;
  // summing first would let one interface's 32-bit wrap mask another's traffic
  // (see collect/network.ts). Returns null when the counters can't be read, so
  // callers can distinguish a read failure from a genuine zero.
  netCounters: () => IfCounters[] | null;
}
