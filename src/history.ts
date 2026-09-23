// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// ANSI rendering for the session history dashboard. A small header (title +
// summary), a headline per-day activity bar chart, then three tabs: Stats
// (token volume, model mix, tool/MCP use, top projects per period), Projects
// (the per-project table), and Sessions (recent ended sessions). Every section
// shares one look — a bold title over a thin rule — so the dashboard reads as a
// grid of panels rather than a stack of loose blocks. Pure functions over an
// already-aggregated History (collect/history.ts); the runtime (app.ts) layers
// scrolling on top, exactly as it does for the detail view.

import {
  type DayBucket,
  dateKey,
  type History,
  type SessionRow,
} from "./collect/history.ts";
import {
  BOLD,
  CYAN,
  DIM,
  formatDuration,
  GREEN,
  pad,
  RESET,
  REVERSE,
  shortModel,
  truncate,
  truncateStart,
  visLen,
} from "./format.ts";

// The tabs in display order; ↹ cycles through them and the first opens.
export const HISTORY_TABS = ["stats", "projects", "sessions"] as const;
export type HistoryTab = (typeof HISTORY_TABS)[number];
const TAB_LABELS: Record<HistoryTab, string> = {
  stats: "Stats",
  projects: "Projects",
  sessions: "Sessions",
};

// --- formatting helpers -----------------------------------------------------

// Compact magnitude for token counts: 1.2B / 3.4M / 56k / 789. `decimals` sets
// the B/M precision — the default 1 for inline figures, 0 for the chart's value
// axis (712M, no ".9M" noise).
export function big(n: number, decimals = 1): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(decimals)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(decimals)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

// MCP tool ids are mcp__<server>__<tool>; render them as <server>:<tool> with
// the server collapsed to its last meaningful segment (dropping a leading
// "plugin_" wrapper and the "-mcp" naming noise) so the distinctive tail stays
// readable. Built-in tool names (Bash, Read, web_search, …) pass through.
export function shortTool(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const [server, ...rest] = name.slice(5).split("__");
  if (!rest.length) return server; // no <server>__<tool> split — leave as-is
  const short =
    server
      .replace(/^plugin_/, "")
      .split("_")
      .at(-1) || server;
  return `${short}:${rest.join("__")}`;
}

const pctStr = (frac: number) =>
  `${frac >= 0.01 ? Math.round(frac * 100) : "<1"}%`;

// The last `n` path segments of a cwd, e.g. ".../controlplaneio/flux-operator".
const lastDirs = (path: string, n: number) =>
  path.split("/").filter(Boolean).slice(-n).join("/") || path;

// --- section chrome ---------------------------------------------------------

const MAX_W = 120; // cap the dashboard width so it doesn't stretch on wide terminals
const COL_GAP = 4; // columns between two side-by-side sections
const LABEL_MAX = 16; // default name cap for a stat list
const MCP_NAME_MAX = 31; // wider cap for "server:tool" MCP names

// Visible width of the widest line in a block (or its title), for sizing a
// content-fit column.
const blockW = (title: string, body: string[]) =>
  Math.max(visLen(title), 0, ...body.map(visLen));

// A section header: a bold title on the left, optional dim meta flushed right
// (kept one column shy of the edge so a terminal that drops the last cell can't
// clip it), over a thin full-width rule. Every section uses this, which is what
// gives the dashboard its consistent paneled look.
function sectionHead(title: string, width: number, meta = ""): string[] {
  let head = `${BOLD}${title}${RESET}`;
  if (meta) {
    const g = Math.max(1, width - visLen(title) - visLen(meta) - 1);
    head += `${" ".repeat(g)}${DIM}${meta}${RESET}`;
  }
  return [head, `${DIM}${"─".repeat(width)}${RESET}`];
}

// A section = its header followed by an already-rendered body. Empty body → no
// section at all (e.g. no MCP tools), so callers don't special-case it.
function section(
  title: string,
  body: string[],
  width: number,
  meta = "",
): string[] {
  if (!body.length) return [];
  return [...sectionHead(title, width, meta), ...body];
}

// Place two rendered sections side by side: the left padded to its column width,
// then a gap, then the right. Either side empty → just the other one.
function twoCol(left: string[], right: string[], leftW: number): string[] {
  if (!right.length) return left;
  if (!left.length) return right;
  const n = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++)
    out.push(
      `${pad(left[i] ?? "", leftW)}${" ".repeat(COL_GAP)}${right[i] ?? ""}`.trimEnd(),
    );
  return out;
}

// A name/value stat list: the name left, its value (and optional percentage)
// right of it, aligned in columns. Values are colored by what they measure
// (`valueColor`: green tokens, cyan counts); percentages are always cyan. Names
// are capped to `nameCap`, and hard-capped to whatever the section width allows
// so a row never overflows its column. `fill` widens the gap after the names
// so the values end flush with a column that wide (the side-by-side layout).
interface StatRow {
  label: string;
  value: string;
  pct?: string;
  color?: string; // overrides the list's valueColor for this row
}
interface StatOpts {
  valueColor?: string;
  nameCap?: number;
}
function statRows(
  rows: StatRow[],
  width: number,
  opts: StatOpts & { fill?: number } = {},
): string[] {
  if (!rows.length) return [];
  const valueW = Math.max(...rows.map((r) => visLen(r.value)));
  const pctW = Math.max(0, ...rows.map((r) => visLen(r.pct ?? "")));
  const segW = valueW + (pctW ? 2 + pctW : 0);
  const cap = Math.min(
    opts.nameCap ?? LABEL_MAX,
    Math.max(1, width - segW - 2),
  );
  const labels = rows.map((r) => truncate(r.label, cap));
  const labelW = Math.max(
    ...labels.map(visLen),
    Math.min(opts.fill ?? 0, width) - segW - 2,
  );
  const vc = opts.valueColor ?? "";
  return rows.map((r, i) => {
    const value = `${r.color ?? vc}${pad(r.value, valueW, true)}${RESET}`;
    const pct = pctW ? `  ${CYAN}${pad(r.pct ?? "", pctW, true)}${RESET}` : "";
    return `${pad(labels[i], labelW)}  ${value}${pct}`;
  });
}

// --- the activity chart -----------------------------------------------------

// Vertical eighth-blocks for the per-day bar chart: index 1..7 are partial cells
// (▁..▇) filling a row from the bottom; a full cell is "█".
const VBLOCK = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇"];

const HISTORY_DAYS = 30; // Claude keeps ~30 days (cleanupPeriodDays); show them all
const CHART_H = 7; // bar-chart height in rows
const Y_TICKS = 3; // value-axis labels (max, ⅔·max, ⅓·max)
const DATE_W = 5; // width of an "MM/DD" label

// "MM/DD" for a YYYY-MM-DD date string (e.g. 2026-06-08 → "06/08").
const monthDay = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}`;

// A day's bar height in eighths of a cell (0..CHART_H*8), scaled to the busiest
// day. A day with any activity always rounds up to at least one eighth, so a
// single huge day can't scale every smaller day down to a blank column.
export function barEighths(turns: number, max: number): number {
  if (turns <= 0) return 0;
  return Math.max(1, Math.round((turns / Math.max(1, max)) * CHART_H * 8));
}

// Per-day vertical bar chart of tokens per day over the last ~30 days (Claude
// Code's transcript retention), scaled to the busiest day with eighth-block
// precision. A left value axis marks three evenly spaced levels (in compact
// 1B/1M/1k form); a date axis below carries evenly spaced MM/DD ticks (including
// the last day). Bars widen to fill the width with a gap between days, and
// narrow again when space is tight. Returns just the chart rows.
const dayTokens = (d: DayBucket) =>
  d.inputFresh + d.cacheRead + d.cacheCreate + d.output;

function activity(h: History, width: number): string[] {
  const all = h.days.slice(-HISTORY_DAYS);
  if (!all.length) return [];
  const max = Math.max(1, ...all.map(dayTokens));
  // Evenly spaced value-axis ticks (max, ⅔·max, ⅓·max), keyed by chart row.
  const yLabels = new Map<number, string>();
  for (let i = 1; i <= Y_TICKS; i++)
    yLabels.set(
      Math.round((CHART_H - 1) * (1 - i / Y_TICKS)),
      big((max * i) / Y_TICKS, 0),
    );
  const labelW = Math.max(...[...yLabels.values()].map((s) => s.length));
  const gutter = (s: string) => `${DIM}${pad(s, labelW, true)}${RESET}`;

  // Never draw more days than there are columns after the gutter, dropping the
  // oldest first, so the bars can't overflow (and wrap) on a narrow terminal.
  const room = Math.max(1, width - labelW - 1);
  const shown = all.slice(-Math.min(all.length, room));
  const n = shown.length;

  const eighths = shown.map((d) => barEighths(dayTokens(d), max));

  // Fit a per-day stride (bar + gap) to the room left after the gutter. Aim for
  // 3-wide bars; drop the gap, then thin the bar, when a narrow terminal can't
  // afford it. stride = barW + gap, so each day occupies `stride` columns.
  const stride = Math.max(1, Math.min(4, Math.floor(room / n)));
  const gap = stride >= 2 ? 1 : 0;
  const barW = stride - gap;

  // Value-axis ticks: the peak at the top row, ~half at the middle, each marked
  // with a ┤ on the axis.
  const yLabel = (r: number) => yLabels.get(r) ?? "";

  const out: string[] = [];
  for (let r = 0; r < CHART_H; r++) {
    const fromBottom = CHART_H - 1 - r; // 0 at the baseline row
    const bars = eighths
      .map((e) => {
        const rem = e - fromBottom * 8;
        const g = rem <= 0 ? " " : rem >= 8 ? "█" : VBLOCK[rem];
        return g === " "
          ? " ".repeat(barW)
          : `${GREEN}${g.repeat(barW)}${RESET}`;
      })
      .join(" ".repeat(gap));
    out.push(
      `${gutter(yLabel(r))}${DIM}${yLabel(r) ? "┤" : "│"}${RESET}${bars}`,
    );
  }
  // Date axis: a few evenly spaced MM/DD labels (always including the last day),
  // each marked with a ┬ tick on the baseline and centered beneath it.
  const center = (i: number) => i * stride + ((barW - 1) >> 1);
  const minStep = Math.ceil((DATE_W + 1) / stride); // labels must not overlap
  let step = Math.max(minStep, Math.ceil(n / 6));
  for (const nice of [1, 2, 5, 7, 10, 14, 30])
    if (nice >= step) {
      step = nice;
      break;
    }
  const ticks: number[] = [];
  for (let i = 0; i < n; i += step) ticks.push(i);
  if (ticks[ticks.length - 1] !== n - 1) {
    while (ticks.length > 1 && n - 1 - ticks[ticks.length - 1] < step)
      ticks.pop();
    ticks.push(n - 1);
  }

  // Run the baseline and date axis out to the full available width (not just the
  // last bar) so the chart fills its panel rather than trailing off short.
  const baseline = new Array(room).fill("─");
  const axis = new Array(room).fill(" ");
  for (const i of ticks) {
    const c = center(i);
    baseline[c] = "┬";
    const text = monthDay(shown[i].date);
    const s = Math.max(0, Math.min(c - (DATE_W >> 1), room - DATE_W));
    for (let k = 0; k < DATE_W; k++) axis[s + k] = text[k];
  }
  out.push(`${gutter("")}${DIM}└${baseline.join("")}${RESET}`);
  out.push(`${" ".repeat(labelW + 1)}${DIM}${axis.join("")}${RESET}`);
  return out;
}

// --- section bodies ---------------------------------------------------------

const TOP_MODELS = 5;
const TOP_TOOLS = 8;
const TOP_PROJECTS = 20;
const TOP_PERIOD_PROJECTS = 5; // per period list on the Stats tab
const PERIOD_NAME_MAX = 20;
const TOP_SESSIONS = 20;

// A titled stat list's content, rendered by statRows once its column width is
// known; `empty` stands in for a list with no rows (a dim placeholder line that
// keeps the column), else the section is dropped.
interface StatList {
  title: string;
  rows: StatRow[];
  opts: StatOpts;
  empty?: string;
}

function renderList(l: StatList, width: number, fill = 0): string[] {
  if (!l.rows.length) return l.empty ? [`${DIM}${l.empty}${RESET}`] : [];
  return statRows(l.rows, width, { ...l.opts, fill });
}

// Token volume: the input total, then the three input classes with their share
// of input (a high cache-read share means most input was cheap cache hits), then
// output. Magnitudes green, shares cyan.
function tokenStats(h: History): StatList {
  let fresh = 0;
  let read = 0;
  let create = 0;
  let output = 0;
  for (const d of h.days) {
    fresh += d.inputFresh;
    read += d.cacheRead;
    create += d.cacheCreate;
    output += d.output;
  }
  const input = fresh + read + create;
  const share = (v: number) => (input > 0 ? pctStr(v / input) : "");
  return {
    title: "Tokens",
    rows: [
      { label: "input", value: big(input) },
      { label: "cache read", value: big(read), pct: share(read) },
      { label: "cache write", value: big(create), pct: share(create) },
      { label: "fresh", value: big(fresh), pct: share(fresh) },
      { label: "output", value: big(output) },
    ],
    opts: { valueColor: GREEN },
  };
}

// Model mix: each model's tokens (green) and share of all model tokens (cyan).
function modelStats(h: History): StatList {
  const total = [...h.byModel.values()].reduce((s, t) => s + t.tokens, 0) || 1;
  const rows = [...h.byModel.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, TOP_MODELS)
    .map(([m, t]) => ({
      label: shortModel(m) ?? m,
      value: big(t.tokens),
      pct: pctStr(t.tokens / total),
    }));
  return { title: "Models", rows, opts: { valueColor: GREEN } };
}

// Averages and peaks over the scanned days. The per-day rates divide by active
// days (any turn), not calendar days, so a week off doesn't dilute them; the
// streak counts consecutive active days back from today, or from yesterday
// while today is still quiet.
function activityStats(h: History, now: number): StatList {
  const active = h.days.filter((d) => d.turns > 0);
  const n = Math.max(1, active.length);
  const busiest = active.reduce<DayBucket | null>(
    (b, d) => (!b || dayTokens(d) > dayTokens(b) ? d : b),
    null,
  );
  const timed = h.sessions.filter((s) => s.endTs > s.startTs);
  const avgSec =
    timed.reduce((t, s) => t + (s.endTs - s.startTs), 0) /
    Math.max(1, timed.length) /
    1000;
  const today = new Date(now);
  const yesterday = dateKey(
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1),
  );
  let streak = 0;
  const last = h.days.at(-1)?.date;
  if (last === dateKey(today) || last === yesterday)
    for (let i = h.days.length - 1; i >= 0 && h.days[i].turns > 0; i--)
      streak++;
  return {
    title: "Activity",
    rows: [
      { label: "tokens/day", value: big(h.totals.tokens / n), color: GREEN },
      { label: "turns/day", value: big(h.totals.turns / n) },
      { label: "sessions/day", value: (h.totals.sessions / n).toFixed(1) },
      { label: "avg session", value: formatDuration(avgSec) },
      {
        label: "busiest day",
        value: busiest ? monthDay(busiest.date) : "-",
      },
      { label: "active days", value: `${active.length}/${h.days.length}` },
      { label: "streak", value: `${streak}d` },
    ],
    opts: { valueColor: CYAN },
  };
}

// The programs Bash tool calls ran most (see bashPrograms in the collector).
function bashStats(h: History): StatList {
  return {
    title: "Bash",
    rows: [...h.byBash.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_TOOLS)
      .map(([label, n]) => ({ label, value: String(n) })),
    opts: { valueColor: CYAN },
  };
}

// Tool-use frequency, ranked separately for built-in tools and MCP tools so the
// high-volume built-ins (Bash/Read/…) don't crowd the MCP tools out of a single
// top-N — they answer different questions (how you work vs which integrations
// you lean on). MCP names are rewritten to "server:tool" with a wider cap.
function toolStats(h: History, mcp: boolean): StatList {
  const rows = rankTools(h.byTool, mcp).map(([label, n]) => ({
    label,
    value: String(n),
  }));
  return {
    title: mcp ? "MCP" : "Tools",
    rows,
    opts: { valueColor: CYAN, ...(mcp ? { nameCap: MCP_NAME_MAX } : {}) },
  };
}

// The top tools of one kind, counts summed per displayed label: one MCP server
// installed two ways (standalone mcp__chrome-devtools__… and as a plugin,
// mcp__plugin_chrome-devtools-mcp_chrome-devtools__…) shortens to the same
// "server:tool", and is one tool to the reader, not two rows.
function rankTools(byTool: Map<string, number>, mcp: boolean) {
  const byLabel = new Map<string, number>();
  for (const [name, n] of byTool) {
    if (name.startsWith("mcp__") !== mcp) continue;
    const label = mcp ? shortTool(name) : name;
    byLabel.set(label, (byLabel.get(label) ?? 0) + n);
  }
  return [...byLabel.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_TOOLS);
}

// A top-style table: a dim header row, then one row per record. Every column
// sizes to its content; only the last (flexible) column is capped to the space
// left in the frame and truncated from the front so its tail stays. `right`
// right-aligns a column, `color` tints its values.
interface Col<R> {
  header: string;
  get: (r: R) => string;
  right?: boolean;
  color?: string;
}
function table<R>(cols: Col<R>[], rows: R[], width: number): string[] {
  if (!rows.length) return [];
  const widths = cols.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => visLen(c.get(r)))),
  );
  const last = widths.length - 1;
  const lead = widths.slice(0, -1).reduce((a, b) => a + b, 0) + 2 * last;
  widths[last] = Math.min(widths[last], Math.max(8, width - lead));
  const cell = (c: Col<R>, i: number, r: R) => {
    const raw = i === last ? truncateStart(c.get(r), widths[i]) : c.get(r);
    const padded = pad(raw, widths[i], c.right);
    return c.color ? `${c.color}${padded}${RESET}` : padded;
  };
  const header = `${DIM}${cols
    .map((c, i) => pad(c.header, widths[i], c.right))
    .join("  ")}${RESET}`;
  return [
    header,
    ...rows.map((r) => cols.map((c, i) => cell(c, i, r)).join("  ")),
  ];
}

// The first day (YYYY-MM-DD, local) of the calendar week (Monday), month, and
// year holding `now`, the lower bounds of the Stats tab's period lists.
export function periodStarts(now: number): {
  week: string;
  month: string;
  year: string;
} {
  const d = new Date(now);
  const monday = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() - ((d.getDay() + 6) % 7),
  );
  return {
    week: dateKey(monday),
    month: dateKey(new Date(d.getFullYear(), d.getMonth(), 1)),
    year: dateKey(new Date(d.getFullYear(), 0, 1)),
  };
}

// Projects ranked by tokens from day `from` (YYYY-MM-DD) on, top first.
export function topProjects(
  h: History,
  from: string,
  n = TOP_PERIOD_PROJECTS,
): [string, number][] {
  const rows: [string, number][] = [];
  for (const [proj, days] of h.projectDays) {
    let tokens = 0;
    for (const [day, t] of days) if (day >= from) tokens += t;
    if (tokens > 0) rows.push([proj, tokens]);
  }
  return rows.sort((a, b) => b[1] - a[1]).slice(0, n);
}

// A period's top projects as a stat list (repo name + tokens); an idle period
// (a fresh Monday) gets a dim placeholder so it keeps its column.
function periodStats(h: History, title: string, from: string): StatList {
  return {
    title,
    rows: topProjects(h, from).map(([p, t]) => ({
      label: lastDirs(p, 1),
      value: big(t),
    })),
    opts: { valueColor: GREEN, nameCap: PERIOD_NAME_MAX },
    empty: "no activity",
  };
}

// Per-project breakdown: Sessions / Tokens / Turns and a Project column (named by
// its last two path segments). Tokens green, like everywhere else.
function projectsTable(h: History, width: number): string[] {
  const all = [...h.byProject.entries()].sort(
    (a, b) => b[1].tokens - a[1].tokens,
  );
  const rows = all.slice(0, TOP_PROJECTS);
  const out = table<(typeof rows)[number]>(
    [
      { header: "Sessions", get: ([, t]) => String(t.sessions), right: true },
      {
        header: "Tokens",
        get: ([, t]) => big(t.tokens),
        right: true,
        color: GREEN,
      },
      { header: "Turns", get: ([, t]) => big(t.turns), right: true },
      { header: "Project", get: ([p]) => lastDirs(p, 2) },
    ],
    rows,
    width,
  );
  const hidden = all.length - rows.length;
  if (hidden > 0) out.push(`${DIM}+${hidden} more${RESET}`);
  return out;
}

// The most recent ended sessions (live ones excluded via `live`): how long ago
// each started, its token/turn footprint (sub-agents folded in), dominant model,
// and project.
function sessionsTable(
  h: History,
  width: number,
  live: Set<string>,
  now: number,
): string[] {
  const ended = h.sessions.filter((s) => !live.has(s.id));
  const rows = ended.slice(0, TOP_SESSIONS);
  const out = table<SessionRow>(
    [
      {
        header: "Age",
        get: (s) => formatDuration((now - s.startTs) / 1000),
        right: true,
      },
      {
        header: "Dur",
        get: (s) => formatDuration((s.endTs - s.startTs) / 1000),
        right: true,
      },
      {
        header: "Tokens",
        get: (s) => big(s.tokens),
        right: true,
        color: GREEN,
      },
      { header: "Turns", get: (s) => big(s.turns), right: true },
      { header: "Tools", get: (s) => big(s.tools), right: true },
      { header: "Model", get: (s) => shortModel(s.model) ?? "?" },
      { header: "Project", get: (s) => lastDirs(s.project, 2) },
    ],
    rows,
    width,
  );
  // a "+N more" tail when the list is capped, like the main TUI's tree overflow
  const hidden = ended.length - rows.length;
  if (hidden > 0) out.push(`${DIM}+${hidden} more${RESET}`);
  return out;
}

// Stats | Projects | Sessions tab bar: the active tab in reverse video, the
// others in plain (readable) text — not dimmed.
function tabBar(active: HistoryTab): string {
  return HISTORY_TABS.map((t) =>
    t === active
      ? `${REVERSE} ${TAB_LABELS[t]} ${RESET}`
      : ` ${TAB_LABELS[t]} `,
  ).join(" ");
}

// Share the frame's spare width out over the columns, one cell at a time to
// the narrowest, so a content-tight column doesn't sit cramped beside wider
// ones. Stops once the columns are even (it never stretches past the widest)
// or the spare runs out; never narrows a column.
function levelWidths(widths: number[], W: number): number[] {
  const out = [...widths];
  let spare = W - out.reduce((a, b) => a + b, 0) - COL_GAP * (out.length - 1);
  for (; spare > 0; spare--) {
    const min = Math.min(...out);
    if (out.every((w) => w === min)) break;
    out[out.indexOf(min)]++;
  }
  return out;
}

// The Stats tab: three rows of small lists — Tokens|Models|Activity, the top
// projects this week|month|year (all-time lives on the Projects tab), and
// Tools|MCP|Bash. Each column is sized to its widest list (not a fraction of
// the frame) so the cards sit close together, every row sharing the column
// widths so they line up, and each list's values sit flush with its column's
// right edge; spare frame width evens the columns out (levelWidths). When
// three columns don't fit, each row's third list wraps below the other two;
// below two columns, all stack in row order.
function statsTab(h: History, W: number, now: number): string[] {
  const { week, month, year } = periodStarts(now);
  const grid: StatList[][] = [
    [tokenStats(h), modelStats(h), activityStats(h, now)],
    [
      periodStats(h, "Top projects this week", week),
      periodStats(h, "This month", month),
      periodStats(h, "This year", year),
    ],
    [toolStats(h, false), toolStats(h, true), bashStats(h)],
  ];
  const natural = (l: StatList) => blockW(l.title, renderList(l, W));
  const colW = (c: number) => Math.max(...grid.map((r) => natural(r[c])));
  const card = (l: StatList, w: number) =>
    section(l.title, renderList(l, W, w), w);

  // lay out rows of lists side by side at the given column widths
  const rowsOut = (rows: StatList[][], widths: number[]) => {
    const out: string[] = [];
    for (const row of rows) {
      let lines: string[] = [];
      let x = 0;
      row.forEach((l, i) => {
        lines = i
          ? twoCol(lines, card(l, widths[i]), x - COL_GAP)
          : card(l, widths[i]);
        x += widths[i] + COL_GAP;
      });
      if (lines.length) out.push(...lines, "");
    }
    return out;
  };

  const widths = [0, 1, 2].map(colW);
  const fits = (ws: number[]) =>
    ws.reduce((a, b) => a + b, 0) + COL_GAP * (ws.length - 1) <= W;
  // two columns: each row's third list wraps under its first, so a row's
  // lists stay together (Activity right below Tokens|Models, not paired off
  // with This year at the end)
  const two = [Math.max(widths[0], widths[2]), widths[1]];
  let out: string[];
  if (fits(widths)) out = rowsOut(grid, levelWidths(widths, W));
  else if (fits(two))
    out = rowsOut(
      grid.flatMap((r) => [r.slice(0, 2), r.slice(2)]),
      levelWidths(two, W),
    );
  else
    out = rowsOut(
      grid.flat().map((l) => [l]),
      [Math.min(W, Math.max(...grid.flat().map(natural)))],
    );
  out.pop(); // no trailing blank after the last section
  return out;
}

// --- entry point ------------------------------------------------------------

export function renderHistory(
  h: History,
  termCols: number,
  tab: HistoryTab = "stats",
  opts: { liveIds?: Set<string>; now?: number } = {},
): string[] {
  // Cap the frame so the dashboard stays compact on a wide terminal rather than
  // stretching edge to edge.
  const W = Math.min(Math.max(termCols, 20), MAX_W);
  if (!h.days.length) {
    return [
      `${BOLD}Session history${RESET}`,
      "",
      `${DIM}No transcript history found under ~/.claude/projects${RESET}`,
    ];
  }

  const t = h.totals;
  const parts: [string, string, string][] = [
    [big(t.tokens), "tokens", GREEN],
    [big(t.turns), "turns", BOLD],
    [String(t.sessions), "sessions", BOLD],
    [String(t.subAgents), "sub-agents", BOLD],
  ];
  const summaryColored = parts
    .map(([v, unit, c]) => `${c}${v}${RESET} ${DIM}${unit}${RESET}`)
    .join(` ${DIM}·${RESET} `);
  const summaryPlain = parts.map(([v, unit]) => `${v} ${unit}`).join(" · ");
  // fall back to a plain (still dim) strip when the colored one can't fit
  const summary =
    visLen(summaryColored) <= W
      ? summaryColored
      : `${DIM}${truncate(summaryPlain, W)}${RESET}`;

  // header: title (with day span) over a heavy rule, then the summary strip, then
  // the headline chart (no title/rule — its axes carry it).
  const [titleLine] = sectionHead(
    "Session history",
    W,
    `last ${h.days.length} days`,
  );
  const out: string[] = [
    titleLine,
    "━".repeat(W),
    summary,
    "",
    ...activity(h, W),
    "",
    tabBar(tab),
    "",
  ];
  const now = opts.now ?? Date.now();
  out.push(
    ...(tab === "sessions"
      ? sessionsTable(h, W, opts.liveIds ?? new Set(), now)
      : tab === "projects"
        ? projectsTable(h, W)
        : statsTab(h, W, now)),
  );
  return out;
}

// Exported for tests only.
export const __test = {
  levelWidths,
  big,
  barEighths,
  shortTool,
  rankTools,
  periodStarts,
  topProjects,
};
