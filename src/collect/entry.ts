// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Minimal shapes over Claude Code's undocumented transcript JSONL. Only the
// fields cctop actually reads are named, everything is optional, and message
// content stays `unknown` so it is narrowed at each use site — a malformed or
// half-written line is handled by the readers, never typed into safety.

export interface TokenUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface AssistantMessage {
  model?: string;
  usage?: TokenUsage;
  content?: unknown;
}

export interface TranscriptEntry {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  gitBranch?: string;
  message?: AssistantMessage;
}

// A message's text: string content as-is, otherwise the first text block.
// Both prompt pickers (a session's last prompt and a sub-agent's first)
// extract text this way, so it lives in this shared leaf.
export function firstText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // the block's text is raw JSON, so it is not a string just because the
    // shape says "text": narrowed here rather than at each caller, one of
    // which would otherwise call a string method on whatever was written
    const text = content.find((b: any) => b?.type === "text")?.text;
    return typeof text === "string" ? text : undefined;
  }
  return undefined;
}

// A turn's context window is fresh input plus both cache buckets. The main
// scanner and the sub-agent scanner report the same number, so the arithmetic
// lives in one place.
export const contextTokens = (u: TokenUsage | undefined): number =>
  (u?.input_tokens ?? 0) +
  (u?.cache_read_input_tokens ?? 0) +
  (u?.cache_creation_input_tokens ?? 0);

// What a turn did, from an assistant message: the most recent tool call (tool +
// its key argument) or, failing that, a snippet of the latest message text.
// Used both as a sub-agent's live label and as a session's "last turn" line, so
// it lives in this shared leaf alongside contextTokens.
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit"]);
export function describeAssistant(msg: any): string | null {
  const blocks = msg?.content;
  if (!Array.isArray(blocks)) return null;
  const tool = [...blocks].reverse().find((b) => b?.type === "tool_use");
  if (tool) {
    const inp = tool.input ?? {};
    let arg = String(
      inp.command ??
        inp.pattern ??
        inp.query ??
        inp.url ??
        inp.file_path ??
        inp.path ??
        inp.description ??
        inp.subagent_type ??
        "",
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    if (FILE_TOOLS.has(tool.name) && arg.includes("/"))
      arg = arg.split("/").pop()!;
    return arg ? `${tool.name}: ${arg}` : tool.name;
  }
  const text = [...blocks].reverse().find((b) => b?.type === "text")?.text;
  return text ? text.replace(/\s+/g, " ").trim() : null;
}
