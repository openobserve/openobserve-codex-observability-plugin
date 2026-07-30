import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HookRunError, parseStopHookInput, runHook } from "../src/index.ts";
import type { OtlpExportTraceRequest } from "../src/types.ts";

describe("Stop hook integration", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("reconstructs a Stop-time turn and exports prompt and response exactly once", async () => {
    const requests: OtlpExportTraceRequest[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as OtlpExportTraceRequest);
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"partialSuccess":{}}');
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

    try {
      const root = await mkdtemp(join(tmpdir(), "openobserve-codex-hook-"));
      temporaryDirectories.push(root);
      const address = server.address() as AddressInfo;
      const codexHome = join(root, ".codex");
      const project = join(root, "project");
      const transcriptPath = join(codexHome, "sessions", "rollout-session-hook.jsonl");
      await Promise.all([
        writeJson(join(codexHome, "openobserve.json"), {
          enabled: true,
          endpoint: `http://127.0.0.1:${address.port}`,
          organization: "default",
          stream_name: "codex",
          authorization: "Basic test-only",
          capture_content: true,
          capture_tool_content: true,
        }),
        writeText(transcriptPath, rollout()),
        mkdir(project, { recursive: true }),
      ]);
      const hook = JSON.stringify({
        session_id: "session-hook",
        turn_id: "turn-hook",
        transcript_path: transcriptPath,
        cwd: project,
        hook_event_name: "Stop",
        model: "gpt-hook",
        last_assistant_message: "Hook response",
      });
      const env = { CODEX_HOME: codexHome, PLUGIN_DATA: join(root, "plugin-data") };

      const first = await runHook(hook, { env });
      const second = await runHook(hook, { env });

      expect(first.status).toBe("exported");
      expect(second.status).toBe("deduplicated");
      expect(requests).toHaveLength(1);
      const spans = requests[0].resourceSpans[0].scopeSpans[0].spans;
      const generation = spans.find((span) => span.name === "chat gpt-hook");
      expect(messageContent(generation, "gen_ai.input.messages")).toEqual(["Hook prompt"]);
      expect(messageContent(generation, "gen_ai.output.messages")).toEqual(["Hook response"]);
      expect(generation?.status.code).toBe(1);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    }
  });

  it("does not access a transcript while tracing is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "openobserve-codex-disabled-"));
    temporaryDirectories.push(root);
    const result = await runHook(
      JSON.stringify({
        session_id: "session-disabled",
        turn_id: "turn-disabled",
        transcript_path: join(root, "missing.jsonl"),
        cwd: root,
        hook_event_name: "Stop",
        model: "gpt-disabled",
        last_assistant_message: null,
      }),
      { env: { CODEX_HOME: join(root, ".codex") } },
    );

    expect(result.status).toBe("disabled");
  });

  it("rejects transcripts outside CODEX_HOME/sessions and mismatched sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "openobserve-codex-trust-"));
    temporaryDirectories.push(root);
    const codexHome = join(root, ".codex");
    const project = join(root, "project");
    const outsidePath = join(root, "outside.jsonl");
    const mismatchedPath = join(codexHome, "sessions", "rollout-mismatch.jsonl");
    await Promise.all([
      writeJson(join(codexHome, "openobserve.json"), {
        enabled: true,
        endpoint: "http://127.0.0.1:5080",
      }),
      writeText(outsidePath, rollout()),
      writeText(mismatchedPath, rollout().replaceAll("session-hook", "different-session")),
      mkdir(project, { recursive: true }),
    ]);
    const baseHook = {
      session_id: "session-hook",
      turn_id: "turn-hook",
      cwd: project,
      hook_event_name: "Stop",
      model: "gpt-hook",
      last_assistant_message: "Hook response",
    };
    const env = { CODEX_HOME: codexHome, PLUGIN_DATA: join(root, "plugin-data") };

    await expect(
      runHook(JSON.stringify({ ...baseHook, transcript_path: outsidePath }), { env }),
    ).rejects.toThrow("must be inside the Codex sessions directory");
    await expect(
      runHook(JSON.stringify({ ...baseHook, transcript_path: mismatchedPath }), { env }),
    ).rejects.toThrow("does not match the transcript session");
  });

  it("preserves trusted strict mode when project configuration is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "openobserve-codex-strict-"));
    temporaryDirectories.push(root);
    const codexHome = join(root, ".codex");
    const project = join(root, "project");
    await Promise.all([
      writeJson(join(codexHome, "openobserve.json"), { fail_on_error: true }),
      writeText(join(project, ".codex", "openobserve.json"), "{"),
    ]);

    const failure = runHook(
      JSON.stringify({
        session_id: "session-strict",
        turn_id: "turn-strict",
        transcript_path: join(codexHome, "sessions", "missing.jsonl"),
        cwd: project,
        hook_event_name: "Stop",
        model: "gpt-strict",
        last_assistant_message: null,
      }),
      { env: { CODEX_HOME: codexHome } },
    );

    await expect(failure).rejects.toMatchObject({ strict: true });
  });

  it("validates hook input without echoing sensitive fields", () => {
    expect(() => parseStopHookInput('{"hook_event_name":"Other","prompt":"private"}')).toThrow(
      "hook_event_name must be Stop",
    );
    expect(() => parseStopHookInput("not-json")).toThrow("not valid JSON");
    return expect(
      runHook("not-json", { env: { OPENOBSERVE_CODEX_FAIL_ON_ERROR: "true" } }),
    ).rejects.toMatchObject({ strict: true } satisfies Partial<HookRunError>);
  });
});

function rollout(): string {
  const records = [
    record(
      "session_meta",
      {
        id: "session-hook",
        cwd: "/workspace",
        originator: "codex_cli_rs",
        cli_version: "0.145.0",
        model_provider: "openai",
      },
      0,
    ),
    record("event_msg", { type: "task_started", turn_id: "turn-hook" }, 1),
    record("turn_context", { turn_id: "turn-hook", model: "gpt-hook" }, 2),
    record("event_msg", { type: "user_message", message: "Hook prompt" }, 3),
    record(
      "response_item",
      {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Hook response" }],
      },
      4,
    ),
    record(
      "event_msg",
      {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
        },
      },
      5,
    ),
  ];
  return `${records.map((item) => JSON.stringify(item)).join("\n")}\n`;
}

function record(type: string, payload: Record<string, unknown>, second: number) {
  return { timestamp: `2026-07-29T10:00:0${second}.000Z`, type, payload };
}

function messageContent(
  span:
    | OtlpExportTraceRequest["resourceSpans"][number]["scopeSpans"][number]["spans"][number]
    | undefined,
  key: string,
): string[] {
  const serialized = span?.attributes.find((attribute) => attribute.key === key)?.value.stringValue;
  if (!serialized) return [];
  return (JSON.parse(serialized) as Array<{ content: string }>).map((message) => message.content);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}
