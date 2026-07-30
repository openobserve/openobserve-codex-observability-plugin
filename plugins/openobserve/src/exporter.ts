import { createHash } from "node:crypto";

import { buildOtlpExportRequest, redactAndTruncate, traceIdForTurn } from "./otlp.ts";
import { ExportStateStore } from "./state.ts";
import type {
  NormalizedSession,
  NormalizedTurn,
  OpenObserveConfig,
  OtlpExportTraceRequest,
} from "./types.ts";

const MAX_ERROR_BODY_CHARS = 1_024;
const MAX_EXPORT_BODY_BYTES = 16 * 1_024 * 1_024;
const MAX_RESPONSE_BODY_BYTES = 64 * 1_024;

export interface ExportOptions {
  fetch?: typeof fetch;
}

export interface ExportOnceOptions extends ExportOptions {
  stateStore?: ExportStateStore;
}

export interface ExportResult {
  exported: boolean;
  deduplicated: boolean;
  traceId: string;
  error?: string;
}

export class ExportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExportError";
  }
}

export async function postOtlpTrace(
  config: OpenObserveConfig,
  request: OtlpExportTraceRequest,
  fetchImplementation: typeof fetch = globalThis.fetch,
): Promise<void> {
  if (typeof fetchImplementation !== "function") {
    throw new ExportError("fetch is not available in this runtime");
  }

  const headers = new Headers(config.headers);
  headers.set("content-type", "application/json");
  headers.set("organization", config.organization);
  headers.set("stream-name", config.streamName);
  if (config.authorization) headers.set("authorization", config.authorization);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body, "utf8") > MAX_EXPORT_BODY_BYTES) {
    clearTimeout(timeout);
    throw new ExportError(`trace export exceeds ${MAX_EXPORT_BODY_BYTES} bytes`);
  }
  try {
    const response = await fetchImplementation(config.endpoint, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
      redirect: "error",
    });
    const responseBody = (await readBoundedResponse(response)).trim();
    if (response.status !== 200) {
      const sanitizedBody = redactAndTruncate(
        responseBody.slice(0, MAX_ERROR_BODY_CHARS),
        MAX_ERROR_BODY_CHARS,
      );
      const details = sanitizedBody ? `: ${sanitizedBody}` : "";
      throw new ExportError(`trace export failed with HTTP ${response.status}${details}`);
    }
    const rejectedSpans = rejectedSpanCount(responseBody);
    if (rejectedSpans > 0) {
      throw new ExportError(`trace export rejected ${rejectedSpans} span(s)`);
    }
  } catch (error) {
    if (error instanceof ExportError) throw error;
    if (controller.signal.aborted) {
      throw new ExportError(`trace export timed out after ${config.timeoutMs}ms`, { cause: error });
    }
    throw new ExportError("trace export request failed", { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

export const exportOtlpTrace = postOtlpTrace;

export async function exportTurn(
  config: OpenObserveConfig,
  session: NormalizedSession,
  turn: NormalizedTurn,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const revision = turnRevision(session, turn, config);
  const traceId = traceIdForTurn(session.id, turn.id, revision);
  if (!config.enabled) return { exported: false, deduplicated: false, traceId };

  try {
    const request = buildOtlpExportRequest(session, turn, config, traceId);
    await postOtlpTrace(config, request, options.fetch);
    debug(config, `exported turn ${turn.id} as trace ${traceId}`);
    return { exported: true, deduplicated: false, traceId };
  } catch (error) {
    return handleExportFailure(config, traceId, error);
  }
}

export async function exportTurnOnce(
  config: OpenObserveConfig,
  session: NormalizedSession,
  turn: NormalizedTurn,
  options: ExportOnceOptions = {},
): Promise<ExportResult> {
  const revision = turnRevision(session, turn, config);
  const traceId = traceIdForTurn(session.id, turn.id, revision);
  if (!config.enabled) return { exported: false, deduplicated: false, traceId };

  const stateStore = options.stateStore ?? new ExportStateStore(config.stateDirectory);
  try {
    const result = await stateStore.runTurnOnce(session.id, turn.id, revision, async () => {
      const request = buildOtlpExportRequest(session, turn, config, traceId);
      await postOtlpTrace(config, request, options.fetch);
      return traceId;
    });
    if (result.exported) {
      debug(config, `exported turn ${turn.id} as trace ${traceId}`);
    } else {
      debug(config, `skipped previously exported turn ${turn.id}`);
    }
    return {
      exported: result.exported,
      deduplicated: !result.exported,
      traceId: result.entry.traceId,
    };
  } catch (error) {
    return handleExportFailure(config, traceId, error);
  }
}

function handleExportFailure(
  config: OpenObserveConfig,
  traceId: string,
  error: unknown,
): ExportResult {
  const exportError =
    error instanceof Error ? error : new ExportError("trace export failed with an unknown error");
  debug(config, exportError.message);
  if (config.failOnError) throw exportError;
  return {
    exported: false,
    deduplicated: false,
    traceId,
    error: exportError.message,
  };
}

function debug(config: OpenObserveConfig, message: string): void {
  if (config.debug) console.error(`[openobserve-codex] ${message}`);
}

export function turnRevision(
  session: NormalizedSession,
  turn: NormalizedTurn,
  config: OpenObserveConfig,
): string {
  const canonicalTrace = buildOtlpExportRequest(
    session,
    turn,
    config,
    traceIdForTurn(session.id, turn.id),
  );
  return createHash("sha256")
    .update(`${config.endpoint}\0${config.organization}\0${config.streamName}\0`)
    .update(JSON.stringify(canonicalTrace))
    .digest("hex")
    .slice(0, 16);
}

function rejectedSpanCount(responseBody: string): number {
  if (!responseBody) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    throw new ExportError("trace export returned an invalid JSON response");
  }
  if (!isRecord(parsed)) {
    throw new ExportError("trace export returned an invalid JSON response");
  }
  const partial = isRecord(parsed.partialSuccess)
    ? parsed.partialSuccess
    : isRecord(parsed.partial_success)
      ? parsed.partial_success
      : undefined;
  if (!partial) return 0;
  const value = partial.rejectedSpans ?? partial.rejected_spans;
  if (value === undefined) return 0;
  const count =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ExportError("trace export returned an invalid rejected span count");
  }
  return count;
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_RESPONSE_BODY_BYTES) {
        await reader.cancel();
        throw new ExportError(`trace export response exceeds ${MAX_RESPONSE_BODY_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
