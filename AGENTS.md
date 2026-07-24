# AGENTS.md

Guidance for AI agents and contributors working on **cctop**, an interactive
`top`-style TUI for monitoring running Claude Code sessions.

## What this is

A single Bun/TypeScript program that lists every running Claude Code session
with process stats, busy/idle state, context size, model, host app, project,
branch, last prompt, a tree of sub-processes, and live sub-agents. On a TTY it's
an interactive TUI; piped or with `--once` it prints one plain-text frame and
exits, while `--json` prints one JSON snapshot and exits.

- **Runtime:** Bun (TypeScript run directly, no build step for dev).
- **Platforms:** macOS and Linux only (process table is read via macOS
  `libproc` FFI or Linux `/proc`).
- **Read-only, with deliberate exceptions.** In its monitoring mode cctop spawns
  no processes and never mutates any session, registry, or transcript. Its only
  writes are its own files under `~/.claude/cctop/`: the usage cache
  (`usage.json`, only under `--capture-usage`) and the persisted TUI preferences
  (`settings.json`, the refresh interval, sort mode, and notifications toggle,
  written only when the user changes them); the only thing it ever does to
  another process is send a signal, and only on an explicit user action (`x` →
  SIGTERM a session; `f` → SIGTERM a session's orphaned dev-server processes to
  free their ports). Preserve this property. Separate from all of that is one
  explicit, opt-in mode: the `cctop upgrade` subcommand (`src/upgrade.ts`)
  reaches the network and replaces cctop's own binary. It never runs from the
  refresh loop — the monitor path never even imports it — so everything that
  isn't `cctop upgrade` stays read-only. It is also the only thing that touches
  the network at all: the monitor makes no network calls, a property
  `docs/usage-limits.md` already relies on ("cctop is read-only: it reads
  `~/.claude` and the process table, and makes no network calls") and the reason
  usage limits arrive through a status-line hook instead of an API call. The
  TUI's "restart to run the new version" notice preserves that: it stats its own
  binary (`src/binary.ts`) to see the file was swapped underneath it, rather
  than asking GitHub whether a release exists. Polling from the refresh loop
  would break it.
- **Zero runtime dependencies.** cctop imports only Bun and OS built-ins
  (`bun:ffi`, `node:fs`, …); `package.json` has no `dependencies` field (the
  devDependencies are just Biome/tsc/types). Do not add npm packages — keep it
  dependency-free.

## Bun docs MCP server

This repo ships a project-scoped MCP server in `.mcp.json`.
Use the `bun-docs` MCP to look up Bun APIs and behavior instead of guessing.
It exposes `search_bun` (semantic search) and
`query_docs_filesystem_bun` (`rg`/`cat`/`head` over the docs).

## Commands

Use the Makefile — each target runs the `package.json` script of the same name,
so `make <x>` and `bun run <x>` are interchangeable. (The one exception is
`make prep-release`, Make-only release tooling. `install-bin` is named to match
its script: a script plainly named `install` would fire on `bun install`.)

```sh
make start      # run the TUI (make start ARGS="flux" to pass a filter)
make dev        # run with --watch live reload
make lint       # bun biome check --write . && bun tsc --noEmit  (format + lint + types)
make test       # bun test (the unit suite under test/)
make build      # compile a standalone binary into bin/
make clean      # remove bin/ and stray .bun-build files
make install-bin # compile + install onto PATH (override PREFIX=...)
```

**Always run `make lint` before finishing a change** (it formats, lints, and
type-checks; it exits non-zero on any unfixable issue) — and **`make test`** when
you touch the collectors or renderers. `make lint` does *not* run the tests.

## Layout

```
cctop.ts        entry: CLI arg parsing, the `upgrade` subcommand dispatch, the
                non-interactive paths (--once/--json/-h/-v), dispatch to runApp();
                VERSION derived from package.json
src/app.ts      interactive runtime: runApp(). State, raw-mode input loop,
                draw(), windowGroups(), the quit action
src/render.ts   pure renderers over rows: buildFrame() (summary/header/groups),
                renderDetail(), rowKey(); the column table definition lives here
src/history.ts  pure renderer for the history dashboard (the `h` view): a
                per-day activity bar chart + compact composition text;
                renderHistory() over the aggregated History
src/format.ts   formatting + ANSI helpers (visLen/pad/colors/formatMem/...)
src/notify.ts   "needs you" notifications: pure busy→idle transition tracking
                (finishedSessions) + the BEL/OSC 9 sequence (notifySeq) the
                TUI writes when a session flips to waiting for input
src/upgrade.ts  `cctop upgrade`: the self-updater — resolves the latest release,
                verifies its checksum, and atomically swaps the standalone binary
                (the one place cctop hits the network / rewrites its own binary)
src/binary.ts   facts about the file cctop runs from: isCompiledBinary() and the
                inode+mtime+size stamp the TUI watches to notice its binary was
                swapped ("restart to run the new version"). Local stats only —
                safe for the monitor to import, unlike upgrade.ts
src/proc.ts     process-table facade: picks the platform impl at startup and
                re-exports listAllProcesses(), cwdOf(), netCounters(), parseProcNetDev()
src/proc/       per-platform sources behind that facade: darwin.ts (libproc FFI),
                linux.ts (/proc); plus the pure parsers they feed, each unit
                tested on its own — cmdline.ts (argv → program name + subcommand,
                shared by both), netdev.ts (/proc/net/dev), nettcp.ts
                (/proc/net/tcp); types.ts (Proc/IfCounters/ProcSource)
src/collect.ts  orchestrator: correlates the process table + session registry +
                transcripts into Instance[]; exports collectRows(filter), matchRow()
src/collect/    one collector per data source: sessions, usage, transcript,
                subagents, process-tree (HOST + sub-process tree), network,
                orphans (leftover dev-server ports), history (full-scan
                aggregator for the `h` view), settings (persisted TUI
                preferences); plus entry/types/paths leaf helpers shared
                between them
install.sh      release-binary installer served from `main` (curl … | sh):
                downloads + checksum-verifies the latest release for the host
                OS/arch. Asset names mirror .github/workflows/release.yml — the
                same names src/upgrade.ts consumes; honors PREFIX/CCTOP_VERSION/
                CCTOP_REPO
```

Data flow: `proc.ts` + the session registry + transcripts → `collect.ts`
assembles `Instance[]` → `render.ts` turns rows into ANSI lines → `cctop.ts` prints
them once, or `app.ts` drives them as a live, navigable TUI.

Data sources, all read-only: the OS process table (libproc/`/proc`), and — under
`~/.claude` — the per-pid session registry `sessions/<pid>.json`, each session's
transcript `projects/<dir>/<id>.jsonl` (tail only, cached by mtime), and the
sub-agent transcripts under `<id>/subagents/`. The only files cctop *writes* are
its own usage cache `~/.claude/cctop/usage.json` (only under `--capture-usage`)
and its preferences `~/.claude/cctop/settings.json` (refresh interval + sort
mode + notifications toggle; written when an explicit `--watch` differs from
the persisted value and when `s` cycles the sort or `n` toggles notifications).

The history view (`h`, TUI-only) is the one place that full-scans *every*
transcript under `projects/` — session files and the `<id>/subagents/` tree
alike — rather than tailing the live ones (`collect/history.ts`); it rolls every
assistant turn into per-day token buckets, model/tool/project tallies, and a
per-session list (sub-agent transcripts fold onto their session via the shared
`<id>`), caches each file's contribution in memory (keyed by mtime+size, no disk
write — the read-only contract holds). Sub-agent turns (which are `isSidechain`)
count toward tokens/turns but not the session tally; session files skip their own
inline sidechain turns to avoid double counting. The view has two tabs (`↹`):
Sessions (the recent-session table) and Stats (token/model/tool/project
composition). The scan is fired on open and on `r` (rescan), never on the
refresh timer.

Two cross-cutting rules worth knowing before you read the code. A Claude session
spawned by another Claude (a background job or sub-session) gets its own
top-level row rather than nesting as a sub-process, and its `HOST` reads `claude`
(the parent). Live sub-agents (`Task`/`Workflow`) run in-process, so they never
hit the process table at all — they come from the `subagents/` transcripts
(`collect/subagents.ts`). The rest — how the `HOST` column walks process ancestry
past wrapping shells, and how the sub-process tree is built — is documented at
the source in `collect/process-tree.ts` (`hostApp`, `HOST_SKIP`, `isClaudeProc`).

## Critical gotchas — read before editing

1. **For the `~/.claude` data (registry, transcripts, usage), file *contents* go
   through `Bun.file` async (`.json()`, `.slice().bytes()`, `Bun.write()`);
   `node:fs` is for directory and metadata ops only (`readdirSync`/`statSync`/
   `mkdirSync`/`renameSync`).** The async reads are deliberate: `readSessions`
   reads the registry with `Promise.all`, and `collectRows` overlaps every
   session's transcript read the same way, so the whole scan runs concurrently.
   Keep it that way. The `node:fs` calls there (directory listing, mtime/
   birthtime, and the `--capture-usage` mkdir + atomic temp-file rename) stay
   synchronous — they have no `Bun.file` equivalent. **The platform `/proc`
   reader is the exception:** `src/proc/linux.ts` reads `/proc` *contents*
   synchronously via `readFileSync`/`readlinkSync` — procfs has no `Bun.file`
   equivalent and the process table is gathered synchronously anyway. That's
   intentional; don't "fix" it to async.

2. **Non-interactive parity is a contract.** `--once` and piped output
   (`isTTY` false) must keep producing a single plain-text frame and exit, and
   `--json` a single JSON snapshot, so `cctop | grep` and `cctop --json | jq`
   work. Only an interactive TTY runs `runApp()`. Don't move TUI-only escape
   sequences into the shared path.

3. **stdin delivers batches.** A single `data` event can carry several
   keypresses (fast typing, or input buffered during startup) and multi-byte
   escape sequences. `app.ts` `parseKeys()` splits a chunk into individual logical
   keys (keeping CSI/SS3 sequences whole). Route all key handling through it;
   never treat a chunk as one key. Note the PTY translates Enter `\r`→`\n`.

4. **Selection is tracked by a stable key, not a row index.** Rows re-sort every
   refresh, so the cursor is keyed on `rowKey(r)` = `` sessionId ?? `pid:${pid}` ``
   (`reconcile()` clamps when a session disappears). Keep this invariant.

5. **`bun build --compile` leaks a `.bun-build` temp file** (upstream bug
   oven-sh/bun#14020). The `build` script removes it (`rm -f .*.bun-build`) and
   it's gitignored. Keep that cleanup if you touch the build command.

6. **Actions are guarded.** Only act on real session rows (they have a pid);
   never sub-process/sub-agent rows. `process.kill` errors (ESRCH/EPERM) must go
   to the status line, never crash. Quitting (`x`) and freeing orphan ports
   (`f`, detail view) are both confirm-gated, and both re-collect before
   signalling so a recycled pid is never hit — `f` signals the freshly
   re-validated orphan pids, not the ones captured when the confirm opened.

7. **The session registry has no heartbeat.** `sessions/<pid>.json` is rewritten
   only when `status` flips, so `statusUpdatedAt` is the *exact* instant a
   session stopped working — which is the instant Claude Code rings the terminal
   bell. That is the whole basis of the `○` marker (`bellTime()` in
   `collect/sessions.ts`, `BELL_MS` + `isRinging()` in `render.ts`): it is
   derived, not recorded, so it survives a cctop restart and needs nothing
   dismissed. The row glyph decays after `BELL_MS`; the summary's `Bell:` line
   does not — it names the most recent `bellAt` for as long as that session is
   still waiting, and hands off to the next one when the session goes busy (which
   clears its `bellAt`). **The trap:** a session *also* writes `status: "idle"` ~100ms after
   `startedAt`, before it has run a turn and without ringing anything, so
   `bellTime()` ignores a flip landing inside a startup grace. Drop that guard
   and every freshly launched session rings for 30s. The bell glyph (`BELL` in
   `format.ts`) is a hollow `○` — single-width like the filled `●` it replaces
   (gutter alignment is automatic) and a plain geometric glyph, so it honors the
   SGR and renders red (an emoji would ignore the color and vary in width). It
   deliberately shares its shape with `renderDetail`'s dim `○` ended-session
   marker; color separates them (red = rang and live, dim = exited) and they
   never share a gutter.

## Conventions

- **Bun-only toolchain.** Bun is assumed to be the *only* runtime present — no Node.
- **Style is enforced by Biome** (`biome.json`): 2-space indent, double quotes,
  semicolons, trailing commas, ~80 col. Three rules are intentionally off —
  `noExplicitAny` (FFI/JSON parsing), `noControlCharactersInRegex` (the ANSI
  `\x1b` regex), `noNonNullAssertion`.
- **Types** are checked by `bun tsc --noEmit` (part of `make lint`). Keep it green.
- **Comments explain *why*, not *what*** — match the existing density. The FFI
  struct offsets and the sync-I/O rationale are load-bearing comments; keep them.
- **Version is single-sourced** in `package.json`; `cctop.ts` derives
  `VERSION = `v${pkg.version}``. Bump via `bun pm version` (no `v` in the field).
- Keep `render.ts` pure (rows → strings). Interactive state, scrolling, and
  selection live in `app.ts`.

## Verifying changes

- **Run the unit suite:** `make test` (or `bun test`). It covers the
  transcript/registry/usage parsers and the renderers (`test/*.test.ts`, via the
  `__test` exports in `collect.ts`); `make lint` does not run it. Run it whenever
  you touch the collectors or renderers.
- **Non-interactive / regressions:** `bun cctop.ts --once`, `--json`,
  `bun cctop.ts | cat` (single frame), `-h`, `-v`.
- **The TUI needs a real terminal** (it requires `isTTY`; piping disables it).
  Drive it with **tmux**: it provides a real pty, `send-keys` reliably reaches
  Bun's raw-mode stdin, and `capture-pane -p` prints the *rendered* screen (after
  all cursor moves) — so you can both see and test the UI. Recipe:

  ```sh
  tmux new-session -d -x 200 -y 50 -s cctop "bun cctop.ts"  # fixed size = stable layout
  sleep 4                                                   # let the first frame draw
  tmux send-keys -t cctop Enter                             # open detail; Escape backs out
  sleep 1
  tmux capture-pane -p -t cctop                             # print the on-screen state
  tmux send-keys -t cctop q                                 # q exits (not Ctrl-C)
  tmux kill-server                                          # always clean up
  ```

  Use `send-keys` names for special keys (`Enter`, `Escape`, `Up`/`Down`) and
  literal chars for the rest (`j`, `/`, `s`, `x`). Re-`capture-pane` after each
  key to assert on the new frame. (`expect` is unreliable here — it does not
  deliver keystrokes to Bun's raw-mode stdin in every environment, so a key like
  `q` is silently dropped; use tmux.)
- **Testing the quit action safely:** don't kill real sessions. Back a fake
  registry entry (`~/.claude/sessions/<pid>.json` with `startedAt` ≈ now) with a
  throwaway `sleep 600 &` process, filter to it (`tmux send-keys` `/`, type the
  filter, `Enter`), `x` → `y`, and confirm the sleep process got the signal.
  Clean up the json + process afterward.

## Spinning up live sub-agents on demand for testing

To exercise the sub-agent rows (the cyan `◆` lines with model, context, and a
ticking *last action*), park a handful of throwaway agents under the current
Claude Code session. Each one blocks on foreground shell loops, so it stays
alive and visibly active for ~10 minutes at near-zero token cost after startup,
and you can stop any of them on demand.

Launch **5 background agents on Haiku**, each with a name so they're easy to
tell apart in the tree and to stop individually — `alpha`, `bravo`, `charlie`,
`delta`, `echo`. Give each the same instruction (swap the name):

> You will make SEVEN Bash tool calls, ONE AT A TIME, in the **foreground** (do
> NOT set `run_in_background`), and nothing else. Don't touch any files. After
> each call returns, immediately make the next one. Each call (rounds 1–7) runs
> this with `timeout: 120000`, swapping the round number R:
> `for i in $(seq 1 90); do echo "alpha round R $i"; sleep 1; done`
> Each loop runs ~90 seconds — that's intended; wait for it, then fire the next
> round. After the 7th call returns, reply with the single word: done

Key points:

- **Several short calls, NOT one long one — this is load-bearing.** A sub-agent
  has no process of its own; cctop infers liveness purely from its transcript's
  mtime (`liveSubagents()` in `collect.ts`). A *single* 10-minute foreground
  call writes one turn and then goes silent on disk, so the row vanishes after
  `SUBAGENT_BUSY_MS` (3 min) even though the loop is still running. Each *new*
  Bash call writes a fresh `tool_use` turn, bumping the mtime back inside the
  window — so ~90s rounds (well under 3 min) keep the `◆` row visible the whole
  time, and you watch the label tick `round 1` → `round 2` → …
- **The loop is load-bearing too.** A bare `sleep 90` is hard-blocked by the
  harness (a standalone leading sleep is refused even with the sandbox off). A
  `sleep` *inside* a loop that does real work (`echo`) is allowed — that's what
  keeps the agent parked instead of exiting immediately. Don't "simplify" it
  back to a plain sleep.
- **Foreground, not background.** `run_in_background: true` makes the agent fire
  the command and exit right away (it won't stay visible). The agent must *block*
  on each call, so it runs in the foreground; the distinct echo per second drives
  the live last-action display. `120000` (2 min) comfortably covers a 90s loop.
- **Cost.** Each agent spends its ~12k-token startup plus a cheap Haiku turn per
  round (7 rounds), then ≈0 while parked inside each loop.
- **Stop them** with `TaskStop` by task id (all at once, or a subset by name);
  otherwise they exit themselves after the 7th round (~10–11 min).
