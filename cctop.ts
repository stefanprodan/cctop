#!/usr/bin/env bun

// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// cctop - an interactive top-style monitor for running Claude Code sessions:
// process stats (memory, CPU, uptime), busy/idle state, context size, model,
// the app hosting the session (terminal or IDE), project directory, git branch,
// and the last user prompt. Each session's sub-processes (the running tool
// command, MCP servers, LSPs) are listed as a tree beneath it, with their own
// memory and CPU; a tool's wrapping shell is skipped so the real command shows.
// Live sub-agents (Task / Workflow) appear as in-process rows. Useful when many
// sessions run at once in different shells and IDEs.
//
// Data sources, all local and read-only, no subprocesses:
//
//   1. The process table: macOS libproc via bun:ffi, or /proc on Linux.
//   2. ~/.claude/sessions/<pid>.json: the per-process session registry.
//   3. The session transcript ~/.claude/projects/<dir>/<id>.jsonl: only the
//      tail is read, for the model, context tokens, git branch, last prompt.
//
// On an interactive terminal it runs as a live TUI with keyboard navigation,
// a per-session detail view, and actions (quit a session); when piped,
// redirected, or run with --once it prints a single frame and exits.

import pkg from "./package.json";
import { runApp } from "./src/app.ts";
import {
  captureUsage,
  collectRows,
  readSettings,
  readUsage,
  saveSettings,
} from "./src/collect.ts";
import { sanitizeDisplay } from "./src/format.ts";
import { buildFrame } from "./src/render.ts";

export const VERSION = `v${pkg.version}`;

const HELP = `\x1b[1mcctop\x1b[0m - monitor running Claude Code sessions

\x1b[1mUsage:\x1b[0m
  cctop [filter] [options]
  cctop upgrade [--check]

\x1b[1mArguments:\x1b[0m
  filter                 only show sessions whose project, host, branch,
                         model, or session id contains this

\x1b[1mCommands:\x1b[0m
  upgrade [--check]      update the standalone binary to the latest release;
                         --check only reports whether a newer version exists

\x1b[1mOptions:\x1b[0m
  -w, --watch[=seconds]  set the refresh interval (default: 1s, min 0.25s);
                         remembered for future runs, like the sort mode
  --once                 render once and exit (default when piped)
  --json                 print full session details as JSON
  --capture-usage        save rate-limit usage from a status-line payload on
                         stdin (see docs/usage-limits.md); prints nothing
  -v, --version          show version
  -h, --help             show this help

Runs as an interactive TUI on a terminal; prints once when piped or --once.

\x1b[1mKeys (interactive):\x1b[0m
  ↑/k ↓/j  move      enter  detail     /  filter    s  sort
  x        quit session (confirm)      n  notify    ?  help    q  quit cctop

\x1b[1mExamples:\x1b[0m
  cctop                  # live TUI
  cctop flux-operator    # only sessions matching "flux-operator"
  cctop --watch=0.5      # refresh twice a second
  cctop --once           # single frame
  cctop --json           # machine-readable snapshot`;

function fail(message: string): never {
  console.error(`error: ${message}\n\n${HELP}`);
  process.exit(1);
}

let filter: string | null = null;
// Refresh interval: an explicit --watch=N, else the value persisted from a
// previous run (settings.json), else 1s. null = not given on the CLI.
let watchSecs: number | null = null;
const DEFAULT_WATCH_SECS = 1;
// Below ~0.25s the %CPU sampling window (200ms) collapses to the lifetime
// average and the process-table walk's duty cycle climbs for no real gain.
const MIN_WATCH_SECS = 0.25;
let once = false; // force a single frame and exit
let asJson = false;
let capture = false; // status-line tap: persist usage from stdin, then exit
const args = Bun.argv.slice(2);

// The self-updater is a separate, explicit mode: the only path that reaches the
// network and rewrites cctop's own binary (the monitor stays read-only and
// offline). Dispatch it before the flag parser so `cctop upgrade` never falls
// through to the filter positional, and load it lazily so the monitor never
// even imports the network/fs-mutating code.
if (args[0] === "upgrade") {
  const rest = args.slice(1);
  const unknown = rest.find((a) => a !== "--check");
  if (unknown) fail(`unknown argument for upgrade: ${unknown}`);
  const { runUpgrade } = await import("./src/upgrade.ts");
  process.exit(await runUpgrade(VERSION, { check: rest.includes("--check") }));
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-h" || arg === "--help") {
    console.log(HELP);
    process.exit(0);
  } else if (arg === "-v" || arg === "--version") {
    console.log(VERSION);
    process.exit(0);
  } else if (arg === "--once") {
    once = true;
  } else if (arg === "-w" || arg === "--watch") {
    // bare flag = explicitly ask for the default, overriding a persisted value
    watchSecs = DEFAULT_WATCH_SECS;
  } else if (arg.startsWith("--watch=")) {
    watchSecs = Number(arg.slice(8));
    if (!(watchSecs >= MIN_WATCH_SECS))
      fail(
        `invalid watch interval: ${arg.slice(8)} (minimum ${MIN_WATCH_SECS}s)`,
      );
  } else if (arg === "--json") {
    asJson = true;
  } else if (arg === "--capture-usage") {
    capture = true;
  } else if (arg.startsWith("-")) {
    fail(`unknown option: ${arg}`);
  } else if (filter === null) {
    filter = arg.toLowerCase();
  } else {
    fail(`unexpected argument: ${arg} (filter is already "${filter}")`);
  }
}

// Status-line tap: read the JSON Claude Code pipes to a status-line command on
// stdin, persist its rate limits for the summary, then exit. Prints nothing (a
// status line's stdout becomes its rendered text) and never fails the caller.
if (capture) {
  if (process.stdin.isTTY) {
    // Run by hand on a terminal rather than wired into a status-line command:
    // there is no payload on stdin, so nothing is captured and the summary's
    // Limits: line stays hidden. Silently exiting here reads as "broken", so
    // explain how the tap is meant to be hooked up. (Warn on stderr only — the
    // hook itself never hits this branch, so the silent-stdout contract holds.)
    console.error(
      "cctop --capture-usage: nothing captured — no status-line payload on stdin.\n" +
        "This flag reads the JSON Claude Code pipes to a status-line command and is\n" +
        "meant to be wired into one, not run directly. See the setup at\n" +
        "https://github.com/stefanprodan/cctop/blob/main/docs/usage-limits.md —\n" +
        "without it cctop simply omits the Limits: line.",
    );
    process.exit(0);
  }
  await captureUsage(await Bun.stdin.text());
  process.exit(0);
}

// Live only on an interactive terminal; piping, redirecting, --once, or
// --json all produce a single frame so scripts and `| grep` keep working.
const live =
  !once && !asJson && Boolean(process.stdout.isTTY && process.stdin.isTTY);

if (asJson) {
  const rows = (await collectRows(filter)).map(({ lastMs, ...row }) => row);
  console.log(JSON.stringify(rows, null, 2));
} else if (!live) {
  const rows = await collectRows(filter);
  if (rows.length === 0) {
    console.log(
      filter
        ? `no Claude Code sessions match "${sanitizeDisplay(filter)}"`
        : "no Claude Code sessions running",
    );
  } else {
    // the persisted column set applies to single-frame output too — the point
    // is making the table fit, and that holds for `cctop | cat` as much as the
    // TUI (--json is untouched: it always carries every field)
    const [usage, settings] = await Promise.all([readUsage(), readSettings()]);
    const frame = buildFrame(
      rows,
      process.stdout.columns ?? 200,
      usage,
      null,
      settings.columns,
    );
    console.log(
      [
        ...frame.summary,
        "",
        frame.header,
        ...frame.groups.flatMap((g) => g.lines),
      ].join("\n"),
    );
  }
} else {
  // Preferences persisted by previous runs: an explicit --watch wins over the
  // persisted interval (and updates it); the persisted value is re-validated
  // against the same floor as the flag in case the file was hand-edited.
  const settings = await readSettings();
  const persisted =
    settings.watchSecs != null && settings.watchSecs >= MIN_WATCH_SECS
      ? settings.watchSecs
      : null;
  if (watchSecs != null && watchSecs !== persisted)
    await saveSettings({ watchSecs });
  await runApp({
    filter,
    watchSecs: watchSecs ?? persisted ?? DEFAULT_WATCH_SECS,
    sort: settings.sort,
    notify: settings.notify ?? false,
    columns: settings.columns,
    version: VERSION,
  });
}
