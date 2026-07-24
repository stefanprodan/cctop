// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { parseCommand, parseProcArgs } from "../src/proc/cmdline.ts";

// parseCommand turns a process's argv into the name and subcommand the
// collectors identify it by. The subcommand is what tells a Claude Code session
// apart from one of the helper processes that share its name and executable.
describe("command line parsing (parseCommand)", () => {
  test("reads a plain executable path with no subcommand", () => {
    expect(parseCommand(["claude"])).toEqual({ name: "claude", sub: null });
    expect(parseCommand(["/usr/local/bin/claude"])).toEqual({
      name: "claude",
      sub: null,
    });
    expect(parseCommand([])).toEqual({ name: null, sub: null });
  });

  // the session Claude: version-named executable, flags, or a prompt — never a
  // subcommand a helper would carry
  test("keeps a session's argv free of a subcommand", () => {
    expect(
      parseCommand([
        "/u/.local/share/claude/versions/2.1.206",
        "--session-id",
        "abc",
      ]),
    ).toEqual({ name: "2.1.206", sub: null });
    expect(parseCommand(["claude", "-p", "summarize this"])).toEqual({
      name: "claude",
      sub: null,
    });
    // a path handed to claude is an argument, not a subcommand
    expect(parseCommand(["claude", "/tmp/prompt.md"])).toEqual({
      name: "claude",
      sub: null,
    });
  });

  // `claude daemon run` passes its subcommand the ordinary way, as argv[1]
  test("reads a subcommand passed as argv[1]", () => {
    expect(
      parseCommand([
        "/home/u/.local/bin/claude",
        "daemon",
        "run",
        "--json-path",
        "/home/u/.claude/daemon.json",
      ]),
    ).toEqual({ name: "claude", sub: "daemon" });
  });

  // The pty and spare hosts rewrite their process title instead: argv[0] is the
  // whole "claude bg-pty-host" string and argv[1] is a flag. Folded in like this
  // the subcommand is invisible to an argv[1] read, which is exactly how these
  // processes used to pass for sessions.
  test("reads a subcommand folded into a rewritten process title", () => {
    expect(
      parseCommand([
        "claude bg-pty-host",
        "--bg-pty-host",
        "/tmp/cc-daemon-1000/abc/pty/session.sock",
        "165",
        "72",
      ]),
    ).toEqual({ name: "claude", sub: "bg-pty-host" });
    expect(
      parseCommand([
        "claude bg-spare",
        "--bg-spare",
        "/tmp/cc-daemon-1000/abc/spare/claim.sock",
      ]),
    ).toEqual({ name: "claude", sub: "bg-spare" });
  });

  // The guard on the title split: an executable path can legitimately contain a
  // space (every macOS .app bundle with a space in its name), and splitting one
  // would strand the HOST column on "Visual". A path keeps its slashes; a
  // rewritten title has none before the space.
  test("does not mistake a spaced executable path for a title", () => {
    expect(
      parseCommand([
        "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      ]),
    ).toEqual({ name: "Electron", sub: null });
  });

  // Claude's helpers are not the only processes that rewrite their title, and
  // the name this yields is what the HOST column and the sub-process rows
  // display — so the common ones are pinned. The trailing colon is punctuation,
  // not part of the name: left on, rows would read "nginx:" and HOST would print
  // the raw title token for any host outside the tmux/sshd/app-bundle set.
  test("names a process that rewrote its title, colon and all", () => {
    expect(parseCommand(["tmux: server"])).toEqual({
      name: "tmux",
      sub: "server",
    });
    expect(parseCommand(["sshd-session: daniel [priv]"])).toEqual({
      name: "sshd-session",
      sub: "daniel",
    });
    expect(parseCommand(["nginx: master process /usr/sbin/nginx"])).toEqual({
      name: "nginx",
      sub: "master",
    });
    expect(parseCommand(["redis-server *:6379"])).toEqual({
      name: "redis-server",
      sub: "*:6379",
    });
  });
});

// The macOS half of the same job: sysctl fills a raw KERN_PROCARGS2 block and
// parseProcArgs decodes it. It is every macOS row's only source of a subcommand,
// so it is tested here against synthetic blocks — the FFI closure that fetches
// the buffer cannot run off a Mac, but this decode can.
describe("KERN_PROCARGS2 decoding (parseProcArgs)", () => {
  // one raw block: argc (i32 LE), the exec path, NUL padding, then the fields —
  // argv first and the environment straight after it, exactly as the kernel
  // lays it out.
  const block = (argc: number, execPath: string, fields: string[]) => {
    const body = `${execPath}\0\0\0${fields.join("\0")}\0`;
    const buf = new Uint8Array(4 + body.length);
    new DataView(buf.buffer).setInt32(0, argc, true);
    for (let i = 0; i < body.length; i++) buf[4 + i] = body.charCodeAt(i);
    return buf;
  };

  // The reason argc is read at all. argv and the environment sit in one block
  // with nothing between them, so a decode that splits to the end of the block
  // would hand back the process's first environment variable as argv[1] — and
  // env vars hold API keys. `claude` with argc 1 must decode to exactly argv.
  test("stops at argc, so the environment cannot leak in as argv[1]", () => {
    const buf = block(1, "/u/claude/versions/2.1.206", [
      "claude",
      "ANTHROPIC_API_KEY=sk-secret",
      "SHELL=/bin/zsh",
    ]);
    expect(parseProcArgs(buf, buf.length)).toEqual(["claude"]);
  });

  test("decodes a helper's argv up to argc", () => {
    const buf = block(
      3,
      "/home/u/.local/bin/claude",
      ["/home/u/.local/bin/claude", "daemon", "run", "PATH=/usr/bin"], // last is env
    );
    expect(parseProcArgs(buf, buf.length)).toEqual([
      "/home/u/.local/bin/claude",
      "daemon",
      "run",
    ]);
    // and the whole point: it reads as the daemon, not as a session
    expect(parseCommand(parseProcArgs(buf, buf.length))).toEqual({
      name: "claude",
      sub: "daemon",
    });
  });

  // a truncated block only ever costs trailing argv entries; argv[0] and argv[1]
  // — the two fields anything here depends on — sit within the first bytes
  test("survives a block truncated short of argc entries", () => {
    const buf = block(5, "/bin/claude", ["claude bg-spare", "--bg-spare"]);
    expect(parseProcArgs(buf, buf.length)).toEqual([
      "claude bg-spare",
      "--bg-spare",
    ]);
  });

  test("returns nothing for a malformed or empty block", () => {
    expect(parseProcArgs(new Uint8Array(0), 0)).toEqual([]); // no argc word
    expect(parseProcArgs(new Uint8Array(2), 2)).toEqual([]); // short of an i32
    expect(parseProcArgs(block(0, "/bin/claude", ["claude"]), 32)).toEqual([]); // argc 0
    const noNul = new Uint8Array(8); // an argc word and no NUL anywhere after it
    new DataView(noNul.buffer).setInt32(0, 1, true);
    noNul.set([0x61, 0x62, 0x63, 0x64], 4);
    expect(parseProcArgs(noNul, noNul.length)).toEqual([]);
  });

  // The source reuses one buffer across every pid, so what a shorter block does
  // not overwrite is the PREVIOUS process's block — including its environment.
  // Only the length sysctl reported bounds the fresh block; the buffer's own
  // capacity would read the last process's leftovers back out as this one's argv.
  test("honours the reported length over the reused buffer's leftovers", () => {
    const stale = block(4, "/a/long/previous/executable/path", [
      "previous",
      "ANTHROPIC_API_KEY=sk-leak",
      "and",
      "more",
    ]);
    const fresh = block(4, "/bin/claude", ["claude", "daemon"]); // argc > fields
    const reused = new Uint8Array(stale.length);
    reused.set(stale);
    reused.set(fresh); // the fresh block only covers part of it

    expect(parseProcArgs(reused, fresh.length)).toEqual(["claude", "daemon"]);
  });
});
