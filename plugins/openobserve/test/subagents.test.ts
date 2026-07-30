import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseRolloutTranscript } from "../src/parser.ts";
import { discoverSubagents } from "../src/subagents.ts";
import type { StopHookInput } from "../src/types.ts";

describe("child session discovery", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "openobserve-codex-subagents-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("loads nested child sessions from the nearest sessions root", async () => {
    const sessionsRoot = join(root, ".codex", "sessions");
    const parentPath = join(sessionsRoot, "2026", "07", "29", "rollout-parent.jsonl");
    const childPath = join(sessionsRoot, "2026", "07", "30", "rollout-child.jsonl");
    const grandchildPath = join(sessionsRoot, "2026", "07", "30", "rollout-grandchild.jsonl");
    const parentTranscript = sessionTranscript("parent", {
      callId: "call-parent-child",
      sessionId: "child",
    });

    await Promise.all([
      writeTranscript(parentPath, parentTranscript),
      writeTranscript(
        childPath,
        sessionTranscript("child", {
          callId: "call-child-grandchild",
          sessionId: "grandchild",
        }),
      ),
      writeTranscript(grandchildPath, sessionTranscript("grandchild")),
    ]);

    const parent = parseSession(parentTranscript, parentPath, "parent");
    const result = await discoverSubagents(parent, parentPath);

    expect(result).toBe(parent);
    expect(parent.subagents).toHaveLength(1);
    expect(parent.subagents[0]).toMatchObject({
      parentCallId: "call-parent-child",
      session: { id: "child" },
    });
    expect(parent.subagents[0]?.session.subagents[0]).toMatchObject({
      parentCallId: "call-child-grandchild",
      session: { id: "grandchild" },
    });
  });

  it("reports a missing child transcript without including message content", async () => {
    const sessionsRoot = join(root, "sessions");
    await mkdir(sessionsRoot);
    const privateMessage = "private transcript body";
    const parentTranscript = sessionTranscript(
      "parent",
      { callId: "call-missing", sessionId: "missing" },
      privateMessage,
    );
    const parent = parseSession(parentTranscript, join(root, "parent.jsonl"), "parent");

    await discoverSubagents(parent, join(root, "parent.jsonl"), { sessionsRoot });

    expect(parent.subagents).toEqual([]);
    expect(parent.diagnostics).toContain(
      "Child transcript was not found for tool call call-missing",
    );
    expect(parent.diagnostics.join(" ")).not.toContain(privateMessage);
  });

  it("detects a child-session cycle", async () => {
    const sessionsRoot = join(root, "sessions");
    const parentPath = join(sessionsRoot, "rollout-parent.jsonl");
    const childPath = join(sessionsRoot, "rollout-child.jsonl");
    const parentTranscript = sessionTranscript("parent", {
      callId: "call-parent-child",
      sessionId: "child",
    });

    await Promise.all([
      writeTranscript(parentPath, parentTranscript),
      writeTranscript(
        childPath,
        sessionTranscript("child", {
          callId: "call-child-parent",
          sessionId: "parent",
        }),
      ),
    ]);

    const parent = parseSession(parentTranscript, parentPath, "parent");
    await discoverSubagents(parent, parentPath);

    const child = parent.subagents[0]?.session;
    expect(child?.subagents).toEqual([]);
    expect(child?.diagnostics).toContain(
      "Child session cycle detected for tool call call-child-parent",
    );
  });

  it("enforces child-depth and transcript-file limits", async () => {
    const sessionsRoot = join(root, "limited-sessions");
    const parentPath = join(root, "parent.jsonl");
    const parentTranscript = sessionTranscript("parent", {
      callId: "call-parent-child",
      sessionId: "child",
    });
    await Promise.all([
      writeTranscript(
        join(sessionsRoot, "rollout-child.jsonl"),
        sessionTranscript("child", {
          callId: "call-child-grandchild",
          sessionId: "grandchild",
        }),
      ),
      writeTranscript(
        join(sessionsRoot, "rollout-grandchild.jsonl"),
        sessionTranscript("grandchild"),
      ),
    ]);

    const depthLimited = parseSession(parentTranscript, parentPath, "parent");
    await discoverSubagents(depthLimited, parentPath, { sessionsRoot, maxDepth: 1 });
    const depthLimitedChild = depthLimited.subagents[0]?.session;
    expect(depthLimitedChild?.subagents).toEqual([]);
    expect(depthLimitedChild?.diagnostics).toContain(
      "Child session depth limit (1) reached for tool call call-child-grandchild",
    );

    const fileLimited = parseSession(parentTranscript, parentPath, "parent");
    await discoverSubagents(fileLimited, parentPath, { sessionsRoot, maxFiles: 1 });
    const fileLimitedChild = fileLimited.subagents[0]?.session;
    expect(fileLimitedChild?.subagents).toEqual([]);
    expect(fileLimitedChild?.diagnostics).toContain(
      "Child transcript scan file limit reached for tool call call-child-grandchild",
    );
  });

  it("does not scan the filesystem when there are no child session IDs", async () => {
    const parentPath = join(root, "parent.jsonl");
    const parentTranscript = sessionTranscript("parent");
    const parent = parseSession(parentTranscript, parentPath, "parent");

    await discoverSubagents(parent, parentPath, {
      sessionsRoot: join(root, "does-not-exist"),
    });

    expect(parent.subagents).toEqual([]);
    expect(parent.diagnostics).toEqual([]);
  });

  it("searches the active session directory before older history reaches the file limit", async () => {
    const sessionsRoot = join(root, "ordered-sessions");
    const activeDirectory = join(sessionsRoot, "2026", "07", "30");
    const parentPath = join(activeDirectory, "rollout-parent.jsonl");
    const parent = parseSession(
      sessionTranscript("parent", { callId: "call-child", sessionId: "recent-child" }),
      parentPath,
      "parent",
    );
    await Promise.all([
      writeTranscript(
        join(sessionsRoot, "2000", "01", "01", "rollout-old.jsonl"),
        sessionTranscript("old"),
      ),
      writeTranscript(
        join(activeDirectory, "rollout-recent-child.jsonl"),
        sessionTranscript("recent-child"),
      ),
    ]);

    await discoverSubagents(parent, parentPath, { sessionsRoot, maxFiles: 1 });

    expect(parent.subagents[0]?.session.id).toBe("recent-child");
  });
});

interface ChildReference {
  callId: string;
  sessionId: string;
}

function sessionTranscript(
  sessionId: string,
  child?: ChildReference,
  assistantMessage = `response from ${sessionId}`,
): string {
  const turnId = `turn-${sessionId}`;
  const records: Array<Record<string, unknown>> = [
    record("session_meta", { id: sessionId, cwd: `/workspace/${sessionId}` }, 0),
    record("event_msg", { type: "task_started", turn_id: turnId }, 1),
    record("turn_context", { turn_id: turnId, model: `model-${sessionId}` }, 2),
  ];
  if (child) {
    records.push(
      record(
        "response_item",
        {
          type: "function_call",
          call_id: child.callId,
          name: "spawn_agent",
          arguments: "{}",
        },
        3,
      ),
      record(
        "event_msg",
        {
          type: "sub_agent_activity",
          event_id: child.callId,
          agent_thread_id: child.sessionId,
        },
        4,
      ),
    );
  }
  records.push(
    record(
      "response_item",
      {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: assistantMessage }],
      },
      5,
    ),
    record("event_msg", { type: "task_complete", turn_id: turnId }, 6),
  );
  return `${records.map((item) => JSON.stringify(item)).join("\n")}\n`;
}

function record(type: string, payload: Record<string, unknown>, second: number) {
  return {
    timestamp: `2026-07-29T10:00:0${second}.000Z`,
    type,
    payload,
  };
}

function parseSession(transcript: string, transcriptPath: string, sessionId: string) {
  const hook: StopHookInput = {
    session_id: sessionId,
    turn_id: `turn-${sessionId}`,
    transcript_path: transcriptPath,
    cwd: `/workspace/${sessionId}`,
    hook_event_name: "Stop",
    model: `model-${sessionId}`,
    last_assistant_message: null,
  };
  return parseRolloutTranscript(transcript, hook);
}

async function writeTranscript(path: string, transcript: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, transcript, "utf8");
}
