import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { OtlpExportTraceRequest } from "../src/types.ts";

const PLUGIN_ROOT = resolve("plugins/openobserve");

describe("installed hook bundle", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("is content-addressed and exports the installed Stop hook exactly once after acceptance", async () => {
    const { bundlePath, filename, commandWindows } = await installedBundle();
    const bundle = await readFile(bundlePath);
    expect(filename).toBe(
      `index.${createHash("sha256").update(bundle).digest("hex").slice(0, 16)}.mjs`,
    );
    expect(commandWindows).toContain(filename);

    const requests: OtlpExportTraceRequest[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as OtlpExportTraceRequest);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          requests.length === 1
            ? '{"partialSuccess":{"rejectedSpans":1}}'
            : '{"partialSuccess":{}}',
        );
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

    try {
      const root = await mkdtemp(join(tmpdir(), "openobserve-codex-bundle-"));
      temporaryDirectories.push(root);
      const codexHome = join(root, ".codex");
      const project = join(root, "project");
      const transcriptPath = join(codexHome, "sessions", "rollout-session-bundle.jsonl");
      const address = server.address() as AddressInfo;
      await Promise.all([
        writeJson(join(codexHome, "openobserve.json"), {
          enabled: true,
          endpoint: `http://127.0.0.1:${address.port}`,
          authorization: "Basic test-only",
          capture_content: true,
        }),
        writeText(transcriptPath, rollout()),
        mkdir(project, { recursive: true }),
      ]);
      const hook = JSON.stringify({
        session_id: "session-bundle",
        turn_id: "turn-bundle",
        transcript_path: transcriptPath,
        cwd: project,
        hook_event_name: "Stop",
        model: "gpt-bundle",
        last_assistant_message: "Bundle response",
      });
      const env = {
        ...process.env,
        CODEX_HOME: codexHome,
        PLUGIN_DATA: join(root, "plugin-data"),
      };

      const rejected = await runBundle(bundlePath, hook, project, env);
      const accepted = await runBundle(bundlePath, hook, project, env);
      const deduplicated = await runBundle(bundlePath, hook, project, env);
      await writeJson(join(project, ".codex", "openobserve.json"), {
        endpoint: "https://untrusted.example",
      });
      const blockedProjectOverride = await runBundle(bundlePath, hook, project, env);

      expect(rejected).toMatchObject({ code: 0 });
      expect(rejected.stderr).toContain("trace export rejected 1 span(s)");
      expect(accepted).toEqual({ code: 0, stderr: "" });
      expect(deduplicated).toEqual({ code: 0, stderr: "" });
      expect(blockedProjectOverride.code).toBe(0);
      expect(blockedProjectOverride.stderr).toContain("project configuration cannot set endpoint");
      expect(requests).toHaveLength(2);
      const spans = requests[1].resourceSpans[0].scopeSpans[0].spans;
      const generation = spans.find((span) => span.name === "chat gpt-bundle");
      expect(messageContent(generation, "gen_ai.input.messages")).toEqual(["Bundle prompt"]);
      expect(messageContent(generation, "gen_ai.output.messages")).toEqual(["Bundle response"]);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    }
  });
});

async function installedBundle(): Promise<{
  bundlePath: string;
  filename: string;
  commandWindows: string;
}> {
  const manifest = JSON.parse(await readFile(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8")) as {
    hooks: {
      Stop: Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>;
    };
  };
  const handler = manifest.hooks.Stop[0]?.hooks[0];
  const match = handler?.command.match(/\$\{PLUGIN_ROOT\}\/dist\/(index\.[0-9a-f]{16}\.mjs)/);
  if (!handler || !match?.[1] || !handler.commandWindows) {
    throw new Error("Stop hook does not reference a portable content-addressed bundle");
  }
  return {
    bundlePath: join(PLUGIN_ROOT, "dist", match[1]),
    filename: match[1],
    commandWindows: handler.commandWindows,
  };
}

async function runBundle(
  bundlePath: string,
  input: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [bundlePath], {
    cwd,
    env,
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", resolveClose);
  });
  return { code, stderr: stderr.trim() };
}

function rollout(): string {
  const records = [
    record("session_meta", { id: "session-bundle", cwd: "/workspace" }, 0),
    record("event_msg", { type: "task_started", turn_id: "turn-bundle" }, 1),
    record("turn_context", { turn_id: "turn-bundle", model: "gpt-bundle" }, 2),
    record(
      "event_msg",
      { type: "user_message", turn_id: "turn-bundle", message: "Bundle prompt" },
      3,
    ),
    record(
      "response_item",
      {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Bundle response" }],
      },
      4,
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
