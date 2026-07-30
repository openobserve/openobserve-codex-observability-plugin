import { createHash } from "node:crypto";

import type {
  NormalizedGeneration,
  NormalizedMessage,
  NormalizedSession,
  NormalizedSubagent,
  NormalizedToolCall,
  NormalizedTurn,
  OpenObserveConfig,
  OtlpEvent,
  OtlpExportTraceRequest,
  OtlpKeyValue,
  OtlpSpan,
  TokenUsage,
} from "./types.ts";

const REDACTED = "[REDACTED]";
const TRUNCATED = "...[truncated]";
const SCOPE_NAME = "openobserve.codex";
const SCOPE_VERSION = "0.1.0";
const MAX_METADATA_CHARS = 1_024;
const CONTENT_ATTRIBUTE_KEYS = new Set([
  "exception.message",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.reasoning",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
]);

type AttributeValue = string | number | boolean | undefined;

export function buildOtlpExportRequest(
  session: NormalizedSession,
  turn: NormalizedTurn,
  config: OpenObserveConfig,
  traceIdOverride?: string,
): OtlpExportTraceRequest {
  const traceId = traceIdOverride ?? traceIdForTurn(session.id, turn.id);
  const generations = normalizedGenerations(turn);
  const bounds = turnBounds(turn, generations);
  const rootSpanId = spanIdFor(traceId, "turn");
  const agentSpanId = spanIdFor(traceId, "agent");
  const spans: OtlpSpan[] = [];

  spans.push(
    makeSpan({
      traceId,
      spanId: rootSpanId,
      name: "codex.turn",
      kind: 2,
      startMs: bounds.startMs,
      endMs: bounds.endMs,
      attributes: {
        "session.id": session.id,
        "gen_ai.conversation.id": turn.threadId,
        "codex.turn.id": turn.id,
        "codex.thread.id": turn.threadId,
        "codex.turn.status": turn.status,
        "codex.source": session.source,
        "codex.originator": session.originator,
        "codex.cli.version": session.cliVersion,
      },
      status: turnStatus(turn, config),
      errorMessage: isTurnError(turn.status) ? turn.statusMessage || turn.status : undefined,
      maxChars: config.maxChars,
    }),
  );

  spans.push(
    makeSpan({
      traceId,
      spanId: agentSpanId,
      parentSpanId: rootSpanId,
      name: "invoke_agent codex",
      kind: 1,
      startMs: bounds.startMs,
      endMs: bounds.endMs,
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "codex",
        "gen_ai.agent.id": turn.threadId,
        "gen_ai.conversation.id": turn.threadId,
        "gen_ai.request.model": turn.model,
        "gen_ai.response.model": turn.model,
        "gen_ai.input.messages": serializeMessages(
          turn.userMessages,
          config.captureContent,
          config.maxChars,
        ),
        "gen_ai.output.messages": serializeMessages(
          turn.assistantMessages,
          config.captureContent,
          config.maxChars,
        ),
        "codex.turn.id": turn.id,
      },
      status: turnStatus(turn, config),
      errorMessage: isTurnError(turn.status) ? turn.statusMessage || turn.status : undefined,
      maxChars: config.maxChars,
    }),
  );

  const generationParents = new Map<string, string>();
  generations.forEach((generation, position) => {
    const spanId = spanIdFor(traceId, `generation:${generation.index}:${position}`);
    for (const callId of generation.toolCallIds) {
      if (!generationParents.has(callId)) generationParents.set(callId, spanId);
    }
    spans.push(
      generationSpan(
        traceId,
        spanId,
        agentSpanId,
        session,
        turn,
        generation,
        config,
        turn.threadId,
        "codex",
        turn.threadId,
      ),
    );
  });

  const toolSpanIds = new Map<string, string>();
  turn.tools.forEach((tool, index) => {
    const spanId = spanIdFor(traceId, `tool:${tool.callId}:${index}`);
    toolSpanIds.set(tool.callId, spanId);
    spans.push(
      toolSpan(
        traceId,
        spanId,
        generationParents.get(tool.callId) ?? agentSpanId,
        tool,
        config,
        turn,
        turn.threadId,
        "codex",
        turn.threadId,
      ),
    );
  });
  appendSubagentSpans(
    spans,
    session.subagents,
    toolSpanIds,
    traceId,
    config,
    turn.threadId,
    turn.id,
    `turn:${turn.id}`,
  );
  expandSpanBounds(spans[0], spans);
  expandSpanBounds(spans[1], spans.slice(1));

  return {
    resourceSpans: [
      {
        resource: {
          attributes: attributes({
            "service.name": config.serviceName,
            "service.version": SCOPE_VERSION,
            "service.namespace": "openobserve.codex",
            "deployment.environment.name": config.environment,
            "telemetry.sdk.language": "nodejs",
            "telemetry.sdk.name": SCOPE_NAME,
            "telemetry.sdk.version": SCOPE_VERSION,
            "process.runtime.name": "nodejs",
          }),
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
            spans,
          },
        ],
      },
    ],
  };
}

export const buildOtlpTrace = buildOtlpExportRequest;

export function traceIdForTurn(sessionId: string, turnId: string, revision = ""): string {
  return nonZeroHash(`trace\0${sessionId}\0${turnId}\0${revision}`, 32);
}

export function spanIdFor(traceId: string, identity: string): string {
  return nonZeroHash(`span\0${traceId}\0${identity}`, 16);
}

export function redactAndTruncate(value: string, maxChars: number): string {
  const redacted = value
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
      REDACTED,
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, (_match, scheme: string) => {
      return `${scheme} ${REDACTED}`;
    })
    .replace(
      /(["']?(?:authorization|api[-_ ]?key|password|secret|token)["']?\s*[:=]\s*)(["']?)([^"'\s,}]+)/gi,
      (_match, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}`,
    )
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, REDACTED)
    .replace(/([?&](?:access_token|api[-_]?key|password|secret|token)=)[^&#\s]*/gi, `$1${REDACTED}`)
    .replace(/(https?:\/\/[^:/\s]+:)[^@/\s]+@/gi, `$1${REDACTED}@`);
  return truncate(redacted, maxChars);
}

function generationSpan(
  traceId: string,
  spanId: string,
  parentSpanId: string,
  session: NormalizedSession,
  turn: NormalizedTurn,
  generation: NormalizedGeneration,
  config: OpenObserveConfig,
  conversationId: string,
  agentName: string,
  agentId: string,
): OtlpSpan {
  const values: Record<string, AttributeValue> = {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": session.modelProvider,
    "gen_ai.request.model": generation.model || turn.model,
    "gen_ai.response.model": generation.model || turn.model,
    "gen_ai.conversation.id": conversationId,
    "gen_ai.agent.name": agentName,
    "gen_ai.agent.id": agentId,
    "gen_ai.input.messages": serializeMessages(
      generation.input,
      config.captureContent,
      config.maxChars,
    ),
    "gen_ai.output.messages": serializeMessages(
      generation.output,
      config.captureContent,
      config.maxChars,
    ),
    "gen_ai.response.finish_reasons": JSON.stringify([finishReason(turn.status)]),
    "codex.generation.index": generation.index,
    "codex.reconstruction.confidence": generation.reconstructionConfidence,
  };

  if (config.captureReasoning && generation.reasoning.length > 0) {
    values["gen_ai.reasoning"] = JSON.stringify(
      generation.reasoning.map((reasoning) => ({
        summary: redactAndTruncate(reasoning.summary, config.maxChars),
        ...(reasoning.content
          ? { content: redactAndTruncate(reasoning.content, config.maxChars) }
          : {}),
      })),
    );
  }
  addUsage(values, generation.usage);

  return makeSpan({
    traceId,
    spanId,
    parentSpanId,
    name: `chat ${generation.model || turn.model}`,
    kind: 3,
    startMs: generation.startedAtMs,
    endMs: generation.endedAtMs,
    attributes: values,
    status: turnStatus(turn, config),
    errorMessage: isTurnError(turn.status) ? turn.statusMessage || turn.status : undefined,
    maxChars: config.maxChars,
  });
}

function toolSpan(
  traceId: string,
  spanId: string,
  parentSpanId: string,
  tool: NormalizedToolCall,
  config: OpenObserveConfig,
  turn?: NormalizedTurn,
  conversationId?: string,
  agentName?: string,
  agentId?: string,
): OtlpSpan {
  const values: Record<string, AttributeValue> = {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": tool.name,
    "gen_ai.tool.call.id": tool.callId,
    "gen_ai.agent.name": agentName ?? (turn ? "codex" : undefined),
    "gen_ai.agent.id": agentId ?? turn?.threadId,
    "gen_ai.conversation.id": conversationId ?? turn?.threadId,
    "codex.tool.namespace": tool.namespace,
    "codex.child.session.id": tool.childSessionId,
  };
  if (config.captureToolContent) {
    values["gen_ai.tool.call.arguments"] = redactAndTruncate(tool.arguments, config.maxChars);
    if (tool.result !== undefined) {
      values["gen_ai.tool.call.result"] = redactAndTruncate(tool.result, config.maxChars);
    }
  }

  const status =
    tool.status === "ok"
      ? { code: 1 }
      : tool.status === "error"
        ? { code: 2, message: sanitizeError(tool.errorMessage || "tool execution failed", config) }
        : { code: 0, message: "tool execution incomplete" };
  return makeSpan({
    traceId,
    spanId,
    parentSpanId,
    name: `execute_tool ${tool.name}`,
    kind: 1,
    startMs: tool.startedAtMs,
    endMs: tool.endedAtMs ?? tool.startedAtMs,
    attributes: values,
    status,
    errorMessage:
      tool.status === "error" ? tool.errorMessage || "tool execution failed" : undefined,
    maxChars: config.maxChars,
  });
}

function appendSubagentSpans(
  spans: OtlpSpan[],
  subagents: NormalizedSubagent[],
  parentToolSpanIds: Map<string, string>,
  traceId: string,
  config: OpenObserveConfig,
  conversationId: string,
  parentTurnId: string,
  ancestry: string,
): void {
  subagents.forEach((subagent, subagentIndex) => {
    if (subagent.parentTurnId && subagent.parentTurnId !== parentTurnId) return;
    const parentSpanId = parentToolSpanIds.get(subagent.parentCallId);
    if (!parentSpanId) return;
    const identity = `${ancestry}/call:${subagent.parentCallId}:${subagentIndex}/session:${subagent.session.id}`;

    for (const turn of subagent.session.turns) {
      const generations = normalizedGenerations(turn);
      const bounds = turnBounds(turn, generations);
      const agentName = "codex.subagent";
      const agentId = subagent.session.id;
      const agentSpanId = spanIdFor(traceId, `${identity}:turn:${turn.id}:agent`);
      spans.push(
        makeSpan({
          traceId,
          spanId: agentSpanId,
          parentSpanId,
          name: `invoke_agent ${agentName}`,
          kind: 1,
          startMs: bounds.startMs,
          endMs: bounds.endMs,
          attributes: {
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.agent.name": agentName,
            "gen_ai.agent.id": agentId,
            "gen_ai.conversation.id": conversationId,
            "gen_ai.request.model": turn.model,
            "gen_ai.response.model": turn.model,
            "gen_ai.input.messages": serializeMessages(
              turn.userMessages,
              config.captureContent,
              config.maxChars,
            ),
            "gen_ai.output.messages": serializeMessages(
              turn.assistantMessages,
              config.captureContent,
              config.maxChars,
            ),
            "codex.turn.id": turn.id,
            "codex.thread.id": turn.threadId,
          },
          status: turnStatus(turn, config),
          errorMessage: isTurnError(turn.status) ? turn.statusMessage || turn.status : undefined,
          maxChars: config.maxChars,
        }),
      );

      const generationParents = new Map<string, string>();
      generations.forEach((generation, position) => {
        const spanId = spanIdFor(
          traceId,
          `${identity}:turn:${turn.id}:generation:${generation.index}:${position}`,
        );
        generation.toolCallIds.forEach((callId) => generationParents.set(callId, spanId));
        spans.push(
          generationSpan(
            traceId,
            spanId,
            agentSpanId,
            subagent.session,
            turn,
            generation,
            config,
            conversationId,
            agentName,
            agentId,
          ),
        );
      });

      const childToolSpanIds = new Map<string, string>();
      turn.tools.forEach((tool, index) => {
        const spanId = spanIdFor(
          traceId,
          `${identity}:turn:${turn.id}:tool:${tool.callId}:${index}`,
        );
        childToolSpanIds.set(tool.callId, spanId);
        spans.push(
          toolSpan(
            traceId,
            spanId,
            generationParents.get(tool.callId) ?? agentSpanId,
            tool,
            config,
            turn,
            conversationId,
            agentName,
            agentId,
          ),
        );
      });
      appendSubagentSpans(
        spans,
        subagent.session.subagents,
        childToolSpanIds,
        traceId,
        config,
        conversationId,
        turn.id,
        `${identity}:turn:${turn.id}`,
      );
    }
  });
}

function expandSpanBounds(target: OtlpSpan | undefined, spans: OtlpSpan[]): void {
  if (!target || spans.length === 0) return;
  target.startTimeUnixNano = spans.reduce(
    (minimum, span) =>
      BigInt(span.startTimeUnixNano) < BigInt(minimum) ? span.startTimeUnixNano : minimum,
    target.startTimeUnixNano,
  );
  target.endTimeUnixNano = spans.reduce(
    (maximum, span) =>
      BigInt(span.endTimeUnixNano) > BigInt(maximum) ? span.endTimeUnixNano : maximum,
    target.endTimeUnixNano,
  );
}

function makeSpan(input: {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startMs: number;
  endMs: number;
  attributes: Record<string, AttributeValue>;
  status: OtlpSpan["status"];
  errorMessage?: string;
  maxChars: number;
}): OtlpSpan {
  const startMs = finiteMilliseconds(input.startMs);
  const endMs = Math.max(startMs, finiteMilliseconds(input.endMs));
  const span: OtlpSpan = {
    traceId: input.traceId,
    spanId: input.spanId,
    ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
    name: redactAndTruncate(input.name.replace(/[\u0000-\u001f\u007f]/g, "?"), MAX_METADATA_CHARS),
    kind: input.kind,
    startTimeUnixNano: millisecondsToUnixNano(startMs),
    endTimeUnixNano: millisecondsToUnixNano(endMs),
    attributes: attributes(input.attributes),
    status: input.status,
  };
  if (input.errorMessage) {
    span.events = [exceptionEvent(endMs, input.errorMessage, input.maxChars)];
  }
  return span;
}

function normalizedGenerations(turn: NormalizedTurn): NormalizedGeneration[] {
  if (turn.generations.length > 0) return turn.generations;
  return [
    {
      index: 0,
      model: turn.model,
      startedAtMs: turn.startedAtMs,
      endedAtMs: turn.endedAtMs,
      input: turn.userMessages,
      output: turn.assistantMessages,
      reasoning: turn.reasoning,
      toolCallIds: turn.tools.map((tool) => tool.callId),
      reconstructionConfidence: "heuristic",
    },
  ];
}

function turnBounds(
  turn: NormalizedTurn,
  generations: NormalizedGeneration[],
): { startMs: number; endMs: number } {
  const starts = [
    finiteMilliseconds(turn.startedAtMs),
    ...generations.map((generation) => finiteMilliseconds(generation.startedAtMs)),
    ...turn.tools.map((tool) => finiteMilliseconds(tool.startedAtMs)),
  ];
  const ends = [
    finiteMilliseconds(turn.endedAtMs),
    ...generations.map((generation) => finiteMilliseconds(generation.endedAtMs)),
    ...turn.tools.map((tool) => finiteMilliseconds(tool.endedAtMs ?? tool.startedAtMs)),
  ];
  const startMs = Math.min(...starts);
  return { startMs, endMs: Math.max(startMs, ...ends) };
}

function addUsage(target: Record<string, AttributeValue>, usage: TokenUsage | undefined): void {
  if (!usage) return;
  target["gen_ai.usage.input_tokens"] = tokenCount(usage.inputTokens);
  target["gen_ai.usage.output_tokens"] = tokenCount(usage.outputTokens);
  target["gen_ai.usage.total_tokens"] = tokenCount(usage.totalTokens);
  target["gen_ai.usage.cache_read.input_tokens"] = tokenCount(usage.cachedInputTokens);
  target["gen_ai.usage.cache_creation.input_tokens"] = tokenCount(usage.cacheWriteInputTokens);
  target["gen_ai.usage.reasoning.output_tokens"] = tokenCount(usage.reasoningOutputTokens);
}

function serializeMessages(
  messages: NormalizedMessage[],
  captureContent: boolean,
  maxChars: number,
): string {
  return JSON.stringify(
    messages.map((message) => ({
      role: message.role,
      content: captureContent ? redactAndTruncate(message.content, maxChars) : REDACTED,
      ...(message.phase ? { phase: redactAndTruncate(message.phase, MAX_METADATA_CHARS) } : {}),
    })),
  );
}

function attributes(values: Record<string, AttributeValue>): OtlpKeyValue[] {
  return Object.entries(values)
    .filter(
      (entry): entry is [string, string | number | boolean] =>
        entry[1] !== undefined && (typeof entry[1] !== "number" || Number.isFinite(entry[1])),
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => ({
      key,
      value: anyValue(
        typeof value === "string" && !CONTENT_ATTRIBUTE_KEYS.has(key)
          ? redactAndTruncate(value, MAX_METADATA_CHARS)
          : value,
      ),
    }));
}

function anyValue(value: string | number | boolean): OtlpKeyValue["value"] {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (Number.isInteger(value)) return { intValue: String(value) };
  return { doubleValue: value };
}

function turnStatus(turn: NormalizedTurn, config: OpenObserveConfig): OtlpSpan["status"] {
  if (turn.status === "completed" || turn.status === "at_stop_hook") return { code: 1 };
  return {
    code: 2,
    message: sanitizeError(turn.statusMessage || turn.status, config),
  };
}

function isTurnError(status: NormalizedTurn["status"]): boolean {
  return status !== "completed" && status !== "at_stop_hook";
}

function finishReason(status: NormalizedTurn["status"]): string {
  if (status === "completed" || status === "at_stop_hook") return "stop";
  if (status === "interrupted") return "cancelled";
  return "error";
}

function exceptionEvent(timeMs: number, message: string, maxChars: number): OtlpEvent {
  return {
    name: "exception",
    timeUnixNano: millisecondsToUnixNano(timeMs),
    attributes: attributes({
      "exception.type": "CodexTurnError",
      "exception.message": redactAndTruncate(message, maxChars),
    }),
  };
}

function sanitizeError(message: string, config: OpenObserveConfig): string {
  return redactAndTruncate(message, config.maxChars);
}

function truncate(value: string, maxChars: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxChars) return value;
  const suffix = Array.from(TRUNCATED);
  if (maxChars <= suffix.length) return suffix.slice(0, maxChars).join("");
  return `${characters.slice(0, maxChars - suffix.length).join("")}${TRUNCATED}`;
}

function finiteMilliseconds(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function tokenCount(value: number): number | undefined {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function millisecondsToUnixNano(value: number): string {
  return (BigInt(value) * 1_000_000n).toString();
}

function nonZeroHash(value: string, length: number): string {
  const hash = createHash("sha256").update(value).digest("hex").slice(0, length);
  return /^0+$/.test(hash) ? `${"0".repeat(length - 1)}1` : hash;
}
