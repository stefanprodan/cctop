// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { __test as H } from "../src/collect/history.ts";
import { visLen } from "../src/format.ts";
import { __test as R, renderHistory } from "../src/history.ts";

// Local-time ISO without a trailing Z, so Date.parse treats it as local and the
// day buckets are deterministic regardless of the runner's TZ.
const aTurn = (
  ts: string,
  usage: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts,
    cwd: "/Users/a/proj",
    message: { model: "claude-sonnet-4-6", usage, content: [] },
    ...extra,
  });

describe("history aggregation", () => {
  test("buckets assistant turns by local day and sums token classes", () => {
    const c = H.aggregateLines([
      aTurn("2026-06-20T01:00:00", {
        input_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
        output_tokens: 5,
      }),
      aTurn("2026-06-20T05:00:00", { input_tokens: 1, output_tokens: 2 }),
      aTurn("2026-06-21T05:00:00", { input_tokens: 7 }),
    ]);
    expect(c.days.size).toBe(2);
    const d20 = c.days.get("2026-06-20")!;
    expect(d20.inputFresh).toBe(101);
    expect(d20.cacheRead).toBe(50);
    expect(d20.cacheCreate).toBe(10);
    expect(d20.output).toBe(7);
    expect(d20.turns).toBe(2);
    expect(c.days.get("2026-06-21")!.turns).toBe(1);
  });

  test("tallies model/project totals over total tokens of each turn", () => {
    const c = H.aggregateLines([
      aTurn("2026-06-20T01:00:00", { input_tokens: 100, output_tokens: 5 }),
      aTurn("2026-06-20T02:00:00", { input_tokens: 10 }),
    ]);
    expect(c.byModel.get("claude-sonnet-4-6")).toEqual({
      tokens: 115,
      turns: 2,
    });
    // projects are keyed by full cwd now; the renderer shortens to last dirs
    expect(c.byProject.get("/Users/a/proj")).toEqual({ tokens: 115, turns: 2 });
  });

  // Each content block of a message is its own entry repeating the message's
  // usage; the message must count as one turn, input once, output at its max.
  test("counts a message split across block entries once", () => {
    const block = (type: string, output: number) =>
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-20T01:00:00",
        cwd: "/Users/a/proj",
        message: {
          id: "msg_1",
          model: "claude-sonnet-4-6",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 1000,
            output_tokens: output,
          },
          content: [{ type, name: "Bash" }],
        },
      });
    const c = H.aggregateLines([
      block("thinking", 8),
      block("text", 8),
      block("tool_use", 300),
    ]);
    const d = c.days.get("2026-06-20")!;
    expect(d.inputFresh).toBe(10);
    expect(d.cacheRead).toBe(1000);
    expect(d.output).toBe(300);
    expect(d.turns).toBe(1);
    expect(c.byModel.get("claude-sonnet-4-6")).toEqual({
      tokens: 1310,
      turns: 1,
    });
    expect(c.byProject.get("/Users/a/proj")).toEqual({
      tokens: 1310,
      turns: 1,
    });
    expect(c.byTool.get("Bash")).toBe(1); // blocks still count their tools
  });

  test("counts tool_use blocks and server web tools", () => {
    const c = H.aggregateLines([
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-20T01:00:00",
        cwd: "/p",
        message: {
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 1,
            server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
          },
          content: [
            { type: "tool_use", name: "Bash", input: {} },
            { type: "tool_use", name: "Bash", input: {} },
            { type: "text", text: "hi" },
          ],
        },
      }),
    ]);
    expect(c.byTool.get("Bash")).toBe(2);
    expect(c.byTool.get("web_search")).toBe(2);
    expect(c.byTool.get("web_fetch")).toBe(1);
  });

  test("skips sidechain, synthetic, usage-less, and malformed lines", () => {
    const c = H.aggregateLines([
      aTurn("2026-06-20T01:00:00", { input_tokens: 9 }, { isSidechain: true }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-20T01:00:00",
        message: { model: "<synthetic>", usage: { input_tokens: 9 } },
      }),
      JSON.stringify({ type: "user", timestamp: "2026-06-19T01:00:00" }),
      "{ not json",
      aTurn("2026-06-20T03:00:00", { input_tokens: 4 }),
    ]);
    expect(c.days.size).toBe(1);
    expect(c.days.get("2026-06-20")!.turns).toBe(1);
    // a user turn with no usage still sets the earliest-seen timestamp
    expect(H.dateKey(new Date(c.firstTs!))).toBe("2026-06-19");
  });

  test("a sub-agent file counts its sidechain turns and starts no session", () => {
    const c = H.aggregateLines(
      [
        aTurn(
          "2026-06-20T01:00:00",
          { input_tokens: 5 },
          { isSidechain: true },
        ),
      ],
      false, // sub-agent transcript
    );
    expect(c.days.get("2026-06-20")!.turns).toBe(1); // sidechain turn counted
    expect(c.firstTs).toBeNull(); // not a session, no session-start day
  });
});

describe("history merge", () => {
  test("gap-fills days, folds in session starts, and totals", () => {
    const c1 = H.aggregateLines([
      aTurn("2026-06-20T01:00:00", { input_tokens: 10 }),
    ]);
    const c2 = H.aggregateLines([
      aTurn("2026-06-22T01:00:00", { input_tokens: 20 }),
    ]);
    const h = H.merge([c1, c2], 0); // 0 sub-agent files
    expect(h.days.map((d) => d.date)).toEqual([
      "2026-06-20",
      "2026-06-21",
      "2026-06-22",
    ]);
    expect(h.days[1].turns).toBe(0); // zero-filled gap day
    expect(h.days[0].sessionsStarted).toBe(1);
    expect(h.days[2].sessionsStarted).toBe(1);
    expect(h.totals).toMatchObject({
      tokens: 30,
      turns: 2,
      sessions: 2,
      subAgents: 0,
      firstDay: "2026-06-20",
      lastDay: "2026-06-22",
    });
  });

  test("folds sub-agent turns into totals but not the session count", () => {
    const main = H.aggregateLines([
      aTurn("2026-06-20T01:00:00", { input_tokens: 10 }),
    ]);
    const sub = H.aggregateLines(
      [
        aTurn(
          "2026-06-20T02:00:00",
          { input_tokens: 7 },
          { isSidechain: true },
        ),
      ],
      false,
    );
    const h = H.merge([main, sub], 1); // 1 sub-agent file
    expect(h.totals.sessions).toBe(1); // only the session file
    expect(h.totals.subAgents).toBe(1);
    expect(h.totals.turns).toBe(2); // both turns counted
    expect(h.totals.tokens).toBe(17);
    expect(h.days[0].turns).toBe(2);
  });

  test("tracks sessions per project and folds subdir work into the parent", () => {
    const turn = (cwd: string, session: boolean) =>
      H.aggregateLines(
        [
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-06-20T01:00:00",
            cwd,
            message: {
              model: "claude-opus-4-8",
              usage: { input_tokens: 10 },
              content: [],
            },
            ...(session ? {} : { isSidechain: true }),
          }),
        ],
        session,
      );
    // two sessions in the repo root, plus sub-agent work in a subdirectory
    const h = H.merge(
      [
        turn("/repo", true),
        turn("/repo", true),
        turn("/repo/web", false), // sub-agent that cd'd into a subdir
      ],
      1,
    );
    const proj = h.byProject.get("/repo")!;
    expect(proj.sessions).toBe(2); // both session files
    expect(proj.turns).toBe(3); // subdir turns folded in
    expect(proj.tokens).toBe(30);
    expect(h.byProject.has("/repo/web")).toBe(false); // not a separate row
  });

  test("keeps a child with its own sessions out of a parent project", () => {
    const turn = (cwd: string) =>
      H.aggregateLines([
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-06-20T01:00:00",
          cwd,
          message: {
            model: "claude-opus-4-8",
            usage: { input_tokens: 10 },
            content: [],
          },
        }),
      ]);
    // one session in an org dir must not swallow the repos beneath it
    const h = H.merge([turn("/org"), turn("/org/repo"), turn("/org/repo")], 0);
    expect(h.byProject.get("/org")).toEqual({
      tokens: 10,
      turns: 1,
      sessions: 1,
    });
    expect(h.byProject.get("/org/repo")).toEqual({
      tokens: 20,
      turns: 2,
      sessions: 2,
    });
  });
});

describe("buildSessions", () => {
  // an assistant turn with explicit cwd / model / tool blocks
  const turn = (
    ts: string,
    o: {
      input?: number;
      tools?: string[];
      model?: string;
      sidechain?: boolean;
    },
  ) =>
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      cwd: "/Users/a/proj",
      isSidechain: o.sidechain,
      message: {
        model: o.model ?? "claude-opus-4-8",
        usage: { input_tokens: o.input ?? 0 },
        content: (o.tools ?? []).map((name) => ({
          type: "tool_use",
          name,
          input: {},
        })),
      },
    });
  const tfile = (path: string, session: boolean) => ({
    path,
    mtimeMs: 0,
    size: 0,
    session,
  });

  test("folds sub-agents by id, drops empties, sorts newest first", () => {
    const main = H.aggregateLines([
      turn("2026-06-20T10:00:00", { input: 100, tools: ["Bash"] }),
      turn("2026-06-20T10:30:00", { input: 50, tools: ["Read", "Edit"] }),
    ]);
    const sub = H.aggregateLines(
      [
        turn("2026-06-20T10:15:00", {
          input: 20,
          tools: ["Grep"],
          sidechain: true,
        }),
      ],
      false,
    );
    const empty = H.aggregateLines([
      JSON.stringify({ type: "user", timestamp: "2026-06-20T09:00:00" }),
    ]);
    const later = H.aggregateLines([
      turn("2026-06-21T10:00:00", { input: 5, tools: ["Bash"] }),
    ]);

    const rows = H.buildSessions(
      [
        tfile("/c/projects/proj/sess1.jsonl", true),
        tfile("/c/projects/proj/sess1/subagents/wf/a.jsonl", false), // sub-agent of sess1
        tfile("/c/projects/proj/empty.jsonl", true),
        tfile("/c/projects/proj/sess2.jsonl", true),
      ],
      [main, sub, empty, later],
    );

    // the empty (assistant-less) session is dropped; newest start first
    expect(rows.map((r) => r.id)).toEqual(["sess2", "sess1"]);

    const s1 = rows.find((r) => r.id === "sess1")!;
    expect(s1.tokens).toBe(170); // 100 + 50 + 20 (sub-agent folded in)
    expect(s1.turns).toBe(3); // 2 main + 1 sub-agent
    expect(s1.tools).toBe(4); // Bash, Read, Edit + Grep
    expect(s1.model).toBe("claude-opus-4-8");
    expect(s1.project).toBe("/Users/a/proj");
    expect(s1.startTs).toBe(Date.parse("2026-06-20T10:00:00"));
    expect(s1.endTs).toBe(Date.parse("2026-06-20T10:30:00"));
  });
});

describe("activity chart", () => {
  test("an active day never scales down to a blank bar", () => {
    expect(R.barEighths(0, 1000)).toBe(0); // no activity → blank
    expect(R.barEighths(1, 1000)).toBe(1); // tiny day still shows one eighth
    expect(R.barEighths(26, 3690)).toBeGreaterThanOrEqual(1); // the regression
    expect(R.barEighths(1000, 1000)).toBe(56); // peak fills the full height
  });
});

describe("formatting", () => {
  test("big formats compact magnitudes", () => {
    expect(R.big(500)).toBe("500");
    expect(R.big(1500)).toBe("2k");
    expect(R.big(1_500_000)).toBe("1.5M");
    expect(R.big(2_000_000_000)).toBe("2.0B");
    // decimals=0 (the chart axis): rounded, no ".9M" noise
    expect(R.big(711_900_000, 0)).toBe("712M");
    expect(R.big(1_500_000_000, 0)).toBe("2B");
  });

  test("shortTool rewrites mcp ids to server:tool, passing built-ins through", () => {
    expect(R.shortTool("Bash")).toBe("Bash");
    expect(R.shortTool("web_search")).toBe("web_search");
    // server collapses to its last segment; plugin_ wrapper and -mcp noise drop
    expect(
      R.shortTool(
        "mcp__plugin_chrome-devtools-mcp_chrome-devtools__evaluate_script",
      ),
    ).toBe("chrome-devtools:evaluate_script");
    expect(R.shortTool("mcp__bun-docs__search_bun")).toBe(
      "bun-docs:search_bun",
    );
    expect(R.shortTool("mcp__claude_ai_Slack__slack_send_message")).toBe(
      "Slack:slack_send_message",
    );
    // a tool name that itself contains __ keeps its tail intact
    expect(R.shortTool("mcp__github__a__b")).toBe("github:a__b");
    // malformed (no <server>__<tool> split) is left as the remainder
    expect(R.shortTool("mcp__weird")).toBe("weird");
  });

  test("rankTools merges MCP ids that shorten to the same label", () => {
    const byTool = new Map([
      ["Bash", 5],
      ["mcp__chrome-devtools__click", 3],
      ["mcp__plugin_chrome-devtools-mcp_chrome-devtools__click", 2],
      ["mcp__bun-docs__search_bun", 4],
    ]);
    expect(R.rankTools(byTool, true)).toEqual([
      ["chrome-devtools:click", 5],
      ["bun-docs:search_bun", 4],
    ]);
    expect(R.rankTools(byTool, false)).toEqual([["Bash", 5]]);
  });
});

describe("project periods", () => {
  // local noon on Wednesday the 22nd: the week began Monday the 20th, the month the 1st
  const wed = new Date(2026, 6, 22, 12).getTime();

  test("periodStarts finds the calendar week (Monday) and month", () => {
    expect(R.periodStarts(wed)).toEqual({
      week: "2026-07-20",
      month: "2026-07-01",
    });
    // a Sunday belongs to the week that began the Monday before
    expect(R.periodStarts(new Date(2026, 6, 26, 12).getTime()).week).toBe(
      "2026-07-20",
    );
  });

  test("topProjects ranks by tokens within a window, folded paths included", () => {
    const turn = (ts: string, cwd: string, tokens: number) =>
      H.aggregateLines([
        JSON.stringify({
          type: "assistant",
          timestamp: ts,
          cwd,
          message: {
            model: "claude-opus-4-8",
            usage: { input_tokens: tokens },
            content: [],
          },
        }),
      ]);
    const h = H.merge(
      [
        turn("2026-07-02T10:00:00", "/old", 1000), // this month, before the week
        turn("2026-07-21T10:00:00", "/new", 10),
        // a 0-session sub-agent subdir: folds into /new, days and all
        H.aggregateLines(
          [
            JSON.stringify({
              type: "assistant",
              timestamp: "2026-07-21T11:00:00",
              cwd: "/new/web",
              isSidechain: true,
              message: {
                model: "claude-opus-4-8",
                usage: { input_tokens: 5 },
                content: [],
              },
            }),
          ],
          false,
        ),
      ],
      1,
    );
    const { week, month } = R.periodStarts(wed);
    expect(R.topProjects(h, week)).toEqual([["/new", 15]]);
    expect(R.topProjects(h, month)).toEqual([
      ["/old", 1000],
      ["/new", 15],
    ]);
    expect(R.topProjects(h, month, 1)).toEqual([["/old", 1000]]);
  });
});

describe("renderHistory", () => {
  test("empty history shows a note, not charts", () => {
    const h = H.merge([], 0);
    const lines = renderHistory(h, 80);
    expect(lines.join("\n")).toContain("No transcript history");
  });

  test("every rendered row fits the column budget", () => {
    const c = H.aggregateLines([
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-20T01:00:00",
        cwd: "/Users/a/some-long-project-name",
        message: {
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 1000,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 200,
            output_tokens: 300,
          },
          content: [
            { type: "tool_use", name: "Bash", input: {} },
            {
              type: "tool_use",
              name: "mcp__plugin_chrome-devtools-mcp_chrome-devtools__evaluate_script",
              input: {},
            },
          ],
        },
      }),
      aTurn("2026-06-25T02:00:00", { input_tokens: 42, output_tokens: 9 }),
    ]);
    const h = H.merge([c], 1);
    for (const width of [60, 80, 120]) {
      for (const line of renderHistory(h, width))
        expect(visLen(line)).toBeLessThanOrEqual(width);
    }
  });

  test("built-in and MCP tools render in separate Tools / MCP lists", () => {
    const c = H.aggregateLines([
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-20T01:00:00",
        cwd: "/Users/a/proj",
        message: {
          model: "claude-opus-4-8",
          usage: { input_tokens: 100 },
          content: [
            { type: "tool_use", name: "Bash", input: {} },
            { type: "tool_use", name: "mcp__bun-docs__search_bun", input: {} },
          ],
        },
      }),
    ]);
    const text = renderHistory(H.merge([c], 0), 120).join("\n");
    expect(text).toContain("Tools");
    expect(text).toContain("MCP");
    // the MCP tool shows rewritten under its own list, not the raw mcp__ id
    expect(text).toContain("bun-docs:search_bun");
    expect(text).not.toContain("mcp__bun-docs");
  });

  test("tabs: Stats shows period lists, Projects the full table", () => {
    const h = H.merge(
      [aTurn("2026-06-20T01:00:00", { input_tokens: 7 })].map((l) =>
        H.aggregateLines([l]),
      ),
      0,
    );
    const now = new Date(2026, 5, 20, 12).getTime();
    const stats = renderHistory(h, 120, "stats", { now }).join("\n");
    for (const t of ["Stats", "Projects", "Sessions"])
      expect(stats).toContain(t);
    expect(stats.indexOf("Stats")).toBeLessThan(stats.indexOf("Projects"));
    for (const t of ["Top projects this week", "This month"])
      expect(stats).toContain(t);
    expect(stats).not.toContain("Overall"); // all-time is the Projects tab
    expect(stats).not.toContain("Turns"); // the table lives on its own tab now
    const projects = renderHistory(h, 120, "projects", { now }).join("\n");
    expect(projects).toContain("Turns");
    expect(projects).toContain("a/proj");
    expect(projects).not.toContain("This week");
  });

  test("the sessions tab lists sessions and fits the column budget", () => {
    const c = H.aggregateLines([
      aTurn("2026-06-20T01:00:00", { input_tokens: 1_000_000 }),
    ]);
    const sessions = [
      {
        id: "abc",
        project: "/Users/a/some-long-project-name",
        model: "claude-opus-4-8",
        startTs: Date.parse("2026-06-20T13:34:00"),
        endTs: Date.parse("2026-06-20T14:00:00"),
        tokens: 1_500_000,
        turns: 42,
        tools: 99,
      },
    ];
    const h = H.merge([c], 0, sessions);
    const stacked = renderHistory(h, 120, "sessions").join("\n");
    // tab bar present, and the session row shows under the Sessions tab
    expect(stacked).toContain("Sessions");
    expect(stacked).toContain("Stats");
    expect(stacked).toContain("Age");
    expect(stacked).toContain("a/some-long-project-name");
    expect(stacked).toContain("opus-4-8");
    for (const width of [60, 80, 120])
      for (const line of renderHistory(h, width, "sessions"))
        expect(visLen(line)).toBeLessThanOrEqual(width);
  });

  test("the sessions tab excludes live sessions", () => {
    const c = H.aggregateLines([
      aTurn("2026-06-20T01:00:00", { input_tokens: 1000 }),
    ]);
    const sessions = [
      {
        id: "live",
        project: "/a/x",
        model: "claude-opus-4-8",
        startTs: 1e12,
        endTs: 1e12,
        tokens: 9,
        turns: 1,
        tools: 1,
      },
      {
        id: "done",
        project: "/a/y",
        model: "claude-opus-4-8",
        startTs: 1e12,
        endTs: 1e12,
        tokens: 9,
        turns: 1,
        tools: 1,
      },
    ];
    const h = H.merge([c], 0, sessions);
    const text = renderHistory(h, 120, "sessions", {
      liveIds: new Set(["live"]),
    }).join("\n");
    expect(text).toContain("a/y"); // ended session shown
    expect(text).not.toContain("a/x"); // live session hidden
  });
});
