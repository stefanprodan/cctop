// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// macOS process source: reads the process table via libproc (bun:ffi) and the
// interface counters via getifaddrs. All read-only; spawns nothing. Importing
// bun:ffi is safe on any OS — it's a Bun builtin — but dlopen of the macOS
// dylibs would throw elsewhere, so every eager FFI call (dlopen, the timebase
// query) lives inside createDarwinSource(); the facade calls it only on darwin.

import { CString, dlopen, FFIType, ptr, read } from "bun:ffi";
import { parseCommand, parseProcArgs } from "./cmdline.ts";
import type { IfCounters, Proc, ProcSource } from "./types.ts";

export function createDarwinSource(): ProcSource {
  const PROC_PIDTBSDINFO = 3; // struct proc_bsdinfo, 136 bytes
  const PROC_PIDTASKINFO = 4; // struct proc_taskinfo, 96 bytes
  const PROC_PIDVNODEPATHINFO = 9; // struct proc_vnodepathinfo, 2352 bytes
  const PROC_PIDT_SHORTBSDINFO = 13; // struct proc_bsdshortinfo, 64 bytes
  const CTL_KERN = 1;
  const KERN_ARGMAX = 8;
  const KERN_PROCARGS2 = 49;

  // listening-port discovery via libproc fd introspection. Flavor selectors,
  // the fd-type tag, and the socket_fdinfo field offsets below were taken from
  // <sys/proc_info.h> (LP64) and verified with offsetof; they are load-bearing.
  const PROC_PIDLISTFDS = 1; // flavor: array of struct proc_fdinfo (8 bytes ea)
  const PROC_PIDFDSOCKETINFO = 3; // flavor: struct socket_fdinfo for one fd
  const PROX_FDTYPE_SOCKET = 2; // proc_fdinfo.proc_fdtype for a socket fd
  const SOCKET_FDINFO_SIZE = 792; // sizeof(struct socket_fdinfo)
  const SOI_KIND_OFF = 256; // socket_info.soi_kind (int)
  const SOCKINFO_TCP = 2; // soi_kind value for a TCP socket
  const TCPSI_STATE_OFF = 344; // tcp_sockinfo.tcpsi_state (int)
  const TCPS_LISTEN = 1; // tcpsi_state value for a listening socket
  const INSI_LPORT_OFF = 268; // in_sockinfo.insi_lport (int, network order)

  const libproc = dlopen("/usr/lib/libproc.dylib", {
    proc_listallpids: {
      args: [FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    proc_pidpath: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    proc_name: {
      args: [FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    proc_pidinfo: {
      args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    // per-fd socket info: fills a struct socket_fdinfo for one fd of a pid
    proc_pidfdinfo: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
  });

  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    sysctl: {
      args: [
        FFIType.ptr, // int *name
        FFIType.u32, // u_int namelen
        FFIType.ptr, // void *oldp
        FFIType.ptr, // size_t *oldlenp
        FFIType.ptr, // void *newp
        FFIType.u64, // size_t newlen
      ],
      returns: FFIType.i32,
    },
    mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
    // getifaddrs(struct ifaddrs **) allocates a linked list of interface
    // records; freeifaddrs releases it. Read-only snapshot of kernel counters.
    getifaddrs: { args: [FFIType.ptr], returns: FFIType.i32 },
    freeifaddrs: { args: [FFIType.ptr], returns: FFIType.void },
  });

  // task CPU times are in mach time units, not nanoseconds
  const machTimebase = new Uint32Array(2); // { numer, denom }
  libc.symbols.mach_timebase_info(ptr(machTimebase));
  const machToSec = machTimebase[0] / machTimebase[1] / 1e9;

  // argv[0] is how the process was invoked; the claude CLI shows up as
  // "claude" here while its executable is named after its version. argv[1] is
  // read too: it is what tells a session apart from one of the helpers that
  // share its name (`claude bg-pty-host`) — see isClaudeProc. parseProcArgs
  // decodes the block; this closure only fetches it.
  //
  // Size the buffer from KERN_ARGMAX rather than guessing. KERN_PROCARGS2 hands
  // back the process's whole environment along with argv, and it fails with
  // ENOMEM rather than truncating when the buffer is too small — so a fixed
  // guess would simply return nothing for any process with a large environment.
  // A failed fetch reads as "no subcommand", which is exactly what lets Claude
  // Code's helper processes pass for sessions, so this has to be sized right.
  const argMax = (() => {
    const mib = new Int32Array([CTL_KERN, KERN_ARGMAX]);
    const out = new Int32Array(1);
    const size = new BigUint64Array([BigInt(out.byteLength)]);
    const r = libc.symbols.sysctl(ptr(mib), 2, ptr(out), ptr(size), null, 0n);
    return r === 0 && out[0] > 0 ? out[0] : 1 << 20; // 1 MB, the current default
  })();
  const argsBuf = new Uint8Array(argMax);
  const procArgv = (pid: number): string[] => {
    const mib = new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]);
    const size = new BigUint64Array([BigInt(argsBuf.byteLength)]);
    const r = libc.symbols.sysctl(
      ptr(mib),
      3,
      ptr(argsBuf),
      ptr(size),
      null,
      0n,
    );
    if (r !== 0) return []; // not ours to inspect, or exited mid-scan
    return parseProcArgs(argsBuf, Number(size[0]));
  };

  // proc_vnodepathinfo: pvi_cdir.vip_path sits after the 152-byte
  // vnode_info, so the cwd is the NUL-terminated string at offset 152
  const vnodeInfo = new Uint8Array(2352);
  const cwdOf = (pid: number): string | null => {
    const got = libproc.symbols.proc_pidinfo(
      pid,
      PROC_PIDVNODEPATHINFO,
      0n,
      ptr(vnodeInfo),
      vnodeInfo.byteLength,
    );
    if (got < 160) return null;
    const end = vnodeInfo.indexOf(0, 152);
    return end > 152
      ? new TextDecoder().decode(vnodeInfo.slice(152, end))
      : null;
  };

  // struct ifaddrs (LP64): ifa_next@0, ifa_name@8, ifa_flags@16, ifa_addr@24,
  // ifa_netmask@32, ifa_dstaddr@40, ifa_data@48 (pointers are 8 bytes). For an
  // AF_LINK (18) record ifa_data points at a struct if_data whose byte counters
  // sit at ifi_ibytes@40 / ifi_obytes@44 (8 u_char + 8 u32 precede them).
  //
  // Those counters are 32-bit and wrap at 4 GiB. macOS has no read-only 64-bit
  // alternative: NET_RT_IFLIST2's `if_data64` leaves the high 32 bits of the
  // byte counters zeroed (verified empirically — the 64-bit total `netstat`
  // shows is reconstructed elsewhere), so it is no better. We therefore return
  // the raw 32-bit counters per interface and let the rate sampler clamp each
  // interface's wrap on its own (see collect/network.ts).
  const AF_LINK = 18;
  const IFF_LOOPBACK = 0x8; // ifa_flags bit; skip lo by flag, not by name
  // Bun types pointers as an opaque brand, but at runtime they are plain
  // numbers; retype read/free/CString to thread numbers through the list walk.
  const rd = read as unknown as {
    ptr: (p: number, o: number) => number;
    u8: (p: number, o: number) => number;
    u32: (p: number, o: number) => number;
  };
  const mkCStr = CString as unknown as new (p: number) => string;
  const free = libc.symbols.freeifaddrs as unknown as (p: number) => void;
  const netCounters = () => {
    const head = new BigUint64Array(1);
    if (libc.symbols.getifaddrs(ptr(head)) !== 0) return null;
    const list = Number(head[0]);
    const out: IfCounters[] = [];
    // freeifaddrs must run even if a read throws mid-walk, or the kernel
    // allocation leaks on every refresh
    try {
      for (let cur = list; cur !== 0; cur = rd.ptr(cur, 0)) {
        const addr = rd.ptr(cur, 24);
        if (addr === 0 || rd.u8(addr, 1) !== AF_LINK) continue;
        if (rd.u32(cur, 16) & IFF_LOOPBACK) continue; // loopback, by flag
        const data = rd.ptr(cur, 48);
        if (data === 0) continue;
        out.push({
          name: String(new mkCStr(rd.ptr(cur, 8))),
          rx: rd.u32(data, 40),
          tx: rd.u32(data, 44),
        });
      }
    } catch {
      // a recoverable read error (e.g. CString over an unexpected address) must
      // signal failure, not crash — the refresh loop has no catch around this
      return null;
    } finally {
      if (list !== 0) free(list); // runs even on the catch's early return
    }
    return out;
  };

  // Listening TCP ports per pid, via libproc fd introspection (what lsof does
  // internally, but in-process — no `lsof` spawn). For each pid: list its fds
  // (PROC_PIDLISTFDS), and for every socket fd pull its socket_fdinfo
  // (PROC_PIDFDSOCKETINFO), keeping TCP sockets in the LISTEN state and reading
  // their local port. The fd-list buffer grows on demand for processes that
  // hold many fds; the socket_fdinfo buffer is fixed-size and reused.
  let fdList = new Uint8Array(8 * 1024); // 1024 proc_fdinfo entries to start
  let fdView = new DataView(fdList.buffer); // rebuilt only when fdList grows
  const sockInfo = new Uint8Array(SOCKET_FDINFO_SIZE);
  const sockView = new DataView(sockInfo.buffer);
  const listeningPorts = (pids: Iterable<number>): Map<number, number[]> => {
    const ports = new Map<number, number[]>();
    for (const pid of pids) {
      // size the fd list first (null buffer returns the byte count needed),
      // then fetch it; a 0/negative count means no fds or not ours to read
      const need = libproc.symbols.proc_pidinfo(
        pid,
        PROC_PIDLISTFDS,
        0n,
        null,
        0,
      );
      if (need <= 0) continue;
      if (need > fdList.byteLength) {
        fdList = new Uint8Array(need);
        fdView = new DataView(fdList.buffer);
      }
      const got = libproc.symbols.proc_pidinfo(
        pid,
        PROC_PIDLISTFDS,
        0n,
        ptr(fdList),
        fdList.byteLength,
      );
      const found = new Set<number>();
      // each proc_fdinfo is { int32 proc_fd; uint32 proc_fdtype }
      for (let off = 0; off + 8 <= got; off += 8) {
        if (fdView.getUint32(off + 4, true) !== PROX_FDTYPE_SOCKET) continue;
        const fd = fdView.getInt32(off, true);
        const r = libproc.symbols.proc_pidfdinfo(
          pid,
          fd,
          PROC_PIDFDSOCKETINFO,
          ptr(sockInfo),
          sockInfo.byteLength,
        );
        if (r < SOCKET_FDINFO_SIZE) continue; // not a socket, or short read
        if (sockView.getInt32(SOI_KIND_OFF, true) !== SOCKINFO_TCP) continue;
        if (sockView.getInt32(TCPSI_STATE_OFF, true) !== TCPS_LISTEN) continue;
        // insi_lport holds a network-byte-order port in an int; a big-endian
        // read of its low two bytes yields the host-order port directly
        const port = sockView.getUint16(INSI_LPORT_OFF, false);
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

  const listAllProcesses = (): Proc[] => {
    const pids = new Int32Array(16384);
    const n = libproc.symbols.proc_listallpids(ptr(pids), pids.byteLength);

    const taskInfo = new Uint8Array(96);
    const taskView = new DataView(taskInfo.buffer);
    const bsdInfo = new Uint8Array(136);
    const bsdView = new DataView(bsdInfo.buffer);
    const shortInfo = new Uint8Array(64);
    const shortView = new DataView(shortInfo.buffer);
    const cstr = new Uint8Array(4096);
    const readCstr = (len: number) =>
      len > 0 ? new TextDecoder().decode(cstr.slice(0, len)) : null;

    const procs: Proc[] = [];
    for (let i = 0; i < n; i++) {
      const pid = pids[i];
      if (pid <= 0) continue;
      // taskinfo fails for other users' processes; keep them anyway
      // (rss/cpu zeroed) so the host-app ancestry walk still works
      let rss = 0;
      let cpuSec = 0;
      const got = libproc.symbols.proc_pidinfo(
        pid,
        PROC_PIDTASKINFO,
        0n,
        ptr(taskInfo),
        taskInfo.byteLength,
      );
      if (got >= 96) {
        rss = Number(taskView.getBigUint64(8, true)); // pti_resident_size
        cpuSec = // pti_total_user + pti_total_system
          (Number(taskView.getBigUint64(16, true)) +
            Number(taskView.getBigUint64(24, true))) *
          machToSec;
      }

      // pbi_ppid at offset 16, pbi_uid at 20, pbi_start_tvsec at offset 120
      let ppid = 0;
      let startSec = 0;
      let uid = -1;
      let comm: string | null = null;
      const gotBsd = libproc.symbols.proc_pidinfo(
        pid,
        PROC_PIDTBSDINFO,
        0n,
        ptr(bsdInfo),
        bsdInfo.byteLength,
      );
      if (gotBsd >= 128) {
        ppid = bsdView.getUint32(16, true);
        uid = bsdView.getUint32(20, true);
        startSec = Number(bsdView.getBigUint64(120, true));
      } else if (
        // bsdinfo fails for other users' processes (login, launchd...),
        // but the host-app ancestry walk still needs their ppid; the short
        // variant works for any process: ppid at 4, comm at 16, pbsi_uid at 36
        libproc.symbols.proc_pidinfo(
          pid,
          PROC_PIDT_SHORTBSDINFO,
          0n,
          ptr(shortInfo),
          shortInfo.byteLength,
        ) >= 64
      ) {
        ppid = shortView.getUint32(4, true);
        uid = shortView.getUint32(36, true);
        const end = shortInfo.indexOf(0, 16);
        comm =
          new TextDecoder().decode(
            shortInfo.slice(16, end < 16 || end > 32 ? 32 : end),
          ) || null;
      }

      const path = readCstr(
        libproc.symbols.proc_pidpath(pid, ptr(cstr), cstr.byteLength),
      );
      const { name: argvName, sub } = parseCommand(procArgv(pid));
      const name =
        argvName ??
        readCstr(libproc.symbols.proc_name(pid, ptr(cstr), cstr.byteLength)) ??
        comm ??
        path?.split("/").pop() ??
        "?";
      procs.push({ pid, ppid, rss, cpuSec, startSec, path, name, sub, uid });
    }
    return procs;
  };

  return { listAllProcesses, cwdOf, netCounters, listeningPorts };
}
