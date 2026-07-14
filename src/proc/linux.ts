// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Linux process source: reads the process table and interface counters from
// /proc. All read-only; spawns nothing. Module load is side-effect-free — the
// facade calls createLinuxSource() only on Linux, so this never touches /proc
// on the wrong OS.

import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { parseCommand } from "./cmdline.ts";
import { parseProcNetDev } from "./netdev.ts";
import { parseTcpListen } from "./nettcp.ts";
import type { Proc, ProcSource } from "./types.ts";

// /proc/<pid>/exe readlinks to ".../2.1.206 (deleted)" once the binary behind a
// running process is gone — the normal end-state of any long-lived Claude Code
// session, since it auto-upgrades out from under itself. The marker is not part
// of the path, and stripping it is load-bearing beyond cosmetics: a nested or
// resumed session is identified by its exec path agreeing with argv[0] (see
// isClaudeProc), so a session that outlived its own install is only still a
// session because of this. Pure, and exported, so that coupling has a test.
export const execPath = (target: string) => target.replace(/ \(deleted\)$/, "");

export function createLinuxSource(): ProcSource {
  const CLK_TCK = 100; // USER_HZ, fixed on every mainstream architecture

  const listAllProcesses = (): Proc[] => {
    const uptimeSec = Number.parseFloat(readFileSync("/proc/uptime", "utf8"));
    const bootSec = Date.now() / 1000 - uptimeSec;
    const procs: Proc[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      try {
        // /proc/pid/stat: "pid (comm) state ppid ..."; comm can contain
        // spaces, so split after the closing paren. After the split:
        // ppid is field 1, utime/stime 11/12, starttime (ticks) 19.
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const ppid = Number(f[1]);
        const cpuSec = (Number(f[11]) + Number(f[12])) / CLK_TCK;
        const startSec = bootSec + Number(f[19]) / CLK_TCK;

        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        const rssKb = Number(status.match(/^VmRSS:\s+(\d+) kB/m)?.[1] ?? 0);
        // "Uid:\t<real>\t<eff>\t..."; the real uid identifies the owner
        const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1] ?? -1);

        let path: string | null = null;
        try {
          path = execPath(readlinkSync(`/proc/${pid}/exe`));
        } catch {} // not ours to inspect

        // /proc/pid/cmdline is the NUL-separated argv, and only argv (the
        // environment lives in a separate file), so every field is safe to read
        const argv = readFileSync(`/proc/${pid}/cmdline`, "latin1").split("\0");
        const { name: argvName, sub } = parseCommand(argv);
        // a kernel thread has an empty cmdline; its name lives in status
        const name = argvName || status.match(/^Name:\s+(.+)$/m)?.[1] || "?";
        procs.push({
          pid,
          ppid,
          rss: rssKb * 1024,
          cpuSec,
          startSec,
          path,
          name,
          sub,
          uid,
        });
      } catch {} // process exited mid-scan
    }
    return procs;
  };

  const cwdOf = (pid: number): string | null => {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  };

  // Listening ports per pid, in two steps (mirrors what lsof does):
  // 1. /proc/net/tcp + tcp6 give every socket's state, local port, and inode;
  //    keep only LISTEN sockets (st field == "0A") as inode -> port.
  // 2. for each requested pid, read /proc/<pid>/fd: a socket fd readlinks to
  //    "socket:[<inode>]", so a matching inode attributes that port to the pid.
  // Both are plain /proc reads — no socket is opened, nothing is spawned.
  const listeningPorts = (pids: Iterable<number>): Map<number, number[]> => {
    const ports = new Map<number, number[]>();
    const pidList = [...pids];
    if (!pidList.length) return ports; // nothing to scan; skip the /proc reads

    const inodeToPort = new Map<string, number>();
    for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let data: string;
      try {
        data = readFileSync(path, "utf8");
      } catch {
        continue; // tcp6 absent when IPv6 is disabled
      }
      for (const [inode, port] of parseTcpListen(data))
        inodeToPort.set(inode, port);
    }
    if (!inodeToPort.size) return ports;

    for (const pid of pidList) {
      let fds: string[];
      try {
        fds = readdirSync(`/proc/${pid}/fd`);
      } catch {
        continue; // not ours to inspect, or exited mid-scan
      }
      const found = new Set<number>();
      for (const fd of fds) {
        let target: string;
        try {
          target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {
          continue; // fd closed mid-scan
        }
        const inode = target.match(/^socket:\[(\d+)\]$/)?.[1];
        const port = inode && inodeToPort.get(inode);
        if (port) found.add(port);
      }
      if (found.size)
        ports.set(
          pid,
          [...found].sort((a, b) => a - b),
        );
    }
    return ports;
  };

  // Snapshot the interface byte counters from /proc/net/dev (parseProcNetDev
  // does the parsing); a read failure signals null rather than a bogus zero.
  const netCounters = () => {
    try {
      return parseProcNetDev(readFileSync("/proc/net/dev", "utf8"));
    } catch {
      return null; // /proc/net/dev unreadable (unusual); signal failure
    }
  };

  return { listAllProcesses, cwdOf, netCounters, listeningPorts };
}
