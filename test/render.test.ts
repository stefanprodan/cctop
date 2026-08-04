// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { Instance, Usage } from "../src/collect.ts";
import {
  BELL,
  BLUE,
  BOLD,
  CYAN,
  RED,
  RESET,
  stripAnsi,
  visLen,
  YELLOW,
} from "../src/format.ts";
import {
  BELL_MS,
  buildFrame,
  newestBell,
  renderDetail,
  resolveDetail,
  rowKey,
  usageLine,
} from "../src/render.ts";

const baseRow = (overrides: Partial<Instance> = {}): Instance => ({
  pid: 12345,
  mem: 512 * 1024 * 1024,
  cpu: 12.3,
  uptimeSec: 90,
  startSec: 1_700_000_000,
  state: "busy",
  kind: "interactive",
  sessionId: "session-1",
  sessionName: "session name",
  version: "2.1.177",
  host: "Ghostty",
  project: "/Users/alice/src/cctop",
  branch: "main",
  model: "claude-opus-4-8",
  contextTokens: 123_456,
  lastActivity: "2026-06-13T12:00:00.000Z",
  lastMs: Date.now(),
  bellAt: null,
  prompt: "implement tests",
  promptAt: Date.now() - 120_000,
  lastTurn: "Edit: render.ts",
  transcript: "/Users/alice/.claude/projects/cctop/session-1.jsonl",
  subagents: [],
  children: [],
  orphanPorts: [],
  ...overrides,
});

describe("render helpers", () => {
  test("uses stable row keys", () => {
    expect(rowKey(baseRow())).toBe("session-1");
    expect(rowKey(baseRow({ sessionId: null }))).toBe("pid:12345");
  });

  test("builds summary, header, and grouped rows", () => {
    const frame = buildFrame(
      [
        baseRow({
          children: [
            {
              pid: 12346,
              name: "bun test",
              mem: 128 * 1024 * 1024,
              cpu: 1.5,
              uptimeSec: 10,
              ports: [5173],
              agent: false,
            },
          ],
          subagents: [
            {
              name: "code-locator",
              model: "claude-sonnet-4",
              ctx: 42_000,
              activity: "Read",
              uptimeSec: 65,
            },
          ],
        }),
      ],
      160,
    );

    const text = stripAnsi(
      [...frame.summary, frame.header, ...frame.groups[0].lines].join("\n"),
    );
    expect(text).toContain("1 busy");
    expect(text).toContain("1 subagents");
    expect(text).toContain("PID");
    expect(text).toContain("cctop");
    expect(text).toContain("implement tests");
    expect(text).toContain("bun test");
    // the child's listening port shows in the list tree, not only the detail view
    expect(text).toContain(":5173");
    // connected tree gutter: ● session, then a spine of branches — the
    // sub-agent runs a long arm out to its (markerless) UP column, the lone
    // sub-process closes the spine with └─
    expect(text).toContain("●");
    expect(text).toMatch(/├─{4,}/);
    expect(text).toContain("└─");
  });

  test("caps a runaway host value instead of widening the column", () => {
    const long =
      "chrome --profile-directory=Profile 1 --app-id=abcdefghijklmnop";
    const frame = buildFrame([baseRow({ host: long })], 200);
    const text = stripAnsi(frame.groups[0].lines[0]);
    expect(text).not.toContain(long);
    expect(text).toContain(`${long.slice(0, 23)}…`); // truncated to MAX_HOST_W
    // the detail view still shows the full value
    expect(
      stripAnsi(renderDetail(baseRow({ host: long }), 200).join("\n")),
    ).toContain(long);
  });

  test("caps sub-agent and sub-process rows in list view; detail shows all", () => {
    const subagents = Array.from({ length: 12 }, (_, i) => ({
      name: null,
      model: "claude-haiku-4-5-20251001",
      ctx: 18_000 - i * 500,
      activity: `Bash: job ${i + 1}`,
      uptimeSec: 300 - i * 10,
    }));
    const children = Array.from({ length: 11 }, (_, i) => ({
      pid: 90_000 + i,
      name: `bash › sleep ${i + 1}`,
      mem: 1024 * 1024,
      cpu: 0.1,
      uptimeSec: 120,
      ports: [],
      agent: false,
    }));
    const row = baseRow({ subagents, children });

    const lines = buildFrame([row], 120).groups[0].lines;
    const text = stripAnsi(lines.join("\n"));
    // 1 session + 8 agents + 1 overflow + 8 procs + 1 overflow
    expect(lines.length).toBe(19);
    expect(text).toContain("+4 sub-agents");
    expect(text).toContain("+3 processes");
    // the overflow line is the closer (└), so every shown child branches with
    // ├ — no child stat row (└ followed by its pid) gets the closing glyph
    expect(text).not.toMatch(/└\s+\d/);
    expect(text).toContain("├");

    const detail = stripAnsi(renderDetail(row, 120).join("\n"));
    expect(detail).toContain("Sub-agents (12)");
    expect(detail).toContain("Sub-processes (11)");
    expect(detail).toContain("Bash: job 12");
    expect(detail).toContain("bash › sleep 11");
    expect(detail).toContain("Last Turn");
    // the tool name is tagged and the colon dropped: "Edit: render.ts" → "Edit render.ts"
    expect(detail).toContain("Edit render.ts");
    expect(detail).toContain("│"); // quoted blocks get a left gutter
  });

  test("shows a sub-agent's resolved name in list and detail views", () => {
    const row = baseRow({
      subagents: [
        {
          // shortModel outputs are kept within the session's own MODEL
          // column width (from "claude-opus-4-8" -> "opus-4-8", 8 chars) so
          // none of these overflow it and skew the name-column alignment
          // checks below.
          name: "code-locator",
          model: "claude-haiku-4",
          ctx: 8_000,
          activity: "Grep: TODO",
          uptimeSec: 12,
        },
        {
          name: null,
          model: "claude-sonnet-4",
          ctx: 4_000,
          activity: "Bash: ls",
          uptimeSec: 3,
        },
      ],
    });

    const frame = buildFrame([row], 160);
    const plainLines = frame.groups[0].lines.map(stripAnsi);
    const namedLine = plainLines.find((l) => l.includes("Grep: TODO"))!;
    const nullLine = plainLines.find((l) => l.includes("Bash: ls"))!;
    expect(namedLine).toContain("code-locator");
    // the name field spans VER+HOST+PROJECT, so every agent's activity
    // starts at the same column as a session row's BRANCH value — regardless
    // of the name's length, or whether it has one at all
    const branchCol = stripAnsi(frame.header).indexOf("BRANCH");
    expect(namedLine.indexOf("Grep: TODO")).toBe(branchCol);
    // a null name still gets the padded empty field, so its activity lines
    // up at that same column too, rather than sitting right after the model
    expect(nullLine.indexOf("Bash: ls")).toBe(branchCol);

    const detail = stripAnsi(renderDetail(row, 120).join("\n"));
    expect(detail).toContain(
      "◆ code-locator · haiku-4 · 8k ctx · up 12s · Grep: TODO",
    );
    // an unresolved name leaves the detail line format unchanged
    expect(detail).toContain("◆ sonnet-4 · 4k ctx · up 3s · Bash: ls");
  });

  test("omits the name field when no agent in the frame has a name", () => {
    const row = baseRow({
      subagents: [
        {
          name: null,
          model: "claude-haiku-4",
          ctx: 8_000,
          activity: "Bash: ls",
          uptimeSec: 3,
        },
      ],
    });

    const frame = buildFrame([row], 160);
    const line = frame.groups[0].lines
      .map(stripAnsi)
      .find((l) => l.includes("Bash: ls"))!;
    // with no names anywhere in the frame there is no name field: the
    // activity follows the model column directly instead of being pushed
    // out to the BRANCH column across an empty field
    expect(line).toMatch(/haiku-4\s+Bash: ls/);
    const branchCol = stripAnsi(frame.header).indexOf("BRANCH");
    expect(line.indexOf("Bash: ls")).toBeLessThan(branchCol);
  });

  test("drops the detail name separator when the name sanitizes away", () => {
    const row = baseRow({
      subagents: [
        {
          // escape and control bytes only: the escape sequence is dropped and
          // the control byte becomes a space, so nothing visible survives
          name: "\x1b[31m\x07",
          model: "claude-haiku-4",
          ctx: 8_000,
          activity: "Grep: TODO",
          uptimeSec: 12,
        },
      ],
    });

    const detail = stripAnsi(renderDetail(row, 120).join("\n"));
    // the list view already treats this agent as nameless; the detail line
    // must agree instead of leading with a dangling separator
    expect(detail).toContain("◆ haiku-4 · 8k ctx · up 12s · Grep: TODO");
  });

  test("keeps the grid when a sub-agent name carries wide characters", () => {
    const row = baseRow({
      subagents: [
        {
          // 8 code units, 16 terminal columns — a name counted by .length
          // would overrun the field and shove the activity off the grid
          name: "検索エージェント検索エージェント",
          model: "claude-haiku-4",
          ctx: 8_000,
          activity: "Grep: TODO",
          uptimeSec: 12,
        },
      ],
    });

    const frame = buildFrame([row], 160);
    const line = stripAnsi(
      frame.groups[0].lines.find((l) => l.includes("Grep: TODO"))!,
    );
    // the activity still starts at the BRANCH column, in terminal columns
    // (not code units, which a wide-character name makes disagree)
    const branchCol = stripAnsi(frame.header).indexOf("BRANCH");
    expect(visLen(line.slice(0, line.indexOf("Grep: TODO")))).toBe(branchCol);
    expect(line).toContain("…"); // cut to fit, rather than overflowing
  });

  test("marks a cross-provider agent child live and cyan in list and detail", () => {
    const row = baseRow({
      children: [
        {
          pid: 22222,
          name: "bash › copilot",
          mem: 256 * 1024 * 1024,
          cpu: 3.2,
          uptimeSec: 45,
          ports: [],
          agent: true,
        },
        {
          pid: 22223,
          name: "bash › go test",
          mem: 64 * 1024 * 1024,
          cpu: 1.0,
          uptimeSec: 12,
          ports: [],
          agent: false,
        },
      ],
    });

    const lines = buildFrame([row], 160).groups[0].lines;
    const agentRow = lines.find((l) => l.includes("copilot"))!;
    const plainRow = lines.find((l) => l.includes("go test"))!;
    // the agent child keeps the dim branch but its stats + name are cyan,
    // like the sub-agent rows — no status dot on the command line
    expect(agentRow).toContain(CYAN);
    expect(agentRow).not.toContain("●");
    expect(stripAnsi(agentRow)).toContain("22222");
    // an ordinary sub-process stays fully dim
    expect(plainRow).not.toContain("●");
    expect(plainRow).not.toContain(CYAN);

    const detail = renderDetail(row, 120);
    const agentDetail = detail.find((l) => l.includes("copilot"))!;
    const plainDetail = detail.find((l) => l.includes("go test"))!;
    // detail keeps just the cyan name — no dot in front of the command
    expect(agentDetail).toContain(CYAN);
    expect(agentDetail).not.toContain("●");
    expect(plainDetail).not.toContain("●");
    expect(plainDetail).not.toContain(CYAN);
  });

  test("detail view lists a sub-process's listening ports", () => {
    const row = baseRow({
      children: [
        {
          pid: 12346,
          name: "node server.js",
          mem: 64 * 1024 * 1024,
          cpu: 2.0,
          uptimeSec: 30,
          ports: [3000, 8080],
          agent: false,
        },
        {
          pid: 12347,
          name: "bash › make build",
          mem: 1024 * 1024,
          cpu: 0,
          uptimeSec: 5,
          ports: [],
          agent: false,
        },
      ],
    });
    const detail = stripAnsi(renderDetail(row, 120).join("\n"));
    // a listening process shows each port; one with none shows no stray colon
    expect(detail).toContain("node server.js  :3000 :8080");
    expect(detail).toContain("bash › make build");
    expect(detail).not.toContain("make build  :");
  });

  test("detail view flags orphan ports with a warning", () => {
    const row = baseRow({
      orphanPorts: [{ pid: 4242, name: "node", ports: [3000, 3001] }],
    });
    const detail = stripAnsi(renderDetail(row, 120).join("\n"));
    expect(detail).toContain("Orphan ports (1)");
    expect(detail).toContain("⚠");
    expect(detail).toContain("4242");
    expect(detail).toContain("node");
    expect(detail).toContain(":3000 :3001");
  });

  test("sanitizes untrusted table text while keeping trusted styling", () => {
    const frame = buildFrame(
      [
        baseRow({
          host: "Host\x1b]52;c;secret\x07",
          project: "/tmp/proj\x1b[2Ject",
          branch: "main\x1b[31m",
          prompt: "bad\x1b]52;c;secret\x07prompt\x1b[2J",
          children: [
            {
              pid: 12346,
              name: "node\x1b[31m-red",
              mem: 0,
              cpu: 0,
              uptimeSec: 1,
              ports: [],
              agent: false,
            },
          ],
          subagents: [
            {
              name: "code-locator\x1b[31m",
              model: "claude-sonnet-4\x1b[2J",
              ctx: 12_000,
              activity: "Read\x1b]52;c;secret\x07file",
              uptimeSec: 30,
            },
          ],
        }),
      ],
      160,
    );

    const raw = [...frame.summary, frame.header, ...frame.groups[0].lines].join(
      "\n",
    );
    expect(raw).not.toContain("\x1b]52");
    expect(raw).not.toContain("\x1b[2J");
    expect(raw).not.toContain("\x1b[31m");
    expect(raw).not.toContain("\x07");

    const plain = stripAnsi(raw);
    expect(plain).toContain("Host");
    expect(plain).toContain("badprompt");
    expect(plain).toContain("node-red");
    expect(plain).toContain("code-locator");
    expect(plain).toContain("Readfile");
  });

  test("renders detail view with sanitized untrusted text", () => {
    const lines = renderDetail(
      baseRow({
        sessionName: "name\x1b[2J",
        prompt: "prompt\x1b]52;c;secret\x07 text",
        lastTurn: "Bash\x1b]52;c;secret\x07: ls\x1b[2J",
        transcript: "/tmp/log\x1b[31m.jsonl",
      }),
      80,
    );
    const raw = lines.join("\n");
    expect(raw).not.toContain("\x1b]52");
    expect(raw).not.toContain("\x1b[2J");
    expect(stripAnsi(raw)).toContain("prompt text");
    expect(stripAnsi(raw)).toContain("Bash ls");
    expect(stripAnsi(raw)).toContain("/tmp/log.jsonl");
  });

  test("renders inline markdown (bold + code) in a text turn", () => {
    const raw = renderDetail(
      baseRow({ lastTurn: "squashed into **ahead 1** at `e0d7429` now" }),
      80,
    ).join("\n");
    // bold wraps the bolded word; inline code is blue
    expect(raw).toContain(`${BOLD}ahead${RESET}`);
    expect(raw).toContain(`${BLUE}e0d7429${RESET}`);
    // markers are stripped from the visible text
    const plain = stripAnsi(raw);
    expect(plain).toContain("ahead 1");
    expect(plain).toContain("e0d7429");
    expect(plain).not.toContain("**");
    expect(plain).not.toContain("`");
  });

  test("marks a brand-new session (no prompt/turn/context) in list and detail", () => {
    const fresh = baseRow({
      prompt: null,
      lastTurn: null,
      promptAt: null,
      contextTokens: null,
      sessionName: "Fresh Start",
    });
    // list: the PROMPT column reads "new session", not the session name
    const frame = buildFrame([fresh], 160);
    const rowLine = stripAnsi(frame.groups[0].lines[0]);
    expect(rowLine).toContain("new session");
    expect(rowLine).not.toContain("Fresh Start");
    // detail: one note, no Last Turn block
    const detail = stripAnsi(renderDetail(fresh, 120).join("\n"));
    expect(detail).toContain("new session — nothing yet");
    expect(detail).not.toContain("Last Turn");

    // a session with any activity is not "new"
    const active = stripAnsi(
      renderDetail(baseRow({ contextTokens: 5000 }), 120).join("\n"),
    );
    expect(active).not.toContain("new session");
    expect(active).toContain("Last Turn");
  });

  test("resolveDetail tracks the live row, then freezes it when it ends", () => {
    const a = baseRow({ sessionId: "a", cpu: 1 });
    const b = baseRow({ sessionId: "b", cpu: 2 });

    // live: returns the fresh row by key (not a stale snapshot), ended=false
    const stale = baseRow({ sessionId: "a", cpu: 99 });
    const live = resolveDetail([a, b], "a", stale);
    expect(live.row).toBe(a);
    expect(live.ended).toBe(false);

    // gone: the pinned session vanished — freeze the prior snapshot, ended=true,
    // and never fall back to a surviving neighbor (b)
    const gone = resolveDetail([b], "a", stale);
    expect(gone.row).toBe(stale);
    expect(gone.ended).toBe(true);

    // no snapshot and no live match: nothing to show
    const empty = resolveDetail([b], "a", null);
    expect(empty.row).toBeNull();
    expect(empty.ended).toBe(false);

    // null key (no selection): only a snapshot can be shown, and only as ended
    expect(resolveDetail([a], null, null).row).toBeNull();
    expect(resolveDetail([a], null, stale)).toEqual({
      row: stale,
      ended: true,
    });

    // recycled pid: a registry-less row is keyed by pid, so a different process
    // can reuse the pinned key. A live match whose start time differs from the
    // snapshot is an impostor — report ended (frozen), never adopt it.
    const oldProc = baseRow({ sessionId: null, pid: 999, startSec: 100 });
    const recycled = baseRow({ sessionId: null, pid: 999, startSec: 200 });
    expect(rowKey(oldProc)).toBe(rowKey(recycled)); // same key, different process
    const impostor = resolveDetail([recycled], "pid:999", oldProc);
    expect(impostor.row).toBe(oldProc);
    expect(impostor.ended).toBe(true);
    // same pid AND same start time is the genuine session — tracked live
    const same = baseRow({ sessionId: null, pid: 999, startSec: 100 });
    expect(resolveDetail([same], "pid:999", oldProc)).toEqual({
      row: same,
      ended: false,
    });
  });

  test("marks an ended session but keeps its last snapshot", () => {
    const row = baseRow({ state: "busy", prompt: "fix the parser" });
    // when ended, the panel is frozen: status reads "ended", but every other
    // field (last prompt, model, context, …) still shows the last snapshot
    const ended = stripAnsi(renderDetail(row, 120, true).join("\n"));
    expect(ended).toContain("session ended");
    expect(ended).toMatch(/state\s+ended/);
    expect(ended).not.toMatch(/state\s+busy/);
    expect(ended).toContain("fix the parser"); // last prompt preserved
    expect(ended).toContain("opus-4-8"); // model preserved

    // the live panel (default ended=false) shows the real state, no badge
    const live = stripAnsi(renderDetail(row, 120).join("\n"));
    expect(live).not.toContain("session ended");
    expect(live).toMatch(/state\s+busy/);

    // the badge and "ended" word are yellow so the frozen panel reads as stopped
    const styled = renderDetail(row, 120, true).join("\n");
    expect(styled).toContain(`${YELLOW}session ended${RESET}`);
    expect(styled).toContain(`${YELLOW}ended${RESET}`);
  });

  test("shows last prompt/turn times in the headers, not the state row", () => {
    const detail = stripAnsi(renderDetail(baseRow(), 120).join("\n"));
    expect(detail).toMatch(/Last Prompt\s+\d+\w ago/);
    expect(detail).toMatch(/Last Turn\s+\d+\w ago/);
    expect(detail).not.toContain("last turn"); // moved out of the state row
  });

  test("trims a long prompt at the head and a long text turn at the tail", () => {
    const many = (p: string) =>
      Array.from({ length: 60 }, (_, i) => `${p}${i}`).join(" ");
    const lines = renderDetail(
      baseRow({ prompt: many("P"), lastTurn: many("T") }),
      50,
    ).map(stripAnsi);
    const blockAfter = (header: string) => {
      const out: string[] = [];
      for (
        let i = lines.findIndex((l) => l.startsWith(header)) + 1;
        lines[i]?.startsWith("│");
        i++
      )
        out.push(lines[i]);
      return out;
    };
    const prompt = blockAfter("Last Prompt");
    const turn = blockAfter("Last Turn");
    expect(prompt).toHaveLength(3); // capped to BLOCK_LINES
    expect(turn).toHaveLength(3);
    // prompt keeps the head, … trails on the last line
    expect(prompt.join(" ")).toContain("P0");
    expect(prompt.join(" ")).not.toContain("P59");
    expect(prompt[2]).toContain("…");
    // turn keeps the tail, … leads on the first line
    expect(turn.join(" ")).toContain("T59");
    expect(turn.join(" ")).not.toContain("T0");
    expect(turn[0]).toContain("…");
  });
});

describe("usage limits line", () => {
  const NOW = 1_700_000_000_000; // fixed clock so countdowns are deterministic
  const sec = NOW / 1000;
  const usage = (o: Partial<Usage> = {}): Usage => ({
    sevenDayPct: null,
    sevenDayResetsAt: null,
    fiveHourPct: null,
    fiveHourResetsAt: null,
    capturedAt: sec,
    ...o,
  });

  test("formats both windows with two-unit reset countdowns", () => {
    const line = usageLine(
      usage({
        sevenDayPct: 8,
        sevenDayResetsAt: sec + 2 * 86400 + 9 * 3600,
        fiveHourPct: 60,
        fiveHourResetsAt: sec + 2 * 3600 + 32 * 60,
      }),
      NOW,
    );
    expect(stripAnsi(line ?? "")).toBe(
      "Limits: 8% 7d (2d9h left)  60% 5h (2h32m left)",
    );
  });

  test("rounds percentages and shows a single window alone", () => {
    expect(stripAnsi(usageLine(usage({ sevenDayPct: 8.7 }), NOW) ?? "")).toBe(
      "Limits: 9% 7d",
    );
  });

  test("heats high percentages toward red, leaves low ones plain", () => {
    const hot = usageLine(usage({ sevenDayPct: 92, fiveHourPct: 60 }), NOW)!;
    expect(hot).toContain(`${RED}92%`); // 92% -> red
    expect(hot).toContain(`${YELLOW}60%`); // 60% -> yellow
    const cool = usageLine(usage({ sevenDayPct: 8 }), NOW)!;
    expect(cool).not.toContain(RED);
    expect(cool).not.toContain(YELLOW);
  });

  test("appends the snapshot age when stale, keeping heat colors", () => {
    const line = usageLine(
      usage({
        sevenDayPct: 92,
        sevenDayResetsAt: sec + 2 * 86400,
        capturedAt: sec - 2 * 3600, // 2h old, past the 1h staleness window
      }),
      NOW,
    );
    expect(stripAnsi(line ?? "")).toBe("Limits: 92% 7d (2d left)  · 2h ago");
    expect(line).toContain(RED); // colors kept — the line is not dimmed
  });

  test("does not flag a recent snapshot as stale", () => {
    const line = usageLine(
      usage({ sevenDayPct: 8, capturedAt: sec - 30 * 60 }), // 30m, within 1h
      NOW,
    );
    expect(stripAnsi(line ?? "")).toBe("Limits: 8% 7d");
  });

  test("shows (due) for a window whose reset moment has already passed", () => {
    expect(
      stripAnsi(
        usageLine(
          usage({ fiveHourPct: 60, fiveHourResetsAt: sec - 10 }),
          NOW,
        ) ?? "",
      ),
    ).toBe("Limits: 60% 5h (due)");
  });

  test("returns null when there is no usable data", () => {
    expect(usageLine(null, NOW)).toBeNull();
    expect(usageLine(usage(), NOW)).toBeNull();
  });
});

// The bell marks the session behind the terminal bell you just heard: a red ○
// in the state gutter for BELL_MS after it stopped, plus a summary line naming
// it. Stateless and decaying, so these assert on bellAt relative to now.
describe("bell marker", () => {
  const idle = (over: Partial<Instance> = {}) =>
    baseRow({ state: "idle", ...over });

  test("swaps the status dot for a bell while a session is ringing", () => {
    const frame = buildFrame([idle({ bellAt: Date.now() - 4_000 })], 200);
    const line = frame.groups[0].lines[0];
    expect(line).toContain(`${RED}${BELL}${RESET}`);
    expect(line).not.toContain(`${RED}●${RESET}`);
  });

  test("still rings for a bellAt in the future (skewed clock)", () => {
    // isRinging reads a future bellAt as ringing (nowMs - bellAt is negative,
    // which is < BELL_MS); a Math.abs/clamp refactor would silently break this
    const frame = buildFrame([idle({ bellAt: Date.now() + 10_000 })], 200);
    expect(frame.groups[0].lines[0]).toContain(`${RED}${BELL}${RESET}`);
  });

  test("identifies the ringing session by project and pid", () => {
    // sessionName appears in no column, so the line must not use it — pid is the
    // only identifier here that is both unique and visible in the table
    const frame = buildFrame(
      [
        idle({
          pid: 1_737_989,
          sessionName: "cctop-92",
          project: "/Users/alice/src/cctop",
          bellAt: Date.now() - 4_000,
        }),
      ],
      200,
    );
    const bell = frame.summary
      .map(stripAnsi)
      .find((l) => l.startsWith("Bell:"));
    expect(bell).toBe(`Bell: ${BELL} cctop · pid 1737989 · 4s ago`);
    expect(bell).not.toContain("cctop-92");
  });

  test("pid tells apart two dings on the same project", () => {
    const now = Date.now();
    const frame = buildFrame(
      [
        idle({ sessionId: "a", pid: 111, bellAt: now - 20_000 }),
        idle({ sessionId: "b", pid: 222, bellAt: now - 2_000 }),
      ],
      200,
    );
    // both rows read "cctop" in PROJECT; only the newest is named, by its pid
    const bell = frame.summary
      .map(stripAnsi)
      .find((l) => l.startsWith("Bell:"));
    expect(bell).toBe(`Bell: ${BELL} cctop · pid 222 · 2s ago`);
  });

  test("falls back to ? when a session has no project", () => {
    const frame = buildFrame(
      [idle({ pid: 42, project: null, bellAt: Date.now() - 1_000 })],
      200,
    );
    const bell = frame.summary
      .map(stripAnsi)
      .find((l) => l.startsWith("Bell:"));
    expect(bell).toBe(`Bell: ${BELL} ? · pid 42 · 1s ago`);
  });

  test("holds a ding from long ago until its session goes busy again", () => {
    const now = Date.now();
    const long = buildFrame(
      [idle({ pid: 111, bellAt: now - 90 * 60_000 })],
      200,
    );
    expect(long.summary.map(stripAnsi).find((l) => l.startsWith("Bell:"))).toBe(
      `Bell: ${BELL} cctop · pid 111 · 1h ago`,
    );

    // answering it turns the session busy, which clears bellAt in collectRows;
    // the line then hands off to whoever is still waiting
    const answered = buildFrame(
      [
        baseRow({ sessionId: "a", pid: 111, state: "busy", bellAt: null }),
        idle({ sessionId: "b", pid: 222, bellAt: now - 5_000 }),
      ],
      200,
    );
    expect(
      answered.summary.map(stripAnsi).find((l) => l.startsWith("Bell:")),
    ).toBe(`Bell: ${BELL} cctop · pid 222 · 5s ago`);
  });

  test("the row glyph decays, but the summary keeps naming the ding", () => {
    const frame = buildFrame([idle({ bellAt: Date.now() - BELL_MS - 1 })], 200);
    // the row is back to a plain idle dot ...
    expect(frame.groups[0].lines[0]).toContain(`${RED}●${RESET}`);
    expect(frame.groups[0].lines[0]).not.toContain(BELL);
    // ... while the header still names who rang, however long ago
    expect(
      frame.summary.map(stripAnsi).find((l) => l.startsWith("Bell:")),
    ).toBe(`Bell: ${BELL} cctop · pid 12345 · 30s ago`);
  });

  test("never rings a busy session", () => {
    // collectRows leaves bellAt null while busy; the renderer must not invent one
    const frame = buildFrame([baseRow({ state: "busy", bellAt: null })], 200);
    expect(frame.groups[0].lines[0]).not.toContain(BELL);
    expect(frame.summary.some((l) => stripAnsi(l).startsWith("Bell:"))).toBe(
      false,
    );
  });

  test("keeps the columns aligned when a session rings", () => {
    // ○ is single-width like the ● it replaces, so a ringing row must measure
    // the same as a dotted one and nothing to its right shifts
    const now = Date.now();
    const frame = buildFrame(
      [
        idle({ sessionId: "a", bellAt: now - 4_000 }),
        idle({ sessionId: "b", bellAt: null }),
      ],
      200,
    );
    const [ringing, quiet] = frame.groups.map((g) => g.lines[0]);
    expect(visLen(ringing)).toBe(visLen(quiet));
  });

  test("carries the bell into the detail view, but not once ended", () => {
    const row = idle({ bellAt: Date.now() - 4_000 });
    expect(renderDetail(row, 80)[0]).toContain(`${RED}${BELL}${RESET}`);
    // an ended session's header is a *dim* ○ (same glyph as the bell), so assert
    // the absence of the red-wrapped bell specifically, not the bare glyph
    expect(renderDetail(row, 80, true)[0]).not.toContain(
      `${RED}${BELL}${RESET}`,
    );
  });
});

// newestBell is the shared selector: the Bell: summary line names its result and
// the `b` key jumps to it, so pinning it here guarantees the two can't drift.
describe("newestBell", () => {
  const at = (id: string, bellAt: number | null) =>
    baseRow({ sessionId: id, state: "idle", bellAt });

  test("returns the row with the newest bellAt", () => {
    const now = Date.now();
    const rows = [at("a", now - 20_000), at("b", now - 2_000), at("c", null)];
    expect(newestBell(rows)?.sessionId).toBe("b");
  });

  test("keeps the first row on a tie", () => {
    const t = Date.now() - 5_000;
    const rows = [at("first", t), at("second", t)];
    expect(newestBell(rows)?.sessionId).toBe("first");
  });

  test("returns null when nothing is waiting", () => {
    expect(newestBell([])).toBeNull();
    expect(newestBell([at("a", null), at("b", null)])).toBeNull();
  });
});

// The visible column set from settings.json: the fixed head (state..model) is
// the tree layout's skeleton and always renders; the optional tail can be
// hidden and reordered. Absent config must stay bit-identical to today.
describe("configurable columns", () => {
  const header = (columns?: string[] | null) =>
    stripAnsi(buildFrame([baseRow()], 200, null, null, columns).header);
  const rowText = (columns?: string[] | null) =>
    stripAnsi(
      buildFrame([baseRow()], 200, null, null, columns).groups[0].lines[0],
    );

  test("null keeps the default set and order", () => {
    expect(header(null)).toBe(header(undefined));
    for (const h of ["PID", "MODEL", "VER", "HOST", "PROJECT", "BRANCH"])
      expect(header(null)).toContain(h);
  });

  test("hides the listed-out columns, keeping the fixed head", () => {
    const h = header(["project", "branch", "last-action", "prompt"]);
    expect(h).not.toContain("VER");
    expect(h).not.toContain("HOST");
    expect(h).toContain("PROJECT");
    expect(h).toContain("MODEL"); // fixed head untouched
    const r = rowText(["project", "branch", "last-action", "prompt"]);
    expect(r).not.toContain("2.1.177"); // version value gone with its column
    expect(r).not.toContain("Ghostty"); // host value too
    expect(r).toContain("implement tests");
  });

  test("honors the configured order", () => {
    const h = header(["branch", "project", "prompt"]);
    expect(h.indexOf("BRANCH")).toBeGreaterThan(-1);
    expect(h.indexOf("BRANCH")).toBeLessThan(h.indexOf("PROJECT"));
    expect(h.indexOf("PROJECT")).toBeLessThan(h.indexOf("PROMPT"));
  });

  test("name is absent by default and appears once listed", () => {
    expect(header(null)).not.toContain("NAME");
    expect(rowText(null)).not.toContain("session name");
    const h = header(["name", "project", "prompt"]);
    expect(h).toContain("NAME");
    expect(h.indexOf("NAME")).toBeLessThan(h.indexOf("PROJECT"));
    expect(rowText(["name", "project", "prompt"])).toContain("session name");
  });

  test("an unnamed session leaves the name column blank, not missing", () => {
    const line = stripAnsi(
      buildFrame([baseRow({ sessionName: null })], 200, null, null, [
        "name",
        "prompt",
      ]).groups[0].lines[0],
    );
    expect(line).toContain("-");
    expect(line).toContain("implement tests");
  });

  test("drops unknown names and duplicates", () => {
    const h = header(["bogus", "prompt", "prompt"]);
    expect(h).not.toContain("bogus");
    expect(h.match(/PROMPT/g)?.length).toBe(1);
  });

  test("an empty list ends the table at the fixed head", () => {
    const h = header([]);
    expect(h).toContain("MODEL");
    for (const gone of ["VER", "HOST", "PROJECT", "BRANCH", "PROMPT"])
      expect(h).not.toContain(gone);
  });

  test("a hidden column frees its width for the prompt", () => {
    // the host is capped at MAX_HOST_W in the cells, so hiding VER + HOST
    // frees their capped widths plus gaps (~35 cols), not the raw 78 chars
    const longHost = baseRow({
      host: "chrome --profile-directory=Profile 1 --app-id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      prompt: "p".repeat(200),
    });
    const width = 160;
    const promptLen = (columns: string[] | null) => {
      const line = stripAnsi(
        buildFrame([longHost], width, null, null, columns).groups[0].lines[0],
      );
      return (line.match(/p{5,}/) ?? [""])[0].length;
    };
    expect(
      promptLen(["project", "branch", "last-action", "prompt"]),
    ).toBeGreaterThan(promptLen(null) + 30);
  });

  test("agent names survive hiding the columns they span", () => {
    const row = baseRow({
      subagents: [
        {
          name: "code-locator",
          model: "claude-sonnet-4",
          ctx: 42_000,
          activity: "Read",
          uptimeSec: 65,
        },
      ],
    });
    const frame = buildFrame([row], 200, null, null, ["prompt"]);
    const text = stripAnsi(frame.groups[0].lines.join("\n"));
    expect(text).toContain("code-locator");
    expect(text).toContain("Read");
  });

  test("prompt stays capped when reordered off the final slot", () => {
    const width = 120;
    const row = baseRow({ prompt: "p".repeat(300) });
    const line = stripAnsi(
      buildFrame([row], width, null, null, ["prompt", "branch"]).groups[0]
        .lines[0],
    );
    expect(visLen(line.trimEnd())).toBeLessThanOrEqual(width);
    expect(line).toContain("main"); // branch still renders after the prompt
  });
});
