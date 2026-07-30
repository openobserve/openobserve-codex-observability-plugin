import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExportError, exportTurn, exportTurnOnce, postOtlpTrace } from "../src/exporter.ts";
import { buildOtlpExportRequest } from "../src/otlp.ts";
import { ExportStateStore } from "../src/state.ts";
import { makeConfig, makeSession } from "./helpers.ts";

describe("trace exporter", () => {
  let stateDirectory: string;

  beforeEach(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), "openobserve-codex-exporter-"));
  });

  afterEach(async () => {
    await rm(stateDirectory, { recursive: true, force: true });
  });

  it("posts OTLP JSON with protected OpenObserve headers and custom headers", async () => {
    const session = makeSession();
    const config = makeConfig({
      headers: {
        "x-extra": "value",
        organization: "wrong",
        "stream-name": "wrong",
        authorization: "wrong",
      },
      organization: "team",
      streamName: "turn-traces",
      authorization: "Bearer correct",
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));

    await postOtlpTrace(
      config,
      buildOtlpExportRequest(session, session.turns[0], config),
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(url).toBe(config.endpoint);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("organization")).toBe("team");
    expect(headers.get("stream-name")).toBe("turn-traces");
    expect(headers.get("authorization")).toBe("Bearer correct");
    expect(headers.get("x-extra")).toBe("value");
  });

  it("returns errors in fail-open mode and throws when configured", async () => {
    const session = makeSession();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("rejected", { status: 401 }));

    await expect(
      exportTurn(makeConfig(), session, session.turns[0], { fetch: fetchMock }),
    ).resolves.toMatchObject({
      exported: false,
      error: "trace export failed with HTTP 401: rejected",
    });
    await expect(
      exportTurn(makeConfig({ failOnError: true }), session, session.turns[0], {
        fetch: fetchMock,
      }),
    ).rejects.toBeInstanceOf(ExportError);
  });

  it("aborts requests after the configured timeout", async () => {
    const waitingFetch: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    const session = makeSession();
    const result = await exportTurn(makeConfig({ timeoutMs: 10 }), session, session.turns[0], {
      fetch: waitingFetch,
    });

    expect(result.error).toBe("trace export timed out after 10ms");
  });

  it("does not issue requests when disabled", async () => {
    const session = makeSession();
    const fetchMock = vi.fn<typeof fetch>();
    const result = await exportTurn(makeConfig({ enabled: false }), session, session.turns[0], {
      fetch: fetchMock,
    });

    expect(result.exported).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deduplicates successful exports and leaves failures unmarked", async () => {
    const session = makeSession();
    const config = makeConfig({ stateDirectory });
    const stateStore = new ExportStateStore(stateDirectory);
    const failedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("try again", { status: 503 }));
    const successfulFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));

    const failed = await exportTurnOnce(config, session, session.turns[0], {
      fetch: failedFetch,
      stateStore,
    });
    expect(failed.exported).toBe(false);
    expect(await stateStore.hasTurn(session.id, "turn-1")).toBe(false);

    const first = await exportTurnOnce(config, session, session.turns[0], {
      fetch: successfulFetch,
      stateStore,
    });
    const second = await exportTurnOnce(config, session, session.turns[0], {
      fetch: successfulFetch,
      stateStore,
    });

    expect(first).toMatchObject({ exported: true, deduplicated: false });
    expect(second).toMatchObject({ exported: false, deduplicated: true });
    expect(successfulFetch).toHaveBeenCalledTimes(1);
  });

  it("exports a new revision when exported prompt or response data changes", async () => {
    const session = makeSession();
    const config = makeConfig({ stateDirectory, captureContent: true });
    const stateStore = new ExportStateStore(stateDirectory);
    const successfulFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const first = await exportTurnOnce(config, session, session.turns[0], {
      fetch: successfulFetch,
      stateStore,
    });
    session.turns[0].assistantMessages[0].content = "Corrected response";
    session.turns[0].generations[0].output[0].content = "Corrected response";
    const corrected = await exportTurnOnce(config, session, session.turns[0], {
      fetch: successfulFetch,
      stateStore,
    });
    const repeated = await exportTurnOnce(config, session, session.turns[0], {
      fetch: successfulFetch,
      stateStore,
    });

    expect(first.exported).toBe(true);
    expect(corrected.exported).toBe(true);
    expect(corrected.traceId).not.toBe(first.traceId);
    expect(repeated.deduplicated).toBe(true);
    expect(successfulFetch).toHaveBeenCalledTimes(2);
  });

  it("exports again when the OpenObserve destination changes", async () => {
    const session = makeSession();
    const stateStore = new ExportStateStore(stateDirectory);
    const successfulFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const original = makeConfig({ stateDirectory, streamName: "codex-a" });
    const moved = makeConfig({ stateDirectory, streamName: "codex-b" });

    const first = await exportTurnOnce(original, session, session.turns[0], {
      fetch: successfulFetch,
      stateStore,
    });
    const second = await exportTurnOnce(moved, session, session.turns[0], {
      fetch: successfulFetch,
      stateStore,
    });

    expect(first.exported).toBe(true);
    expect(second.exported).toBe(true);
    expect(second.traceId).not.toBe(first.traceId);
    expect(successfulFetch).toHaveBeenCalledTimes(2);
  });

  it("rejects partial OTLP success, malformed success bodies, and oversized responses", async () => {
    const session = makeSession();
    const request = buildOtlpExportRequest(session, session.turns[0], makeConfig());

    await expect(
      postOtlpTrace(
        makeConfig(),
        request,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response('{"partialSuccess":{"rejectedSpans":"2"}}', { status: 200 }),
          ),
      ),
    ).rejects.toThrow("rejected 2 span(s)");
    await expect(
      postOtlpTrace(
        makeConfig(),
        request,
        vi.fn<typeof fetch>().mockResolvedValue(new Response("not-json", { status: 200 })),
      ),
    ).rejects.toThrow("invalid JSON response");
    await expect(
      postOtlpTrace(
        makeConfig(),
        request,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("x".repeat(65 * 1_024), { status: 200 })),
      ),
    ).rejects.toThrow("response exceeds");
  });
});
