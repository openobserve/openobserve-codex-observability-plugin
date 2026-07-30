import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigError, loadConfig, normalizeOtlpEndpoint } from "../src/config.ts";

describe("configuration", () => {
  let root: string;
  let codexHome: string;
  let cwd: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "openobserve-codex-config-"));
    codexHome = join(root, "home");
    cwd = join(root, "project");
    await Promise.all([mkdir(codexHome), mkdir(join(cwd, ".codex"), { recursive: true })]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uses private defaults and normalizes a base host", async () => {
    const config = await loadConfig({ cwd, env: { CODEX_HOME: codexHome } });

    expect(config.endpoint).toBe("http://localhost:5080/api/default/v1/traces");
    expect(config.enabled).toBe(false);
    expect(config.organization).toBe("default");
    expect(config.streamName).toBe("codex");
    expect(config.captureContent).toBe(false);
    expect(config.captureReasoning).toBe(false);
    expect(config.captureToolContent).toBe(false);
    expect(config.failOnError).toBe(false);
    expect(config.stateDirectory).toBe(join(codexHome, "openobserve"));
  });

  it("accepts documented snake-case keys and discovers project config from a subdirectory", async () => {
    const nestedCwd = join(cwd, "src", "feature");
    await mkdir(nestedCwd, { recursive: true });
    await writeJson(join(codexHome, "openobserve.json"), {
      enabled: true,
      endpoint: "https://observe.example",
      capture_content: true,
      capture_reasoning: true,
      capture_tool_content: true,
      max_chars: 4_096,
      stream_name: "codex-rich",
      service_name: "codex-desktop",
      timeout_ms: 5_000,
      fail_on_error: true,
    });
    await writeJson(join(cwd, ".codex", "openobserve.json"), {
      capture_reasoning: false,
      max_chars: 2_048,
    });

    const config = await loadConfig({ cwd: nestedCwd, env: { CODEX_HOME: codexHome } });

    expect(config).toMatchObject({
      enabled: true,
      endpoint: "https://observe.example/api/default/v1/traces",
      streamName: "codex-rich",
      captureContent: true,
      captureReasoning: false,
      captureToolContent: true,
      maxChars: 2_048,
      serviceName: "codex-desktop",
      timeoutMs: 5_000,
      failOnError: true,
      stateDirectory: join(codexHome, "openobserve"),
    });
  });

  it("uses PLUGIN_DATA for deduplication state by default", async () => {
    const pluginData = join(root, "plugin-data");
    const config = await loadConfig({
      cwd,
      env: { CODEX_HOME: codexHome, PLUGIN_DATA: pluginData },
    });

    expect(config.stateDirectory).toBe(pluginData);
  });

  it("applies global, project, and environment layers in order and merges headers", async () => {
    await writeJson(join(codexHome, "openobserve.json"), {
      endpoint: "https://global.example",
      organization: "global-org",
      authorization: "Basic global",
      captureContent: true,
      captureReasoning: true,
      captureToolContent: true,
      headers: { "x-global": "yes", "X-Shared": "global" },
    });
    await writeJson(join(cwd, ".codex", "openobserve.json"), {
      captureReasoning: false,
      maxChars: 1_024,
    });

    const config = await loadConfig({
      cwd,
      env: {
        CODEX_HOME: codexHome,
        OPENOBSERVE_CODEX_ORGANIZATION: "env-org",
        OPENOBSERVE_CODEX_STREAM_NAME: "env-stream",
        OPENOBSERVE_CODEX_CAPTURE_CONTENT: "0",
        OPENOBSERVE_CODEX_CAPTURE_TOOL_CONTENT: "true",
        OPENOBSERVE_CODEX_TIMEOUT_MS: "2500",
        OPENOBSERVE_CODEX_HEADERS: '{"x-env":"yes","x-shared":"env"}',
      },
    });

    expect(config).toMatchObject({
      endpoint: "https://global.example/api/env-org/v1/traces",
      organization: "env-org",
      streamName: "env-stream",
      authorization: "Basic global",
      captureContent: false,
      captureReasoning: false,
      captureToolContent: true,
      maxChars: 1_024,
      timeoutMs: 2_500,
      headers: {
        "x-global": "yes",
        "x-env": "yes",
        "x-shared": "env",
      },
    });
  });

  it("prevents project configuration from redirecting credentials or escalating capture", async () => {
    await writeJson(join(codexHome, "openobserve.json"), {
      enabled: true,
      endpoint: "https://trusted.example",
      authorization: "Basic global",
      captureContent: false,
    });
    await writeJson(join(cwd, ".codex", "openobserve.json"), {
      endpoint: "https://untrusted.example",
      captureContent: true,
    });

    await expect(loadConfig({ cwd, env: { CODEX_HOME: codexHome } })).rejects.toThrow(
      "project configuration cannot set endpoint",
    );
  });

  it.each([
    ["endpoint", "https://untrusted.example"],
    ["organization", "other"],
    ["streamName", "other"],
    ["authorization", "Bearer untrusted"],
    ["headers", { "x-untrusted": "value" }],
    ["environment", "other"],
    ["serviceName", "other"],
    ["timeoutMs", 1],
    ["debug", true],
    ["failOnError", false],
    ["stateDirectory", "/tmp/untrusted"],
  ])("rejects project control of %s", async (key, value) => {
    await writeJson(join(cwd, ".codex", "openobserve.json"), { [key]: value });
    await expect(loadConfig({ cwd, env: { CODEX_HOME: codexHome } })).rejects.toThrow(
      `project configuration cannot set ${key}`,
    );
  });

  it("requires private permissions for global custom headers", async () => {
    const globalPath = join(codexHome, "openobserve.json");
    await writeFile(globalPath, JSON.stringify({ headers: { "x-api-key": "secret" } }), {
      encoding: "utf8",
      mode: 0o644,
    });
    if (process.platform === "win32") return;
    await expect(loadConfig({ cwd, env: { CODEX_HOME: codexHome } })).rejects.toThrow(
      "must not be accessible",
    );
  });

  it("accepts full OTLP endpoints and encodes organizations for base hosts", () => {
    expect(normalizeOtlpEndpoint("https://observe.example", "team one")).toBe(
      "https://observe.example/api/team%20one/v1/traces",
    );
    expect(normalizeOtlpEndpoint("https://observe.example/prefix/v1/traces", "ignored")).toBe(
      "https://observe.example/prefix/v1/traces",
    );
    expect(() =>
      normalizeOtlpEndpoint("https://observe.example/api/other/v1/traces", "default"),
    ).toThrow("organization must match");
    expect(() => normalizeOtlpEndpoint("http://observe.example", "default")).toThrow(
      "must use https",
    );
  });

  it.each([
    ["a non-boolean flag", { enabled: "yes" }],
    ["a non-integer maximum", { maxChars: 1.5 }],
    ["a zero timeout", { timeoutMs: 0 }],
    ["an invalid header", { headers: { "bad header": "value" } }],
    ["a multiline header", { headers: { "x-test": "first\nsecond" } }],
    ["a reserved header", { headers: { authorization: "Bearer override" } }],
  ])("rejects %s in JSON configuration", async (_description, value) => {
    await writeJson(join(cwd, ".codex", "openobserve.json"), value);
    await expect(loadConfig({ cwd, env: { CODEX_HOME: codexHome } })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it.each([
    ["OPENOBSERVE_CODEX_DEBUG", "sometimes"],
    ["OPENOBSERVE_CODEX_MAX_CHARS", "2.5"],
    ["OPENOBSERVE_CODEX_TIMEOUT_MS", "-1"],
    ["OPENOBSERVE_CODEX_HEADERS", "[]"],
  ])("rejects invalid environment setting %s", async (name, value) => {
    await expect(
      loadConfig({ cwd, env: { CODEX_HOME: codexHome, [name]: value } }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("rejects malformed files and unsupported endpoint paths", async () => {
    await writeFile(join(cwd, ".codex", "openobserve.json"), "{", "utf8");
    await expect(loadConfig({ cwd, env: { CODEX_HOME: codexHome } })).rejects.toThrow(
      "invalid JSON",
    );
    expect(() => normalizeOtlpEndpoint("file:///tmp/traces", "default")).toThrow("http or https");
    expect(() => normalizeOtlpEndpoint("https://observe.example/api", "default")).toThrow(
      "base host or a full OTLP",
    );
  });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
}
