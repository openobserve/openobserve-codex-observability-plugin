import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { loadConfig, loadTrustedFailOnError } from "./config.ts";
import { exportTurnOnce, type ExportResult } from "./exporter.ts";
import { redactAndTruncate } from "./otlp.ts";
import { parseRolloutTranscript } from "./parser.ts";
import { discoverSubagents } from "./subagents.ts";
import type { StopHookInput } from "./types.ts";

const MAX_HOOK_INPUT_BYTES = 1_048_576;
const MAX_TRANSCRIPT_BYTES = 64 * 1_048_576;

export interface RunHookOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export interface HookRunResult {
  status: "disabled" | "exported" | "deduplicated";
  export?: ExportResult;
  diagnostics: string[];
}

export class HookRunError extends Error {
  constructor(
    message: string,
    readonly strict: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HookRunError";
  }
}

export async function runHook(input: string, options: RunHookOptions = {}): Promise<HookRunResult> {
  const env = options.env ?? process.env;
  const envStrict = parseEnvironmentBoolean(env.OPENOBSERVE_CODEX_FAIL_ON_ERROR);
  let strict = envStrict;

  try {
    strict = await loadTrustedFailOnError({ env });
    const hook = parseStopHookInput(input);
    const config = await loadConfig({ cwd: hook.cwd, env });
    strict = config.failOnError;
    if (!config.enabled) {
      return { status: "disabled", diagnostics: [] };
    }
    if (!hook.transcript_path) {
      throw new Error("Stop hook did not provide a transcript path");
    }

    const trustedTranscript = await readTrustedTranscript(hook.transcript_path, env);
    const transcript = trustedTranscript.contents;
    const session = parseRolloutTranscript(transcript, hook);
    if (session.id !== hook.session_id) {
      throw new Error("Stop-hook session does not match the transcript session");
    }
    await discoverSubagents(session, trustedTranscript.path);
    const turn = session.turns.find((candidate) => candidate.id === hook.turn_id);
    if (!turn) {
      throw new Error(`Stop-hook turn ${safeIdentifier(hook.turn_id)} was not found`);
    }

    if (config.debug) {
      for (const diagnostic of session.diagnostics) {
        console.error(`[openobserve-codex] ${redactAndTruncate(diagnostic, 1_024)}`);
      }
    }
    const exported = await exportTurnOnce(config, session, turn, {
      fetch: options.fetch,
    });
    if (exported.error) {
      throw new Error(exported.error);
    }
    return {
      status: exported.deduplicated ? "deduplicated" : "exported",
      export: exported,
      diagnostics: session.diagnostics,
    };
  } catch (error) {
    if (error instanceof HookRunError) throw error;
    const message = error instanceof Error ? error.message : "unknown hook failure";
    throw new HookRunError(message, strict, { cause: error });
  }
}

export function parseStopHookInput(input: string): StopHookInput {
  if (Buffer.byteLength(input, "utf8") > MAX_HOOK_INPUT_BYTES) {
    throw new Error("Stop hook input exceeds the supported size");
  }
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (error) {
    throw new Error("Stop hook input is not valid JSON", { cause: error });
  }
  if (!isRecord(value)) {
    throw new Error("Stop hook input must be a JSON object");
  }
  if (value.hook_event_name !== "Stop") {
    throw new Error("hook_event_name must be Stop");
  }

  const sessionId = requiredString(value, "session_id");
  const turnId = requiredString(value, "turn_id");
  const cwd = requiredString(value, "cwd");
  const model = requiredString(value, "model");
  const transcriptPath = nullableString(value, "transcript_path");
  const lastAssistantMessage = nullableString(value, "last_assistant_message");
  return {
    session_id: sessionId,
    turn_id: turnId,
    cwd,
    model,
    transcript_path: transcriptPath,
    hook_event_name: "Stop",
    last_assistant_message: lastAssistantMessage,
    ...(typeof value.permission_mode === "string"
      ? { permission_mode: value.permission_mode }
      : {}),
    ...(typeof value.stop_hook_active === "boolean"
      ? { stop_hook_active: value.stop_hook_active }
      : {}),
  };
}

async function main(): Promise<void> {
  try {
    await runHook(await readStdin());
  } catch (error) {
    const hookError =
      error instanceof HookRunError
        ? error
        : new HookRunError(error instanceof Error ? error.message : "unknown hook failure", false);
    console.error(`[openobserve-codex] ${hookError.message}`);
    if (hookError.strict) process.exitCode = 1;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_HOOK_INPUT_BYTES) {
      throw new Error("Stop hook input exceeds the supported size");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim() === "") {
    throw new Error(`${key} must be a non-empty string`);
  }
  return field;
}

function nullableString(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  if (field === null || field === undefined) return null;
  if (typeof field !== "string") throw new Error(`${key} must be a string or null`);
  return field;
}

function parseEnvironmentBoolean(value: string | undefined): boolean {
  if (!value) return false;
  return ["true", "1"].includes(value.trim().toLowerCase());
}

function safeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, "?").slice(0, 128);
}

async function readTrustedTranscript(
  transcriptPath: string,
  env: NodeJS.ProcessEnv,
): Promise<{ path: string; contents: string }> {
  if (!isAbsolute(transcriptPath)) {
    throw new Error("Stop-hook transcript path must be absolute");
  }
  const codexHome = resolve(env.CODEX_HOME ?? join(homedir(), ".codex"));
  const sessionsRoot = await realpath(join(codexHome, "sessions"));
  const canonicalPath = await realpath(transcriptPath);
  const pathWithinSessions = relative(sessionsRoot, canonicalPath);
  if (
    pathWithinSessions === ".." ||
    pathWithinSessions.startsWith(`..${sep}`) ||
    isAbsolute(pathWithinSessions)
  ) {
    throw new Error("Stop-hook transcript path must be inside the Codex sessions directory");
  }
  const details = await stat(canonicalPath);
  if (!details.isFile()) {
    throw new Error("Stop-hook transcript path must identify a regular file");
  }
  if (details.size > MAX_TRANSCRIPT_BYTES) {
    throw new Error(`Stop-hook transcript exceeds ${MAX_TRANSCRIPT_BYTES} bytes`);
  }
  const contents = await readFile(canonicalPath, "utf8");
  if (Buffer.byteLength(contents, "utf8") > MAX_TRANSCRIPT_BYTES) {
    throw new Error(`Stop-hook transcript exceeds ${MAX_TRANSCRIPT_BYTES} bytes`);
  }
  return { path: canonicalPath, contents };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  await main();
}
