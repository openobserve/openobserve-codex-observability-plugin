import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseRolloutJsonl, parseRolloutTranscript } from "../src/parser.ts";
import type { StopHookInput } from "../src/types.ts";

const completeFixture = readFileSync(
  new URL("./fixtures/rollout-complete.jsonl", import.meta.url),
  "utf8",
);

function hook(overrides: Partial<StopHookInput> = {}): StopHookInput {
  return {
    session_id: "session-1",
    turn_id: "turn-1",
    transcript_path: "/tmp/rollout.jsonl",
    cwd: "/hook-workspace",
    hook_event_name: "Stop",
    model: "hook-model",
    last_assistant_message: "Hook final response",
    ...overrides,
  };
}

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

describe("parseRolloutTranscript", () => {
  it("normalizes prompts, responses, reasoning, tools, usage, and canonical metadata", () => {
    const session = parseRolloutTranscript(completeFixture, hook());
    const turn = session.turns[0];

    expect(session).toMatchObject({
      id: "session-1",
      cwd: "/workspace",
      originator: "codex_cli_rs",
      cliVersion: "1.2.3",
      source: "cli",
      modelProvider: "openai",
      parentThreadId: "parent-1",
    });
    expect(turn).toMatchObject({
      id: "turn-1",
      threadId: "session-1",
      model: "gpt-test",
      status: "completed",
    });
    expect(turn?.startedAtMs).toBe(Date.parse("2026-07-01T10:00:01.000Z"));
    expect(turn?.endedAtMs).toBe(Date.parse("2026-07-01T10:00:04.200Z"));
    expect(turn?.userMessages.map((message) => message.content)).toEqual(["Build the parser"]);
    expect(turn?.assistantMessages.map((message) => [message.phase, message.content])).toEqual([
      ["commentary", "I will inspect the inputs."],
      ["final_answer", "Hook final response"],
    ]);
    expect(new Set(turn?.assistantMessages.map((message) => message.content)).size).toBe(2);
    expect(turn?.reasoning).toEqual([
      {
        summary: "Reasoning summary",
        content: "Raw reasoning chunk\nDetailed raw reasoning",
        timestampMs: Date.parse("2026-07-01T10:00:02.100Z"),
      },
    ]);

    expect(turn?.tools.map((tool) => [tool.callId, tool.name, tool.status])).toEqual([
      ["function-1", "read_file", "ok"],
      ["custom-1", "apply_change", "ok"],
      ["shell-1", "local_shell", "ok"],
      ["web-1", "web_search", "ok"],
      ["image-1", "image_generation", "ok"],
      ["function-error", "failing_tool", "error"],
    ]);
    expect(turn?.tools[0]).toMatchObject({
      namespace: "workspace",
      arguments: '{"path":"input.txt"}',
      result: "file contents",
    });
    expect(turn?.tools[2]?.result).toBe('{"exit_code":0,"stdout":"tests passed"}');
    expect(turn?.tools[3]?.result).toBe('[{"title":"JSONL guide"}]');
    expect(turn?.tools[4]?.result).toBe('{"image_id":"image-result-1"}');
    expect(turn?.tools[5]).toMatchObject({
      result: '{"error":"tool failed","exit_code":2}',
      errorMessage: "tool failed",
    });

    expect(turn?.generations).toHaveLength(3);
    expect(
      turn?.generations.every((generation) => generation.reconstructionConfidence === "heuristic"),
    ).toBe(true);
    expect(turn?.generations[0]?.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 25,
      cacheWriteInputTokens: 5,
      outputTokens: 20,
      reasoningOutputTokens: 7,
      totalTokens: 120,
    });
    expect(turn?.generations[0]?.toolCallIds).toEqual(["function-1"]);
    expect(turn?.generations[1]?.input.map((message) => message.content)).toContain(
      "file contents",
    );
    expect(session.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining("malformed JSONL record"),
        expect.stringContaining("unknown response item type future_item"),
        expect.stringContaining("unknown event type future_event"),
      ]),
    );
  });

  it("supports lifecycle aliases, interrupted and failed turns, and an open Stop turn", () => {
    const transcript = jsonl([
      {
        timestamp: "2026-07-02T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "session-2", cwd: "/workspace" },
      },
      {
        timestamp: "2026-07-02T10:00:01.000Z",
        type: "event_msg",
        payload: { type: "turn_started", turn_id: "alias-complete" },
      },
      {
        timestamp: "2026-07-02T10:00:02.000Z",
        type: "event_msg",
        payload: { type: "turn_complete", turn_id: "alias-complete" },
      },
      {
        timestamp: "2026-07-02T10:00:03.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "interrupted" },
      },
      {
        timestamp: "2026-07-02T10:00:04.000Z",
        type: "event_msg",
        payload: { type: "turn_aborted", turn_id: "interrupted", reason: "user_interrupt" },
      },
      {
        timestamp: "2026-07-02T10:00:05.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "failed" },
      },
      {
        timestamp: "2026-07-02T10:00:06.000Z",
        type: "event_msg",
        payload: { type: "error", turn_id: "failed", message: "model request failed" },
      },
      {
        timestamp: "2026-07-02T10:00:07.000Z",
        type: "event_msg",
        payload: { type: "task_failed", turn_id: "failed", error: "model request failed" },
      },
      {
        timestamp: "2026-07-02T10:00:08.000Z",
        type: "event_msg",
        payload: { type: "turn_started", turn_id: "open" },
      },
      {
        timestamp: "2026-07-02T10:00:08.100Z",
        type: "turn_context",
        payload: { turn_id: "open", model: "gpt-open" },
      },
      {
        timestamp: "2026-07-02T10:00:08.200Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Keep this turn open" },
      },
      {
        timestamp: "2026-07-02T10:00:09.000Z",
        type: "event_msg",
        payload: { type: "agent_message", phase: "final_answer", message: "Stale final" },
      },
    ]);

    const session = parseRolloutTranscript(
      transcript,
      hook({
        session_id: "session-2",
        turn_id: "open",
        model: "hook-open",
        last_assistant_message: "Current Stop response",
      }),
    );

    expect(session.turns.map((turn) => [turn.id, turn.status])).toEqual([
      ["alias-complete", "completed"],
      ["interrupted", "interrupted"],
      ["failed", "failed"],
      ["open", "at_stop_hook"],
    ]);
    expect(session.turns[1]?.statusMessage).toBe("user_interrupt");
    expect(session.turns[2]?.statusMessage).toBe("model request failed");
    expect(session.turns[3]).toMatchObject({ model: "gpt-open", status: "at_stop_hook" });
    expect(session.turns[3]?.assistantMessages).toHaveLength(1);
    expect(session.turns[3]?.assistantMessages[0]?.content).toBe("Current Stop response");
    expect(session.diagnostics).toContain("Turn failed error: model request failed");
  });

  it("uses response user messages only as a fallback and does not duplicate synthetic messages", () => {
    const transcript = jsonl([
      {
        timestamp: "2026-07-03T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "session-3" },
      },
      {
        timestamp: "2026-07-03T10:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-3" },
      },
      {
        timestamp: "2026-07-03T10:00:01.100Z",
        type: "turn_context",
        payload: { turn_id: "turn-3", model: "gpt-test" },
      },
      {
        timestamp: "2026-07-03T10:00:01.200Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "One prompt" }],
        },
      },
      {
        timestamp: "2026-07-03T10:00:01.200Z",
        type: "event_msg",
        payload: { type: "user_message", message: "One prompt" },
      },
      {
        timestamp: "2026-07-03T10:00:02.000Z",
        type: "event_msg",
        payload: { type: "agent_message", phase: "final_answer", message: "One response" },
      },
      {
        timestamp: "2026-07-03T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "One response" }],
        },
      },
      {
        timestamp: "2026-07-03T10:00:02.100Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-3" },
      },
    ]);

    const session = parseRolloutTranscript(
      transcript,
      hook({
        session_id: "session-3",
        turn_id: "turn-3",
        last_assistant_message: "One response",
      }),
    );

    expect(session.turns[0]?.userMessages.map((message) => message.content)).toEqual([
      "One prompt",
    ]);
    expect(session.turns[0]?.assistantMessages.map((message) => message.content)).toEqual([
      "One response",
    ]);
  });

  it("supports paginated completed items and treats completion errors as failures", () => {
    const transcript = jsonl([
      {
        timestamp: "2026-07-05T10:00:00.000Z",
        ordinal: 0,
        type: "session_meta",
        payload: { id: "session-5", history_mode: "paginated" },
      },
      {
        timestamp: "2026-07-05T10:00:01.000Z",
        ordinal: 1,
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-5" },
      },
      {
        timestamp: "2026-07-05T10:00:01.100Z",
        ordinal: 2,
        type: "turn_context",
        payload: { turn_id: "turn-5", model: "gpt-paginated" },
      },
      {
        timestamp: "2026-07-05T10:00:01.200Z",
        ordinal: 3,
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn-5",
          completed_at_ms: Date.parse("2026-07-05T10:00:01.200Z"),
          item: {
            type: "UserMessage",
            id: "user-5",
            content: [{ type: "text", text: "Paginated prompt" }],
          },
        },
      },
      {
        timestamp: "2026-07-05T10:00:02.000Z",
        ordinal: 4,
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn-5",
          completed_at_ms: Date.parse("2026-07-05T10:00:02.000Z"),
          item: {
            type: "AgentMessage",
            id: "assistant-5",
            phase: "final_answer",
            content: [{ type: "text", text: "Paginated response" }],
          },
        },
      },
      {
        timestamp: "2026-07-05T10:00:02.100Z",
        ordinal: 5,
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-5",
          error: { message: "provider failed" },
        },
      },
    ]);

    const session = parseRolloutTranscript(
      transcript,
      hook({
        session_id: "session-5",
        turn_id: "turn-5",
        last_assistant_message: "Paginated response",
      }),
    );

    expect(session.turns[0]?.userMessages.map((message) => message.content)).toEqual([
      "Paginated prompt",
    ]);
    expect(session.turns[0]?.assistantMessages.map((message) => message.content)).toEqual([
      "Paginated response",
    ]);
    expect(session.turns[0]).toMatchObject({ status: "failed", statusMessage: "provider failed" });
  });

  it("coalesces cumulative snapshots, preserves steering input, and applies precise durations", () => {
    const totalUsage = { input_tokens: 20, output_tokens: 5, total_tokens: 25 };
    const transcript = jsonl([
      recordAt("2026-07-06T10:00:00.000Z", "session_meta", { id: "session-6" }),
      recordAt("2026-07-06T10:00:01.756Z", "event_msg", {
        type: "task_started",
        turn_id: "turn-6",
        started_at: Date.parse("2026-07-06T10:00:01.000Z") / 1_000,
      }),
      recordAt("2026-07-06T10:00:01.800Z", "turn_context", {
        turn_id: "turn-6",
        model: "gpt-snapshots",
      }),
      recordAt("2026-07-06T10:00:01.900Z", "event_msg", {
        type: "user_message",
        message: "Initial prompt",
      }),
      recordAt("2026-07-06T10:00:02.000Z", "response_item", {
        type: "reasoning",
        summary: [{ text: "Plan" }],
        content: [{ text: "Step" }],
      }),
      recordAt("2026-07-06T10:00:02.100Z", "response_item", {
        type: "reasoning",
        summary: [{ text: "Plan extended" }],
        content: [{ text: "Step expanded" }],
      }),
      recordAt("2026-07-06T10:00:02.200Z", "event_msg", {
        type: "agent_message",
        phase: "commentary",
        message: "First response",
      }),
      recordAt("2026-07-06T10:00:02.300Z", "event_msg", {
        type: "token_count",
        info: { last_token_usage: totalUsage, total_token_usage: totalUsage },
      }),
      recordAt("2026-07-06T10:00:02.400Z", "event_msg", {
        type: "token_count",
        info: { last_token_usage: totalUsage, total_token_usage: totalUsage },
      }),
      recordAt("2026-07-06T10:00:02.500Z", "event_msg", {
        type: "user_message",
        message: "Steering prompt",
      }),
      recordAt("2026-07-06T10:00:03.000Z", "event_msg", {
        type: "agent_message",
        phase: "final_answer",
        message: "Final response",
      }),
      recordAt("2026-07-06T10:00:05.300Z", "event_msg", {
        type: "task_complete",
        turn_id: "turn-6",
        completed_at: Date.parse("2026-07-06T10:00:05.000Z") / 1_000,
        duration_ms: 4_000,
      }),
    ]);

    const session = parseRolloutTranscript(
      transcript,
      hook({
        session_id: "session-6",
        turn_id: "turn-6",
        last_assistant_message: "Final response",
      }),
    );
    const turn = session.turns[0];

    expect(turn?.reasoning).toEqual([
      {
        summary: "Plan extended",
        content: "Step expanded",
        timestampMs: Date.parse("2026-07-06T10:00:02.100Z"),
      },
    ]);
    expect(turn?.generations).toHaveLength(2);
    expect(turn?.generations[1]?.input.map((message) => message.content)).toEqual([
      "Steering prompt",
    ]);
    expect(turn?.startedAtMs).toBe(Date.parse("2026-07-06T10:00:01.300Z"));
    expect(turn?.endedAtMs).toBe(Date.parse("2026-07-06T10:00:05.300Z"));
  });

  it("removes inherited parent history from forked child sessions and keeps agent assignments", () => {
    const transcript = jsonl([
      recordAt("2026-07-07T10:00:06.000Z", "session_meta", {
        id: "child-session",
        session_id: "parent-session",
        forked_from_id: "parent-session",
        parent_thread_id: "parent-session",
        timestamp: "2026-07-07T10:00:05.000Z",
      }),
      recordAt("2026-07-07T10:00:06.001Z", "session_meta", {
        id: "parent-session",
        session_id: "parent-session",
      }),
      recordAt("2026-07-07T10:00:06.002Z", "event_msg", {
        type: "task_started",
        turn_id: "parent-turn",
        started_at: Date.parse("2026-07-07T10:00:00.000Z") / 1_000,
      }),
      recordAt("2026-07-07T10:00:06.003Z", "turn_context", {
        turn_id: "parent-turn",
        model: "parent-model",
      }),
      recordAt("2026-07-07T10:00:06.004Z", "event_msg", {
        type: "user_message",
        message: "Inherited parent prompt",
      }),
      recordAt("2026-07-07T10:00:06.005Z", "event_msg", {
        type: "task_complete",
        turn_id: "parent-turn",
      }),
      recordAt("2026-07-07T10:00:06.100Z", "event_msg", {
        type: "task_started",
        turn_id: "child-turn",
        started_at: Date.parse("2026-07-07T10:00:06.000Z") / 1_000,
      }),
      recordAt("2026-07-07T10:00:06.200Z", "turn_context", {
        turn_id: "child-turn",
        model: "child-model",
      }),
      recordAt("2026-07-07T10:00:06.300Z", "response_item", {
        type: "agent_message",
        author: "/root",
        recipient: "/root/audit",
        content: [{ type: "input_text", text: "Message Type: NEW_TASK\nPayload: Audit UI" }],
        internal_chat_message_metadata_passthrough: { turn_id: "child-turn" },
      }),
      recordAt("2026-07-07T10:00:07.000Z", "event_msg", {
        type: "agent_message",
        phase: "final_answer",
        message: "Child result",
      }),
      recordAt("2026-07-07T10:00:07.100Z", "event_msg", {
        type: "task_complete",
        turn_id: "child-turn",
      }),
    ]);

    const session = parseRolloutTranscript(
      transcript,
      hook({
        session_id: "child-session",
        turn_id: "child-turn",
        last_assistant_message: "Child result",
      }),
    );

    expect(session.turns.map((turn) => turn.id)).toEqual(["child-turn"]);
    expect(session.turns[0]?.userMessages.map((message) => message.content)).toEqual([
      "Message Type: NEW_TASK\nPayload: Audit UI",
    ]);
    expect(session.turns[0]?.assistantMessages.map((message) => message.content)).toEqual([
      "Child result",
    ]);
    expect(session.diagnostics).toContain(
      "Ignored 5 inherited record(s) from parent session history",
    );
  });
});

describe("parseRolloutJsonl", () => {
  it("keeps complete records while diagnosing malformed and unterminated lines", () => {
    const valid = JSON.stringify({
      timestamp: "2026-07-04T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "session-4" },
    });
    const parsed = parseRolloutJsonl(`${valid}\nnot-json\n{\"timestamp\":`);

    expect(parsed.records).toHaveLength(1);
    expect(parsed.diagnostics).toEqual([
      "Line 3: ignored unterminated JSONL record",
      "Line 2: malformed JSONL record",
    ]);
    expect(parseRolloutJsonl(valid)).toEqual({
      records: [],
      diagnostics: ["Line 1: ignored unterminated JSONL record"],
    });
  });
});

function recordAt(timestamp: string, type: string, payload: Record<string, unknown>) {
  return { timestamp, type, payload };
}
