import type { NormalizedSession, NormalizedTurn, OpenObserveConfig } from "../src/types.ts";

export function makeConfig(overrides: Partial<OpenObserveConfig> = {}): OpenObserveConfig {
  return {
    enabled: true,
    endpoint: "http://127.0.0.1:5080/api/default/v1/traces",
    organization: "default",
    streamName: "codex",
    authorization: "Basic example",
    headers: {},
    captureContent: false,
    captureReasoning: false,
    captureToolContent: false,
    maxChars: 128,
    environment: "test",
    serviceName: "codex-test",
    timeoutMs: 1_000,
    debug: false,
    failOnError: false,
    stateDirectory: "/tmp/openobserve-codex-test",
    ...overrides,
  };
}

export function makeSession(turnOverrides: Partial<NormalizedTurn> = {}): NormalizedSession {
  const turn: NormalizedTurn = {
    id: "turn-1",
    threadId: "thread-1",
    model: "codex-model",
    startedAtMs: 1_700_000_000_000,
    endedAtMs: 1_700_000_001_000,
    status: "completed",
    userMessages: [
      {
        role: "user",
        content: "Inspect the project",
        timestampMs: 1_700_000_000_000,
      },
    ],
    assistantMessages: [
      {
        role: "assistant",
        content: "The project is ready",
        timestampMs: 1_700_000_000_900,
      },
    ],
    reasoning: [
      {
        summary: "Check the files",
        content: "Read the relevant files first",
        timestampMs: 1_700_000_000_100,
      },
    ],
    tools: [
      {
        callId: "call-1",
        name: "read_file",
        namespace: "workspace",
        arguments: '{"path":"src/index.ts"}',
        result: '{"lines":20}',
        startedAtMs: 1_700_000_000_200,
        endedAtMs: 1_700_000_000_300,
        status: "ok",
      },
    ],
    generations: [
      {
        index: 0,
        model: "codex-model",
        startedAtMs: 1_700_000_000_050,
        endedAtMs: 1_700_000_000_950,
        input: [
          {
            role: "user",
            content: "Inspect the project",
            timestampMs: 1_700_000_000_000,
          },
        ],
        output: [
          {
            role: "assistant",
            content: "The project is ready",
            timestampMs: 1_700_000_000_900,
          },
        ],
        reasoning: [
          {
            summary: "Check the files",
            timestampMs: 1_700_000_000_100,
          },
        ],
        usage: {
          inputTokens: 100,
          cachedInputTokens: 25,
          cacheWriteInputTokens: 10,
          outputTokens: 30,
          reasoningOutputTokens: 5,
          totalTokens: 130,
        },
        toolCallIds: ["call-1"],
        reconstructionConfidence: "heuristic",
      },
    ],
    ...turnOverrides,
  };

  return {
    id: "session-1",
    cwd: "/workspace/project",
    originator: "codex-cli",
    cliVersion: "1.2.3",
    source: "cli",
    modelProvider: "openai",
    turns: [turn],
    subagents: [],
    diagnostics: [],
  };
}
