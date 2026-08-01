// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// ANSI rendering: the top-style summary, the session table with its
// sub-process / sub-agent tree, and the per-session detail view. Pure
// functions over already-collected rows; the interactive runtime (app.ts)
// layers selection, scrolling, and overlays on top.

import type { Instance, NetRate, SubProc, Usage } from "./collect.ts";
import {
  BELL,
  BLUE,
  BOLD,
  BRIGHT_GREEN,
  CYAN,
  cpuColor,
  ctxColor,
  DIM,
  formatCountdown,
  formatDuration,
  formatMem,
  formatRate,
  formatTokens,
  heatNum,
  pad,
  RED,
  RESET,
  sanitizeDisplay,
  shortModel,
  shortProject,
  stateDot,
  stateWord,
  tildePath,
  truncate,
  truncateStart,
  truncateStyled,
  visLen,
  YELLOW,
} from "./format.ts";

// A stable identity for a session row that survives re-sorting across
// refreshes, so the selection cursor stays put.
export const rowKey = (r: Instance) => r.sessionId ?? `pid:${r.pid}`;

// The row that dinged last — the newest bellAt, or null when nothing is
// waiting. The single source of truth for "which session rang": the summary's
// Bell: line names it and the `b` key jumps to it, so both must agree. Ties
// keep the first in the given order (strict `>`), matching the busy-first,
// lastMs-desc order rows already arrive in.
export const newestBell = (rows: Instance[]): Instance | null =>
  rows.reduce<Instance | null>(
    (best, r) =>
      r.bellAt != null && (best === null || r.bellAt > best.bellAt!) ? r : best,
    null,
  );

// `min` reserves a stable width for the volatile numeric columns so a
// changing value (cpu spiking to "100.0%", mem growing) does not resize the
// column and shove every column to its right around between refreshes
interface Col {
  key: string;
  header: string;
  align: "l" | "r";
  min?: number;
}
// The fixed head of the table — not configurable, and not an arbitrary "first
// seven": these columns are the tree layout's skeleton. The sub-agent arm spans
// state+pid+mem+cpu, sub-agents borrow up/ctx/model for their own stats, and
// sub-process rows align under pid/mem/cpu/up. Removing any of them would
// break every child row in the frame.
const FIXED_COLS: Col[] = [
  // first column is the tree gutter: a colored status dot (●) on session rows,
  // then a connected spine of branches for its children. Sub-processes branch
  // with ├─/└─ into their stats; sub-agents have no stats columns, so their
  // branch runs an arm out to the UP column, where their cyan stats begin.
  // Headerless — the glyphs speak for themselves, like systemd's status dot.
  { key: "state", header: "", align: "l" },
  { key: "pid", header: "PID", align: "r", min: 5 },
  { key: "mem", header: "MEM", align: "r", min: 4 },
  { key: "cpu", header: "CPU", align: "r", min: 5 }, // up to "99.9%"
  { key: "up", header: "UP", align: "r", min: 3 },
  { key: "ctx", header: "CTX", align: "r", min: 4 }, // up to "999k"
  { key: "model", header: "MODEL", align: "l" },
];

// The configurable tail: settings.json's `columns` lists the visible ones in
// display order (see resolveCols). Keys are the names users write in the
// config, so they are spelled out rather than abbreviated.
const OPTIONAL_COLS: Col[] = [
  { key: "version", header: "VER", align: "l" },
  { key: "host", header: "HOST", align: "l" },
  { key: "project", header: "PROJECT", align: "l" },
  { key: "branch", header: "BRANCH", align: "l" },
  { key: "last-action", header: "LAST", align: "r", min: 3 },
  { key: "prompt", header: "PROMPT", align: "l" },
];

// The effective column table for a frame: the fixed head, then the configured
// optional columns in the order given (null = all, default order). Unknown
// names are dropped rather than erroring — the file is hand-edited and may
// come from a newer cctop that knows more columns; duplicates keep the first.
function resolveCols(columns?: string[] | null): Col[] {
  if (columns == null) return [...FIXED_COLS, ...OPTIONAL_COLS];
  const seen = new Set<string>();
  const tail: Col[] = [];
  for (const key of columns) {
    const col = OPTIONAL_COLS.find((c) => c.key === key);
    if (col && !seen.has(key)) {
      seen.add(key);
      tail.push(col);
    }
  }
  return [...FIXED_COLS, ...tail];
}

// pid/mem/cpu/up are shared between a session and its sub-process rows,
// so these columns align across both and their widths consider children
const TREE_COLS = ["pid", "mem", "cpu", "up"] as const;
type TreeCol = (typeof TREE_COLS)[number];

// In list view a single session must not crowd the others off-screen, so cap
// how many sub-agent and sub-process rows it shows; the overflow is summarized
// on one line and the detail view (Enter) still lists every one.
const MAX_SUBAGENT_ROWS = 8;
const MAX_CHILD_ROWS = 8;

// HOST is the one column whose value is arbitrary process-derived text (a
// rewritten process title can be anything), so a single weird row must not set
// the column width for the whole table. Capping the cell text caps the column
// — widths derive from cells. Real hosts fit ("gnome-terminal-server" is 21);
// the detail view still shows the full value.
const MAX_HOST_W = 24;

type Cells = Record<string, string>;
const safe = (s: string | null | undefined, fallback = "-") =>
  sanitizeDisplay(s ?? fallback);

// The displayable sub-agent name — one rule shared by the list and detail
// views so they can never disagree on whether a name is visible: a name that
// is only escape or control bytes sanitizes to blanks, and an invisible name
// must not claim space (or its separator) any more than a missing one does.
const agentDisplayName = (a: { name: string | null }) =>
  a.name ? safe(a.name).trim() : "";

// A session that has just started and done nothing yet: no prompt, no turn, no
// context. Surfaced as a dim "new session" rather than a blank prompt/empty
// blocks, so a fresh session reads as fresh instead of broken.
const isNew = (r: Instance) => !r.prompt && !r.lastTurn && !r.contextTokens;

// How long a session's *row* wears its bell after it rings. Claude Code rings
// once and the sound is gone, so the row glyph is a decaying echo of that ring:
// it answers "I just heard a bell — which session was it?" and then gets out of
// the way, leaving a plain idle dot. The summary's Bell: line does not decay —
// it names the last session to ding for as long as it is still waiting, so a
// ding you missed while away is still answered. Both are derived from bellAt:
// nothing is stored and nothing is dismissed, so cctop shows the same thing
// whether it has been running for a second or a week — a bell that had to be
// cleared would be a bell that lies after a restart.
export const BELL_MS = 30_000;

// A session is ringing if it stopped within the decay window. A bellAt in the
// future (a session file written by a host with a skewed clock) still reads as a
// ring, and ages into silence as the window catches up.
const isRinging = (r: Instance, nowMs: number) =>
  r.bellAt != null && nowMs - r.bellAt < BELL_MS;

// pid/mem/cpu/uptime + sanitized name of a sub-process, formatted to display
// strings. Shared by the list-view child cells and the detail-view sub-process
// row so both format a SubProc identically; the two differ only in how they pad
// and color these (the table aligns them under the session columns and dims the
// whole row, the detail panel uses fixed widths and shows the name normally).
const subProcCells = (c: SubProc) => ({
  pid: String(c.pid),
  mem: formatMem(c.mem),
  cpu: `${c.cpu.toFixed(1)}%`,
  up: formatDuration(c.uptimeSec),
  name: safe(c.name),
  ports: c.ports,
  agent: c.agent,
});

// listening ports joined for display: ":3000 :8080". The one place the port
// display format lives, shared by the live (green) and orphan (red) renderers.
const portList = (ports: number[]) => ports.map((p) => `:${p}`).join(" ");

// the green " :3000 :8080" tail trailing a sub-process name (a listening server
// reads as live), or "" when it listens on nothing. Shared by the list tree and
// the detail view so both render ports identically; the leading two spaces sit
// outside any surrounding dim so the green stays bright.
const portTail = (ports: number[]) =>
  ports.length ? `  ${BRIGHT_GREEN}${portList(ports)}${RESET}` : "";

// Paint a session cell: status dot (a bell while it rings), heat-colored
// cpu/ctx, dimmed units, dimmed placeholders; everything else as-is.
function styleCell(
  key: string,
  value: string,
  raw: Instance,
  ringing: boolean,
) {
  if (value === "-") return `${DIM}-${RESET}`;
  switch (key) {
    case "state":
      return stateDot(raw.state, ringing);
    case "cpu": {
      const c = cpuColor(raw.cpu);
      return c ? heatNum(value, c) : value;
    }
    case "ctx": {
      const c = ctxColor(raw.contextTokens ?? 0);
      return c ? heatNum(value, c) : value;
    }
    case "prompt":
      // a new session's "new session" placeholder reads as dim chrome, not text
      return isNew(raw) ? `${DIM}${value}${RESET}` : value;
    default:
      return value;
  }
}

export interface Group {
  key: string;
  lines: string[];
}

// "Limits: 8% 7d (2d left)  60% 5h (40m left)" — the account-wide rate-limit
// summary line, from the status-line tap's snapshot (collect.ts readUsage()).
// Percentages heat toward red as they climb (like CPU); the "(… left)" comes
// from the absolute reset time, so it stays accurate even when the snapshot is
// stale. Returns null when there is no usable data, so the summary just omits
// the line. Once the snapshot is over an hour old, its age is appended so a
// stale reading isn't mistaken for a live one (the percentages stop updating
// when no session is active to refresh them).
const USAGE_STALE_MS = 60 * 60_000;
export function usageLine(
  usage: Usage | null,
  nowMs = Date.now(),
): string | null {
  if (!usage) return null;
  const segs: string[] = [];
  const win = (pct: number | null, label: string, resetsAt: number | null) => {
    if (pct == null) return;
    const p = Math.round(pct);
    const c = cpuColor(p);
    const head = `${c ? heatNum(`${p}%`, c) : `${p}%`} ${label}`;
    // "(due)" once the reset moment has passed: the window should have reset but
    // the snapshot still carries the old percentage (it lags behind real time)
    const hint =
      resetsAt == null
        ? ""
        : resetsAt * 1000 > nowMs
          ? `(${formatCountdown(resetsAt - nowMs / 1000)} left)`
          : "(due)";
    segs.push(hint ? `${head} ${DIM}${hint}${RESET}` : head);
  };
  win(usage.sevenDayPct, "7d", usage.sevenDayResetsAt);
  win(usage.fiveHourPct, "5h", usage.fiveHourResetsAt);
  if (!segs.length) return null;
  let line = `${DIM}Limits:${RESET} ${segs.join("  ")}`;
  if (
    usage.capturedAt != null &&
    nowMs - usage.capturedAt * 1000 > USAGE_STALE_MS
  ) {
    const age = formatDuration(nowMs / 1000 - usage.capturedAt);
    line += `  ${DIM}· ${age} ago${RESET}`;
  }
  return line;
}

export interface Frame {
  message?: string;
  summary: string[];
  header: string;
  groups: Group[];
}

// Build the full table frame from already-collected rows. `termCols` is the
// width available to the table body (the caller subtracts any left gutter).
// `net` is the machine-wide throughput (host-wide, not Claude-only); when
// present it appends a ↓/↑ rate to the Resources line. Single-frame callers
// (--once/--json) pass nothing, so the line stays unchanged there. `columns`
// is settings.json's visible-column list (see resolveCols); null = default.
export function buildFrame(
  rows: Instance[],
  termCols: number,
  usage?: Usage | null,
  net?: NetRate | null,
  columns?: string[] | null,
): Frame {
  const nowMs = Date.now();
  const cols = resolveCols(columns);
  // column key -> its index in `cols`, built once per frame so the per-row
  // renderers don't re-scan with findIndex on every line
  const colIdx: Record<string, number> = {};
  cols.forEach((c, i) => {
    colIdx[c.key] = i;
  });
  const view = rows.map((r) => ({
    raw: r,
    ringing: isRinging(r, nowMs),
    cells: {
      pid: String(r.pid),
      mem: formatMem(r.mem),
      cpu: `${r.cpu.toFixed(1)}%`,
      up: formatDuration(r.uptimeSec),
      state: r.state,
      ctx: r.contextTokens ? formatTokens(r.contextTokens) : "-",
      model: safe(shortModel(r.model)),
      version: safe(r.version),
      host: truncate(safe(r.host), MAX_HOST_W),
      project: safe(shortProject(r.project)),
      branch: safe(r.branch),
      "last-action": r.lastMs ? formatDuration((nowMs - r.lastMs) / 1000) : "-",
      prompt: isNew(r) ? "new session" : safe(r.prompt ?? r.sessionName),
    } as Cells,
    children: r.children.map(subProcCells),
    subagents: r.subagents.map((a) => ({
      ...a,
      name: a.name ? safe(a.name) : null,
      model: a.model ? safe(a.model) : null,
      activity: a.activity ? safe(a.activity) : null,
    })),
  }));
  // row types for the per-row renderers below, derived so they track `view`
  type ChildRow = (typeof view)[number]["children"][number];
  type AgentRow = (typeof view)[number]["subagents"][number];

  // top-style summary: session counts by state, plus the total CPU,
  // memory, and sub-process footprint of Claude (sessions and children)
  let busy = 0;
  let idle = 0; // everything not busy with a known status (idle/waiting/shell/…)
  let totalCpu = 0;
  let totalMem = 0;
  let totalProcs = 0;
  let totalAgents = 0;
  for (const { raw } of view) {
    if (raw.state === "busy") busy++;
    else if (raw.state !== "?") idle++;
    totalCpu += raw.cpu;
    totalMem += raw.mem;
    totalProcs += 1 + raw.children.length; // the session plus its children
    totalAgents += raw.subagents.length;
    for (const c of raw.children) {
      totalCpu += c.cpu;
      totalMem += c.mem;
    }
  }
  const states: string[] = [];
  if (busy) states.push(`${BRIGHT_GREEN}●${RESET} ${busy} busy`);
  if (idle) states.push(`${RED}●${RESET} ${idle} idle`);
  const summary = [
    `${DIM}Sessions:${RESET} ${states.join("  ") || view.length}` +
      (totalAgents ? `   ${CYAN}◆${RESET} ${totalAgents} subagents` : ""),
    // value-first ("1.8% cpu") to match the Sessions line's "1 busy" style;
    // the ↓/↑ net rate is host-wide (every interface), unlike the Claude-only
    // cpu/mem/procs to its left, so it carries its own arrows rather than a
    // "net" label that would imply it's scoped to the sessions
    `${DIM}Resources:${RESET} ${totalCpu.toFixed(1)}% cpu  ${formatMem(
      totalMem,
    )} mem  ${totalProcs} procs${
      net
        ? `  ${DIM}↓${RESET} ${formatRate(net.rx)} ${DIM}↑${RESET} ${formatRate(
            net.tx,
          )}`
        : ""
    }`,
  ];
  // account-wide rate limits, when the status-line tap has captured them
  const limits = usageLine(usage ?? null, nowMs);
  if (limits) summary.push(limits);

  // "Bell: ○ cctop · pid 1737989 · 4m ago" — the session that dinged last.
  // Identified the way the table identifies it: PROJECT says what it is, PID
  // says which row, and the PID is the only thing here that cannot collide (two
  // sessions on the same project are ordinary). Deliberately *not* sessionName —
  // it has no column of its own, so a name like "cctop-92" would send you hunting.
  //
  // Unlike the row's own bell, this does not decay: it holds the session until
  // it goes busy again, which clears its bellAt and hands the line to the next
  // one still waiting. So it stays true for a ding you missed an hour ago, and
  // it walks the queue as you answer them. Only one entry — the most recent —
  // since the row glyphs already flag every session that rang inside the window,
  // and a fixed-shape line keeps the summary from jittering. Last in the summary
  // (nearest the table) and dropped when nothing waits, so it never shifts the
  // lines above it.
  const dinged = newestBell(rows);
  if (dinged) {
    const project = safe(shortProject(dinged.project), "?");
    const ago = formatDuration((nowMs - dinged.bellAt!) / 1000);
    summary.push(
      `${DIM}Bell:${RESET} ${RED}${BELL}${RESET} ${project} ` +
        `${DIM}· pid ${dinged.pid} · ${ago} ago${RESET}`,
    );
  }

  // sub-agent rows borrow the up/ctx/model columns; the width pass below
  // needs their cell text (as agentLine renders it) so an agent value longer
  // than every session's can't overflow the column and break the grid
  const agentCell = (key: "up" | "ctx" | "model", a: AgentRow) => {
    switch (key) {
      case "up":
        return a.uptimeSec != null ? formatDuration(a.uptimeSec) : "";
      case "ctx":
        return a.ctx != null ? formatTokens(a.ctx) : "?";
      case "model":
        return shortModel(a.model) ?? "agent";
    }
  };

  // widths use the plain cell text (color is added afterward); the state
  // column is the tree gutter, 2 wide — a status dot, or a sub-process branch
  // (a sub-agent's arm sets its own length, past this column); tree columns
  // also fit child values
  const widths = cols.map(({ key, header, min = 0 }) => {
    if (key === "state") return 2; // ● dot, or ├─ / └─ branch
    let w = Math.max(
      header.length,
      min,
      ...view.map((r) => r.cells[key].length),
    );
    if ((TREE_COLS as readonly string[]).includes(key))
      for (const r of view)
        for (const c of r.children) w = Math.max(w, c[key as TreeCol].length);
    // only agents that will be shown may widen the column
    if (key === "up" || key === "ctx" || key === "model")
      for (const r of view)
        for (const a of r.subagents.slice(0, MAX_SUBAGENT_ROWS))
          w = Math.max(w, agentCell(key, a).length);
    return w;
  });
  // the prompt column absorbs whatever terminal width is left, wherever the
  // configured order puts it — prompts are routinely longer than a terminal,
  // so an uncapped mid-table prompt would overflow every row. With prompt
  // hidden, the final column inherits the flex role so the table still ends
  // at the terminal edge.
  const flexI = colIdx.prompt ?? cols.length - 1;
  const fixed =
    widths.reduce((a, b) => a + b, 0) - widths[flexI] + 2 * (cols.length - 1);
  const avail = Math.max(termCols - fixed, 12);
  widths[flexI] = Math.min(widths[flexI], avail);

  const header = cols
    .map(
      ({ header, align }, i) =>
        `${BOLD}${pad(header, widths[i], align === "r")}${RESET}`,
    )
    .join("  ");

  const sessionLine = (cells: Cells, raw: Instance, ringing: boolean) =>
    cols
      .map(({ key, align }, i) => {
        let plain = cells[key];
        if (i === flexI && plain.length > widths[i])
          plain = truncate(plain, widths[i]);
        return pad(
          styleCell(key, plain, raw, ringing),
          widths[i],
          align === "r",
        );
      })
      .join("  ");

  const stateI = colIdx.state;

  // a sub-process row: a tree branch in the state gutter, then pid/mem/cpu/up
  // aligned under the session's columns, then the command name and any listening
  // ports; the row (bar the green ports) is dimmed so sessions stay the focus.
  // A cross-provider agent CLI (copilot, gemini, codex, …) is a delegated agent
  // at work, not background noise: its row is cyan like the sub-agent rows.
  const childLine = (c: ChildRow, isLast: boolean) => {
    const branch = pad(isLast ? "└─" : "├─", widths[stateI]);
    const stats = TREE_COLS.map((key) => {
      const i = colIdx[key];
      return pad(c[key], widths[i], cols[i].align === "r");
    }).join("  ");
    const head = `${branch}  ${stats}  `;
    const tail = portTail(c.ports);
    const room = Math.max(termCols - visLen(head) - visLen(tail), 8);
    if (c.agent)
      return `${DIM}${branch}${RESET}  ${CYAN}${stats}  ${truncate(c.name, room)}${RESET}${tail}`;
    return `${DIM}${head}${truncate(c.name, room)}${RESET}${tail}`;
  };

  // a live sub-agent row: branches off the same spine as the processes, but it
  // has no pid/mem/cpu of its own, so the branch runs a horizontal arm across
  // those empty columns out to the UP column, where the agent's own stats begin
  // — all cyan: uptime (from the transcript's creation time), then ctx/model
  // under the parent's columns, with the action flowing free after.
  const ctxI = colIdx.ctx;
  const modelI = colIdx.model;
  const upI = colIdx.up;
  // the arm a sub-agent row draws: spans the gutter and the empty pid/mem/cpu
  // columns (with their separators), reaching the UP column where its stats begin
  const agentArmW =
    widths[stateI] +
    ["pid", "mem", "cpu"].reduce(
      (sum, key) => sum + 2 + widths[colIdx[key]],
      0,
    );
  const agentArm = (isLast: boolean) =>
    `${isLast ? "└" : "├"}${"─".repeat(Math.max(0, agentArmW - 1))}`;
  // the agent's name spans the same width as the session row's VER + HOST +
  // PROJECT columns (with their gaps), so it always snaps to the grid: a
  // resolved (or empty, for a nameless agent) name field ends exactly where
  // a session row's BRANCH value begins, and the activity that follows lines
  // up with it too. The field only exists at all when some visible agent in
  // the frame has a name — an all-nameless frame keeps the activity right
  // after the model column instead of shifting it across an empty field.
  // Any of the three columns may be hidden — the span covers the visible
  // ones (out of default order, it degrades to just a reserved width); with
  // all three hidden the field falls back to fitting the widest name, so a
  // named agent can't lose its name to a column setting.
  const frameHasNames = view.some((r) =>
    r.subagents.slice(0, MAX_SUBAGENT_ROWS).some((a) => agentDisplayName(a)),
  );
  const AGENT_NAME_FALLBACK_W = 20;
  let agentNameW = ["version", "host", "project"]
    .filter((key) => colIdx[key] != null)
    .reduce((sum, key, i) => sum + (i ? 2 : 0) + widths[colIdx[key]], 0);
  if (!agentNameW && frameHasNames) {
    for (const r of view)
      for (const a of r.subagents.slice(0, MAX_SUBAGENT_ROWS))
        agentNameW = Math.max(agentNameW, visLen(agentDisplayName(a)));
    agentNameW = Math.min(agentNameW, AGENT_NAME_FALLBACK_W);
  }
  const agentLine = (a: AgentRow, isLast: boolean) => {
    const arm = agentArm(isLast);
    // the same cell text the width pass measured, so the two can't drift
    const up = pad(agentCell("up", a), widths[upI], true);
    const ctx = pad(agentCell("ctx", a), widths[ctxI], true);
    const model = pad(agentCell("model", a), widths[modelI], false);
    // cut in terminal columns, the unit pad() counts in: a name is arbitrary
    // user text, so a CJK/emoji one would otherwise overrun the field and
    // shove the activity out of the grid
    const name = frameHasNames
      ? `  ${pad(truncateStyled(agentDisplayName(a), agentNameW), agentNameW, false)}`
      : "";
    const prefix = `${arm}  ${up}  ${ctx}  ${model}${name}`;
    const room = Math.max(termCols - visLen(prefix) - 2, 8);
    // cut in the same terminal columns `room` was measured in: an activity is
    // a tool argument, so a CJK/emoji one would otherwise wrap the row and
    // push the frame off the bottom of the screen
    const activity = truncateStyled(a.activity ?? "", room);
    const tail = activity ? `  ${activity}` : "";
    // trimEnd drops the name padding when nothing follows it, so a nameless
    // idle agent's row doesn't end in a run of spaces
    return `${DIM}${arm}${RESET}  ${CYAN}${`${up}  ${ctx}  ${model}${name}${tail}`.trimEnd()}${RESET}`;
  };

  // a dim summary line that stands in for capped sub-agent/sub-process rows; it
  // reuses the same arm/branch as the rows it replaces so it sits flush on the
  // spine instead of dangling off a stub pipe
  const moreLine = (arm: string, hidden: number, noun: string) =>
    `${DIM}${arm}  +${hidden} ${noun}${RESET}`;

  // each group is a session row, then its live sub-agents (a long markerless
  // arm each), then its sub-process tree (├─), all hanging off one connected
  // spine: every child branches with ├ and only the final line closes it with └.
  // Kept together so truncation never orphans them; each kind is capped so one
  // busy session can't fill the view.
  const groups: Group[] = view.map((r) => {
    const lines = [sessionLine(r.cells, r.raw, r.ringing)];

    const agents = r.subagents.slice(0, MAX_SUBAGENT_ROWS);
    const moreAgents = r.subagents.length - agents.length;
    const kids = r.children.slice(0, MAX_CHILD_ROWS);
    const moreKids = r.children.length - kids.length;

    // total child lines, so the very last one (whatever kind) gets the └ closer
    const total =
      agents.length +
      (moreAgents > 0 ? 1 : 0) +
      kids.length +
      (moreKids > 0 ? 1 : 0);
    let n = 0;
    const last = () => ++n === total;

    for (const a of agents) lines.push(agentLine(a, last()));
    if (moreAgents > 0)
      lines.push(moreLine(agentArm(last()), moreAgents, "sub-agents"));
    for (const c of kids) lines.push(childLine(c, last()));
    if (moreKids > 0)
      lines.push(
        moreLine(
          pad(last() ? "└─" : "├─", widths[stateI]),
          moreKids,
          "processes",
        ),
      );

    return { key: rowKey(r.raw), lines };
  });

  return { summary, header, groups };
}

// --- Detail view -----------------------------------------------------------

export interface DetailResolution {
  row: Instance | null; // the session to render, or null when there is none
  ended: boolean; // its session has exited; `row` is the frozen last snapshot
}

// Decide which session the detail view shows and whether it has ended. A live
// match (by key) tracks fresh; once the pinned session leaves `rows`, the prior
// snapshot is returned frozen (ended=true) so the panel keeps its last-known
// data instead of swapping to a neighbor. Pid-keyed rows (registry-less) can
// collide with a recycled pid, so a live match must also share the snapshot's
// startSec to count as the same session. Pure, so the freeze logic is testable.
export function resolveDetail(
  rows: Instance[],
  key: string | null,
  prev: Instance | null,
): DetailResolution {
  const live = key != null ? rows.find((r) => rowKey(r) === key) : undefined;
  if (live && (!prev || live.startSec === prev.startSec))
    return { row: live, ended: false };
  if (prev) return { row: prev, ended: true };
  return { row: null, ended: false };
}

const label = (s: string) => `${DIM}${pad(s, 9)}${RESET}`;

// A styled span of text: the visible string plus the ANSI prefix to wrap it in
// (empty for plain). Markers are already stripped from `text`.
interface MdRun {
  text: string;
  style: string;
}

// One whitespace-delimited word as a list of styled fragments (a word can mix
// styles, e.g. a code span inside bold) plus its visible width, ready for
// width-aware wrapping.
interface MdWord {
  frags: MdRun[];
  width: number;
}

// How many wrapped lines a free-text block (last prompt/turn) keeps before it
// is trimmed with a …; the detail view shows context, not the whole transcript.
const BLOCK_LINES = 3;

// Minimal inline-markdown parser for the free-text blocks: the assistant writes
// GitHub-flavored markdown, so a last turn/prompt carries `**bold**` and
// `` `inline code` ``. Render bold as bold and inline code as blue, stripping
// the markers; everything else is literal. Input is already ANSI-sanitized, so
// the only escapes in the output are the ones added here. Unmatched markers are
// left as text. Code spans are literal (no bold parsing inside), but a code span
// nested in bold keeps both styles.
function parseInlineMd(text: string): MdRun[] {
  const runs: MdRun[] = [];
  let bold = false;
  let buf = "";
  const flush = (t: string, code: boolean) => {
    if (t)
      runs.push({ text: t, style: (bold ? BOLD : "") + (code ? BLUE : "") });
  };
  for (let i = 0; i < text.length; ) {
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end < 0) {
        buf += text[i++];
        continue;
      } // unmatched: literal backtick
      flush(buf, false);
      buf = "";
      flush(text.slice(i + 1, end), true);
      i = end + 1;
    } else if (text[i] === "*" && text[i + 1] === "*") {
      flush(buf, false);
      buf = "";
      bold = !bold;
      i += 2;
    } else {
      buf += text[i++];
    }
  }
  flush(buf, false);
  return runs;
}

// Split styled runs into whitespace-delimited words, ready for width-aware
// wrapping with inline markdown applied.
function mdWords(text: string): MdWord[] {
  const words: MdWord[] = [];
  let cur: MdWord | null = null;
  for (const run of parseInlineMd(text)) {
    for (const seg of run.text.split(/(\s+)/)) {
      if (!seg) continue;
      if (/^\s+$/.test(seg)) {
        if (cur) {
          words.push(cur);
          cur = null;
        }
      } else {
        cur ??= { frags: [], width: 0 };
        cur.frags.push({ text: seg, style: run.style });
        cur.width += visLen(seg);
      }
    }
  }
  if (cur) words.push(cur);
  return words;
}

// Words for plain (non-markdown) text: one unstyled fragment each. Used for tool
// arguments, which are commands — backticks/asterisks there are literal.
function plainWords(text: string): MdWord[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ({ frags: [{ text: t, style: "" }], width: visLen(t) }));
}

// A full-screen panel for one session: everything the row truncates, shown
// in full. Returns the body lines (caller adds title/footer chrome). `ended`
// swaps the live status dot/word for an "ended" marker over the frozen snapshot.
export function renderDetail(
  r: Instance,
  termCols: number,
  ended = false,
): string[] {
  const width = Math.max(termCols, 20);

  // A free-text block (last prompt/turn): wrap styled words to the body width,
  // mark each line with a dim left gutter so it reads as quoted content, and cap
  // it to BLOCK_LINES with a dim … where it was cut. `fromEnd` keeps the tail
  // (… leads) instead of the head (… trails) — used for text turns, whose most
  // recent / concluding content is at the end. Never splits a word.
  const gut = `${DIM}│${RESET} `;
  const ell = `${DIM}…${RESET}`;
  const renderWord = (w: MdWord) =>
    w.frags.map((f) => (f.style ? f.style + f.text + RESET : f.text)).join("");
  const block = (words: MdWord[], fromEnd = false): string[] => {
    const room = Math.max(width - 2, 8);
    const wordLines: MdWord[][] = [];
    let line: MdWord[] = [];
    let lineW = 0;
    for (const w of words) {
      if (line.length && lineW + 1 + w.width > room) {
        wordLines.push(line);
        line = [];
        lineW = 0;
      }
      lineW += (line.length ? 1 : 0) + w.width;
      line.push(w);
    }
    if (line.length) wordLines.push(line);
    if (!wordLines.length) return [gut];
    if (wordLines.length <= BLOCK_LINES)
      return wordLines.map((ws) => gut + ws.map(renderWord).join(" "));
    // truncated: keep the tail (… leads) or the head (… trails), and drop words
    // from the cut edge of the … line so " …" / "… " fits within the body width.
    const lineVis = (ws: MdWord[]) =>
      ws.reduce((s, w) => s + w.width, 0) + (ws.length - 1);
    if (fromEnd) {
      const kept = wordLines.slice(wordLines.length - BLOCK_LINES);
      const first = kept[0];
      while (first.length > 1 && lineVis(first) + 2 > room) first.shift();
      return kept.map(
        (ws, i) =>
          gut + (i === 0 ? `${ell} ` : "") + ws.map(renderWord).join(" "),
      );
    }
    const kept = wordLines.slice(0, BLOCK_LINES);
    const last = kept[BLOCK_LINES - 1];
    while (last.length > 1 && lineVis(last) + 2 > room) last.pop();
    return kept.map(
      (ws, i) =>
        gut +
        ws.map(renderWord).join(" ") +
        (i === BLOCK_LINES - 1 ? ` ${ell}` : ""),
    );
  };

  // a dim "<duration> ago" suffix for a section header, or "" when no timestamp
  const agoSuffix = (ms: number | null) =>
    ms ? `  ${DIM}${formatDuration((Date.now() - ms) / 1000)} ago${RESET}` : "";

  // ended: a hollow dim dot (no live signal) + a yellow badge, so the frozen
  // panel reads as stopped, not broken. A live session that is still inside its
  // bell window keeps the bell here too, so opening the row you heard confirms
  // you landed on the right one.
  const dot = ended
    ? `${DIM}○${RESET}`
    : stateDot(r.state, isRinging(r, Date.now()));
  const out: string[] = [];
  const projectShort = safe(shortProject(r.project), "?");
  out.push(
    `${dot} ${BOLD}${projectShort}${RESET}` +
      (ended ? `  ${YELLOW}session ended${RESET}` : ""),
  );
  out.push("");
  out.push(`${label("session")}${safe(r.sessionId)}`);
  out.push(`${label("uptime")}${formatDuration(r.uptimeSec)}`);
  out.push(
    `${label("state")}${ended ? `${YELLOW}ended${RESET}` : stateWord(safe(r.state))}`,
  );
  out.push(`${label("pid")}${r.pid}  ${DIM}·${RESET}  ${safe(r.kind)}`);
  const cpuC = cpuColor(r.cpu);
  const cpuStr = `${r.cpu.toFixed(1)}%`;
  out.push(
    `${label("cpu/mem")}${cpuC ? heatNum(cpuStr, cpuC) : cpuStr}  ${DIM}·${RESET}  ${formatMem(r.mem)}`,
  );
  const ctx =
    r.contextTokens != null
      ? (() => {
          const c = ctxColor(r.contextTokens);
          const s = formatTokens(r.contextTokens);
          return c ? heatNum(s, c) : s;
        })()
      : "-";
  out.push(`${label("context")}${ctx}`);
  out.push(`${label("model")}${safe(shortModel(r.model))}`);
  out.push(`${label("host")}${safe(r.host)}`);
  // full cwd (not the table's shortened last segment), home root as ~
  out.push(
    `${label("project")}${safe(r.project ? tildePath(r.project) : null)}`,
  );
  out.push(`${label("branch")}${safe(r.branch)}`);
  if (r.transcript) {
    // relative to ~/.claude/ — the absolute prefix is just noise in this view
    const log = r.transcript.replace(/^.*\/\.claude\//, "");
    // keep it on one line: the label eats 9 cols, then trim from the left so the
    // filename (the part that matters) survives and a … leads the dropped prefix
    out.push(`${label("log")}${truncateStart(safe(log), width - 9)}`);
  }

  out.push("");
  if (isNew(r)) {
    // nothing to show yet — one dim note in place of the empty prompt/turn blocks
    out.push(`${BOLD}Last Prompt${RESET}`);
    out.push(`${DIM}│ new session — nothing yet${RESET}`);
  } else {
    out.push(`${BOLD}Last Prompt${RESET}${agoSuffix(r.promptAt)}`);
    // keep the head: a prompt opens with the actual request
    out.push(...block(mdWords(safe(r.prompt ?? r.sessionName))));

    out.push("");
    out.push(`${BOLD}Last Turn${RESET}${agoSuffix(r.lastMs)}`);
    const turn = safe(r.lastTurn);
    // describeAssistant renders a tool call as "Tool: arg" — tag the tool name
    // in cyan (matching the sub-agent rows) as its own word and drop the colon;
    // the arg is a command, not markdown, so keep the head so the tool stays
    // visible. A text turn is assistant markdown; keep its tail — the most
    // recent / often concluding content (a status or a question) is at the end.
    const tool = r.lastTurn ? turn.match(/^([^\s:]{1,40}): (\S.*)$/) : null;
    if (tool)
      out.push(
        ...block([
          { frags: [{ text: tool[1], style: CYAN }], width: visLen(tool[1]) },
          ...plainWords(tool[2]),
        ]),
      );
    else out.push(...block(mdWords(turn), true));
  }

  if (r.subagents.length) {
    out.push("");
    out.push(`${BOLD}Sub-agents${RESET} ${DIM}(${r.subagents.length})${RESET}`);
    for (const a of r.subagents) {
      const model = safe(shortModel(a.model), "agent");
      const ac = a.ctx != null ? formatTokens(a.ctx) : "?";
      const named = agentDisplayName(a);
      const name = named ? `${named} · ` : "";
      const line = `${CYAN}◆${RESET} ${name}${model} · ${ac} ctx · up ${formatDuration(
        a.uptimeSec,
      )}${a.activity ? ` · ${safe(a.activity)}` : ""}`;
      out.push(truncateStyled(line, width));
    }
  }

  if (r.children.length) {
    out.push("");
    out.push(
      `${BOLD}Sub-processes${RESET} ${DIM}(${r.children.length})${RESET}`,
    );
    for (const c of r.children) {
      const cell = subProcCells(c);
      const stats = `${pad(cell.pid, 6, true)} ${pad(cell.mem, 5, true)} ${pad(
        cell.cpu,
        6,
        true,
      )} ${pad(cell.up, 3, true)}`;
      // listening ports trail the name (green, like a live server); reserve
      // their width (and the 2-space name separator) so the name truncates
      // around them rather than over them
      const tail = portTail(c.ports);
      const room = Math.max(width - stats.length - 2 - visLen(tail), 8);
      // an agent CLI reads as a live delegated agent, so its name is cyan like
      // the list tree's agent rows (which tint the stats too; here they stay
      // dim, so the fixed-width columns keep reading as chrome)
      out.push(
        c.agent
          ? `${DIM}${stats}${RESET}  ${CYAN}${truncate(cell.name, room)}${RESET}${tail}`
          : `${DIM}${stats}${RESET}  ${truncate(cell.name, room)}${tail}`,
      );
    }
  }

  // leftover servers from this project whose parent process has exited (they
  // reparented to init) — a forgotten dev server still holding its port. Flagged
  // in red since, unlike a live sub-process's port, nothing is supervising it.
  if (r.orphanPorts.length) {
    out.push("");
    out.push(
      `${BOLD}Orphan ports${RESET} ${DIM}(${r.orphanPorts.length})${RESET}`,
    );
    for (const o of r.orphanPorts) {
      const line = `${RED}⚠${RESET} ${pad(String(o.pid), 6, true)} ${safe(
        o.name,
      )}  ${RED}${portList(o.ports)}${RESET}`;
      out.push(truncateStyled(line, width));
    }
  }
  return out;
}
