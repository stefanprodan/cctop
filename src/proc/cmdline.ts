// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// argv reduced to the two fields the collectors identify a process by: the
// program name and its subcommand. Shared by both platform sources (Linux reads
// argv from /proc/<pid>/cmdline, macOS from KERN_PROCARGS2) and pure, so it is
// unit tested directly.

export interface Command {
  // the leading token of a rewritten process title, else argv[0]'s basename;
  // null when argv is empty
  name: string | null;
  sub: string | null; // its subcommand, when it has one
}

// macOS hands back one raw block per process (KERN_PROCARGS2): argc as a
// little-endian i32, the executable's path, a run of NUL padding, then argv —
// and immediately after argv, the environment.
//
// argc is what bounds argv, and it has to: without it, argv[1] of a bare
// `claude` would read as that process's first environment variable, which is
// both wrong and a way to pull another process's secrets into a row. `len` is
// what sysctl reported it actually wrote, so a truncated block only ever costs
// trailing argv entries.
//
// Pure, and separate from the FFI closure that fills the buffer, so the decode
// every macOS row depends on is unit tested rather than taken on trust.
export function parseProcArgs(buf: Uint8Array, len: number): string[] {
  if (len < 4) return [];
  const argc = new DataView(buf.buffer, buf.byteOffset, 4).getInt32(0, true);
  if (argc <= 0) return [];
  // latin1: each byte maps 1:1 to a char, which is all we need to find the
  // NUL-separated fields (Buffer avoids TextDecoder's stricter typing)
  const raw = Buffer.from(buf.slice(4, len)).toString("latin1");
  const start = raw.indexOf("\0"); // end of the exec path
  if (start < 0) return [];
  const fields = raw.slice(start).replace(/^\0+/, "").split("\0");
  // every field is NUL-terminated, so the split leaves a trailing empty one;
  // it would show up as a phantom argv entry when the block ends before argc
  if (fields.at(-1) === "") fields.pop();
  return fields.slice(0, argc);
}

// argv[0] is normally the executable's path, but a process may rewrite its
// title — and Claude Code's background helpers do, in a way that hides what they
// are. `claude daemon run` passes its subcommand as argv[1], while the pty and
// spare hosts fold theirs into the title: argv[0] is the whole string "claude
// bg-pty-host" and argv[1] is a flag. Both spellings have to surface the same
// subcommand, or the helpers read as sessions (see isClaudeProc).
//
// A rewritten title is told from a path by the slash: an executable path that
// happens to contain a space ("/Applications/Visual Studio Code.app/…") still
// has one in its first token, a title does not.
export function parseCommand(argv: string[]): Command {
  const argv0 = argv[0] ?? "";
  // a title's first token is a bare program name; a path's holds a slash
  const titled = /^[^/ ]+ /.test(argv0);
  const [cmd = "", next] = titled ? argv0.split(" ") : [argv0, argv[1]];
  // a flag is not a subcommand, and neither is a path (`claude /tmp/prompt.md`)
  const sub =
    next && !next.startsWith("-") && !next.startsWith("/") ? next : null;
  // a title's program name often carries a trailing colon ("tmux: server",
  // "nginx: master process …") — it is punctuation, not part of the name
  return { name: cmd.split("/").pop()?.replace(/:$/, "") || null, sub };
}
