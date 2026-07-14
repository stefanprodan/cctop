// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { __test } from "../src/collect.ts";
import { execPath } from "../src/proc/linux.ts";

// The Linux source's pure pieces. Importing linux.ts touches no /proc — module
// load is side-effect-free — so these run on either platform.
describe("executable path (/proc/<pid>/exe)", () => {
  test("strips the marker left when the binary is gone", () => {
    expect(execPath("/u/claude/versions/2.1.206 (deleted)")).toBe(
      "/u/claude/versions/2.1.206",
    );
    expect(execPath("/usr/bin/node")).toBe("/usr/bin/node");
  });

  // only the marker, and only at the end: a path may legitimately contain the
  // word, and a file may legitimately be named for it
  test("leaves a path that merely contains the word alone", () => {
    expect(execPath("/srv/ (deleted)/bin/tool")).toBe(
      "/srv/ (deleted)/bin/tool",
    );
    expect(execPath("/srv/deleted")).toBe("/srv/deleted");
  });

  // Why the strip is load-bearing. Claude Code auto-upgrades under a live
  // session, so a long-running one ends up executing a binary that is no longer
  // on disk. A nested or resumed session is recognized only by its exec path
  // agreeing with argv[0] — leave the marker on and that agreement breaks, and a
  // real session silently stops being one.
  test("keeps a session whose binary was upgraded out from under it", () => {
    const raw = "/u/claude/versions/2.1.206 (deleted)";
    const proc = {
      pid: 1,
      ppid: 1,
      rss: 0,
      cpuSec: 0,
      startSec: 0,
      path: execPath(raw),
      name: "2.1.206", // argv[0]: the version-named binary, invoked directly
      sub: null, // a session, so no subcommand
      uid: 0,
    };
    expect(__test.isClaudeProc(proc)).toBe(true);
  });
});
