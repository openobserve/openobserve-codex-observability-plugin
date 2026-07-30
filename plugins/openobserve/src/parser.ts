import type {
  NormalizedGeneration,
  NormalizedMessage,
  NormalizedReasoning,
  NormalizedSession,
  NormalizedToolCall,
  NormalizedTurn,
  RolloutRecord,
  StopHookInput,
  TokenUsage,
} from "./types.ts";

export interface ParsedRolloutJsonl {
  records: RolloutRecord[];
  diagnostics: string[];
}

interface GenerationDraft {
  model: string;
  startedAtMs: number;
  endedAtMs: number;
  input: NormalizedMessage[];
  output: NormalizedMessage[];
  reasoning: NormalizedReasoning[];
  usage?: TokenUsage;
  toolCallIds: string[];
}

interface TurnBuilder {
  turn: NormalizedTurn;
  contextSeen: boolean;
  hasCanonicalUser: boolean;
  fallbackUsers: Set<NormalizedMessage>;
  fallbackAssistants: Set<NormalizedMessage>;
  pendingRawReasoning: Array<{ text: string; timestampMs: number }>;
  pendingGenerationInputs: NormalizedMessage[];
  currentGeneration?: GenerationDraft;
  toolsById: Map<string, NormalizedToolCall>;
  toolOutputMessages: Map<string, NormalizedMessage>;
  toolOutputPriorities: Map<string, number>;
  lastTimestampMs: number;
  lastTotalUsage?: TokenUsage;
  closed: boolean;
}

const START_EVENTS = new Set(["task_started", "turn_started"]);
const COMPLETE_EVENTS = new Set(["task_complete", "turn_complete"]);
const FAILED_EVENTS = new Set(["task_failed", "turn_failed"]);
const ABORTED_EVENTS = new Set([
  "task_aborted",
  "turn_aborted",
  "task_cancelled",
  "turn_cancelled",
  "task_canceled",
  "turn_canceled",
]);
const ERROR_EVENTS = new Set(["error", "task_error", "turn_error", "stream_error"]);
const IGNORED_RECORDS = new Set(["compacted", "world_state"]);
const IGNORED_EVENTS = new Set([
  "context_compacted",
  "thread_goal_updated",
  "thread_rolled_back",
  "thread_settings_applied",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function timestampMs(value: unknown): number | undefined {
  const numeric = numberValue(value);
  if (numeric !== undefined) {
    if (numeric > 1_000_000_000_000_000) {
      return Math.floor(numeric / 1_000_000);
    }
    if (numeric > 1_000_000_000_000) {
      return Math.floor(numeric);
    }
    if (numeric > 1_000_000_000) {
      return Math.floor(numeric * 1_000);
    }
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
}

function recordTimestampMs(record: RolloutRecord, fallback: number): number {
  return timestampMs(record.timestamp) ?? fallback;
}

function payloadTimestampMs(
  payload: Record<string, unknown>,
  keys: string[],
  fallback: number,
): number {
  for (const key of keys) {
    const raw = payload[key];
    const parsed = timestampMs(raw);
    if (parsed !== undefined) {
      const numeric = numberValue(raw);
      if (
        numeric !== undefined &&
        numeric >= 1_000_000_000 &&
        numeric < 1_000_000_000_000 &&
        Math.floor(fallback / 1_000) === Math.floor(numeric)
      ) {
        return fallback;
      }
      return parsed;
    }
  }
  return fallback;
}

function extractText(value: unknown, depth = 0): string {
  if (depth > 32) return "";
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => extractText(item, depth + 1))
      .filter((text) => text.length > 0)
      .join("\n");
  }

  if (!isRecord(value)) {
    return "";
  }

  for (const key of ["text", "content", "message", "summary"]) {
    const text = extractText(value[key], depth + 1);
    if (text.length > 0) {
      return text;
    }
  }

  return "";
}

function serialize(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function firstDefined(payload: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== undefined) {
      return payload[key];
    }
  }
  return undefined;
}

function statusMessage(payload: Record<string, unknown>): string | undefined {
  for (const key of ["error_message", "error", "reason", "message", "stderr"]) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (isRecord(value)) {
      const nested = statusMessage(value);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

function normalizedUsage(candidate: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!candidate) return undefined;
  const token = (snakeCase: string, camelCase: string): number =>
    Math.max(0, numberValue(candidate[snakeCase] ?? candidate[camelCase]) ?? 0);

  return {
    inputTokens: token("input_tokens", "inputTokens"),
    cachedInputTokens: token("cached_input_tokens", "cachedInputTokens"),
    cacheWriteInputTokens: token("cache_write_input_tokens", "cacheWriteInputTokens"),
    outputTokens: token("output_tokens", "outputTokens"),
    reasoningOutputTokens: token("reasoning_output_tokens", "reasoningOutputTokens"),
    totalTokens: token("total_tokens", "totalTokens"),
  };
}

function usageFromPayload(payload: Record<string, unknown>): TokenUsage | undefined {
  const info = isRecord(payload.info) ? payload.info : undefined;
  const candidate =
    (info && isRecord(info.last_token_usage) && info.last_token_usage) ||
    (isRecord(payload.last_token_usage) && payload.last_token_usage) ||
    (isRecord(payload.usage) && payload.usage) ||
    (info && isRecord(info.total_token_usage) && info.total_token_usage) ||
    (isRecord(payload.total_token_usage) && payload.total_token_usage);

  return normalizedUsage(candidate || undefined);
}

function totalUsageFromPayload(payload: Record<string, unknown>): TokenUsage | undefined {
  const info = isRecord(payload.info) ? payload.info : undefined;
  const candidate =
    (info && isRecord(info.total_token_usage) && info.total_token_usage) ||
    (isRecord(payload.total_token_usage) && payload.total_token_usage);
  return normalizedUsage(candidate || undefined);
}

function sameUsage(left: TokenUsage, right: TokenUsage): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.cacheWriteInputTokens === right.cacheWriteInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.reasoningOutputTokens === right.reasoningOutputTokens &&
    left.totalTokens === right.totalTokens
  );
}

function terminalToolStatus(value: unknown): NormalizedToolCall["status"] | undefined {
  const status = typeof value === "string" ? value.toLowerCase() : "";
  if (["ok", "success", "succeeded", "complete", "completed"].includes(status)) {
    return "ok";
  }
  if (["error", "failed", "failure", "cancelled", "canceled"].includes(status)) {
    return "error";
  }
  if (["incomplete", "in_progress", "pending", "running"].includes(status)) {
    return "incomplete";
  }
  return undefined;
}

function outputIsError(payload: Record<string, unknown>, result: unknown): boolean {
  const explicitStatus = terminalToolStatus(payload.status);
  if (explicitStatus === "error" || payload.success === false) {
    return true;
  }

  if (isRecord(result)) {
    if (terminalToolStatus(result.status) === "error" || result.success === false) {
      return true;
    }
    if (result.error !== undefined) {
      return true;
    }
    const exitCode = numberValue(result.exit_code ?? result.exitCode);
    if (exitCode !== undefined && exitCode !== 0) {
      return true;
    }
  }

  return (
    typeof result === "string" &&
    (/process exited with code\s+[1-9]\d*/i.test(result) ||
      /"(?:exit_code|exitCode)"\s*:\s*[1-9]\d*/.test(result))
  );
}

function childSessionId(payload: Record<string, unknown>, result?: unknown): string | undefined {
  let parsedResult = result;
  if (typeof result === "string") {
    try {
      parsedResult = JSON.parse(result);
    } catch {
      parsedResult = result;
    }
  }
  for (const source of [payload, isRecord(parsedResult) ? parsedResult : undefined]) {
    if (!source) {
      continue;
    }
    for (const key of ["child_session_id", "session_id", "thread_id", "agent_id"]) {
      const value = stringValue(source[key]);
      if (value !== undefined) {
        return value;
      }
    }
  }
  return undefined;
}

function combineText(parts: Array<string | undefined>): string {
  const unique: string[] = [];
  for (const part of parts) {
    if (part && !unique.includes(part)) {
      unique.push(part);
    }
  }
  return unique.join("\n");
}

function generationHasOutput(generation: GenerationDraft): boolean {
  return (
    generation.output.length > 0 ||
    generation.reasoning.length > 0 ||
    generation.toolCallIds.length > 0
  );
}

function ensureGeneration(builder: TurnBuilder, atMs: number): GenerationDraft {
  if (builder.currentGeneration) {
    builder.currentGeneration.endedAtMs = Math.max(builder.currentGeneration.endedAtMs, atMs);
    return builder.currentGeneration;
  }

  const firstGeneration = builder.turn.generations.length === 0;
  const input = firstGeneration
    ? [...builder.turn.userMessages]
    : builder.pendingGenerationInputs.splice(0);
  const inputStart =
    input.length > 0 ? Math.min(...input.map((message) => message.timestampMs)) : atMs;
  builder.currentGeneration = {
    model: builder.turn.model,
    startedAtMs: Math.max(builder.turn.startedAtMs, inputStart),
    endedAtMs: atMs,
    input,
    output: [],
    reasoning: [],
    toolCallIds: [],
  };
  return builder.currentGeneration;
}

function finishGeneration(builder: TurnBuilder, atMs: number, usage?: TokenUsage): void {
  const generation = builder.currentGeneration;
  if (!generation) {
    return;
  }

  generation.endedAtMs = Math.max(generation.startedAtMs, generation.endedAtMs, atMs);
  generation.usage = usage ?? generation.usage;
  if (generationHasOutput(generation)) {
    const normalized: NormalizedGeneration = {
      index: builder.turn.generations.length,
      model: generation.model,
      startedAtMs: generation.startedAtMs,
      endedAtMs: generation.endedAtMs,
      input: generation.input,
      output: generation.output,
      reasoning: generation.reasoning,
      toolCallIds: generation.toolCallIds,
      reconstructionConfidence: "heuristic",
    };
    if (generation.usage) {
      normalized.usage = generation.usage;
    }
    builder.turn.generations.push(normalized);
  }
  builder.currentGeneration = undefined;
}

function removeMessage(builder: TurnBuilder, message: NormalizedMessage): void {
  builder.turn.userMessages = builder.turn.userMessages.filter(
    (candidate) => candidate !== message,
  );
  builder.turn.assistantMessages = builder.turn.assistantMessages.filter(
    (candidate) => candidate !== message,
  );
  builder.pendingGenerationInputs = builder.pendingGenerationInputs.filter(
    (candidate) => candidate !== message,
  );
  if (builder.currentGeneration) {
    builder.currentGeneration.input = builder.currentGeneration.input.filter(
      (candidate) => candidate !== message,
    );
    builder.currentGeneration.output = builder.currentGeneration.output.filter(
      (candidate) => candidate !== message,
    );
  }
  for (const generation of builder.turn.generations) {
    generation.input = generation.input.filter((candidate) => candidate !== message);
    generation.output = generation.output.filter((candidate) => candidate !== message);
  }
}

function addReasoning(builder: TurnBuilder, summary: string, content: string, atMs: number): void {
  if (summary.length === 0 && content.length === 0) {
    return;
  }
  const generation = ensureGeneration(builder, atMs);
  const previous = generation.reasoning.at(-1);
  if (
    previous &&
    ((summary.length > 0 && previous.summary.length > 0 && summary.startsWith(previous.summary)) ||
      (content.length > 0 && previous.content && content.startsWith(previous.content)))
  ) {
    if (summary.length > 0) previous.summary = summary;
    if (content.length > 0) previous.content = content;
    previous.timestampMs = atMs;
    return;
  }
  const reasoning: NormalizedReasoning = { summary, timestampMs: atMs };
  if (content.length > 0) {
    reasoning.content = content;
  }
  builder.turn.reasoning.push(reasoning);
  generation.reasoning.push(reasoning);
}

function flushRawReasoning(builder: TurnBuilder, atMs: number): void {
  if (builder.pendingRawReasoning.length === 0) {
    return;
  }
  const content = combineText(builder.pendingRawReasoning.map((item) => item.text));
  const timestamp = builder.pendingRawReasoning[0]?.timestampMs ?? atMs;
  builder.pendingRawReasoning = [];
  addReasoning(builder, "", content, timestamp);
}

function addAssistantMessage(
  builder: TurnBuilder,
  content: string,
  atMs: number,
  phase: string | undefined,
  fallback: boolean,
): NormalizedMessage | undefined {
  if (content.length === 0) {
    return undefined;
  }

  const duplicate = builder.turn.assistantMessages.find(
    (message) => message.content === content && Math.abs(message.timestampMs - atMs) <= 1,
  );
  if (duplicate) {
    if (!fallback && phase !== undefined) {
      duplicate.phase = phase;
    }
    return duplicate;
  }

  const message: NormalizedMessage = {
    role: "assistant",
    content,
    timestampMs: atMs,
  };
  if (phase !== undefined) {
    message.phase = phase;
  }
  builder.turn.assistantMessages.push(message);
  ensureGeneration(builder, atMs).output.push(message);
  if (fallback) {
    builder.fallbackAssistants.add(message);
  }
  return message;
}

function addCanonicalAssistant(
  builder: TurnBuilder,
  content: string,
  atMs: number,
  phase: string | undefined,
): void {
  for (const fallback of builder.fallbackAssistants) {
    if (fallback.content === content && Math.abs(fallback.timestampMs - atMs) <= 1) {
      removeMessage(builder, fallback);
      builder.fallbackAssistants.delete(fallback);
    }
  }
  addAssistantMessage(builder, content, atMs, phase, false);
}

function addCanonicalUser(builder: TurnBuilder, content: string, atMs: number): void {
  if (content.length === 0) {
    return;
  }
  for (const fallback of builder.fallbackUsers) {
    removeMessage(builder, fallback);
  }
  builder.fallbackUsers.clear();
  builder.hasCanonicalUser = true;

  const duplicate = builder.turn.userMessages.some(
    (message) => message.content === content && Math.abs(message.timestampMs - atMs) <= 1,
  );
  if (duplicate) {
    return;
  }
  const message: NormalizedMessage = { role: "user", content, timestampMs: atMs };
  builder.turn.userMessages.push(message);
  if (builder.currentGeneration && builder.turn.generations.length === 0) {
    builder.currentGeneration.input.push(message);
  } else if (builder.turn.generations.length > 0) {
    builder.pendingGenerationInputs.push(message);
  }
}

function addFallbackUser(builder: TurnBuilder, content: string, atMs: number): void {
  if (content.length === 0 || builder.hasCanonicalUser || !builder.contextSeen) {
    return;
  }
  const message: NormalizedMessage = { role: "user", content, timestampMs: atMs };
  builder.turn.userMessages.push(message);
  builder.fallbackUsers.add(message);
  if (builder.turn.generations.length > 0) {
    builder.pendingGenerationInputs.push(message);
  }
}

function createTurnBuilder(
  id: string,
  threadId: string,
  model: string,
  startedAtMs: number,
): TurnBuilder {
  return {
    turn: {
      id,
      threadId,
      model,
      startedAtMs,
      endedAtMs: startedAtMs,
      status: "incomplete",
      userMessages: [],
      assistantMessages: [],
      reasoning: [],
      tools: [],
      generations: [],
    },
    contextSeen: false,
    hasCanonicalUser: false,
    fallbackUsers: new Set(),
    fallbackAssistants: new Set(),
    pendingRawReasoning: [],
    pendingGenerationInputs: [],
    toolsById: new Map(),
    toolOutputMessages: new Map(),
    toolOutputPriorities: new Map(),
    lastTimestampMs: startedAtMs,
    closed: false,
  };
}

function toolDescriptor(
  itemType: string,
  payload: Record<string, unknown>,
): { name: string; namespace?: string; arguments: string; embeddedResult?: unknown } {
  if (itemType === "function_call") {
    return {
      name: stringValue(payload.name) ?? "function",
      namespace: stringValue(payload.namespace),
      arguments: serialize(payload.arguments),
    };
  }
  if (itemType === "custom_tool_call") {
    return {
      name: stringValue(payload.name) ?? "custom_tool",
      namespace: stringValue(payload.namespace),
      arguments: serialize(payload.input),
    };
  }
  if (["local_shell_call", "shell_call"].includes(itemType)) {
    return {
      name: "local_shell",
      arguments: serialize(firstDefined(payload, ["action", "command", "input"])),
      embeddedResult: firstDefined(payload, ["output", "result"]),
    };
  }
  if (itemType === "web_search_call") {
    return {
      name: "web_search",
      arguments: serialize(firstDefined(payload, ["action", "query", "input"])),
      embeddedResult: firstDefined(payload, ["output", "result", "results"]),
    };
  }
  if (["image_generation_call", "image_call"].includes(itemType)) {
    return {
      name: "image_generation",
      arguments: serialize(firstDefined(payload, ["prompt", "input", "action"])),
      embeddedResult: firstDefined(payload, ["output", "result", "images"]),
    };
  }
  return {
    name: "tool_search",
    arguments: serialize(payload.arguments),
    embeddedResult: firstDefined(payload, ["output", "result", "tools"]),
  };
}

function addToolCall(
  builder: TurnBuilder,
  itemType: string,
  payload: Record<string, unknown>,
  atMs: number,
  fallbackCallId: string,
): NormalizedToolCall {
  const descriptor = toolDescriptor(itemType, payload);
  const callId =
    stringValue(payload.call_id) ??
    stringValue(payload.callId) ??
    stringValue(payload.id) ??
    fallbackCallId;
  let tool = builder.toolsById.get(callId);
  if (!tool) {
    tool = {
      callId,
      name: descriptor.name,
      arguments: descriptor.arguments,
      startedAtMs: atMs,
      status: "incomplete",
    };
    builder.toolsById.set(callId, tool);
    builder.turn.tools.push(tool);
  } else {
    tool.name = descriptor.name;
    tool.arguments = descriptor.arguments;
    tool.startedAtMs = Math.min(tool.startedAtMs, atMs);
  }
  if (descriptor.namespace !== undefined) {
    tool.namespace = descriptor.namespace;
  }
  tool.childSessionId = childSessionId(payload) ?? tool.childSessionId;

  const generation = ensureGeneration(builder, atMs);
  if (!generation.toolCallIds.includes(callId)) {
    generation.toolCallIds.push(callId);
  }

  if (descriptor.embeddedResult !== undefined) {
    applyToolOutput(builder, callId, descriptor.name, payload, descriptor.embeddedResult, atMs, 2);
  } else if (["web_search_call", "image_generation_call", "image_call"].includes(itemType)) {
    const terminal = terminalToolStatus(payload.status);
    if (terminal && terminal !== "incomplete") {
      tool.status = terminal;
      tool.endedAtMs = atMs;
    }
  }
  return tool;
}

function applyToolOutput(
  builder: TurnBuilder,
  callId: string,
  fallbackName: string,
  payload: Record<string, unknown>,
  result: unknown,
  atMs: number,
  priority: number,
): void {
  let tool = builder.toolsById.get(callId);
  if (!tool) {
    tool = {
      callId,
      name: fallbackName,
      arguments: "",
      startedAtMs: atMs,
      status: "incomplete",
    };
    builder.toolsById.set(callId, tool);
    builder.turn.tools.push(tool);
  }

  const previousPriority = builder.toolOutputPriorities.get(callId) ?? -1;
  const output = serialize(result);
  if (priority >= previousPriority) {
    tool.result = output;
    builder.toolOutputPriorities.set(callId, priority);
    const failed = outputIsError(payload, result);
    tool.status = failed ? "error" : (terminalToolStatus(payload.status) ?? "ok");
    tool.endedAtMs = atMs;
    if (failed) {
      tool.errorMessage =
        statusMessage(payload) ?? (isRecord(result) ? statusMessage(result) : output);
    } else {
      delete tool.errorMessage;
    }
    tool.childSessionId = childSessionId(payload, result) ?? tool.childSessionId;
  }

  let message = builder.toolOutputMessages.get(callId);
  if (!message) {
    message = { role: "tool", content: output, timestampMs: atMs };
    builder.toolOutputMessages.set(callId, message);
    builder.pendingGenerationInputs.push(message);
  } else if (priority >= previousPriority) {
    message.content = output;
    message.timestampMs = atMs;
  }
}

function outputDescriptor(itemType: string): { name: string; priority: number } {
  if (itemType === "function_call_output") {
    return { name: "function", priority: 2 };
  }
  if (itemType === "custom_tool_call_output") {
    return { name: "custom_tool", priority: 2 };
  }
  if (["local_shell_call_output", "shell_call_output"].includes(itemType)) {
    return { name: "local_shell", priority: 2 };
  }
  if (["web_search_call_output", "web_search_output"].includes(itemType)) {
    return { name: "web_search", priority: 2 };
  }
  if (["image_generation_call_output", "image_call_output"].includes(itemType)) {
    return { name: "image_generation", priority: 2 };
  }
  return { name: "tool_search", priority: 2 };
}

function applyHookAssistantMessage(builder: TurnBuilder, hookMessage: string): void {
  if (hookMessage.length === 0) {
    return;
  }
  const reversed = [...builder.turn.assistantMessages].reverse();
  const target =
    reversed.find((message) => message.phase === "final" || message.phase === "final_answer") ??
    reversed.find((message) => message.phase !== "commentary");

  if (target) {
    target.content = hookMessage;
    target.phase ??= "final_answer";
    for (const duplicate of [...builder.turn.assistantMessages]) {
      if (duplicate !== target && duplicate.content === hookMessage) {
        removeMessage(builder, duplicate);
      }
    }
    return;
  }

  const message: NormalizedMessage = {
    role: "assistant",
    content: hookMessage,
    timestampMs: builder.turn.endedAtMs,
    phase: "final_answer",
  };
  builder.turn.assistantMessages.push(message);
  const lastGeneration = builder.turn.generations.at(-1);
  if (lastGeneration) {
    lastGeneration.output.push(message);
    lastGeneration.endedAtMs = Math.max(lastGeneration.endedAtMs, message.timestampMs);
  } else {
    builder.turn.generations.push({
      index: 0,
      model: builder.turn.model,
      startedAtMs: builder.turn.startedAtMs,
      endedAtMs: builder.turn.endedAtMs,
      input: [...builder.turn.userMessages],
      output: [message],
      reasoning: [],
      toolCallIds: [],
      reconstructionConfidence: "heuristic",
    });
  }
}

export function parseRolloutJsonl(jsonl: string): ParsedRolloutJsonl {
  const diagnostics: string[] = [];
  const records: RolloutRecord[] = [];
  const lines = jsonl.split("\n");
  if (lines.length > 250_001) {
    throw new Error("Codex transcript exceeds the supported record count");
  }
  if (!jsonl.endsWith("\n") && lines.at(-1)?.trim()) {
    diagnostics.push(`Line ${lines.length}: ignored unterminated JSONL record`);
    lines.pop();
  } else if (lines.at(-1) === "") {
    lines.pop();
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let line = lines[index] ?? "";
    if (lineNumber === 1) {
      line = line.replace(/^\uFEFF/, "");
    }
    line = line.replace(/\r$/, "");
    if (line.trim().length === 0) {
      continue;
    }
    if (Buffer.byteLength(line, "utf8") > 4 * 1_048_576) {
      throw new Error(`Line ${lineNumber}: Codex transcript record exceeds the supported size`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      diagnostics.push(`Line ${lineNumber}: malformed JSONL record`);
      continue;
    }
    if (!isRecord(parsed)) {
      diagnostics.push(`Line ${lineNumber}: JSONL record is not an object`);
      continue;
    }
    if (typeof parsed.type !== "string" || !isRecord(parsed.payload)) {
      diagnostics.push(`Line ${lineNumber}: JSONL record is missing a type or object payload`);
      continue;
    }

    let timestamp: string;
    if (typeof parsed.timestamp === "string") {
      timestamp = parsed.timestamp;
    } else if (typeof parsed.timestamp === "number") {
      timestamp = String(parsed.timestamp);
    } else {
      timestamp = "";
      diagnostics.push(`Line ${lineNumber}: JSONL record has no usable timestamp`);
    }
    if (timestamp.length > 0 && timestampMs(timestamp) === undefined) {
      diagnostics.push(`Line ${lineNumber}: JSONL record has an invalid timestamp`);
    }

    const ordinal = numberValue(parsed.ordinal);
    records.push({
      timestamp,
      ordinal: ordinal === undefined ? lineNumber : ordinal,
      type: parsed.type,
      payload: parsed.payload,
    });
  }

  return { records, diagnostics };
}

export function parseRolloutTranscript(jsonl: string, hook: StopHookInput): NormalizedSession {
  const parsed = parseRolloutJsonl(jsonl);
  const diagnostics = [...parsed.diagnostics];
  const metadataRecords = parsed.records.filter((record) => record.type === "session_meta");
  const canonicalMetadata =
    metadataRecords.find((record) => {
      const id = stringValue(record.payload.id) ?? stringValue(record.payload.session_id);
      return id === hook.session_id;
    }) ?? metadataRecords[0];
  const metadata = canonicalMetadata?.payload ?? {};
  if (!canonicalMetadata) {
    diagnostics.push("Transcript has no session_meta record; hook metadata was used");
  } else {
    const metadataId = stringValue(metadata.id) ?? stringValue(metadata.session_id);
    if (metadataId !== undefined && metadataId !== hook.session_id) {
      diagnostics.push(
        `No session_meta record matched hook session ${hook.session_id}; using ${metadataId}`,
      );
    }
  }

  const sessionId =
    stringValue(metadata.id) ??
    stringValue(metadata.session_id) ??
    hook.session_id ??
    "unknown-session";
  const session: NormalizedSession = {
    id: sessionId,
    turns: [],
    subagents: [],
    diagnostics,
  };
  const sessionRecords = recordsForSession(parsed.records, canonicalMetadata, diagnostics);
  const assignMetadata = (
    key: keyof Pick<
      NormalizedSession,
      "cwd" | "originator" | "cliVersion" | "source" | "modelProvider" | "parentThreadId"
    >,
    value: unknown,
  ): void => {
    const normalized = stringValue(value);
    if (normalized !== undefined) {
      session[key] = normalized;
    }
  };
  assignMetadata("cwd", metadata.cwd ?? hook.cwd);
  assignMetadata("originator", metadata.originator);
  assignMetadata("cliVersion", metadata.cli_version);
  assignMetadata("source", metadata.source);
  assignMetadata("modelProvider", metadata.model_provider);
  assignMetadata("parentThreadId", metadata.parent_thread_id ?? metadata.forked_from_id);

  const metadataTime = timestampMs(metadata.timestamp) ?? 0;
  const turnsById = new Map<string, TurnBuilder>();
  const orderedBuilders: TurnBuilder[] = [];
  let active: TurnBuilder | undefined;
  let lastTimestamp = metadataTime;

  const getOrCreateTurn = (
    id: string,
    atMs: number,
    model?: string,
    inferred = false,
  ): TurnBuilder => {
    const existing = turnsById.get(id);
    if (existing) {
      existing.turn.startedAtMs = Math.min(existing.turn.startedAtMs, atMs);
      existing.lastTimestampMs = Math.max(existing.lastTimestampMs, atMs);
      if (model !== undefined) {
        existing.turn.model = model;
        if (existing.currentGeneration) {
          existing.currentGeneration.model = model;
        }
      }
      return existing;
    }
    const builder = createTurnBuilder(
      id,
      sessionId,
      model ?? (id === hook.turn_id ? hook.model : "unknown"),
      atMs,
    );
    turnsById.set(id, builder);
    orderedBuilders.push(builder);
    if (inferred) {
      diagnostics.push(`Turn ${id} was inferred without a start event`);
    }
    return builder;
  };

  const finishTurn = (
    builder: TurnBuilder,
    atMs: number,
    status: NormalizedTurn["status"],
    message?: string,
  ): void => {
    flushRawReasoning(builder, atMs);
    finishGeneration(builder, atMs);
    builder.turn.endedAtMs = Math.max(builder.turn.startedAtMs, atMs);
    builder.lastTimestampMs = Math.max(builder.lastTimestampMs, atMs);
    builder.turn.status = status;
    if (message !== undefined) {
      builder.turn.statusMessage = message;
    }
    builder.closed = true;
  };

  for (const record of sessionRecords) {
    const atMs = recordTimestampMs(record, lastTimestamp);
    lastTimestamp = Math.max(lastTimestamp, atMs);
    const payload = record.payload;
    const eventType =
      record.type === "event_msg" ? stringValue(payload.type) : stringValue(record.type);
    const line = record.ordinal ?? 0;

    if (record.type === "session_meta") {
      continue;
    }

    if (eventType && START_EVENTS.has(eventType)) {
      const id = stringValue(payload.turn_id) ?? stringValue(payload.id);
      if (!id) {
        diagnostics.push(`Line ${line}: ${eventType} has no turn ID`);
        continue;
      }
      const startedAt = payloadTimestampMs(payload, ["started_at", "timestamp"], atMs);
      const model = stringValue(payload.model);
      if (active && active.turn.id !== id && !active.closed) {
        const status = active.turn.status === "failed" ? "failed" : "incomplete";
        const message =
          active.turn.status === "failed"
            ? active.turn.statusMessage
            : "A new turn started before this turn ended";
        finishTurn(active, atMs, status, message);
      }
      active = getOrCreateTurn(id, startedAt, model);
      active.closed = false;
      continue;
    }

    if (record.type === "turn_context") {
      const id = stringValue(payload.turn_id) ?? active?.turn.id;
      if (!id) {
        diagnostics.push(`Line ${line}: turn_context has no associated turn`);
        continue;
      }
      const builder = getOrCreateTurn(id, atMs, stringValue(payload.model), !turnsById.has(id));
      builder.contextSeen = true;
      builder.lastTimestampMs = Math.max(builder.lastTimestampMs, atMs);
      active = builder;
      continue;
    }

    if (eventType && COMPLETE_EVENTS.has(eventType)) {
      const id = stringValue(payload.turn_id) ?? active?.turn.id;
      if (!id) {
        diagnostics.push(`Line ${line}: ${eventType} has no associated turn`);
        continue;
      }
      const builder = getOrCreateTurn(id, atMs, undefined, !turnsById.has(id));
      const completionMessage = stringValue(payload.last_agent_message);
      if (completionMessage && builder.turn.assistantMessages.length === 0) {
        addAssistantMessage(builder, completionMessage, atMs, "final_answer", true);
      }
      const completedAt = payloadTimestampMs(payload, ["completed_at", "ended_at"], atMs);
      const durationMs = numberValue(payload.duration_ms);
      if (durationMs !== undefined && durationMs >= 0 && durationMs <= completedAt) {
        builder.turn.startedAtMs = completedAt - durationMs;
      }
      const explicitStatus = stringValue(payload.status)?.toLowerCase();
      const status: NormalizedTurn["status"] =
        payload.error !== undefined ||
        (explicitStatus && ["failed", "error", "failure"].includes(explicitStatus))
          ? "failed"
          : explicitStatus &&
              ["interrupted", "aborted", "cancelled", "canceled"].includes(explicitStatus)
            ? "interrupted"
            : "completed";
      finishTurn(builder, completedAt, status, statusMessage(payload));
      if (active === builder) {
        active = undefined;
      }
      continue;
    }

    if (eventType && ABORTED_EVENTS.has(eventType)) {
      const id = stringValue(payload.turn_id) ?? active?.turn.id;
      if (!id) {
        diagnostics.push(`Line ${line}: ${eventType} has no associated turn`);
        continue;
      }
      const builder = getOrCreateTurn(id, atMs, undefined, !turnsById.has(id));
      const completedAt = payloadTimestampMs(payload, ["completed_at", "ended_at"], atMs);
      finishTurn(builder, completedAt, "interrupted", statusMessage(payload));
      if (active === builder) {
        active = undefined;
      }
      continue;
    }

    if (eventType && FAILED_EVENTS.has(eventType)) {
      const id = stringValue(payload.turn_id) ?? active?.turn.id;
      if (!id) {
        diagnostics.push(`Line ${line}: ${eventType} has no associated turn`);
        continue;
      }
      const builder = getOrCreateTurn(id, atMs, undefined, !turnsById.has(id));
      const completedAt = payloadTimestampMs(payload, ["completed_at", "ended_at"], atMs);
      finishTurn(builder, completedAt, "failed", statusMessage(payload));
      if (active === builder) {
        active = undefined;
      }
      continue;
    }

    const explicitTurnId = stringValue(payload.turn_id);
    const builder = explicitTurnId ? turnsById.get(explicitTurnId) : active;
    if (builder) {
      builder.lastTimestampMs = Math.max(builder.lastTimestampMs, atMs);
      builder.turn.endedAtMs = Math.max(builder.turn.endedAtMs, atMs);
    }

    if (record.type === "response_item") {
      const itemType = stringValue(payload.type);
      if (!itemType) {
        diagnostics.push(`Line ${line}: response_item has no item type`);
        continue;
      }
      if (!builder) {
        diagnostics.push(`Line ${line}: response item ${itemType} is outside a turn`);
        continue;
      }

      if (itemType === "message") {
        const role = stringValue(payload.role);
        const content = extractText(payload.content);
        if (role === "assistant") {
          addCanonicalAssistant(builder, content, atMs, stringValue(payload.phase));
        } else if (role === "user") {
          addFallbackUser(builder, content, atMs);
        } else if (role === "tool") {
          builder.pendingGenerationInputs.push({ role: "tool", content, timestampMs: atMs });
        } else if (role !== "system" && role !== "developer") {
          diagnostics.push(`Line ${line}: unknown response message role ${role ?? "<missing>"}`);
        }
        continue;
      }

      if (itemType === "reasoning") {
        const summary = extractText(payload.summary);
        const raw = combineText([
          ...builder.pendingRawReasoning.map((item) => item.text),
          extractText(payload.content),
        ]);
        builder.pendingRawReasoning = [];
        addReasoning(builder, summary, raw, atMs);
        continue;
      }

      if (itemType === "agent_message") {
        addCanonicalUser(builder, extractText(payload.content), atMs);
        continue;
      }

      if (itemType === "error") {
        const message = statusMessage(payload) ?? "Unknown response error";
        builder.turn.status = "failed";
        builder.turn.statusMessage = message;
        diagnostics.push(`Turn ${builder.turn.id} error: ${message}`);
        continue;
      }

      if (
        [
          "function_call",
          "custom_tool_call",
          "local_shell_call",
          "shell_call",
          "web_search_call",
          "image_generation_call",
          "image_call",
          "tool_search_call",
        ].includes(itemType)
      ) {
        addToolCall(builder, itemType, payload, atMs, `${itemType}-${line}`);
        continue;
      }

      if (
        [
          "function_call_output",
          "custom_tool_call_output",
          "local_shell_call_output",
          "shell_call_output",
          "web_search_call_output",
          "web_search_output",
          "image_generation_call_output",
          "image_call_output",
          "tool_search_output",
        ].includes(itemType)
      ) {
        const descriptor = outputDescriptor(itemType);
        const callId =
          stringValue(payload.call_id) ?? stringValue(payload.callId) ?? `${itemType}-${line}`;
        if (!stringValue(payload.call_id) && !stringValue(payload.callId)) {
          diagnostics.push(`Line ${line}: ${itemType} has no call ID`);
        }
        const result = firstDefined(payload, ["output", "result", "data", "images", "tools"]);
        applyToolOutput(
          builder,
          callId,
          descriptor.name,
          payload,
          result,
          atMs,
          descriptor.priority,
        );
        continue;
      }

      diagnostics.push(`Line ${line}: unknown response item type ${itemType}`);
      continue;
    }

    if (record.type === "event_msg") {
      if (!eventType) {
        diagnostics.push(`Line ${line}: event_msg has no event type`);
        continue;
      }
      if (eventType === "user_message") {
        if (!builder) {
          diagnostics.push(`Line ${line}: user message is outside a turn`);
        } else {
          addCanonicalUser(builder, extractText(payload.message), atMs);
        }
        continue;
      }
      if (eventType === "agent_message") {
        if (!builder) {
          diagnostics.push(`Line ${line}: agent message is outside a turn`);
        } else {
          addAssistantMessage(
            builder,
            extractText(payload.message),
            atMs,
            stringValue(payload.phase),
            true,
          );
        }
        continue;
      }
      if (eventType === "agent_reasoning") {
        if (!builder) {
          diagnostics.push(`Line ${line}: reasoning is outside a turn`);
        } else {
          const text = extractText(payload.text);
          if (text.length > 0) {
            builder.pendingRawReasoning.push({ text, timestampMs: atMs });
            ensureGeneration(builder, atMs);
          }
        }
        continue;
      }
      if (eventType === "token_count") {
        if (!builder) {
          diagnostics.push(`Line ${line}: token usage is outside a turn`);
        } else {
          const totalUsage = totalUsageFromPayload(payload);
          if (
            totalUsage &&
            builder.lastTotalUsage &&
            sameUsage(totalUsage, builder.lastTotalUsage)
          ) {
            continue;
          }
          if (totalUsage) builder.lastTotalUsage = totalUsage;
          flushRawReasoning(builder, atMs);
          finishGeneration(builder, atMs, usageFromPayload(payload));
        }
        continue;
      }
      if (eventType === "item_completed") {
        if (!builder) {
          diagnostics.push(`Line ${line}: completed item is outside a turn`);
          continue;
        }
        const item = isRecord(payload.item) ? payload.item : undefined;
        const itemType = item ? stringValue(item.type) : undefined;
        const completedAt = payloadTimestampMs(payload, ["completed_at_ms"], atMs);
        if (!item || !itemType) {
          diagnostics.push(`Line ${line}: item_completed has no typed item`);
          continue;
        }
        if (itemType === "UserMessage") {
          addCanonicalUser(builder, extractText(item.content), completedAt);
        } else if (itemType === "AgentMessage") {
          addAssistantMessage(
            builder,
            extractText(item.content),
            completedAt,
            stringValue(item.phase),
            true,
          );
        } else if (itemType === "Reasoning") {
          addReasoning(
            builder,
            extractText(item.summary_text),
            extractText(item.raw_content),
            completedAt,
          );
        } else if (itemType === "CommandExecution") {
          const callId = stringValue(item.id) ?? `command-${line}`;
          addToolCall(
            builder,
            "function_call",
            {
              call_id: callId,
              name: "exec_command",
              arguments: serialize(item.command),
            },
            payloadTimestampMs(payload, ["started_at_ms"], completedAt),
            callId,
          );
          applyToolOutput(
            builder,
            callId,
            "exec_command",
            item,
            firstDefined(item, ["aggregated_output", "formatted_output", "stdout", "stderr"]),
            completedAt,
            1,
          );
        } else if (itemType === "DynamicToolCall") {
          const callId = stringValue(item.id) ?? `dynamic-tool-${line}`;
          addToolCall(
            builder,
            "function_call",
            {
              call_id: callId,
              name: stringValue(item.tool) ?? "dynamic_tool",
              namespace: item.namespace,
              arguments: serialize(item.arguments),
            },
            payloadTimestampMs(payload, ["started_at_ms"], completedAt),
            callId,
          );
          applyToolOutput(
            builder,
            callId,
            stringValue(item.tool) ?? "dynamic_tool",
            item,
            item.content_items ?? item.error,
            completedAt,
            1,
          );
        } else if (itemType === "SubAgentActivity") {
          const callId = stringValue(item.id);
          const childId = stringValue(item.agent_thread_id);
          if (callId && childId) {
            const tool = builder.toolsById.get(callId);
            if (tool) tool.childSessionId = childId;
          }
        }
        continue;
      }
      if (eventType === "web_search_end") {
        if (!builder) {
          diagnostics.push(`Line ${line}: web search output is outside a turn`);
        } else {
          const callId = stringValue(payload.call_id) ?? `web_search-${line}`;
          const result = firstDefined(payload, ["results", "result", "output", "query", "action"]);
          applyToolOutput(builder, callId, "web_search", payload, result, atMs, 1);
        }
        continue;
      }
      if (eventType === "sub_agent_activity") {
        if (builder) {
          const callId = stringValue(payload.event_id);
          const childId = stringValue(payload.agent_thread_id);
          if (callId && childId) {
            const tool = builder.toolsById.get(callId);
            if (tool) {
              tool.childSessionId = childId;
            } else {
              diagnostics.push(
                `Line ${line}: sub-agent activity references unknown call ${callId}`,
              );
            }
          }
        }
        continue;
      }
      if (eventType === "patch_apply_end" || eventType === "mcp_tool_call_end") {
        if (builder) {
          const callId = stringValue(payload.call_id) ?? `${eventType}-${line}`;
          const result =
            eventType === "mcp_tool_call_end"
              ? firstDefined(payload, ["result", "output"])
              : {
                  changes: payload.changes,
                  stdout: payload.stdout,
                  stderr: payload.stderr,
                  success: payload.success,
                };
          applyToolOutput(builder, callId, eventType, payload, result, atMs, 1);
        }
        continue;
      }
      if (ERROR_EVENTS.has(eventType)) {
        const message = statusMessage(payload) ?? "Unknown turn error";
        diagnostics.push(
          builder ? `Turn ${builder.turn.id} error: ${message}` : `Line ${line}: ${message}`,
        );
        if (builder) {
          builder.turn.status = "failed";
          builder.turn.statusMessage = message;
          const callId = stringValue(payload.call_id);
          if (callId) {
            applyToolOutput(builder, callId, "tool", payload, payload.error ?? message, atMs, 2);
          }
        }
        continue;
      }
      if (IGNORED_EVENTS.has(eventType)) {
        continue;
      }
      diagnostics.push(`Line ${line}: unknown event type ${eventType}`);
      continue;
    }

    if (ERROR_EVENTS.has(record.type)) {
      const message = statusMessage(payload) ?? "Unknown turn error";
      diagnostics.push(builder ? `Turn ${builder.turn.id} error: ${message}` : message);
      if (builder) {
        builder.turn.status = "failed";
        builder.turn.statusMessage = message;
      }
      continue;
    }

    if (!IGNORED_RECORDS.has(record.type)) {
      diagnostics.push(`Line ${line}: unknown record type ${record.type}`);
    }
  }

  for (const builder of orderedBuilders) {
    if (!builder.closed) {
      flushRawReasoning(builder, builder.lastTimestampMs);
      finishGeneration(builder, builder.lastTimestampMs);
      builder.turn.endedAtMs = Math.max(builder.turn.startedAtMs, builder.lastTimestampMs);
      if (builder.turn.status !== "failed") {
        builder.turn.status = builder.turn.id === hook.turn_id ? "at_stop_hook" : "incomplete";
      }
    }
    for (const tool of builder.turn.tools) {
      if (tool.status === "incomplete" && tool.endedAtMs !== undefined) {
        tool.status = "ok";
      }
    }
  }

  const hookTurn = turnsById.get(hook.turn_id);
  if (!hookTurn) {
    diagnostics.push(`Hook turn ${hook.turn_id} was not found in the transcript`);
  } else if (hook.last_assistant_message) {
    applyHookAssistantMessage(hookTurn, hook.last_assistant_message);
  }

  session.turns = orderedBuilders.map((builder) => builder.turn);
  return session;
}

function recordsForSession(
  records: RolloutRecord[],
  canonicalMetadata: RolloutRecord | undefined,
  diagnostics: string[],
): RolloutRecord[] {
  const metadata = canonicalMetadata?.payload;
  if (!canonicalMetadata || !metadata || !stringValue(metadata.forked_from_id)) return records;

  const createdAt = timestampMs(metadata.timestamp) ?? recordTimestampMs(canonicalMetadata, 0);
  const firstOwnTurn = records.findIndex((record) => {
    const type =
      record.type === "event_msg" ? stringValue(record.payload.type) : stringValue(record.type);
    if (!type || !START_EVENTS.has(type)) return false;
    const startedAt = payloadTimestampMs(
      record.payload,
      ["started_at", "timestamp"],
      recordTimestampMs(record, 0),
    );
    return startedAt >= createdAt;
  });
  if (firstOwnTurn <= 0) return records;

  diagnostics.push(`Ignored ${firstOwnTurn - 1} inherited record(s) from parent session history`);
  return [
    canonicalMetadata,
    ...records.slice(firstOwnTurn).filter((record) => record.type !== "session_meta"),
  ];
}
