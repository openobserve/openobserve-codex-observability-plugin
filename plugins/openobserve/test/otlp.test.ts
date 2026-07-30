import { describe, expect, it } from "vitest";

import {
  buildOtlpExportRequest,
  redactAndTruncate,
  spanIdFor,
  traceIdForTurn,
} from "../src/otlp.ts";
import type { OtlpKeyValue, OtlpSpan } from "../src/types.ts";
import { makeConfig, makeSession } from "./helpers.ts";

describe("OTLP mapping", () => {
  it("builds one deterministic trace with root, agent, generation, and tool spans", () => {
    const config = makeConfig();
    const session = makeSession();
    const first = buildOtlpExportRequest(session, session.turns[0], config);
    const second = buildOtlpExportRequest(session, session.turns[0], config);
    const spans = first.resourceSpans[0].scopeSpans[0].spans;

    expect(first).toEqual(second);
    expect(spans).toHaveLength(4);
    expect(spans.map((span) => span.name)).toEqual([
      "codex.turn",
      "invoke_agent codex",
      "chat codex-model",
      "execute_tool read_file",
    ]);
    expect(spans[0].kind).toBe(2);
    expect(spans[1].parentSpanId).toBe(spans[0].spanId);
    expect(spans[2].parentSpanId).toBe(spans[1].spanId);
    expect(spans[3].parentSpanId).toBe(spans[2].spanId);
    expect(new Set(spans.map((span) => span.traceId))).toEqual(new Set([spans[0].traceId]));
    expect(spans[0].traceId).toMatch(/^[0-9a-f]{32}$/);
    for (const span of spans) expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(spans[0].startTimeUnixNano).toBe("1700000000000000000");
    expect(spans[0].endTimeUnixNano).toBe("1700000001000000000");
  });

  it("emits OpenObserve-recognized generation fields and token cache usage", () => {
    const session = makeSession();
    const request = buildOtlpExportRequest(session, session.turns[0], makeConfig());
    const generation = request.resourceSpans[0].scopeSpans[0].spans[2];

    expect(attribute(generation, "gen_ai.operation.name")).toBe("chat");
    expect(attribute(generation, "gen_ai.request.model")).toBe("codex-model");
    expect(attribute(generation, "gen_ai.usage.input_tokens")).toBe("100");
    expect(attribute(generation, "gen_ai.usage.output_tokens")).toBe("30");
    expect(attribute(generation, "gen_ai.usage.total_tokens")).toBe("130");
    expect(attribute(generation, "gen_ai.usage.cache_read.input_tokens")).toBe("25");
    expect(attribute(generation, "gen_ai.usage.cache_creation.input_tokens")).toBe("10");
    expect(JSON.parse(String(attribute(generation, "gen_ai.input.messages")))).toEqual([
      { role: "user", content: "[REDACTED]" },
    ]);
    expect(attribute(generation, "gen_ai.reasoning")).toBeUndefined();
  });

  it("captures opted-in content while redacting secrets and truncating fields", () => {
    const session = makeSession({
      userMessages: [
        {
          role: "user",
          content: "Authorization: Bearer abc.def and password=hunter2 with extra content",
          timestampMs: 1,
        },
      ],
      generations: [],
      tools: [
        {
          callId: "secret-tool",
          name: "shell",
          arguments: '{"api_key":"abc123","command":"a very long command"}',
          result: "token: result-token",
          startedAtMs: 2,
          endedAtMs: 3,
          status: "ok",
        },
      ],
    });
    const config = makeConfig({
      captureContent: true,
      captureReasoning: true,
      captureToolContent: true,
      maxChars: 48,
    });
    const spans = buildOtlpExportRequest(session, session.turns[0], config).resourceSpans[0]
      .scopeSpans[0].spans;
    const generation = spans[2];
    const tool = spans[3];
    const messages = JSON.parse(String(attribute(generation, "gen_ai.input.messages"))) as Array<{
      content: string;
    }>;

    expect(messages[0].content).not.toContain("abc.def");
    expect(messages[0].content).not.toContain("hunter2");
    expect(Array.from(messages[0].content).length).toBeLessThanOrEqual(48);
    expect(attribute(generation, "gen_ai.reasoning")).toBeTypeOf("string");
    expect(attribute(tool, "gen_ai.tool.call.arguments")).not.toContain("abc123");
    expect(attribute(tool, "gen_ai.tool.call.result")).not.toContain("result-token");
  });

  it("creates a heuristic generation when parsed generation boundaries are absent", () => {
    const session = makeSession({ generations: [] });
    const spans = buildOtlpExportRequest(session, session.turns[0], makeConfig()).resourceSpans[0]
      .scopeSpans[0].spans;

    expect(spans.find((span) => span.name === "chat codex-model")).toBeDefined();
    expect(attribute(spans[2], "codex.reconstruction.confidence")).toBe("heuristic");
  });

  it("omits invalid numeric usage rather than emitting invalid OTLP values", () => {
    const session = makeSession();
    const usage = session.turns[0].generations[0].usage;
    if (!usage) throw new Error("fixture must contain usage");
    usage.inputTokens = Number.NaN;
    usage.cachedInputTokens = -1;
    const generation = buildOtlpExportRequest(session, session.turns[0], makeConfig())
      .resourceSpans[0].scopeSpans[0].spans[2];

    expect(attribute(generation, "gen_ai.usage.input_tokens")).toBeUndefined();
    expect(attribute(generation, "gen_ai.usage.cache_read.input_tokens")).toBeUndefined();
    expect(JSON.stringify(generation)).not.toContain('"doubleValue":null');
  });

  it("maps failed turns and tools to error status and exception events", () => {
    const session = makeSession({
      status: "failed",
      statusMessage: "password=private failure",
      tools: [
        {
          callId: "failed-call",
          name: "shell",
          arguments: "ignored",
          startedAtMs: 10,
          endedAtMs: 20,
          status: "error",
          errorMessage: "Bearer private-token failed",
        },
      ],
    });
    const spans = buildOtlpExportRequest(session, session.turns[0], makeConfig()).resourceSpans[0]
      .scopeSpans[0].spans;

    expect(spans[0].status.code).toBe(2);
    expect(spans[0].status.message).not.toContain("private");
    expect(spans[0].events?.[0].name).toBe("exception");
    expect(spans[3].status.code).toBe(2);
    const errorMessage = spans[3].events?.[0].attributes?.find(
      (item) => item.key === "exception.message",
    )?.value.stringValue;
    expect(errorMessage).not.toContain("private-token");
  });

  it("produces stable non-zero identifiers and Unicode-safe limits", () => {
    expect(traceIdForTurn("session", "turn")).toBe(traceIdForTurn("session", "turn"));
    expect(traceIdForTurn("session", "turn")).not.toBe(traceIdForTurn("session", "other"));
    expect(spanIdFor("a".repeat(32), "root")).toMatch(/^(?!0+$)[0-9a-f]{16}$/);
    expect(Array.from(redactAndTruncate("abcdefghijk", 8))).toHaveLength(8);
    expect(Array.from(redactAndTruncate("😀😀😀😀", 3))).toHaveLength(3);
  });

  it("nests child-agent generations and tools under the spawning tool", () => {
    const session = makeSession();
    session.turns[0].tools[0].childSessionId = "child-session";
    const child = makeSession();
    child.id = "child-session";
    child.turns[0].id = "child-turn";
    child.turns[0].threadId = "child-session";
    child.turns[0].model = "child-model";
    child.turns[0].generations[0].model = "child-model";
    child.subagents = [];
    session.subagents = [{ parentCallId: "call-1", session: child }];

    const spans = buildOtlpExportRequest(
      session,
      session.turns[0],
      makeConfig({
        captureContent: true,
      }),
    ).resourceSpans[0].scopeSpans[0].spans;
    const spawn = spans.find((span) => span.name === "execute_tool read_file");
    const childAgent = spans.find((span) => span.name === "invoke_agent codex.subagent");
    const childGeneration = spans.find((span) => span.name === "chat child-model");

    expect(childAgent?.parentSpanId).toBe(spawn?.spanId);
    expect(childGeneration?.parentSpanId).toBe(childAgent?.spanId);
    expect(attribute(childGeneration!, "gen_ai.conversation.id")).toBe("thread-1");
    expect(attribute(childGeneration!, "gen_ai.agent.id")).toBe("child-session");
  });

  it("keeps span IDs unique for reused child sessions and expands parent bounds", () => {
    const session = makeSession();
    const child = makeSession();
    child.id = "shared-child";
    child.turns[0].id = "child-turn";
    child.turns[0].threadId = "shared-child";
    child.turns[0].startedAtMs = session.turns[0].endedAtMs + 1_000;
    child.turns[0].endedAtMs = session.turns[0].endedAtMs + 5_000;
    child.turns[0].generations[0].startedAtMs = child.turns[0].startedAtMs;
    child.turns[0].generations[0].endedAtMs = child.turns[0].endedAtMs;
    session.subagents = [
      { parentCallId: "call-1", parentTurnId: "turn-1", session: child },
      { parentCallId: "call-1", parentTurnId: "turn-1", session: child },
    ];

    const spans = buildOtlpExportRequest(session, session.turns[0], makeConfig()).resourceSpans[0]
      .scopeSpans[0].spans;
    expect(new Set(spans.map((span) => span.spanId)).size).toBe(spans.length);
    expect(BigInt(spans[0].endTimeUnixNano)).toBe(
      spans.reduce(
        (maximum, span) =>
          BigInt(span.endTimeUnixNano) > maximum ? BigInt(span.endTimeUnixNano) : maximum,
        0n,
      ),
    );
  });
});

function attribute(span: OtlpSpan, key: string): string | number | boolean | undefined {
  const value = span.attributes.find((item) => item.key === key)?.value;
  return anyValue(value);
}

function anyValue(value: OtlpKeyValue["value"] | undefined): string | number | boolean | undefined {
  if (!value) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return value.intValue;
  if (value.doubleValue !== undefined) return value.doubleValue;
  return value.boolValue;
}
