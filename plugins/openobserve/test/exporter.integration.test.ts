import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { normalizeOtlpEndpoint } from "../src/config.ts";
import { exportTurnOnce } from "../src/exporter.ts";
import type { OtlpExportTraceRequest } from "../src/types.ts";
import { makeConfig, makeSession } from "./helpers.ts";

describe("HTTP export integration", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("posts once to the self-hosted traces route and persists dedup state", async () => {
    const requests: Array<{
      url: string;
      headers: Record<string, string | string[] | undefined>;
      body: OtlpExportTraceRequest;
    }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          url: request.url ?? "",
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as OtlpExportTraceRequest,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"code":200}');
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

    try {
      const address = server.address() as AddressInfo;
      const stateDirectory = await mkdtemp(join(tmpdir(), "openobserve-codex-integration-"));
      temporaryDirectories.push(stateDirectory);
      const config = makeConfig({
        endpoint: normalizeOtlpEndpoint(`http://127.0.0.1:${address.port}`, "engineering"),
        organization: "engineering",
        streamName: "codex-turns",
        authorization: "Basic integration",
        headers: { "x-integration": "true" },
        stateDirectory,
      });
      const session = makeSession();

      const first = await exportTurnOnce(config, session, session.turns[0]);
      const second = await exportTurnOnce(config, session, session.turns[0]);

      expect(first.exported).toBe(true);
      expect(second.deduplicated).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe("/api/engineering/v1/traces");
      expect(requests[0].headers.organization).toBe("engineering");
      expect(requests[0].headers["stream-name"]).toBe("codex-turns");
      expect(requests[0].headers.authorization).toBe("Basic integration");
      expect(requests[0].headers["x-integration"]).toBe("true");
      const spans = requests[0].body.resourceSpans[0].scopeSpans[0].spans;
      expect(spans[0].kind).toBe(2);
      expect(new Set(spans.map((span) => span.traceId))).toEqual(new Set([first.traceId]));
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    }
  });
});
