// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Interactive TUI runtime: an event-driven loop fed by a refresh timer and
// raw-mode keyboard input. Holds the app state (selection, mode, filter,
// sort), windows the table to the terminal, draws the detail/help/confirm
// overlays, and runs process actions (quit a session).

import { selfStamp } from "./binary.ts";
import {
  collectHistory,
  collectRows,
  type History,
  type Instance,
  matchRow,
  type NetRate,
  netThroughput,
  readUsage,
  saveSettings,
  type Usage,
} from "./collect.ts";
import {
  BLUE_BG,
  BOLD,
  CYAN,
  clockTime,
  DIM,
  GREEN,
  RED,
  RESET,
  sanitizeDisplay,
  shortProject,
  truncate,
  truncateStyled,
  visLen,
  YELLOW,
} from "./format.ts";
import { type HistoryTab, renderHistory } from "./history.ts";
import { finishedSessions, notifySeq } from "./notify.ts";
import {
  buildFrame,
  type Group,
  newestBell,
  renderDetail,
  resolveDetail,
  rowKey,
} from "./render.ts";

type Mode = "list" | "detail" | "filter" | "confirm" | "help" | "history";

// A pending destructive action awaiting y/n. "quit" signals the session pid;
// "free" signals the session's orphaned dev-server processes to release their
// ports. Both are SIGTERM and both are confirm-gated.
type ConfirmAction =
  | { kind: "quit"; row: Instance; signal: "SIGTERM" }
  | { kind: "free"; row: Instance };

interface State {
  rows: Instance[]; // all sessions, unfiltered, sorted by collectRows default
  usage: Usage | null; // account-wide rate limits, or null when not captured
  net: NetRate | null; // machine-wide network throughput, sampled per refresh
  mode: Mode;
  selectedKey: string | null;
  selectedIndex: number; // last known index, for clamping when a row vanishes
  filter: string | null; // active filter (lowercased)
  filterInput: string; // edit buffer while in filter mode
  sortIndex: number;
  scrollTop: number; // first visible group index (list)
  detailScroll: number; // first visible line (detail)
  detailRow: Instance | null; // last-known snapshot of the session in detail view
  detailEnded: boolean; // that session has disappeared from the live set
  history: History | null; // aggregated history, scanned on first open then cached
  historyLoading: boolean; // a full-scan is in flight (first open or rescan)
  historyScroll: number; // first visible line (history)
  historyTab: HistoryTab; // active history tab (sessions | stats)
  message: string | null;
  messageColor: string;
  messageUntil: number;
  confirm: ConfirmAction | null;
  notify: boolean; // ring (BEL + OSC 9) when a busy session needs input
}

interface SortMode {
  name: string;
  cmp: (a: Instance, b: Instance) => number;
}

const SORTS: SortMode[] = [
  {
    name: "default",
    cmp: (a, b) =>
      (a.state === "busy" ? 0 : 1) - (b.state === "busy" ? 0 : 1) ||
      b.lastMs - a.lastMs ||
      a.pid - b.pid,
  },
  { name: "cpu", cmp: (a, b) => b.cpu - a.cpu || a.pid - b.pid },
  { name: "mem", cmp: (a, b) => b.mem - a.mem || a.pid - b.pid },
  {
    name: "ctx",
    cmp: (a, b) =>
      (b.contextTokens ?? 0) - (a.contextTokens ?? 0) || a.pid - b.pid,
  },
  { name: "pid", cmp: (a, b) => a.pid - b.pid },
];

// A solid blue background cell, not a ▌ half-block glyph: block glyphs leave
// vertical gaps in terminals that add line spacing (e.g. JetBrains/GoLand),
// whereas a background color fills the leading, so the bar stays continuous
// everywhere. Blue keeps it distinct from the green/red dots and cyan agents.
const SELBAR = `${BLUE_BG} ${RESET} `; // left bar marking the selected group
const GUTTER = "  "; // matching width for unselected rows + header

export interface AppOptions {
  filter: string | null;
  watchSecs: number;
  sort: string | null; // persisted sort-mode name; unknown/null = default
  notify: boolean; // persisted notifications toggle (default off)
  columns: string[] | null; // persisted visible-column set; null = default
  version: string;
}

export async function runApp(opts: AppOptions): Promise<void> {
  const out = process.stdout;
  const state: State = {
    rows: [],
    usage: await readUsage(),
    net: null, // first sample has no baseline; fills in on the next refresh
    mode: "list",
    selectedKey: null,
    selectedIndex: 0,
    filter: opts.filter,
    filterInput: "",
    // restore the persisted sort; a name from a newer/older version that no
    // longer exists falls back to default (findIndex -1 → 0)
    sortIndex: Math.max(
      0,
      SORTS.findIndex((s) => s.name === opts.sort),
    ),
    scrollTop: 0,
    detailScroll: 0,
    detailRow: null,
    detailEnded: false,
    history: null,
    historyLoading: false,
    historyScroll: 0,
    historyTab: "sessions",
    message: null,
    messageColor: DIM,
    messageUntil: 0,
    confirm: null,
    notify: opts.notify,
  };
  // rowKey → when the session was first observed busy (see notify.ts)
  const busySince = new Map<string, number>();

  // --- terminal setup / teardown ------------------------------------------
  // Alt screen (like top), hidden cursor, focus reporting off (we never read
  // those events; if the terminal has it on they leak as \x1b[I/\x1b[O).
  out.write("\x1b[?1004l\x1b[?1049h\x1b[?25l\x1b[H");
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      process.stdin.setRawMode?.(false);
    } catch {}
    out.write("\x1b[?25h\x1b[?1049l\x1b[?1004l");
  };
  process.on("exit", restore);
  const quit = () => {
    restore();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);

  // --- selection helpers ---------------------------------------------------
  const activeFilter = () =>
    state.mode === "filter"
      ? state.filterInput.toLowerCase() || null
      : state.filter;

  const displayRows = (): Instance[] =>
    state.rows
      .filter((r) => matchRow(r, activeFilter()))
      .sort(SORTS[state.sortIndex].cmp);

  const selectedRow = (rows: Instance[]): Instance | null => {
    if (!rows.length) return null;
    const i = rows.findIndex((r) => rowKey(r) === state.selectedKey);
    return i >= 0
      ? rows[i]
      : rows[Math.min(state.selectedIndex, rows.length - 1)];
  };

  // The live row for the session open in detail, or null once it has ended (or a
  // recycled pid took its key). x/f target this, so they never hit the wrong
  // process. Resolved against the snapshot so resolveDetail's startSec check runs.
  const detailTarget = (): Instance | null => {
    const { row, ended } = resolveDetail(
      state.rows,
      state.selectedKey,
      state.detailRow,
    );
    return ended ? null : row;
  };

  // After data/filter/sort changes, keep the cursor on the same session if it
  // is still present; otherwise clamp to the nearest surviving index.
  const reconcile = (rows: Instance[]) => {
    if (!rows.length) {
      state.selectedKey = null;
      state.selectedIndex = 0;
      return;
    }
    let i = rows.findIndex((r) => rowKey(r) === state.selectedKey);
    if (i < 0) i = Math.min(state.selectedIndex, rows.length - 1);
    state.selectedIndex = i;
    state.selectedKey = rowKey(rows[i]);
  };

  const move = (delta: number) => {
    const rows = displayRows();
    if (!rows.length) return;
    let i = rows.findIndex((r) => rowKey(r) === state.selectedKey);
    if (i < 0) i = state.selectedIndex;
    i = Math.max(0, Math.min(rows.length - 1, i + delta));
    state.selectedIndex = i;
    state.selectedKey = rowKey(rows[i]);
  };

  const jump = (to: "top" | "bottom") => {
    const rows = displayRows();
    if (!rows.length) return;
    const i = to === "top" ? 0 : rows.length - 1;
    state.selectedIndex = i;
    state.selectedKey = rowKey(rows[i]);
  };

  const flash = (msg: string, color = DIM) => {
    state.message = msg;
    state.messageColor = color;
    state.messageUntil = Date.now() + 4000;
  };

  // --- self-upgrade notice -------------------------------------------------
  // `cctop upgrade` (or a re-run of install.sh) swaps the binary with rename(2):
  // the directory entry points at the new inode while this process keeps
  // executing the old one, so a TUI left running elsewhere silently stays on the
  // old version forever. Stamp the file at startup and watch for it to change.
  // Purely local (two stat calls, no network) — the read-only monitor contract
  // in AGENTS.md holds. Latched: say it once, not every refresh.
  const stampAtStart = selfStamp();
  let restartNoticed = false;
  const checkForRestart = () => {
    if (restartNoticed || !stampAtStart) return;
    const stamp = selfStamp();
    // null = the file vanished (uninstalled mid-run); unknown, not changed.
    if (!stamp || stamp === stampAtStart) return;
    restartNoticed = true;
    flash("cctop was updated on disk — restart to run the new version", YELLOW);
  };

  // --- data refresh --------------------------------------------------------
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      state.rows = await collectRows(null); // collect all; filter in-app
      state.usage = await readUsage(); // cheap single-file read; refresh alongside
      state.net = netThroughput(Date.now()); // delta vs the previous refresh
    } finally {
      refreshing = false;
    }
    checkForRestart();
    // Track busy→idle flips every refresh (so toggling notifications on never
    // fires for stale transitions), ring only when enabled. All sessions
    // count, not just filtered ones — the filter is a view concern.
    const finished = finishedSessions(busySince, state.rows, Date.now());
    if (state.notify && finished.length) out.write(notifySeq(finished));
    // listScreen re-validates the cursor (the only surface that shows it), so a
    // session ending while the user sits in detail or a confirm never moves the
    // pinned selection. Just repaint.
    draw();
  };

  // Full-scan every transcript and aggregate the history. Kept off the refresh
  // timer (it reads the whole corpus); fired on first open and on an explicit
  // rescan (r). The per-file cache in collectHistory makes a rescan cheap. The
  // previous result stays on screen while a rescan runs, so the view never
  // blanks. Read-only — nothing here writes to disk.
  let historyScanning = false;
  const loadHistory = async () => {
    if (historyScanning) return;
    // A rescan keeps the prior frame up (no centered "Scanning…" note), so flash
    // status in the footer to confirm it actually ran — the cached scan is fast
    // and the data may look unchanged.
    const rescan = state.history !== null;
    historyScanning = true;
    state.historyLoading = true;
    if (rescan) flash("rescanning transcripts…");
    draw();
    try {
      state.history = await collectHistory();
      if (rescan) flash(`history rescanned · ${clockTime()}`, GREEN);
    } catch (e: any) {
      flash(
        `could not scan history: ${sanitizeDisplay(e?.message ?? "failed")}`,
        RED,
      );
    } finally {
      historyScanning = false;
      state.historyLoading = false;
    }
    draw();
  };

  // --- actions -------------------------------------------------------------
  const sameSignalTarget = (a: Instance, b: Instance) =>
    a.pid === b.pid && rowKey(a) === rowKey(b) && a.startSec === b.startSec;

  const doQuit = async (action: Extract<ConfirmAction, { kind: "quit" }>) => {
    const { row, signal } = action;
    let rows: Instance[];
    try {
      rows = await collectRows(null);
    } catch (e: any) {
      flash(
        `could not refresh sessions: ${sanitizeDisplay(e?.message ?? "failed")}`,
        RED,
      );
      return;
    }
    state.rows = rows;
    const current = rows.find((r) => sameSignalTarget(r, row));
    if (!current) {
      const id = row.sessionId ? row.sessionId.slice(0, 8) : `pid ${row.pid}`;
      flash(`session ${sanitizeDisplay(id)} is no longer running`, YELLOW);
      return;
    }
    try {
      process.kill(current.pid, signal);
      flash(
        `sent ${signal} to ${current.pid} (${sanitizeDisplay(shortProject(current.project))})`,
        GREEN,
      );
    } catch (e: any) {
      const why =
        e?.code === "ESRCH"
          ? "already gone"
          : e?.code === "EPERM"
            ? "permission denied"
            : sanitizeDisplay(e?.message ?? "failed");
      flash(`could not signal ${current.pid}: ${why}`, RED);
    }
  };

  // Free a session's orphaned dev-server ports by SIGTERM-ing the processes
  // holding them. Re-collect first so we signal freshly re-validated orphan
  // pids (orphan detection re-runs every collect), never a stale or recycled
  // one captured when the confirm opened.
  const doFree = async (action: Extract<ConfirmAction, { kind: "free" }>) => {
    let rows: Instance[];
    try {
      rows = await collectRows(null);
    } catch (e: any) {
      flash(
        `could not refresh sessions: ${sanitizeDisplay(e?.message ?? "failed")}`,
        RED,
      );
      return;
    }
    state.rows = rows;
    const current = rows.find((r) => sameSignalTarget(r, action.row));
    const orphans = current?.orphanPorts ?? [];
    if (!orphans.length) {
      flash("no orphan ports left to free", YELLOW);
      return;
    }
    let freedPorts = 0;
    const failed: string[] = [];
    for (const o of orphans) {
      try {
        process.kill(o.pid, "SIGTERM");
        freedPorts += o.ports.length;
      } catch (e: any) {
        const why =
          e?.code === "ESRCH"
            ? "gone"
            : e?.code === "EPERM"
              ? "denied"
              : sanitizeDisplay(e?.code ?? "failed");
        failed.push(`${o.pid} ${why}`);
      }
    }
    const ports = (n: number) => `${n} orphan port${n === 1 ? "" : "s"}`;
    if (freedPorts && !failed.length)
      flash(`freed ${ports(freedPorts)} (SIGTERM)`, GREEN);
    else if (freedPorts)
      flash(
        `freed ${ports(freedPorts)}, ${failed.length} failed: ${failed.join(", ")}`,
        YELLOW,
      );
    else flash(`could not free orphan ports: ${failed.join(", ")}`, RED);
  };

  // --- input ---------------------------------------------------------------
  const onListKey = (k: string) => {
    switch (k) {
      case "up":
      case "k":
        move(-1);
        break;
      case "down":
      case "j":
        move(1);
        break;
      case "pageup":
        move(-10);
        break;
      case "pagedown":
        move(10);
        break;
      case "g":
      case "home":
        jump("top");
        break;
      case "G":
      case "end":
        jump("bottom");
        break;
      case "enter": {
        const row = selectedRow(displayRows());
        if (row) {
          state.mode = "detail";
          state.detailScroll = 0;
          state.detailRow = row;
          state.detailEnded = false;
        }
        break;
      }
      case "b": {
        // Jump to the session named on the summary's Bell: line — the last one
        // to ding. newestBell() is the same selector buildFrame uses for that
        // line, over the *displayed* rows, so the jump always lands on the row
        // the summary names and only ever on one the user can see.
        const rows = displayRows();
        const target = newestBell(rows);
        if (!target) {
          // yellow: the keypress had nothing to act on, matching x/f's no-op
          // feedback ("no orphan ports left to free")
          flash(
            state.rows.some((r) => r.bellAt != null)
              ? "the session that rang is hidden by the filter"
              : "no session is waiting on you",
            YELLOW,
          );
          break;
        }
        const key = rowKey(target);
        // already there (the common case — a ringing row sorts near the top):
        // acknowledge the keypress so it doesn't read as a dead key
        if (state.selectedKey === key)
          flash("already on the session that rang");
        state.selectedIndex = rows.indexOf(target);
        state.selectedKey = key;
        break;
      }
      case "/":
        state.mode = "filter";
        state.filterInput = state.filter ?? "";
        break;
      case "s":
        state.sortIndex = (state.sortIndex + 1) % SORTS.length;
        flash(`sort: ${SORTS[state.sortIndex].name}`);
        // remember across restarts; best-effort and off the draw path
        void saveSettings({ sort: SORTS[state.sortIndex].name });
        break;
      case "n":
        state.notify = !state.notify;
        flash(
          state.notify
            ? "notifications on: bell when a busy session needs input"
            : "notifications off",
        );
        void saveSettings({ notify: state.notify });
        break;
      case "x": {
        const row = selectedRow(displayRows());
        if (row) {
          state.confirm = { kind: "quit", row, signal: "SIGTERM" };
          state.mode = "confirm";
        }
        break;
      }
      case "h":
        state.mode = "history";
        state.historyScroll = 0;
        if (!state.history) void loadHistory(); // first open: scan; else reuse cache
        break;
      case "?":
        state.mode = "help";
        break;
      case "q":
        quit();
        return;
    }
    draw();
  };

  const onHistoryKey = (k: string) => {
    switch (k) {
      case "tab":
      case "left":
      case "right":
        // toggle Sessions <-> Stats; reset scroll so the new tab starts at top
        state.historyTab =
          state.historyTab === "sessions" ? "stats" : "sessions";
        state.historyScroll = 0;
        break;
      case "up":
      case "k":
        state.historyScroll = Math.max(0, state.historyScroll - 1);
        break;
      case "down":
      case "j":
        state.historyScroll += 1;
        break;
      case "pageup":
        state.historyScroll = Math.max(0, state.historyScroll - 10);
        break;
      case "pagedown":
        state.historyScroll += 10;
        break;
      case "g":
      case "home":
        state.historyScroll = 0;
        break;
      case "G":
      case "end":
        state.historyScroll = Number.MAX_SAFE_INTEGER; // clipLines clamps to end
        break;
      case "r":
        void loadHistory(); // rescan: re-reads only changed transcripts
        break;
      case "escape":
      case "q":
        state.mode = "list";
        break;
    }
    draw();
  };

  const onDetailKey = (k: string) => {
    switch (k) {
      case "up":
      case "k":
        state.detailScroll = Math.max(0, state.detailScroll - 1);
        break;
      case "down":
      case "j":
        state.detailScroll += 1;
        break;
      case "pageup":
        state.detailScroll = Math.max(0, state.detailScroll - 10);
        break;
      case "pagedown":
        state.detailScroll += 10;
        break;
      case "x": {
        const row = detailTarget();
        if (row) {
          state.confirm = { kind: "quit", row, signal: "SIGTERM" };
          state.mode = "confirm";
        } else {
          flash("session has ended");
        }
        break;
      }
      case "f": {
        // free the orphaned dev-server ports shown in this detail view
        const row = detailTarget();
        if (!row) {
          flash("session has ended");
        } else if (row.orphanPorts.length) {
          state.confirm = { kind: "free", row };
          state.mode = "confirm";
        } else {
          flash("no orphan ports to free");
        }
        break;
      }
      case "escape":
      case "q":
        state.mode = "list";
        break;
    }
    draw();
  };

  const onFilterKey = (k: string) => {
    if (k === "enter") {
      state.filter = state.filterInput.toLowerCase() || null;
      state.mode = "list";
    } else if (k === "escape") {
      state.filterInput = "";
      state.mode = "list";
    } else if (k === "backspace") {
      state.filterInput = state.filterInput.slice(0, -1);
    } else if (k.length === 1 && k >= " " && k !== "\x7f") {
      state.filterInput += k;
    }
    reconcile(displayRows());
    draw();
  };

  const onConfirmKey = async (k: string) => {
    if (k === "y" || k === "Y") {
      const action = state.confirm;
      state.confirm = null;
      // freeing leaves the session alive, so return to its detail view; a quit
      // removes it, so fall back to the list
      state.mode = action?.kind === "free" ? "detail" : "list";
      if (action?.kind === "quit") await doQuit(action);
      else if (action?.kind === "free") await doFree(action);
    } else if (k === "n" || k === "N" || k === "escape" || k === "q") {
      // back to wherever the confirm was raised from
      state.mode = state.confirm?.kind === "free" ? "detail" : "list";
      state.confirm = null;
    }
    draw();
  };

  const onHelpKey = (k: string) => {
    if (k === "escape" || k === "q" || k === "?") state.mode = "list";
    draw();
  };

  // Map a recognized escape sequence to a logical key name.
  const seqName = (s: string): string => {
    switch (s) {
      case "\x1b[A":
      case "\x1bOA":
        return "up";
      case "\x1b[B":
      case "\x1bOB":
        return "down";
      case "\x1b[C":
      case "\x1bOC":
        return "right";
      case "\x1b[D":
      case "\x1bOD":
        return "left";
      case "\x1b[5~":
        return "pageup";
      case "\x1b[6~":
        return "pagedown";
      case "\x1b[H":
      case "\x1b[1~":
        return "home";
      case "\x1b[F":
      case "\x1b[4~":
        return "end";
      default:
        return ""; // unknown sequence: ignore
    }
  };

  const charName = (c: string): string => {
    switch (c) {
      case "\r":
      case "\n":
        return "enter";
      case "\x7f":
      case "\b":
        return "backspace";
      case "\x1b":
        return "escape";
      case "\t":
        return "tab";
      case "\x03":
        return "ctrl-c";
      default:
        return c;
    }
  };

  // A single read can carry several keypresses (fast typing, or input buffered
  // while the first frame renders) and/or multi-byte escape sequences. Split a
  // chunk into individual logical keys, keeping CSI/SS3 sequences whole.
  const parseKeys = (data: string): string[] => {
    const keys: string[] = [];
    let i = 0;
    while (i < data.length) {
      const c = data[i];
      if (c === "\x1b" && i + 1 < data.length) {
        const next = data[i + 1];
        if (next === "O" && i + 2 < data.length) {
          keys.push(seqName(data.slice(i, i + 3)) || "");
          i += 3;
          continue;
        }
        if (next === "[") {
          let j = i + 2;
          while (j < data.length && !(data[j] >= "@" && data[j] <= "~")) j++;
          keys.push(seqName(data.slice(i, j + 1)) || "");
          i = j + 1;
          continue;
        }
      }
      keys.push(charName(c));
      i += 1;
    }
    return keys.filter(Boolean);
  };

  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  // Synchronized Output (DEC private mode 2026): when supported, wrapping a
  // frame in BSU/ESU makes the terminal render it atomically, so no partial
  // frame ever tears on screen. Probe once rather than emitting it blindly:
  // unsupported terminals mostly ignore the unknown mode, but Apple Terminal
  // echoes the query as text, so skip it there and assume unsupported.
  const probeSyncOutput = (): Promise<boolean> => {
    if (!process.stdin.isTTY || process.env.TERM_PROGRAM === "Apple_Terminal")
      return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      let buf = "";
      // Reply is CSI ? 2026 ; Ps $ y — Ps 1 (set) or 2 (reset) both mean the
      // terminal knows the mode. Accumulate, since it may arrive split.
      const onData = (d: string) => {
        buf += d;
        const m = buf.match(/\x1b\[\?2026;(\d+)\$y/);
        if (!m) return;
        clearTimeout(timer);
        process.stdin.off("data", onData);
        resolve(m[1] === "1" || m[1] === "2");
      };
      timer = setTimeout(() => {
        process.stdin.off("data", onData);
        resolve(false);
      }, 150);
      process.stdin.on("data", onData);
      out.write("\x1b[?2026$p");
    });
  };
  const syncOutput = await probeSyncOutput();

  process.stdin.on("data", (data: string) => {
    for (const k of parseKeys(data)) {
      if (k === "ctrl-c") return quit();
      switch (state.mode) {
        case "list":
          onListKey(k);
          break;
        case "detail":
          onDetailKey(k);
          break;
        case "filter":
          onFilterKey(k);
          break;
        case "confirm":
          void onConfirmKey(k);
          break;
        case "help":
          onHelpKey(k);
          break;
        case "history":
          onHistoryKey(k);
          break;
      }
    }
  });

  // A drag-resize fires many SIGWINCH events; coalesce them so we repaint once
  // the size settles instead of thrashing through intermediate geometries.
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  out.on("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      draw();
    }, 150);
  });

  // --- rendering -----------------------------------------------------------
  function draw() {
    const cols = out.columns || 200;
    const rows = out.rows || 40;
    const lines =
      state.mode === "help"
        ? helpScreen(rows, opts)
        : state.mode === "history"
          ? historyScreen(cols, rows)
          : state.mode === "detail"
            ? detailScreen(cols, rows)
            : listScreen(cols, rows);
    const frame = lines.map((l) => `${l}\x1b[K`).join("\n");
    const body = `\x1b[H${frame}\x1b[J`;
    out.write(syncOutput ? `\x1b[?2026h${body}\x1b[?2026l` : body);
  }

  // Fit a clip to height: returns the visible slice plus scroll indicators,
  // padded to exactly `height` lines. `scroll` is the first visible line.
  function clipLines(
    body: string[],
    height: number,
    scroll: number,
  ): { lines: string[]; scroll: number } {
    if (body.length <= height) {
      return {
        lines: [...body, ...Array(height - body.length).fill("")],
        scroll: 0,
      };
    }
    const top = Math.max(0, Math.min(scroll, body.length - height));
    const out: string[] = [];
    const hasUp = top > 0;
    const hasDown = top + height < body.length;
    const innerH = height - (hasUp ? 1 : 0) - (hasDown ? 1 : 0);
    if (hasUp) out.push(`${DIM}  ↑ ${top} more${RESET}`);
    out.push(...body.slice(top, top + innerH));
    if (hasDown)
      out.push(`${DIM}  ↓ ${body.length - top - innerH} more${RESET}`);
    while (out.length < height) out.push("");
    return { lines: out, scroll: top };
  }

  function listScreen(cols: number, termRows: number): string[] {
    const rows = displayRows();
    // Keep the cursor on a live row while the list is the active surface, so the
    // highlight and the action target agree (even just back from an ended detail
    // view). Skip during a confirm: it anchors a specific session, and a refresh
    // mid-dialog must not retarget it (esp. the free-ports confirm, which returns
    // to the frozen detail view, not the list).
    if (state.mode !== "confirm") reconcile(rows);
    const top = [...summaryLines(rows).map((l) => GUTTER + l), ""];
    const footer = GUTTER + footerLine(cols - GUTTER.length);
    const region = Math.max(
      termRows - top.length - 1 /*header*/ - 1 /*footer*/,
      1,
    );

    if (!rows.length) {
      // No table, so drop the dangling column header and center a two-line note
      // in the empty region instead of a lone left-aligned line above blank.
      const filter = activeFilter();
      const note = filter
        ? [
            `${DIM}No sessions match${RESET}  ${BOLD}${sanitizeDisplay(filter)}${RESET}`,
            `${DIM}Press${RESET} ${CYAN}/${RESET} ${DIM}to change the filter${RESET}`,
          ]
        : [
            `${DIM}No Claude Code sessions running${RESET}`,
            `${DIM}Start one with${RESET} ${CYAN}claude${RESET} ${DIM}and it shows up here${RESET}`,
          ];
      // reclaim the reserved header line, center vertically, pad so the footer pins
      const area = region + 1;
      const body: string[] = [];
      const padTop = Math.max(0, Math.floor((area - note.length) / 2));
      for (let i = 0; i < padTop; i++) body.push("");
      // clip first so a narrow terminal can't wrap a line and shove the footer down
      for (const l of note) body.push(center(truncateStyled(l, cols), cols));
      while (body.length < area) body.push("");
      return [...top, ...body.slice(0, area), footer];
    }

    const frame = buildFrame(
      rows,
      cols - GUTTER.length,
      state.usage,
      state.net,
      opts.columns,
    );
    const selIdx = rows.findIndex((r) => rowKey(r) === state.selectedKey);
    const body = windowGroups(frame.groups, selIdx, region);
    return [...top, GUTTER + frame.header, ...body, footer];
  }

  // Window the session groups to `budget` lines, keeping the selected group
  // visible, applying the selection bar, and adding scroll indicators.
  function windowGroups(
    groups: Group[],
    selIdx: number,
    budget: number,
  ): string[] {
    const n = groups.length;
    const fitFrom = (start: number): number[] => {
      let avail = budget - (start > 0 ? 1 : 0); // reserve up-indicator
      const idxs: number[] = [];
      for (let i = start; i < n; i++) {
        const reserve = i < n - 1 ? 1 : 0; // possible down-indicator
        if (idxs.length && groups[i].lines.length + reserve > avail) break;
        idxs.push(i);
        avail -= groups[i].lines.length;
      }
      return idxs;
    };

    let top = state.scrollTop;
    if (top > selIdx) top = selIdx;
    if (top < 0) top = 0;
    let idxs = fitFrom(top);
    while (selIdx >= 0 && !idxs.includes(selIdx) && top < n - 1) {
      top += 1;
      idxs = fitFrom(top);
    }
    state.scrollTop = top;

    const lines: string[] = [];
    if (top > 0) lines.push(`${DIM}  ↑ ${top} more above${RESET}`);
    for (const i of idxs) {
      const selected = i === selIdx;
      for (const line of groups[i].lines)
        lines.push((selected ? SELBAR : GUTTER) + line);
    }
    const below = n - (idxs.length ? idxs[idxs.length - 1] + 1 : top);
    if (below > 0) lines.push(`${DIM}  ↓ ${below} more below${RESET}`);
    while (lines.length < budget) lines.push("");
    return lines.slice(0, budget);
  }

  function detailScreen(cols: number, termRows: number): string[] {
    // Track the snapshot by its pinned key while live; once the session leaves
    // the table, freeze it (ended) rather than swapping to a neighbor, so the
    // user stays on the session they opened with its last prompt/turn/stats.
    const { row, ended } = resolveDetail(
      state.rows,
      state.selectedKey,
      state.detailRow,
    );
    if (!row) {
      state.mode = "list";
      return listScreen(cols, termRows);
    }
    state.detailRow = row;
    state.detailEnded = ended;
    const footer = GUTTER + footerLine(cols - GUTTER.length);
    const region = Math.max(termRows - 1, 1);
    const body = renderDetail(row, cols - 2, ended).map((l) => `  ${l}`);
    const clipped = clipLines(body, region, state.detailScroll);
    state.detailScroll = clipped.scroll;
    return [...clipped.lines, footer];
  }

  function historyScreen(cols: number, termRows: number): string[] {
    const footer = GUTTER + footerLine(cols - GUTTER.length);
    const region = Math.max(termRows - 1, 1);
    // First open has no data yet: center a scanning note where the dashboard
    // will land. A rescan keeps the prior frame on screen instead of blanking.
    if (state.historyLoading && !state.history) {
      const note = center(`${DIM}Scanning transcripts…${RESET}`, cols);
      const body = Array(region).fill("");
      body[Math.floor(region / 2)] = note;
      return [...body, footer];
    }
    if (!state.history) return [...Array(region).fill(""), footer];
    // live session ids so the Sessions tab can show only ended ones
    const liveIds = new Set<string>();
    for (const r of state.rows) if (r.sessionId) liveIds.add(r.sessionId);
    const body = renderHistory(state.history, cols - 2, state.historyTab, {
      liveIds,
      now: Date.now(),
    }).map((l) => `  ${l}`);
    const clipped = clipLines(body, region, state.historyScroll);
    state.historyScroll = clipped.scroll;
    return [...clipped.lines, footer];
  }

  function helpScreen(termRows: number, o: AppOptions): string[] {
    const b = (s: string) => `${BOLD}${s}${RESET}`;
    const key = (k: string, d: string) =>
      `  ${CYAN}${k.padEnd(12)}${RESET}${d}`;
    const body = [
      `${b("cctop")} ${DIM}${o.version}${RESET}`,
      "",
      b("Navigation"),
      key("↑ / k", "move up"),
      key("↓ / j", "move down"),
      key("PgUp/PgDn", "jump 10 rows"),
      key("g / G", "top / bottom"),
      key("b", "jump to the session that rang last (list view)"),
      key("enter", "open detail view"),
      key("esc", "back / close overlay"),
      "",
      b("View"),
      key("/", "filter sessions (type, enter to apply)"),
      key("s", "cycle sort (default, cpu, mem, ctx, pid)"),
      key(
        "n",
        "toggle notifications (bell + desktop when a session needs input)",
      ),
      key("h", "session history (↹ tabs, ↑↓ scroll, r rescan, esc back)"),
      key("?", "toggle this help"),
      "",
      b("Actions"),
      key("x", "quit selected session (SIGTERM, confirm)"),
      key("f", "free orphan ports in detail view (SIGTERM, confirm)"),
      "",
      b("Exit"),
      key("q / Ctrl-C", "quit cctop"),
    ];
    const footer = `${GUTTER}${DIM}press any of esc / q / ? to return${RESET}`;
    const region = Math.max(termRows - 1, 1);
    const clipped = clipLines(
      body.map((l) => `  ${l}`),
      region,
      0,
    );
    return [...clipped.lines, footer];
  }

  function summaryLines(rows: Instance[]): string[] {
    // Reuse buildFrame's summary for the (filtered) rows; if empty, a stub.
    // Limits are account-wide, so they show even when no rows match the filter.
    if (!rows.length) {
      // Resources/limits are not row-scoped (net is machine-wide, limits are
      // account-wide), so reuse buildFrame for them even with zero rows.
      return buildFrame(
        [],
        (out.columns || 200) - GUTTER.length,
        state.usage,
        state.net,
        opts.columns,
      ).summary;
    }
    return buildFrame(
      rows,
      (out.columns || 200) - GUTTER.length,
      state.usage,
      state.net,
      opts.columns,
    ).summary;
  }

  function footerLine(cols: number): string {
    if (state.mode === "filter") {
      const cursor = `${CYAN}▏${RESET}`;
      return truncate(
        `${BOLD}/${RESET}${sanitizeDisplay(state.filterInput)}${cursor}  ${DIM}enter apply · esc cancel${RESET}`,
        cols + 999, // keep ANSI; filter input is short
      );
    }
    if (state.mode === "confirm" && state.confirm) {
      const { row } = state.confirm;
      const project = sanitizeDisplay(shortProject(row.project));
      const yn = `${BOLD}${GREEN}y${RESET}es / ${BOLD}${RED}n${RESET}o`;
      if (state.confirm.kind === "free") {
        const n = row.orphanPorts.reduce((s, o) => s + o.ports.length, 0);
        const ports = `${n} orphan port${n === 1 ? "" : "s"}`;
        return `${YELLOW}Free ${ports} of ${project} with SIGTERM?${RESET}  ${yn}`;
      }
      const id = sanitizeDisplay(
        row.sessionId ? row.sessionId.slice(0, 8) : `pid ${row.pid}`,
      );
      return `${YELLOW}Quit ${project} (${id}) with ${state.confirm.signal}?${RESET}  ${yn}`;
    }
    if (state.message) {
      return `${state.messageColor}${state.message}${RESET}`;
    }
    const sort = SORTS[state.sortIndex].name;
    const hint =
      state.mode === "history"
        ? "↹ tabs · ↑↓ scroll · r rescan · esc back · q exit"
        : state.mode === "detail"
          ? // x/f no-op on an ended session, so drop them from the hint and say why
            state.detailEnded
            ? "session ended · ↑↓ scroll · esc back · q exit"
            : "↑↓ scroll · esc back · x quit · f free ports · q exit"
          : `↑↓ move · enter detail · / filter · s sort:${sort} · n notify:${state.notify ? "on" : "off"} · b goto bell · h history · x quit · ? help · q exit`;
    // the history view doesn't auto-refresh, so drop the "every Ns · clock" part
    const left =
      state.mode === "history"
        ? `${DIM}cctop/${opts.version}${RESET}`
        : `${DIM}cctop/${opts.version} · every ${opts.watchSecs}s · ${clockTime()}${RESET}`;
    const line = `${left}  ${DIM}·${RESET}  ${DIM}${hint}${RESET}`;
    return visLen(line) > cols
      ? `${DIM}${truncateVisible(hint, cols)}${RESET}`
      : line;
  }

  // --- start ---------------------------------------------------------------
  await refresh();
  setInterval(() => {
    // clear an expired transient message on the natural refresh cadence
    refresh();
  }, opts.watchSecs * 1000);
  // a lightweight clock/message tick so the footer time stays current and
  // flashes clear even between data refreshes
  setInterval(() => {
    if (state.message && Date.now() > state.messageUntil) state.message = null;
    draw();
  }, 1000);
}

// Truncate a plain (no-ANSI) string to a visible width with an ellipsis.
function truncateVisible(s: string, width: number): string {
  return s.length <= width ? s : truncate(s, width);
}

// Left-pad an (ANSI-styled) string so its visible text is centered in `width`.
function center(s: string, width: number): string {
  const left = Math.max(0, Math.floor((width - visLen(s)) / 2));
  return " ".repeat(left) + s;
}
