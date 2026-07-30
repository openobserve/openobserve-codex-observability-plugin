export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface StopHookInput {
  session_id: string;
  turn_id: string;
  transcript_path: string | null;
  cwd: string;
  hook_event_name: "Stop";
  model: string;
  permission_mode?: string;
  stop_hook_active?: boolean;
  last_assistant_message: string | null;
}

export interface RolloutRecord {
  timestamp: string;
  ordinal?: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface NormalizedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestampMs: number;
  phase?: string;
}

export interface NormalizedReasoning {
  summary: string;
  content?: string;
  timestampMs: number;
}

export interface NormalizedToolCall {
  callId: string;
  name: string;
  namespace?: string;
  arguments: string;
  result?: string;
  startedAtMs: number;
  endedAtMs?: number;
  status: "ok" | "error" | "incomplete";
  errorMessage?: string;
  childSessionId?: string;
}

export interface NormalizedGeneration {
  index: number;
  model: string;
  startedAtMs: number;
  endedAtMs: number;
  input: NormalizedMessage[];
  output: NormalizedMessage[];
  reasoning: NormalizedReasoning[];
  usage?: TokenUsage;
  toolCallIds: string[];
  reconstructionConfidence: "exact" | "heuristic";
}

export interface NormalizedTurn {
  id: string;
  threadId: string;
  model: string;
  startedAtMs: number;
  endedAtMs: number;
  status: "completed" | "failed" | "interrupted" | "at_stop_hook" | "incomplete";
  statusMessage?: string;
  userMessages: NormalizedMessage[];
  assistantMessages: NormalizedMessage[];
  reasoning: NormalizedReasoning[];
  tools: NormalizedToolCall[];
  generations: NormalizedGeneration[];
}

export interface NormalizedSession {
  id: string;
  cwd?: string;
  originator?: string;
  cliVersion?: string;
  source?: string;
  modelProvider?: string;
  parentThreadId?: string;
  turns: NormalizedTurn[];
  subagents: NormalizedSubagent[];
  diagnostics: string[];
}

export interface NormalizedSubagent {
  parentCallId: string;
  parentTurnId?: string;
  session: NormalizedSession;
}

export interface OpenObserveConfig {
  enabled: boolean;
  endpoint: string;
  organization: string;
  streamName: string;
  authorization?: string;
  headers: Record<string, string>;
  captureContent: boolean;
  captureReasoning: boolean;
  captureToolContent: boolean;
  maxChars: number;
  environment: string;
  serviceName: string;
  timeoutMs: number;
  debug: boolean;
  failOnError: boolean;
  stateDirectory: string;
}

export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpEvent {
  name: string;
  timeUnixNano: string;
  attributes?: OtlpKeyValue[];
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events?: OtlpEvent[];
  status: {
    code: number;
    message?: string;
  };
}

export interface OtlpExportTraceRequest {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: OtlpSpan[];
    }>;
  }>;
}

export interface ExportState {
  version: 1;
  exportedTurns: Record<string, { traceId: string; exportedAt: string }>;
}
