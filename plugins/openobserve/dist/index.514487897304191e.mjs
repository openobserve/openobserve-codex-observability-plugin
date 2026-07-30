#!/usr/bin/env node

// plugins/openobserve/src/index.ts
import { readFile as readFile4, realpath, stat as stat4 } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { fileURLToPath } from "node:url";
import { isAbsolute as isAbsolute3, join as join3, relative as relative2, resolve as resolve4, sep as sep2 } from "node:path";

// plugins/openobserve/src/config.ts
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
var DEFAULT_ENDPOINT = "http://localhost:5080";
var DEFAULT_MAX_CHARS = 32768;
var DEFAULT_TIMEOUT_MS = 1e4;
var MAX_INTEGER_SETTING = 1e6;
var MAX_TIMEOUT_MS = 15e3;
var HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
var RESERVED_HEADERS = /* @__PURE__ */ new Set([
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "host",
  "organization",
  "stream-name",
  "transfer-encoding"
]);
var ConfigError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ConfigError";
  }
};
function defaultConfig(codexHome = join(homedir(), ".codex"), pluginData) {
  return {
    enabled: false,
    endpoint: DEFAULT_ENDPOINT,
    organization: "default",
    streamName: "codex",
    headers: {},
    captureContent: false,
    captureReasoning: false,
    captureToolContent: false,
    maxChars: DEFAULT_MAX_CHARS,
    environment: "development",
    serviceName: "codex",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    debug: false,
    failOnError: false,
    stateDirectory: pluginData || join(codexHome, "openobserve")
  };
}
function normalizeOtlpEndpoint(endpoint, organization) {
  let url;
  try {
    url = new URL(endpoint);
  } catch (error) {
    throw new ConfigError(`endpoint must be a valid absolute URL: ${endpoint}`, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("endpoint must use http or https");
  }
  if (url.username || url.password) {
    throw new ConfigError("endpoint must not contain credentials; use authorization instead");
  }
  if (url.hash) {
    throw new ConfigError("endpoint must not contain a URL fragment");
  }
  if (url.search) {
    throw new ConfigError("endpoint must not contain query parameters");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new ConfigError("endpoint must use https unless it targets a loopback host");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "") {
    url.pathname = `/api/${encodeURIComponent(organization)}/v1/traces`;
  } else if (!path.endsWith("/v1/traces")) {
    throw new ConfigError("endpoint must be a base host or a full OTLP /v1/traces endpoint");
  } else {
    const organizationMatch = path.match(/\/api\/([^/]+)\/v1\/traces$/);
    if (organizationMatch?.[1] && decodeURIComponent(organizationMatch[1]) !== organization) {
      throw new ConfigError("endpoint organization must match the configured organization");
    }
    url.pathname = path;
  }
  return url.toString();
}
async function loadConfig(options = {}) {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const codexHome = resolve(env.CODEX_HOME ?? join(options.homeDirectory ?? homedir(), ".codex"));
  const globalPath = join(codexHome, "openobserve.json");
  const projectPath = await findProjectConfig(cwd);
  let config = defaultConfig(codexHome, env.PLUGIN_DATA);
  const globalValue = await readConfigFile(globalPath);
  if (globalValue) {
    const layer = parseFileLayer(globalValue, globalPath);
    if (layer.authorization || Object.keys(layer.headers ?? {}).length > 0) {
      await assertPrivateConfigFile(globalPath);
    }
    config = applyLayer(config, layer);
  }
  if (projectPath && projectPath !== globalPath) {
    const projectValue = await readConfigFile(projectPath);
    if (projectValue) {
      config = applyProjectLayer(config, parseFileLayer(projectValue, projectPath), projectPath);
    }
  }
  config = applyLayer(config, parseEnvironment(env));
  validateConfig(config);
  config.endpoint = normalizeOtlpEndpoint(config.endpoint, config.organization);
  if (!isAbsolute(config.stateDirectory)) {
    config.stateDirectory = resolve(cwd, config.stateDirectory);
  }
  return config;
}
async function loadTrustedFailOnError(options = {}) {
  const env = options.env ?? process.env;
  const codexHome = resolve(env.CODEX_HOME ?? join(options.homeDirectory ?? homedir(), ".codex"));
  const globalPath = join(codexHome, "openobserve.json");
  let config = defaultConfig(codexHome, env.PLUGIN_DATA);
  const globalValue = await readConfigFile(globalPath);
  if (globalValue) {
    config = applyLayer(config, parseFileLayer(globalValue, globalPath));
  }
  config = applyLayer(config, parseEnvironment(env));
  return config.failOnError;
}
async function readConfigFile(path) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return void 0;
    }
    throw new ConfigError(`unable to read configuration file ${path}`, { cause: error });
  }
  let value;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new ConfigError(`invalid JSON in configuration file ${path}`, { cause: error });
  }
  if (!isPlainObject(value)) {
    throw new ConfigError(`configuration file ${path} must contain a JSON object`);
  }
  return value;
}
function parseFileLayer(value, source) {
  const normalized = normalizeFileKeys(value, source);
  const layer = {};
  readFileBoolean(normalized, layer, "enabled", source);
  readFileString(normalized, layer, "endpoint", source);
  readFileString(normalized, layer, "organization", source);
  readFileString(normalized, layer, "streamName", source);
  readFileAuthorization(normalized, layer, source);
  readFileHeaders(normalized, layer, source);
  readFileBoolean(normalized, layer, "captureContent", source);
  readFileBoolean(normalized, layer, "captureReasoning", source);
  readFileBoolean(normalized, layer, "captureToolContent", source);
  readFileInteger(normalized, layer, "maxChars", source);
  readFileString(normalized, layer, "environment", source);
  readFileString(normalized, layer, "serviceName", source);
  readFileInteger(normalized, layer, "timeoutMs", source);
  readFileBoolean(normalized, layer, "debug", source);
  readFileBoolean(normalized, layer, "failOnError", source);
  readFileString(normalized, layer, "stateDirectory", source);
  return layer;
}
function normalizeFileKeys(value, source) {
  const aliases = {
    stream_name: "streamName",
    capture_content: "captureContent",
    capture_reasoning: "captureReasoning",
    capture_tool_content: "captureToolContent",
    max_chars: "maxChars",
    service_name: "serviceName",
    timeout_ms: "timeoutMs",
    fail_on_error: "failOnError",
    state_directory: "stateDirectory"
  };
  const normalized = { ...value };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (!Object.hasOwn(value, alias)) continue;
    if (Object.hasOwn(value, canonical)) {
      throw new ConfigError(`${source}: specify only one of ${alias} and ${canonical}`);
    }
    normalized[canonical] = value[alias];
  }
  return normalized;
}
async function findProjectConfig(cwd) {
  const root = parse(cwd).root;
  let current = cwd;
  while (true) {
    const candidate = join(current, ".codex", "openobserve.json");
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw new ConfigError(`unable to inspect project configuration ${candidate}`, {
          cause: error
        });
      }
    }
    if (current === root) return void 0;
    current = dirname(current);
  }
}
function parseEnvironment(env) {
  const layer = {};
  readEnvBoolean(env, layer, "OPENOBSERVE_CODEX_ENABLED", "enabled");
  readEnvString(env, layer, "OPENOBSERVE_CODEX_ENDPOINT", "endpoint");
  readEnvString(env, layer, "OPENOBSERVE_CODEX_ORGANIZATION", "organization");
  readEnvString(env, layer, "OPENOBSERVE_CODEX_STREAM_NAME", "streamName");
  if (env.OPENOBSERVE_CODEX_AUTHORIZATION !== void 0) {
    layer.authorization = env.OPENOBSERVE_CODEX_AUTHORIZATION || null;
  }
  if (env.OPENOBSERVE_CODEX_HEADERS !== void 0) {
    let headers;
    try {
      headers = JSON.parse(env.OPENOBSERVE_CODEX_HEADERS);
    } catch (error) {
      throw new ConfigError("OPENOBSERVE_CODEX_HEADERS must be a JSON object", { cause: error });
    }
    layer.headers = parseHeaders(headers, "OPENOBSERVE_CODEX_HEADERS");
  }
  readEnvBoolean(env, layer, "OPENOBSERVE_CODEX_CAPTURE_CONTENT", "captureContent");
  readEnvBoolean(env, layer, "OPENOBSERVE_CODEX_CAPTURE_REASONING", "captureReasoning");
  readEnvBoolean(env, layer, "OPENOBSERVE_CODEX_CAPTURE_TOOL_CONTENT", "captureToolContent");
  readEnvInteger(env, layer, "OPENOBSERVE_CODEX_MAX_CHARS", "maxChars");
  readEnvString(env, layer, "OPENOBSERVE_CODEX_ENVIRONMENT", "environment");
  readEnvString(env, layer, "OPENOBSERVE_CODEX_SERVICE_NAME", "serviceName");
  readEnvInteger(env, layer, "OPENOBSERVE_CODEX_TIMEOUT_MS", "timeoutMs");
  readEnvBoolean(env, layer, "OPENOBSERVE_CODEX_DEBUG", "debug");
  readEnvBoolean(env, layer, "OPENOBSERVE_CODEX_FAIL_ON_ERROR", "failOnError");
  readEnvString(env, layer, "OPENOBSERVE_CODEX_STATE_DIRECTORY", "stateDirectory");
  return layer;
}
function applyLayer(config, layer) {
  const { authorization, headers, ...values } = layer;
  const next = {
    ...config,
    ...values,
    headers: mergeHeaders(config.headers, headers)
  };
  if (authorization === null) {
    delete next.authorization;
  } else if (authorization !== void 0) {
    next.authorization = authorization;
  }
  return next;
}
function applyProjectLayer(config, layer, source) {
  for (const key of [
    "endpoint",
    "organization",
    "streamName",
    "authorization",
    "headers",
    "environment",
    "serviceName",
    "timeoutMs",
    "debug",
    "failOnError",
    "stateDirectory"
  ]) {
    if (layer[key] !== void 0) {
      throw new ConfigError(`${source}: project configuration cannot set ${key}`);
    }
  }
  for (const key of [
    "enabled",
    "captureContent",
    "captureReasoning",
    "captureToolContent"
  ]) {
    if (layer[key] === true && config[key] === false) {
      throw new ConfigError(`${source}: project configuration cannot enable ${key}`);
    }
  }
  if (layer.maxChars !== void 0 && layer.maxChars > config.maxChars) {
    throw new ConfigError(`${source}: project configuration cannot increase maxChars`);
  }
  return applyLayer(config, layer);
}
function mergeHeaders(current, overrides) {
  const merged = { ...current };
  for (const [name, value] of Object.entries(overrides ?? {})) {
    const normalizedName = name.toLowerCase();
    for (const existingName of Object.keys(merged)) {
      if (existingName.toLowerCase() === normalizedName) delete merged[existingName];
    }
    merged[name] = value;
  }
  return merged;
}
function validateConfig(config) {
  assertNonEmpty(config.endpoint, "endpoint");
  assertHeaderValue(config.organization, "organization");
  assertHeaderValue(config.streamName, "streamName");
  assertHeaderValue(config.environment, "environment");
  assertHeaderValue(config.serviceName, "serviceName");
  assertNonEmpty(config.stateDirectory, "stateDirectory");
  assertPositiveInteger(config.maxChars, "maxChars");
  assertPositiveInteger(config.timeoutMs, "timeoutMs", MAX_TIMEOUT_MS);
  if (config.authorization !== void 0) {
    assertHeaderValue(config.authorization, "authorization");
  }
  parseHeaders(config.headers, "headers");
}
function readFileBoolean(source, target, key, sourceName) {
  if (!Object.hasOwn(source, key)) return;
  if (typeof source[key] !== "boolean") {
    throw new ConfigError(`${sourceName}: ${String(key)} must be a boolean`);
  }
  Object.assign(target, { [key]: source[key] });
}
function readFileInteger(source, target, key, sourceName) {
  if (!Object.hasOwn(source, key)) return;
  const value = source[key];
  if (typeof value !== "number") {
    throw new ConfigError(`${sourceName}: ${String(key)} must be an integer`);
  }
  assertPositiveInteger(value, `${sourceName}: ${String(key)}`);
  Object.assign(target, { [key]: value });
}
function readFileString(source, target, key, sourceName) {
  if (!Object.hasOwn(source, key)) return;
  const value = source[key];
  if (typeof value !== "string") {
    throw new ConfigError(`${sourceName}: ${String(key)} must be a string`);
  }
  Object.assign(target, { [key]: value });
}
function readFileAuthorization(source, target, sourceName) {
  if (!Object.hasOwn(source, "authorization")) return;
  const value = source.authorization;
  if (value !== null && typeof value !== "string") {
    throw new ConfigError(`${sourceName}: authorization must be a string or null`);
  }
  target.authorization = value || null;
}
function readFileHeaders(source, target, sourceName) {
  if (!Object.hasOwn(source, "headers")) return;
  target.headers = parseHeaders(source.headers, `${sourceName}: headers`);
}
function readEnvBoolean(env, target, envName, key) {
  const raw = env[envName];
  if (raw === void 0) return;
  const normalized = raw.trim().toLowerCase();
  if (normalized !== "true" && normalized !== "false" && normalized !== "1" && normalized !== "0") {
    throw new ConfigError(`${envName} must be true, false, 1, or 0`);
  }
  Object.assign(target, { [key]: normalized === "true" || normalized === "1" });
}
function readEnvInteger(env, target, envName, key) {
  const raw = env[envName];
  if (raw === void 0) return;
  if (!/^\d+$/.test(raw.trim())) {
    throw new ConfigError(`${envName} must be a positive integer`);
  }
  const value = Number(raw);
  assertPositiveInteger(value, envName);
  Object.assign(target, { [key]: value });
}
function readEnvString(env, target, envName, key) {
  const value = env[envName];
  if (value === void 0) return;
  Object.assign(target, { [key]: value });
}
function parseHeaders(value, source) {
  if (!isPlainObject(value)) {
    throw new ConfigError(`${source} must be an object with string values`);
  }
  const headers = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new ConfigError(`${source} contains an invalid header name: ${name}`);
    }
    if (typeof headerValue !== "string" || /[\r\n]/.test(headerValue)) {
      throw new ConfigError(`${source}.${name} must be a single-line string`);
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new ConfigError(`${source} cannot override reserved header ${name}`);
    }
    headers[name] = headerValue;
  }
  return headers;
}
function assertPositiveInteger(value, name, maximum = MAX_INTEGER_SETTING) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new ConfigError(`${name} must be a positive integer no greater than ${maximum}`);
  }
}
function assertNonEmpty(value, name) {
  if (value.trim() === "") {
    throw new ConfigError(`${name} must not be empty`);
  }
}
function assertHeaderValue(value, name) {
  assertNonEmpty(value, name);
  if (/[\r\n]/.test(value)) {
    throw new ConfigError(`${name} must be a single-line string`);
  }
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNodeError(error) {
  return error instanceof Error && "code" in error;
}
async function assertPrivateConfigFile(path) {
  if (process.platform === "win32") return;
  const mode = (await stat(path)).mode & 511;
  if ((mode & 63) !== 0) {
    throw new ConfigError(
      `${path} contains credentials or custom headers and must not be accessible by group or other users`
    );
  }
}
function isLoopbackHostname(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

// plugins/openobserve/src/exporter.ts
import { createHash as createHash3 } from "node:crypto";

// plugins/openobserve/src/otlp.ts
import { createHash } from "node:crypto";
var REDACTED = "[REDACTED]";
var TRUNCATED = "...[truncated]";
var SCOPE_NAME = "openobserve.codex";
var SCOPE_VERSION = "0.1.0";
var MAX_METADATA_CHARS = 1024;
var CONTENT_ATTRIBUTE_KEYS = /* @__PURE__ */ new Set([
  "exception.message",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.reasoning",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result"
]);
function buildOtlpExportRequest(session, turn, config, traceIdOverride) {
  const traceId = traceIdOverride ?? traceIdForTurn(session.id, turn.id);
  const generations = normalizedGenerations(turn);
  const bounds = turnBounds(turn, generations);
  const rootSpanId = spanIdFor(traceId, "turn");
  const agentSpanId = spanIdFor(traceId, "agent");
  const spans = [];
  spans.push(
    makeSpan({
      traceId,
      spanId: rootSpanId,
      name: "codex.turn",
      kind: 2,
      startMs: bounds.startMs,
      endMs: bounds.endMs,
      attributes: {
        "session.id": session.id,
        "gen_ai.conversation.id": turn.threadId,
        "codex.turn.id": turn.id,
        "codex.thread.id": turn.threadId,
        "codex.turn.status": turn.status,
        "codex.source": session.source,
        "codex.originator": session.originator,
        "codex.cli.version": session.cliVersion
      },
      status: turnStatus(turn, config),
      errorMessage: isTurnError(turn.status) ? turn.statusMessage || turn.status : void 0,
      maxChars: config.maxChars
    })
  );
  spans.push(
    makeSpan({
      traceId,
      spanId: agentSpanId,
      parentSpanId: rootSpanId,
      name: "invoke_agent codex",
      kind: 1,
      startMs: bounds.startMs,
      endMs: bounds.endMs,
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "codex",
        "gen_ai.agent.id": turn.threadId,
        "gen_ai.conversation.id": turn.threadId,
        "gen_ai.request.model": turn.model,
        "gen_ai.response.model": turn.model,
        "gen_ai.input.messages": serializeMessages(
          turn.userMessages,
          config.captureContent,
          config.maxChars
        ),
        "gen_ai.output.messages": serializeMessages(
          turn.assistantMessages,
          config.captureContent,
          config.maxChars
        ),
        "codex.turn.id": turn.id
      },
      status: turnStatus(turn, config),
      errorMessage: isTurnError(turn.status) ? turn.statusMessage || turn.status : void 0,
      maxChars: config.maxChars
    })
  );
  const generationParents = /* @__PURE__ */ new Map();
  generations.forEach((generation, position) => {
    const spanId = spanIdFor(traceId, `generation:${generation.index}:${position}`);
    for (const callId of generation.toolCallIds) {
      if (!generationParents.has(callId)) generationParents.set(callId, spanId);
    }
    spans.push(
      generationSpan(
        traceId,
        spanId,
        agentSpanId,
        session,
        turn,
        generation,
        config,
        turn.threadId,
        "codex",
        turn.threadId
      )
    );
  });
  const toolSpanIds = /* @__PURE__ */ new Map();
  turn.tools.forEach((tool, index) => {
    const spanId = spanIdFor(traceId, `tool:${tool.callId}:${index}`);
    toolSpanIds.set(tool.callId, spanId);
    spans.push(
      toolSpan(
        traceId,
        spanId,
        generationParents.get(tool.callId) ?? agentSpanId,
        tool,
        config,
        turn,
        turn.threadId,
        "codex",
        turn.threadId
      )
    );
  });
  appendSubagentSpans(
    spans,
    session.subagents,
    toolSpanIds,
    traceId,
    config,
    turn.threadId,
    turn.id,
    `turn:${turn.id}`
  );
  expandSpanBounds(spans[0], spans);
  expandSpanBounds(spans[1], spans.slice(1));
  return {
    resourceSpans: [
      {
        resource: {
          attributes: attributes({
            "service.name": config.serviceName,
            "service.version": SCOPE_VERSION,
            "service.namespace": "openobserve.codex",
            "deployment.environment.name": config.environment,
            "telemetry.sdk.language": "nodejs",
            "telemetry.sdk.name": SCOPE_NAME,
            "telemetry.sdk.version": SCOPE_VERSION,
            "process.runtime.name": "nodejs"
          })
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
            spans
          }
        ]
      }
    ]
  };
}
function traceIdForTurn(sessionId, turnId, revision = "") {
  return nonZeroHash(`trace\0${sessionId}\0${turnId}\0${revision}`, 32);
}
function spanIdFor(traceId, identity) {
  return nonZeroHash(`span\0${traceId}\0${identity}`, 16);
}
function redactAndTruncate(value, maxChars) {
  const redacted = value.replace(
    /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
    REDACTED
  ).replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, (_match, scheme) => {
    return `${scheme} ${REDACTED}`;
  }).replace(
    /(["']?(?:authorization|api[-_ ]?key|password|secret|token)["']?\s*[:=]\s*)(["']?)([^"'\s,}]+)/gi,
    (_match, prefix, quote) => `${prefix}${quote}${REDACTED}`
  ).replace(/\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, REDACTED).replace(/([?&](?:access_token|api[-_]?key|password|secret|token)=)[^&#\s]*/gi, `$1${REDACTED}`).replace(/(https?:\/\/[^:/\s]+:)[^@/\s]+@/gi, `$1${REDACTED}@`);
  return truncate(redacted, maxChars);
}
function generationSpan(traceId, spanId, parentSpanId, session, turn, generation, config, conversationId, agentName, agentId) {
  const values = {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": session.modelProvider,
    "gen_ai.request.model": generation.model || turn.model,
    "gen_ai.response.model": generation.model || turn.model,
    "gen_ai.conversation.id": conversationId,
    "gen_ai.agent.name": agentName,
    "gen_ai.agent.id": agentId,
    "gen_ai.input.messages": serializeMessages(
      generation.input,
      config.captureContent,
      config.maxChars
    ),
    "gen_ai.output.messages": serializeMessages(
      generation.output,
      config.captureContent,
      config.maxChars
    ),
    "gen_ai.response.finish_reasons": JSON.stringify([finishReason(turn.status)]),
    "codex.generation.index": generation.index,
    "codex.reconstruction.confidence": generation.reconstructionConfidence
  };
  if (config.captureReasoning && generation.reasoning.length > 0) {
    values["gen_ai.reasoning"] = JSON.stringify(
      generation.reasoning.map((reasoning) => ({
        summary: redactAndTruncate(reasoning.summary, config.maxChars),
        ...reasoning.content ? { content: redactAndTruncate(reasoning.content, config.maxChars) } : {}
      }))
    );
  }
  addUsage(values, generation.usage);
  return makeSpan({
    traceId,
    spanId,
    parentSpanId,
    name: `chat ${generation.model || turn.model}`,
    kind: 3,
    startMs: generation.startedAtMs,
    endMs: generation.endedAtMs,
    attributes: values,
    status: turnStatus(turn, config),
    errorMessage: isTurnError(turn.status) ? turn.statusMessage || turn.status : void 0,
    maxChars: config.maxChars
  });
}
function toolSpan(traceId, spanId, parentSpanId, tool, config, turn, conversationId, agentName, agentId) {
  const values = {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": tool.name,
    "gen_ai.tool.call.id": tool.callId,
    "gen_ai.agent.name": agentName ?? (turn ? "codex" : void 0),
    "gen_ai.agent.id": agentId ?? turn?.threadId,
    "gen_ai.conversation.id": conversationId ?? turn?.threadId,
    "codex.tool.namespace": tool.namespace,
    "codex.child.session.id": tool.childSessionId
  };
  if (config.captureToolContent) {
    values["gen_ai.tool.call.arguments"] = redactAndTruncate(tool.arguments, config.maxChars);
    if (tool.result !== void 0) {
      values["gen_ai.tool.call.result"] = redactAndTruncate(tool.result, config.maxChars);
    }
  }
  const status = tool.status === "ok" ? { code: 1 } : tool.status === "error" ? { code: 2, message: sanitizeError(tool.errorMessage || "tool execution failed", config) } : { code: 0, message: "tool execution incomplete" };
  return makeSpan({
    traceId,
    spanId,
    parentSpanId,
    name: `execute_tool ${tool.name}`,
    kind: 1,
    startMs: tool.startedAtMs,
    endMs: tool.endedAtMs ?? tool.startedAtMs,
    attributes: values,
    status,
    errorMessage: tool.status === "error" ? tool.errorMessage || "tool execution failed" : void 0,
    maxChars: config.maxChars
  });
}
function appendSubagentSpans(spans, subagents, parentToolSpanIds, traceId, config, conversationId, parentTurnId, ancestry) {
  subagents.forEach((subagent, subagentIndex) => {
    if (subagent.parentTurnId && subagent.parentTurnId !== parentTurnId) return;
    const parentSpanId = parentToolSpanIds.get(subagent.parentCallId);
    if (!parentSpanId) return;
    const identity = `${ancestry}/call:${subagent.parentCallId}:${subagentIndex}/session:${subagent.session.id}`;
    for (const turn of subagent.session.turns) {
      const generations = normalizedGenerations(turn);
      const bounds = turnBounds(turn, generations);
      const agentName = "codex.subagent";
      const agentId = subagent.session.id;
      const agentSpanId = spanIdFor(traceId, `${identity}:turn:${turn.id}:agent`);
      spans.push(
        makeSpan({
          traceId,
          spanId: agentSpanId,
          parentSpanId,
          name: `invoke_agent ${agentName}`,
          kind: 1,
          startMs: bounds.startMs,
          endMs: bounds.endMs,
          attributes: {
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.agent.name": agentName,
            "gen_ai.agent.id": agentId,
            "gen_ai.conversation.id": conversationId,
            "gen_ai.request.model": turn.model,
            "gen_ai.response.model": turn.model,
            "gen_ai.input.messages": serializeMessages(
              turn.userMessages,
              config.captureContent,
              config.maxChars
            ),
            "gen_ai.output.messages": serializeMessages(
              turn.assistantMessages,
              config.captureContent,
              config.maxChars
            ),
            "codex.turn.id": turn.id,
            "codex.thread.id": turn.threadId
          },
          status: turnStatus(turn, config),
          errorMessage: isTurnError(turn.status) ? turn.statusMessage || turn.status : void 0,
          maxChars: config.maxChars
        })
      );
      const generationParents = /* @__PURE__ */ new Map();
      generations.forEach((generation, position) => {
        const spanId = spanIdFor(
          traceId,
          `${identity}:turn:${turn.id}:generation:${generation.index}:${position}`
        );
        generation.toolCallIds.forEach((callId) => generationParents.set(callId, spanId));
        spans.push(
          generationSpan(
            traceId,
            spanId,
            agentSpanId,
            subagent.session,
            turn,
            generation,
            config,
            conversationId,
            agentName,
            agentId
          )
        );
      });
      const childToolSpanIds = /* @__PURE__ */ new Map();
      turn.tools.forEach((tool, index) => {
        const spanId = spanIdFor(
          traceId,
          `${identity}:turn:${turn.id}:tool:${tool.callId}:${index}`
        );
        childToolSpanIds.set(tool.callId, spanId);
        spans.push(
          toolSpan(
            traceId,
            spanId,
            generationParents.get(tool.callId) ?? agentSpanId,
            tool,
            config,
            turn,
            conversationId,
            agentName,
            agentId
          )
        );
      });
      appendSubagentSpans(
        spans,
        subagent.session.subagents,
        childToolSpanIds,
        traceId,
        config,
        conversationId,
        turn.id,
        `${identity}:turn:${turn.id}`
      );
    }
  });
}
function expandSpanBounds(target, spans) {
  if (!target || spans.length === 0) return;
  target.startTimeUnixNano = spans.reduce(
    (minimum, span) => BigInt(span.startTimeUnixNano) < BigInt(minimum) ? span.startTimeUnixNano : minimum,
    target.startTimeUnixNano
  );
  target.endTimeUnixNano = spans.reduce(
    (maximum, span) => BigInt(span.endTimeUnixNano) > BigInt(maximum) ? span.endTimeUnixNano : maximum,
    target.endTimeUnixNano
  );
}
function makeSpan(input) {
  const startMs = finiteMilliseconds(input.startMs);
  const endMs = Math.max(startMs, finiteMilliseconds(input.endMs));
  const span = {
    traceId: input.traceId,
    spanId: input.spanId,
    ...input.parentSpanId ? { parentSpanId: input.parentSpanId } : {},
    name: redactAndTruncate(input.name.replace(/[\u0000-\u001f\u007f]/g, "?"), MAX_METADATA_CHARS),
    kind: input.kind,
    startTimeUnixNano: millisecondsToUnixNano(startMs),
    endTimeUnixNano: millisecondsToUnixNano(endMs),
    attributes: attributes(input.attributes),
    status: input.status
  };
  if (input.errorMessage) {
    span.events = [exceptionEvent(endMs, input.errorMessage, input.maxChars)];
  }
  return span;
}
function normalizedGenerations(turn) {
  if (turn.generations.length > 0) return turn.generations;
  return [
    {
      index: 0,
      model: turn.model,
      startedAtMs: turn.startedAtMs,
      endedAtMs: turn.endedAtMs,
      input: turn.userMessages,
      output: turn.assistantMessages,
      reasoning: turn.reasoning,
      toolCallIds: turn.tools.map((tool) => tool.callId),
      reconstructionConfidence: "heuristic"
    }
  ];
}
function turnBounds(turn, generations) {
  const starts = [
    finiteMilliseconds(turn.startedAtMs),
    ...generations.map((generation) => finiteMilliseconds(generation.startedAtMs)),
    ...turn.tools.map((tool) => finiteMilliseconds(tool.startedAtMs))
  ];
  const ends = [
    finiteMilliseconds(turn.endedAtMs),
    ...generations.map((generation) => finiteMilliseconds(generation.endedAtMs)),
    ...turn.tools.map((tool) => finiteMilliseconds(tool.endedAtMs ?? tool.startedAtMs))
  ];
  const startMs = Math.min(...starts);
  return { startMs, endMs: Math.max(startMs, ...ends) };
}
function addUsage(target, usage) {
  if (!usage) return;
  target["gen_ai.usage.input_tokens"] = tokenCount(usage.inputTokens);
  target["gen_ai.usage.output_tokens"] = tokenCount(usage.outputTokens);
  target["gen_ai.usage.total_tokens"] = tokenCount(usage.totalTokens);
  target["gen_ai.usage.cache_read.input_tokens"] = tokenCount(usage.cachedInputTokens);
  target["gen_ai.usage.cache_creation.input_tokens"] = tokenCount(usage.cacheWriteInputTokens);
  target["gen_ai.usage.reasoning.output_tokens"] = tokenCount(usage.reasoningOutputTokens);
}
function serializeMessages(messages, captureContent, maxChars) {
  return JSON.stringify(
    messages.map((message) => ({
      role: message.role,
      content: captureContent ? redactAndTruncate(message.content, maxChars) : REDACTED,
      ...message.phase ? { phase: redactAndTruncate(message.phase, MAX_METADATA_CHARS) } : {}
    }))
  );
}
function attributes(values) {
  return Object.entries(values).filter(
    (entry) => entry[1] !== void 0 && (typeof entry[1] !== "number" || Number.isFinite(entry[1]))
  ).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, value]) => ({
    key,
    value: anyValue(
      typeof value === "string" && !CONTENT_ATTRIBUTE_KEYS.has(key) ? redactAndTruncate(value, MAX_METADATA_CHARS) : value
    )
  }));
}
function anyValue(value) {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (Number.isInteger(value)) return { intValue: String(value) };
  return { doubleValue: value };
}
function turnStatus(turn, config) {
  if (turn.status === "completed" || turn.status === "at_stop_hook") return { code: 1 };
  return {
    code: 2,
    message: sanitizeError(turn.statusMessage || turn.status, config)
  };
}
function isTurnError(status) {
  return status !== "completed" && status !== "at_stop_hook";
}
function finishReason(status) {
  if (status === "completed" || status === "at_stop_hook") return "stop";
  if (status === "interrupted") return "cancelled";
  return "error";
}
function exceptionEvent(timeMs, message, maxChars) {
  return {
    name: "exception",
    timeUnixNano: millisecondsToUnixNano(timeMs),
    attributes: attributes({
      "exception.type": "CodexTurnError",
      "exception.message": redactAndTruncate(message, maxChars)
    })
  };
}
function sanitizeError(message, config) {
  return redactAndTruncate(message, config.maxChars);
}
function truncate(value, maxChars) {
  const characters = Array.from(value);
  if (characters.length <= maxChars) return value;
  const suffix = Array.from(TRUNCATED);
  if (maxChars <= suffix.length) return suffix.slice(0, maxChars).join("");
  return `${characters.slice(0, maxChars - suffix.length).join("")}${TRUNCATED}`;
}
function finiteMilliseconds(value) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}
function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : void 0;
}
function millisecondsToUnixNano(value) {
  return (BigInt(value) * 1000000n).toString();
}
function nonZeroHash(value, length) {
  const hash = createHash("sha256").update(value).digest("hex").slice(0, length);
  return /^0+$/.test(hash) ? `${"0".repeat(length - 1)}1` : hash;
}

// plugins/openobserve/src/state.ts
import { createHash as createHash2, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile as readFile2, rename, rm, stat as stat2, writeFile } from "node:fs/promises";
import { resolve as resolve2 } from "node:path";
var STATE_FILE_NAME = "export-state.json";
var LOCK_DIRECTORY_NAME = ".export-state.lock";
var LOCK_OWNER_FILE_NAME = "owner";
var DEFAULT_LOCK_TIMEOUT_MS = 1e4;
var DEFAULT_STALE_LOCK_MS = 3e5;
var LOCK_RETRY_MS = 20;
var MAX_STATE_BYTES = 8 * 1048576;
var MAX_STATE_ENTRIES = 1e4;
var temporaryFileSequence = 0;
var StateError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "StateError";
  }
};
var ExportStateStore = class {
  statePath;
  lockPath;
  stateDirectory;
  lockTimeoutMs;
  staleLockMs;
  now;
  lockOwner = `${process.pid}:${randomUUID()}`;
  constructor(stateDirectory, options = {}) {
    this.stateDirectory = resolve2(stateDirectory);
    this.statePath = resolve2(this.stateDirectory, STATE_FILE_NAME);
    this.lockPath = resolve2(this.stateDirectory, LOCK_DIRECTORY_NAME);
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.now = options.now ?? Date.now;
  }
  async load() {
    return readState(this.statePath);
  }
  async getTurn(sessionId, turnId, revision = "") {
    const state = await this.load();
    return state.exportedTurns[transcriptTurnKey(sessionId, turnId, revision)];
  }
  async hasTurn(sessionId, turnId, revision = "") {
    return await this.getTurn(sessionId, turnId, revision) !== void 0;
  }
  async markTurnExported(sessionId, turnId, traceId, revision = "") {
    assertTraceId(traceId);
    return this.withLock(async () => {
      const state = await readState(this.statePath);
      const key = transcriptTurnKey(sessionId, turnId, revision);
      const existing = state.exportedTurns[key];
      if (existing) return existing;
      const entry = { traceId, exportedAt: new Date(this.now()).toISOString() };
      state.exportedTurns[key] = entry;
      await writeStateAtomically(this.stateDirectory, this.statePath, state);
      return entry;
    });
  }
  async runTurnOnce(sessionId, turnId, revision, exportOperation) {
    return this.withLock(async () => {
      const state = await readState(this.statePath);
      const key = transcriptTurnKey(sessionId, turnId, revision);
      const existing = state.exportedTurns[key];
      if (existing) return { exported: false, entry: existing };
      const traceId = await exportOperation();
      assertTraceId(traceId);
      const entry = { traceId, exportedAt: new Date(this.now()).toISOString() };
      state.exportedTurns[key] = entry;
      await writeStateAtomically(this.stateDirectory, this.statePath, state);
      return { exported: true, entry };
    });
  }
  async withLock(operation) {
    await mkdir(this.stateDirectory, { recursive: true, mode: 448 });
    if (process.platform !== "win32") await chmod(this.stateDirectory, 448);
    await this.acquireLock();
    try {
      return await operation();
    } finally {
      await this.releaseLock();
    }
  }
  async acquireLock() {
    const deadline = this.now() + this.lockTimeoutMs;
    while (true) {
      try {
        await mkdir(this.lockPath, { mode: 448 });
      } catch (error) {
        if (!isNodeError2(error) || error.code !== "EEXIST") {
          throw new StateError(`unable to acquire state lock ${this.lockPath}`, { cause: error });
        }
        await this.removeStaleLock();
        if (this.now() >= deadline) {
          throw new StateError(`timed out waiting for state lock ${this.lockPath}`);
        }
        await delay(LOCK_RETRY_MS);
        continue;
      }
      try {
        await writeFile(resolve2(this.lockPath, LOCK_OWNER_FILE_NAME), this.lockOwner, {
          encoding: "utf8",
          mode: 384
        });
        return;
      } catch (error) {
        await rm(this.lockPath, { recursive: true, force: true });
        throw new StateError(`unable to initialize state lock ${this.lockPath}`, { cause: error });
      }
    }
  }
  async removeStaleLock() {
    try {
      const details = await stat2(this.lockPath);
      if (this.now() - details.mtimeMs > this.staleLockMs) {
        await rm(this.lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (!isNodeError2(error) || error.code !== "ENOENT") throw error;
    }
  }
  async releaseLock() {
    try {
      const owner = await readFile2(resolve2(this.lockPath, LOCK_OWNER_FILE_NAME), "utf8");
      if (owner === this.lockOwner) {
        await rm(this.lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (!isNodeError2(error) || error.code !== "ENOENT") throw error;
    }
  }
};
function transcriptTurnKey(sessionId, turnId, revision = "") {
  if (sessionId.trim() === "") throw new StateError("session ID must not be empty");
  if (turnId.trim() === "") throw new StateError("turn ID must not be empty");
  return createHash2("sha256").update(`session\0${sessionId}\0turn\0${turnId}\0revision\0${revision}`).digest("hex");
}
async function readState(statePath) {
  try {
    const details = await lstat(statePath);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new StateError(`export state ${statePath} must be a regular file`);
    }
    if (details.size > MAX_STATE_BYTES) {
      throw new StateError(`export state ${statePath} exceeds ${MAX_STATE_BYTES} bytes`);
    }
  } catch (error) {
    if (!isNodeError2(error) || error.code !== "ENOENT") throw error;
    return emptyState();
  }
  let contents;
  try {
    contents = await readFile2(statePath, "utf8");
  } catch (error) {
    if (isNodeError2(error) && error.code === "ENOENT") return emptyState();
    throw new StateError(`unable to read export state ${statePath}`, { cause: error });
  }
  let value;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new StateError(`export state ${statePath} contains invalid JSON`, { cause: error });
  }
  if (!isExportState(value)) {
    throw new StateError(`export state ${statePath} has an unsupported format`);
  }
  return value;
}
async function writeStateAtomically(stateDirectory, statePath, state) {
  const orderedState = {
    version: 1,
    exportedTurns: Object.fromEntries(
      Object.entries(state.exportedTurns).sort(([, left], [, right]) => Date.parse(right.exportedAt) - Date.parse(left.exportedAt)).slice(0, MAX_STATE_ENTRIES).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    )
  };
  temporaryFileSequence += 1;
  const temporaryPath = resolve2(
    stateDirectory,
    `.${STATE_FILE_NAME}.${process.pid}.${temporaryFileSequence}.tmp`
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(orderedState, null, 2)}
`, {
      encoding: "utf8",
      flag: "wx",
      mode: 384
    });
    await rename(temporaryPath, statePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw new StateError(`unable to update export state ${statePath}`, { cause: error });
  }
}
function emptyState() {
  return { version: 1, exportedTurns: {} };
}
function isExportState(value) {
  if (!isObject(value) || value.version !== 1 || !isObject(value.exportedTurns)) return false;
  return Object.values(value.exportedTurns).every(
    (entry) => isObject(entry) && typeof entry.traceId === "string" && /^[0-9a-f]{32}$/.test(entry.traceId) && typeof entry.exportedAt === "string" && Number.isFinite(Date.parse(entry.exportedAt))
  );
}
function assertTraceId(traceId) {
  if (!/^[0-9a-f]{32}$/.test(traceId) || /^0+$/.test(traceId)) {
    throw new StateError("trace ID must be 32 lowercase hexadecimal characters and non-zero");
  }
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNodeError2(error) {
  return error instanceof Error && "code" in error;
}
function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

// plugins/openobserve/src/exporter.ts
var MAX_ERROR_BODY_CHARS = 1024;
var MAX_EXPORT_BODY_BYTES = 16 * 1024 * 1024;
var MAX_RESPONSE_BODY_BYTES = 64 * 1024;
var ExportError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ExportError";
  }
};
async function postOtlpTrace(config, request, fetchImplementation = globalThis.fetch) {
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
      redirect: "error"
    });
    const responseBody = (await readBoundedResponse(response)).trim();
    if (response.status !== 200) {
      const sanitizedBody = redactAndTruncate(
        responseBody.slice(0, MAX_ERROR_BODY_CHARS),
        MAX_ERROR_BODY_CHARS
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
async function exportTurnOnce(config, session, turn, options = {}) {
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
      traceId: result.entry.traceId
    };
  } catch (error) {
    return handleExportFailure(config, traceId, error);
  }
}
function handleExportFailure(config, traceId, error) {
  const exportError = error instanceof Error ? error : new ExportError("trace export failed with an unknown error");
  debug(config, exportError.message);
  if (config.failOnError) throw exportError;
  return {
    exported: false,
    deduplicated: false,
    traceId,
    error: exportError.message
  };
}
function debug(config, message) {
  if (config.debug) console.error(`[openobserve-codex] ${message}`);
}
function turnRevision(session, turn, config) {
  const canonicalTrace = buildOtlpExportRequest(
    session,
    turn,
    config,
    traceIdForTurn(session.id, turn.id)
  );
  return createHash3("sha256").update(`${config.endpoint}\0${config.organization}\0${config.streamName}\0`).update(JSON.stringify(canonicalTrace)).digest("hex").slice(0, 16);
}
function rejectedSpanCount(responseBody) {
  if (!responseBody) return 0;
  let parsed;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    throw new ExportError("trace export returned an invalid JSON response");
  }
  if (!isRecord(parsed)) {
    throw new ExportError("trace export returned an invalid JSON response");
  }
  const partial = isRecord(parsed.partialSuccess) ? parsed.partialSuccess : isRecord(parsed.partial_success) ? parsed.partial_success : void 0;
  if (!partial) return 0;
  const value = partial.rejectedSpans ?? partial.rejected_spans;
  if (value === void 0) return 0;
  const count = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ExportError("trace export returned an invalid rejected span count");
  }
  return count;
}
async function readBoundedResponse(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
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
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// plugins/openobserve/src/parser.ts
var START_EVENTS = /* @__PURE__ */ new Set(["task_started", "turn_started"]);
var COMPLETE_EVENTS = /* @__PURE__ */ new Set(["task_complete", "turn_complete"]);
var FAILED_EVENTS = /* @__PURE__ */ new Set(["task_failed", "turn_failed"]);
var ABORTED_EVENTS = /* @__PURE__ */ new Set([
  "task_aborted",
  "turn_aborted",
  "task_cancelled",
  "turn_cancelled",
  "task_canceled",
  "turn_canceled"
]);
var ERROR_EVENTS = /* @__PURE__ */ new Set(["error", "task_error", "turn_error", "stream_error"]);
var IGNORED_RECORDS = /* @__PURE__ */ new Set(["compacted", "world_state"]);
var IGNORED_EVENTS = /* @__PURE__ */ new Set([
  "context_compacted",
  "thread_goal_updated",
  "thread_rolled_back",
  "thread_settings_applied"
]);
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : void 0;
  }
  return void 0;
}
function timestampMs(value) {
  const numeric = numberValue(value);
  if (numeric !== void 0) {
    if (numeric > 1e15) {
      return Math.floor(numeric / 1e6);
    }
    if (numeric > 1e12) {
      return Math.floor(numeric);
    }
    if (numeric > 1e9) {
      return Math.floor(numeric * 1e3);
    }
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? void 0 : parsed;
  }
  return void 0;
}
function recordTimestampMs(record, fallback) {
  return timestampMs(record.timestamp) ?? fallback;
}
function payloadTimestampMs(payload, keys, fallback) {
  for (const key of keys) {
    const raw = payload[key];
    const parsed = timestampMs(raw);
    if (parsed !== void 0) {
      const numeric = numberValue(raw);
      if (numeric !== void 0 && numeric >= 1e9 && numeric < 1e12 && Math.floor(fallback / 1e3) === Math.floor(numeric)) {
        return fallback;
      }
      return parsed;
    }
  }
  return fallback;
}
function extractText(value, depth = 0) {
  if (depth > 32) return "";
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => extractText(item, depth + 1)).filter((text) => text.length > 0).join("\n");
  }
  if (!isRecord2(value)) {
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
function serialize(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value === void 0) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function firstDefined(payload, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== void 0) {
      return payload[key];
    }
  }
  return void 0;
}
function statusMessage(payload) {
  for (const key of ["error_message", "error", "reason", "message", "stderr"]) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (isRecord2(value)) {
      const nested = statusMessage(value);
      if (nested !== void 0) {
        return nested;
      }
    }
  }
  return void 0;
}
function normalizedUsage(candidate) {
  if (!candidate) return void 0;
  const token = (snakeCase, camelCase) => Math.max(0, numberValue(candidate[snakeCase] ?? candidate[camelCase]) ?? 0);
  return {
    inputTokens: token("input_tokens", "inputTokens"),
    cachedInputTokens: token("cached_input_tokens", "cachedInputTokens"),
    cacheWriteInputTokens: token("cache_write_input_tokens", "cacheWriteInputTokens"),
    outputTokens: token("output_tokens", "outputTokens"),
    reasoningOutputTokens: token("reasoning_output_tokens", "reasoningOutputTokens"),
    totalTokens: token("total_tokens", "totalTokens")
  };
}
function usageFromPayload(payload) {
  const info = isRecord2(payload.info) ? payload.info : void 0;
  const candidate = info && isRecord2(info.last_token_usage) && info.last_token_usage || isRecord2(payload.last_token_usage) && payload.last_token_usage || isRecord2(payload.usage) && payload.usage || info && isRecord2(info.total_token_usage) && info.total_token_usage || isRecord2(payload.total_token_usage) && payload.total_token_usage;
  return normalizedUsage(candidate || void 0);
}
function totalUsageFromPayload(payload) {
  const info = isRecord2(payload.info) ? payload.info : void 0;
  const candidate = info && isRecord2(info.total_token_usage) && info.total_token_usage || isRecord2(payload.total_token_usage) && payload.total_token_usage;
  return normalizedUsage(candidate || void 0);
}
function sameUsage(left, right) {
  return left.inputTokens === right.inputTokens && left.cachedInputTokens === right.cachedInputTokens && left.cacheWriteInputTokens === right.cacheWriteInputTokens && left.outputTokens === right.outputTokens && left.reasoningOutputTokens === right.reasoningOutputTokens && left.totalTokens === right.totalTokens;
}
function terminalToolStatus(value) {
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
  return void 0;
}
function outputIsError(payload, result) {
  const explicitStatus = terminalToolStatus(payload.status);
  if (explicitStatus === "error" || payload.success === false) {
    return true;
  }
  if (isRecord2(result)) {
    if (terminalToolStatus(result.status) === "error" || result.success === false) {
      return true;
    }
    if (result.error !== void 0) {
      return true;
    }
    const exitCode = numberValue(result.exit_code ?? result.exitCode);
    if (exitCode !== void 0 && exitCode !== 0) {
      return true;
    }
  }
  return typeof result === "string" && (/process exited with code\s+[1-9]\d*/i.test(result) || /"(?:exit_code|exitCode)"\s*:\s*[1-9]\d*/.test(result));
}
function childSessionId(payload, result) {
  let parsedResult = result;
  if (typeof result === "string") {
    try {
      parsedResult = JSON.parse(result);
    } catch {
      parsedResult = result;
    }
  }
  for (const source of [payload, isRecord2(parsedResult) ? parsedResult : void 0]) {
    if (!source) {
      continue;
    }
    for (const key of ["child_session_id", "session_id", "thread_id", "agent_id"]) {
      const value = stringValue(source[key]);
      if (value !== void 0) {
        return value;
      }
    }
  }
  return void 0;
}
function combineText(parts) {
  const unique = [];
  for (const part of parts) {
    if (part && !unique.includes(part)) {
      unique.push(part);
    }
  }
  return unique.join("\n");
}
function generationHasOutput(generation) {
  return generation.output.length > 0 || generation.reasoning.length > 0 || generation.toolCallIds.length > 0;
}
function ensureGeneration(builder, atMs) {
  if (builder.currentGeneration) {
    builder.currentGeneration.endedAtMs = Math.max(builder.currentGeneration.endedAtMs, atMs);
    return builder.currentGeneration;
  }
  const firstGeneration = builder.turn.generations.length === 0;
  const input = firstGeneration ? [...builder.turn.userMessages] : builder.pendingGenerationInputs.splice(0);
  const inputStart = input.length > 0 ? Math.min(...input.map((message) => message.timestampMs)) : atMs;
  builder.currentGeneration = {
    model: builder.turn.model,
    startedAtMs: Math.max(builder.turn.startedAtMs, inputStart),
    endedAtMs: atMs,
    input,
    output: [],
    reasoning: [],
    toolCallIds: []
  };
  return builder.currentGeneration;
}
function finishGeneration(builder, atMs, usage) {
  const generation = builder.currentGeneration;
  if (!generation) {
    return;
  }
  generation.endedAtMs = Math.max(generation.startedAtMs, generation.endedAtMs, atMs);
  generation.usage = usage ?? generation.usage;
  if (generationHasOutput(generation)) {
    const normalized = {
      index: builder.turn.generations.length,
      model: generation.model,
      startedAtMs: generation.startedAtMs,
      endedAtMs: generation.endedAtMs,
      input: generation.input,
      output: generation.output,
      reasoning: generation.reasoning,
      toolCallIds: generation.toolCallIds,
      reconstructionConfidence: "heuristic"
    };
    if (generation.usage) {
      normalized.usage = generation.usage;
    }
    builder.turn.generations.push(normalized);
  }
  builder.currentGeneration = void 0;
}
function removeMessage(builder, message) {
  builder.turn.userMessages = builder.turn.userMessages.filter(
    (candidate) => candidate !== message
  );
  builder.turn.assistantMessages = builder.turn.assistantMessages.filter(
    (candidate) => candidate !== message
  );
  builder.pendingGenerationInputs = builder.pendingGenerationInputs.filter(
    (candidate) => candidate !== message
  );
  if (builder.currentGeneration) {
    builder.currentGeneration.input = builder.currentGeneration.input.filter(
      (candidate) => candidate !== message
    );
    builder.currentGeneration.output = builder.currentGeneration.output.filter(
      (candidate) => candidate !== message
    );
  }
  for (const generation of builder.turn.generations) {
    generation.input = generation.input.filter((candidate) => candidate !== message);
    generation.output = generation.output.filter((candidate) => candidate !== message);
  }
}
function addReasoning(builder, summary, content, atMs) {
  if (summary.length === 0 && content.length === 0) {
    return;
  }
  const generation = ensureGeneration(builder, atMs);
  const previous = generation.reasoning.at(-1);
  if (previous && (summary.length > 0 && previous.summary.length > 0 && summary.startsWith(previous.summary) || content.length > 0 && previous.content && content.startsWith(previous.content))) {
    if (summary.length > 0) previous.summary = summary;
    if (content.length > 0) previous.content = content;
    previous.timestampMs = atMs;
    return;
  }
  const reasoning = { summary, timestampMs: atMs };
  if (content.length > 0) {
    reasoning.content = content;
  }
  builder.turn.reasoning.push(reasoning);
  generation.reasoning.push(reasoning);
}
function flushRawReasoning(builder, atMs) {
  if (builder.pendingRawReasoning.length === 0) {
    return;
  }
  const content = combineText(builder.pendingRawReasoning.map((item) => item.text));
  const timestamp = builder.pendingRawReasoning[0]?.timestampMs ?? atMs;
  builder.pendingRawReasoning = [];
  addReasoning(builder, "", content, timestamp);
}
function addAssistantMessage(builder, content, atMs, phase, fallback) {
  if (content.length === 0) {
    return void 0;
  }
  const duplicate = builder.turn.assistantMessages.find(
    (message2) => message2.content === content && Math.abs(message2.timestampMs - atMs) <= 1
  );
  if (duplicate) {
    if (!fallback && phase !== void 0) {
      duplicate.phase = phase;
    }
    return duplicate;
  }
  const message = {
    role: "assistant",
    content,
    timestampMs: atMs
  };
  if (phase !== void 0) {
    message.phase = phase;
  }
  builder.turn.assistantMessages.push(message);
  ensureGeneration(builder, atMs).output.push(message);
  if (fallback) {
    builder.fallbackAssistants.add(message);
  }
  return message;
}
function addCanonicalAssistant(builder, content, atMs, phase) {
  for (const fallback of builder.fallbackAssistants) {
    if (fallback.content === content && Math.abs(fallback.timestampMs - atMs) <= 1) {
      removeMessage(builder, fallback);
      builder.fallbackAssistants.delete(fallback);
    }
  }
  addAssistantMessage(builder, content, atMs, phase, false);
}
function addCanonicalUser(builder, content, atMs) {
  if (content.length === 0) {
    return;
  }
  for (const fallback of builder.fallbackUsers) {
    removeMessage(builder, fallback);
  }
  builder.fallbackUsers.clear();
  builder.hasCanonicalUser = true;
  const duplicate = builder.turn.userMessages.some(
    (message2) => message2.content === content && Math.abs(message2.timestampMs - atMs) <= 1
  );
  if (duplicate) {
    return;
  }
  const message = { role: "user", content, timestampMs: atMs };
  builder.turn.userMessages.push(message);
  if (builder.currentGeneration && builder.turn.generations.length === 0) {
    builder.currentGeneration.input.push(message);
  } else if (builder.turn.generations.length > 0) {
    builder.pendingGenerationInputs.push(message);
  }
}
function addFallbackUser(builder, content, atMs) {
  if (content.length === 0 || builder.hasCanonicalUser || !builder.contextSeen) {
    return;
  }
  const message = { role: "user", content, timestampMs: atMs };
  builder.turn.userMessages.push(message);
  builder.fallbackUsers.add(message);
  if (builder.turn.generations.length > 0) {
    builder.pendingGenerationInputs.push(message);
  }
}
function createTurnBuilder(id, threadId, model, startedAtMs) {
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
      generations: []
    },
    contextSeen: false,
    hasCanonicalUser: false,
    fallbackUsers: /* @__PURE__ */ new Set(),
    fallbackAssistants: /* @__PURE__ */ new Set(),
    pendingRawReasoning: [],
    pendingGenerationInputs: [],
    toolsById: /* @__PURE__ */ new Map(),
    toolOutputMessages: /* @__PURE__ */ new Map(),
    toolOutputPriorities: /* @__PURE__ */ new Map(),
    lastTimestampMs: startedAtMs,
    closed: false
  };
}
function toolDescriptor(itemType, payload) {
  if (itemType === "function_call") {
    return {
      name: stringValue(payload.name) ?? "function",
      namespace: stringValue(payload.namespace),
      arguments: serialize(payload.arguments)
    };
  }
  if (itemType === "custom_tool_call") {
    return {
      name: stringValue(payload.name) ?? "custom_tool",
      namespace: stringValue(payload.namespace),
      arguments: serialize(payload.input)
    };
  }
  if (["local_shell_call", "shell_call"].includes(itemType)) {
    return {
      name: "local_shell",
      arguments: serialize(firstDefined(payload, ["action", "command", "input"])),
      embeddedResult: firstDefined(payload, ["output", "result"])
    };
  }
  if (itemType === "web_search_call") {
    return {
      name: "web_search",
      arguments: serialize(firstDefined(payload, ["action", "query", "input"])),
      embeddedResult: firstDefined(payload, ["output", "result", "results"])
    };
  }
  if (["image_generation_call", "image_call"].includes(itemType)) {
    return {
      name: "image_generation",
      arguments: serialize(firstDefined(payload, ["prompt", "input", "action"])),
      embeddedResult: firstDefined(payload, ["output", "result", "images"])
    };
  }
  return {
    name: "tool_search",
    arguments: serialize(payload.arguments),
    embeddedResult: firstDefined(payload, ["output", "result", "tools"])
  };
}
function addToolCall(builder, itemType, payload, atMs, fallbackCallId) {
  const descriptor = toolDescriptor(itemType, payload);
  const callId = stringValue(payload.call_id) ?? stringValue(payload.callId) ?? stringValue(payload.id) ?? fallbackCallId;
  let tool = builder.toolsById.get(callId);
  if (!tool) {
    tool = {
      callId,
      name: descriptor.name,
      arguments: descriptor.arguments,
      startedAtMs: atMs,
      status: "incomplete"
    };
    builder.toolsById.set(callId, tool);
    builder.turn.tools.push(tool);
  } else {
    tool.name = descriptor.name;
    tool.arguments = descriptor.arguments;
    tool.startedAtMs = Math.min(tool.startedAtMs, atMs);
  }
  if (descriptor.namespace !== void 0) {
    tool.namespace = descriptor.namespace;
  }
  tool.childSessionId = childSessionId(payload) ?? tool.childSessionId;
  const generation = ensureGeneration(builder, atMs);
  if (!generation.toolCallIds.includes(callId)) {
    generation.toolCallIds.push(callId);
  }
  if (descriptor.embeddedResult !== void 0) {
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
function applyToolOutput(builder, callId, fallbackName, payload, result, atMs, priority) {
  let tool = builder.toolsById.get(callId);
  if (!tool) {
    tool = {
      callId,
      name: fallbackName,
      arguments: "",
      startedAtMs: atMs,
      status: "incomplete"
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
    tool.status = failed ? "error" : terminalToolStatus(payload.status) ?? "ok";
    tool.endedAtMs = atMs;
    if (failed) {
      tool.errorMessage = statusMessage(payload) ?? (isRecord2(result) ? statusMessage(result) : output);
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
function outputDescriptor(itemType) {
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
function applyHookAssistantMessage(builder, hookMessage) {
  if (hookMessage.length === 0) {
    return;
  }
  const reversed = [...builder.turn.assistantMessages].reverse();
  const target = reversed.find((message2) => message2.phase === "final" || message2.phase === "final_answer") ?? reversed.find((message2) => message2.phase !== "commentary");
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
  const message = {
    role: "assistant",
    content: hookMessage,
    timestampMs: builder.turn.endedAtMs,
    phase: "final_answer"
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
      reconstructionConfidence: "heuristic"
    });
  }
}
function parseRolloutJsonl(jsonl) {
  const diagnostics = [];
  const records = [];
  const lines = jsonl.split("\n");
  if (lines.length > 250001) {
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
    if (Buffer.byteLength(line, "utf8") > 4 * 1048576) {
      throw new Error(`Line ${lineNumber}: Codex transcript record exceeds the supported size`);
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      diagnostics.push(`Line ${lineNumber}: malformed JSONL record`);
      continue;
    }
    if (!isRecord2(parsed)) {
      diagnostics.push(`Line ${lineNumber}: JSONL record is not an object`);
      continue;
    }
    if (typeof parsed.type !== "string" || !isRecord2(parsed.payload)) {
      diagnostics.push(`Line ${lineNumber}: JSONL record is missing a type or object payload`);
      continue;
    }
    let timestamp;
    if (typeof parsed.timestamp === "string") {
      timestamp = parsed.timestamp;
    } else if (typeof parsed.timestamp === "number") {
      timestamp = String(parsed.timestamp);
    } else {
      timestamp = "";
      diagnostics.push(`Line ${lineNumber}: JSONL record has no usable timestamp`);
    }
    if (timestamp.length > 0 && timestampMs(timestamp) === void 0) {
      diagnostics.push(`Line ${lineNumber}: JSONL record has an invalid timestamp`);
    }
    const ordinal = numberValue(parsed.ordinal);
    records.push({
      timestamp,
      ordinal: ordinal === void 0 ? lineNumber : ordinal,
      type: parsed.type,
      payload: parsed.payload
    });
  }
  return { records, diagnostics };
}
function parseRolloutTranscript(jsonl, hook) {
  const parsed = parseRolloutJsonl(jsonl);
  const diagnostics = [...parsed.diagnostics];
  const metadataRecords = parsed.records.filter((record) => record.type === "session_meta");
  const canonicalMetadata = metadataRecords.find((record) => {
    const id = stringValue(record.payload.id) ?? stringValue(record.payload.session_id);
    return id === hook.session_id;
  }) ?? metadataRecords[0];
  const metadata = canonicalMetadata?.payload ?? {};
  if (!canonicalMetadata) {
    diagnostics.push("Transcript has no session_meta record; hook metadata was used");
  } else {
    const metadataId = stringValue(metadata.id) ?? stringValue(metadata.session_id);
    if (metadataId !== void 0 && metadataId !== hook.session_id) {
      diagnostics.push(
        `No session_meta record matched hook session ${hook.session_id}; using ${metadataId}`
      );
    }
  }
  const sessionId = stringValue(metadata.id) ?? stringValue(metadata.session_id) ?? hook.session_id ?? "unknown-session";
  const session = {
    id: sessionId,
    turns: [],
    subagents: [],
    diagnostics
  };
  const sessionRecords = recordsForSession(parsed.records, canonicalMetadata, diagnostics);
  const assignMetadata = (key, value) => {
    const normalized = stringValue(value);
    if (normalized !== void 0) {
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
  const turnsById = /* @__PURE__ */ new Map();
  const orderedBuilders = [];
  let active;
  let lastTimestamp = metadataTime;
  const getOrCreateTurn = (id, atMs, model, inferred = false) => {
    const existing = turnsById.get(id);
    if (existing) {
      existing.turn.startedAtMs = Math.min(existing.turn.startedAtMs, atMs);
      existing.lastTimestampMs = Math.max(existing.lastTimestampMs, atMs);
      if (model !== void 0) {
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
      atMs
    );
    turnsById.set(id, builder);
    orderedBuilders.push(builder);
    if (inferred) {
      diagnostics.push(`Turn ${id} was inferred without a start event`);
    }
    return builder;
  };
  const finishTurn = (builder, atMs, status, message) => {
    flushRawReasoning(builder, atMs);
    finishGeneration(builder, atMs);
    builder.turn.endedAtMs = Math.max(builder.turn.startedAtMs, atMs);
    builder.lastTimestampMs = Math.max(builder.lastTimestampMs, atMs);
    builder.turn.status = status;
    if (message !== void 0) {
      builder.turn.statusMessage = message;
    }
    builder.closed = true;
  };
  for (const record of sessionRecords) {
    const atMs = recordTimestampMs(record, lastTimestamp);
    lastTimestamp = Math.max(lastTimestamp, atMs);
    const payload = record.payload;
    const eventType2 = record.type === "event_msg" ? stringValue(payload.type) : stringValue(record.type);
    const line = record.ordinal ?? 0;
    if (record.type === "session_meta") {
      continue;
    }
    if (eventType2 && START_EVENTS.has(eventType2)) {
      const id = stringValue(payload.turn_id) ?? stringValue(payload.id);
      if (!id) {
        diagnostics.push(`Line ${line}: ${eventType2} has no turn ID`);
        continue;
      }
      const startedAt = payloadTimestampMs(payload, ["started_at", "timestamp"], atMs);
      const model = stringValue(payload.model);
      if (active && active.turn.id !== id && !active.closed) {
        const status = active.turn.status === "failed" ? "failed" : "incomplete";
        const message = active.turn.status === "failed" ? active.turn.statusMessage : "A new turn started before this turn ended";
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
      const builder2 = getOrCreateTurn(id, atMs, stringValue(payload.model), !turnsById.has(id));
      builder2.contextSeen = true;
      builder2.lastTimestampMs = Math.max(builder2.lastTimestampMs, atMs);
      active = builder2;
      continue;
    }
    if (eventType2 && COMPLETE_EVENTS.has(eventType2)) {
      const id = stringValue(payload.turn_id) ?? active?.turn.id;
      if (!id) {
        diagnostics.push(`Line ${line}: ${eventType2} has no associated turn`);
        continue;
      }
      const builder2 = getOrCreateTurn(id, atMs, void 0, !turnsById.has(id));
      const completionMessage = stringValue(payload.last_agent_message);
      if (completionMessage && builder2.turn.assistantMessages.length === 0) {
        addAssistantMessage(builder2, completionMessage, atMs, "final_answer", true);
      }
      const completedAt = payloadTimestampMs(payload, ["completed_at", "ended_at"], atMs);
      const durationMs = numberValue(payload.duration_ms);
      if (durationMs !== void 0 && durationMs >= 0 && durationMs <= completedAt) {
        builder2.turn.startedAtMs = completedAt - durationMs;
      }
      const explicitStatus = stringValue(payload.status)?.toLowerCase();
      const status = payload.error !== void 0 || explicitStatus && ["failed", "error", "failure"].includes(explicitStatus) ? "failed" : explicitStatus && ["interrupted", "aborted", "cancelled", "canceled"].includes(explicitStatus) ? "interrupted" : "completed";
      finishTurn(builder2, completedAt, status, statusMessage(payload));
      if (active === builder2) {
        active = void 0;
      }
      continue;
    }
    if (eventType2 && ABORTED_EVENTS.has(eventType2)) {
      const id = stringValue(payload.turn_id) ?? active?.turn.id;
      if (!id) {
        diagnostics.push(`Line ${line}: ${eventType2} has no associated turn`);
        continue;
      }
      const builder2 = getOrCreateTurn(id, atMs, void 0, !turnsById.has(id));
      const completedAt = payloadTimestampMs(payload, ["completed_at", "ended_at"], atMs);
      finishTurn(builder2, completedAt, "interrupted", statusMessage(payload));
      if (active === builder2) {
        active = void 0;
      }
      continue;
    }
    if (eventType2 && FAILED_EVENTS.has(eventType2)) {
      const id = stringValue(payload.turn_id) ?? active?.turn.id;
      if (!id) {
        diagnostics.push(`Line ${line}: ${eventType2} has no associated turn`);
        continue;
      }
      const builder2 = getOrCreateTurn(id, atMs, void 0, !turnsById.has(id));
      const completedAt = payloadTimestampMs(payload, ["completed_at", "ended_at"], atMs);
      finishTurn(builder2, completedAt, "failed", statusMessage(payload));
      if (active === builder2) {
        active = void 0;
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
          extractText(payload.content)
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
      if ([
        "function_call",
        "custom_tool_call",
        "local_shell_call",
        "shell_call",
        "web_search_call",
        "image_generation_call",
        "image_call",
        "tool_search_call"
      ].includes(itemType)) {
        addToolCall(builder, itemType, payload, atMs, `${itemType}-${line}`);
        continue;
      }
      if ([
        "function_call_output",
        "custom_tool_call_output",
        "local_shell_call_output",
        "shell_call_output",
        "web_search_call_output",
        "web_search_output",
        "image_generation_call_output",
        "image_call_output",
        "tool_search_output"
      ].includes(itemType)) {
        const descriptor = outputDescriptor(itemType);
        const callId = stringValue(payload.call_id) ?? stringValue(payload.callId) ?? `${itemType}-${line}`;
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
          descriptor.priority
        );
        continue;
      }
      diagnostics.push(`Line ${line}: unknown response item type ${itemType}`);
      continue;
    }
    if (record.type === "event_msg") {
      if (!eventType2) {
        diagnostics.push(`Line ${line}: event_msg has no event type`);
        continue;
      }
      if (eventType2 === "user_message") {
        if (!builder) {
          diagnostics.push(`Line ${line}: user message is outside a turn`);
        } else {
          addCanonicalUser(builder, extractText(payload.message), atMs);
        }
        continue;
      }
      if (eventType2 === "agent_message") {
        if (!builder) {
          diagnostics.push(`Line ${line}: agent message is outside a turn`);
        } else {
          addAssistantMessage(
            builder,
            extractText(payload.message),
            atMs,
            stringValue(payload.phase),
            true
          );
        }
        continue;
      }
      if (eventType2 === "agent_reasoning") {
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
      if (eventType2 === "token_count") {
        if (!builder) {
          diagnostics.push(`Line ${line}: token usage is outside a turn`);
        } else {
          const totalUsage = totalUsageFromPayload(payload);
          if (totalUsage && builder.lastTotalUsage && sameUsage(totalUsage, builder.lastTotalUsage)) {
            continue;
          }
          if (totalUsage) builder.lastTotalUsage = totalUsage;
          flushRawReasoning(builder, atMs);
          finishGeneration(builder, atMs, usageFromPayload(payload));
        }
        continue;
      }
      if (eventType2 === "item_completed") {
        if (!builder) {
          diagnostics.push(`Line ${line}: completed item is outside a turn`);
          continue;
        }
        const item = isRecord2(payload.item) ? payload.item : void 0;
        const itemType = item ? stringValue(item.type) : void 0;
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
            true
          );
        } else if (itemType === "Reasoning") {
          addReasoning(
            builder,
            extractText(item.summary_text),
            extractText(item.raw_content),
            completedAt
          );
        } else if (itemType === "CommandExecution") {
          const callId = stringValue(item.id) ?? `command-${line}`;
          addToolCall(
            builder,
            "function_call",
            {
              call_id: callId,
              name: "exec_command",
              arguments: serialize(item.command)
            },
            payloadTimestampMs(payload, ["started_at_ms"], completedAt),
            callId
          );
          applyToolOutput(
            builder,
            callId,
            "exec_command",
            item,
            firstDefined(item, ["aggregated_output", "formatted_output", "stdout", "stderr"]),
            completedAt,
            1
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
              arguments: serialize(item.arguments)
            },
            payloadTimestampMs(payload, ["started_at_ms"], completedAt),
            callId
          );
          applyToolOutput(
            builder,
            callId,
            stringValue(item.tool) ?? "dynamic_tool",
            item,
            item.content_items ?? item.error,
            completedAt,
            1
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
      if (eventType2 === "web_search_end") {
        if (!builder) {
          diagnostics.push(`Line ${line}: web search output is outside a turn`);
        } else {
          const callId = stringValue(payload.call_id) ?? `web_search-${line}`;
          const result = firstDefined(payload, ["results", "result", "output", "query", "action"]);
          applyToolOutput(builder, callId, "web_search", payload, result, atMs, 1);
        }
        continue;
      }
      if (eventType2 === "sub_agent_activity") {
        if (builder) {
          const callId = stringValue(payload.event_id);
          const childId = stringValue(payload.agent_thread_id);
          if (callId && childId) {
            const tool = builder.toolsById.get(callId);
            if (tool) {
              tool.childSessionId = childId;
            } else {
              diagnostics.push(
                `Line ${line}: sub-agent activity references unknown call ${callId}`
              );
            }
          }
        }
        continue;
      }
      if (eventType2 === "patch_apply_end" || eventType2 === "mcp_tool_call_end") {
        if (builder) {
          const callId = stringValue(payload.call_id) ?? `${eventType2}-${line}`;
          const result = eventType2 === "mcp_tool_call_end" ? firstDefined(payload, ["result", "output"]) : {
            changes: payload.changes,
            stdout: payload.stdout,
            stderr: payload.stderr,
            success: payload.success
          };
          applyToolOutput(builder, callId, eventType2, payload, result, atMs, 1);
        }
        continue;
      }
      if (ERROR_EVENTS.has(eventType2)) {
        const message = statusMessage(payload) ?? "Unknown turn error";
        diagnostics.push(
          builder ? `Turn ${builder.turn.id} error: ${message}` : `Line ${line}: ${message}`
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
      if (IGNORED_EVENTS.has(eventType2)) {
        continue;
      }
      diagnostics.push(`Line ${line}: unknown event type ${eventType2}`);
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
      if (tool.status === "incomplete" && tool.endedAtMs !== void 0) {
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
function recordsForSession(records, canonicalMetadata, diagnostics) {
  const metadata = canonicalMetadata?.payload;
  if (!canonicalMetadata || !metadata || !stringValue(metadata.forked_from_id)) return records;
  const createdAt = timestampMs(metadata.timestamp) ?? recordTimestampMs(canonicalMetadata, 0);
  const firstOwnTurn = records.findIndex((record) => {
    const type = record.type === "event_msg" ? stringValue(record.payload.type) : stringValue(record.type);
    if (!type || !START_EVENTS.has(type)) return false;
    const startedAt = payloadTimestampMs(
      record.payload,
      ["started_at", "timestamp"],
      recordTimestampMs(record, 0)
    );
    return startedAt >= createdAt;
  });
  if (firstOwnTurn <= 0) return records;
  diagnostics.push(`Ignored ${firstOwnTurn - 1} inherited record(s) from parent session history`);
  return [
    canonicalMetadata,
    ...records.slice(firstOwnTurn).filter((record) => record.type !== "session_meta")
  ];
}

// plugins/openobserve/src/subagents.ts
import { readFile as readFile3, readdir, stat as stat3 } from "node:fs/promises";
import { basename, dirname as dirname2, isAbsolute as isAbsolute2, join as join2, parse as parse2, relative, resolve as resolve3, sep } from "node:path";
var DEFAULT_MAX_DEPTH = 8;
var DEFAULT_MAX_FILES = 2048;
var DEFAULT_MAX_SCAN_DEPTH = 8;
var MAX_CHILD_TRANSCRIPT_BYTES = 64 * 1048576;
var START_EVENTS2 = /* @__PURE__ */ new Set(["task_started", "turn_started"]);
var TranscriptLocator = class {
  constructor(sessionsRoot, maxFiles, maxScanDepth, preferredDirectory) {
    this.sessionsRoot = sessionsRoot;
    this.maxFiles = maxFiles;
    this.maxScanDepth = maxScanDepth;
    this.preferredDirectory = preferredDirectory;
  }
  transcriptPaths = [];
  scanPromise;
  filesSeen = 0;
  fileLimitReached = false;
  scanDepthLimitReached = false;
  scanFailed = false;
  visitedDirectories = /* @__PURE__ */ new Set();
  async locate(sessionId) {
    this.scanPromise ??= this.scan();
    await this.scanPromise;
    return {
      paths: this.transcriptPaths.filter(
        (path) => filenameMatchesSession(basename(path), sessionId)
      ),
      fileLimitReached: this.fileLimitReached,
      scanDepthLimitReached: this.scanDepthLimitReached,
      scanFailed: this.scanFailed
    };
  }
  async scan() {
    if (this.preferredDirectory && pathIsWithin(this.sessionsRoot, this.preferredDirectory)) {
      await this.scanDirectory(this.preferredDirectory, 0);
    }
    await this.scanDirectory(this.sessionsRoot, 0);
  }
  async scanDirectory(directory, depth) {
    const canonicalDirectory = resolve3(directory);
    if (this.visitedDirectories.has(canonicalDirectory)) return true;
    this.visitedDirectories.add(canonicalDirectory);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      this.scanFailed = true;
      return true;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth >= this.maxScanDepth) {
          this.scanDepthLimitReached = true;
          continue;
        }
        if (!await this.scanDirectory(join2(directory, entry.name), depth + 1)) {
          return false;
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        if (this.filesSeen >= this.maxFiles) {
          this.fileLimitReached = true;
          return false;
        }
        this.filesSeen += 1;
        this.transcriptPaths.push(join2(directory, entry.name));
      }
    }
    return true;
  }
};
async function discoverSubagents(session, parentTranscriptPath, options = {}) {
  if (childTools(session).length === 0) {
    return session;
  }
  const sessionsRoot = options.sessionsRoot ? resolve3(options.sessionsRoot) : nearestSessionsRoot(parentTranscriptPath);
  if (!sessionsRoot) {
    appendDiagnostic(session, "Child transcript discovery could not locate a Codex sessions root");
    return session;
  }
  const maxDepth = boundedInteger(options.maxDepth, DEFAULT_MAX_DEPTH);
  const locator = new TranscriptLocator(
    sessionsRoot,
    boundedInteger(options.maxFiles, DEFAULT_MAX_FILES),
    boundedInteger(options.maxScanDepth, DEFAULT_MAX_SCAN_DEPTH),
    dirname2(resolve3(parentTranscriptPath))
  );
  const loaded = /* @__PURE__ */ new Map([[session.id, session]]);
  await loadChildren(session, 0, /* @__PURE__ */ new Set([session.id]), maxDepth, locator, loaded);
  return session;
}
async function loadChildren(parent, depth, ancestors, maxDepth, locator, loaded) {
  for (const childTool of childTools(parent)) {
    if (ancestors.has(childTool.sessionId)) {
      appendDiagnostic(parent, `Child session cycle detected for tool call ${childTool.callId}`);
      continue;
    }
    if (depth >= maxDepth) {
      appendDiagnostic(
        parent,
        `Child session depth limit (${maxDepth}) reached for tool call ${childTool.callId}`
      );
      continue;
    }
    const cached = loaded.get(childTool.sessionId);
    if (cached) {
      attachChild(parent, childTool.parentTurnId, childTool.callId, cached);
      continue;
    }
    const existing = parent.subagents.find(
      (subagent) => subagent.parentCallId === childTool.callId && subagent.parentTurnId === childTool.parentTurnId && subagent.session.id === childTool.sessionId
    );
    if (existing) {
      loaded.set(childTool.sessionId, existing.session);
      const nextAncestors2 = new Set(ancestors).add(childTool.sessionId);
      await loadChildren(existing.session, depth + 1, nextAncestors2, maxDepth, locator, loaded);
      continue;
    }
    const located = await locator.locate(childTool.sessionId);
    const child = await parseLocatedChild(located.paths, childTool, parent);
    if (!child) {
      appendLocateDiagnostic(parent, childTool.callId, located);
      continue;
    }
    if (located.paths.length > 1) {
      appendDiagnostic(
        parent,
        `Multiple child transcripts matched tool call ${childTool.callId}; one was used`
      );
    }
    loaded.set(childTool.sessionId, child);
    attachChild(parent, childTool.parentTurnId, childTool.callId, child);
    const nextAncestors = new Set(ancestors).add(childTool.sessionId);
    await loadChildren(child, depth + 1, nextAncestors, maxDepth, locator, loaded);
  }
}
async function parseLocatedChild(paths, childTool, parent) {
  for (const transcriptPath of paths) {
    let transcript;
    try {
      const details = await stat3(transcriptPath);
      if (!details.isFile() || details.size > MAX_CHILD_TRANSCRIPT_BYTES) continue;
      transcript = await readFile3(transcriptPath, "utf8");
      if (Buffer.byteLength(transcript, "utf8") > MAX_CHILD_TRANSCRIPT_BYTES) continue;
    } catch {
      continue;
    }
    try {
      const hook = deriveStopHook(transcript, transcriptPath, childTool.sessionId, parent);
      const child = parseRolloutTranscript(transcript, hook);
      if (child.id === childTool.sessionId) {
        return child;
      }
    } catch {
      continue;
    }
  }
  return void 0;
}
function deriveStopHook(transcript, transcriptPath, sessionId, parent) {
  const records = parseRolloutJsonl(transcript).records;
  const metadata = records.find(
    (record) => record.type === "session_meta" && recordSessionId(record) === sessionId
  )?.payload ?? records.find((record) => record.type === "session_meta")?.payload;
  const turnId = lastTurnId(records) ?? `synthetic-stop-${sessionId}`;
  const model = lastModelForTurn(records, turnId) ?? parent.turns.at(-1)?.model ?? "unknown";
  return {
    session_id: sessionId,
    turn_id: turnId,
    transcript_path: transcriptPath,
    cwd: nonEmptyString(metadata?.cwd) ?? parent.cwd ?? dirname2(transcriptPath),
    hook_event_name: "Stop",
    model,
    last_assistant_message: lastAssistantMessage(records, turnId)
  };
}
function lastTurnId(records) {
  let turnId;
  for (const record of records) {
    const explicit = nonEmptyString(record.payload.turn_id);
    if (explicit) {
      turnId = explicit;
      continue;
    }
    if (START_EVENTS2.has(eventType(record))) {
      turnId = nonEmptyString(record.payload.id) ?? turnId;
    }
  }
  return turnId;
}
function lastModelForTurn(records, turnId) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record) {
      continue;
    }
    const recordTurnId = nonEmptyString(record.payload.turn_id) ?? (START_EVENTS2.has(eventType(record)) ? nonEmptyString(record.payload.id) : void 0);
    const model = nonEmptyString(record.payload.model);
    if (model && recordTurnId === turnId) {
      return model;
    }
  }
  return void 0;
}
function lastAssistantMessage(records, turnId) {
  let activeTurnId;
  let message = null;
  for (const record of records) {
    const type = eventType(record);
    const explicitTurnId = nonEmptyString(record.payload.turn_id);
    if (explicitTurnId) {
      activeTurnId = explicitTurnId;
    } else if (START_EVENTS2.has(type)) {
      activeTurnId = nonEmptyString(record.payload.id) ?? activeTurnId;
    }
    if (activeTurnId !== turnId) {
      continue;
    }
    if (type === "agent_message") {
      message = extractText2(record.payload.message) || message;
    } else if (type === "task_complete" || type === "turn_complete") {
      message = nonEmptyString(record.payload.last_agent_message) ?? message;
    } else if (record.type === "response_item" && record.payload.type === "message" && record.payload.role === "assistant") {
      message = extractText2(record.payload.content) || message;
    }
  }
  return message;
}
function childTools(session) {
  const tools = /* @__PURE__ */ new Map();
  for (const turn of session.turns) {
    for (const tool of turn.tools) {
      addChildTool(tools, turn.id, tool);
    }
  }
  return [...tools.values()];
}
function addChildTool(tools, parentTurnId, tool) {
  const key = `${parentTurnId}\0${tool.callId}`;
  if (!tool.childSessionId || tools.has(key)) {
    return;
  }
  tools.set(key, { callId: tool.callId, parentTurnId, sessionId: tool.childSessionId });
}
function attachChild(parent, parentTurnId, parentCallId, child) {
  const subagent = { parentCallId, parentTurnId, session: child };
  const existingIndex = parent.subagents.findIndex(
    (candidate) => candidate.parentCallId === parentCallId && candidate.parentTurnId === parentTurnId
  );
  if (existingIndex === -1) {
    parent.subagents.push(subagent);
  } else {
    parent.subagents[existingIndex] = subagent;
  }
}
function appendLocateDiagnostic(session, callId, located) {
  if (located.fileLimitReached) {
    appendDiagnostic(session, `Child transcript scan file limit reached for tool call ${callId}`);
  } else if (located.scanDepthLimitReached) {
    appendDiagnostic(session, `Child transcript scan depth limit reached for tool call ${callId}`);
  } else if (located.scanFailed) {
    appendDiagnostic(session, `Child transcript scan failed for tool call ${callId}`);
  } else if (located.paths.length > 0) {
    appendDiagnostic(session, `Child transcript could not be parsed for tool call ${callId}`);
  } else {
    appendDiagnostic(session, `Child transcript was not found for tool call ${callId}`);
  }
}
function appendDiagnostic(session, diagnostic) {
  if (!session.diagnostics.includes(diagnostic)) {
    session.diagnostics.push(diagnostic);
  }
}
function nearestSessionsRoot(transcriptPath) {
  let current = resolve3(dirname2(transcriptPath));
  const filesystemRoot = parse2(current).root;
  while (true) {
    if (basename(current) === "sessions") {
      return current;
    }
    if (current === filesystemRoot) {
      return void 0;
    }
    current = dirname2(current);
  }
}
function filenameMatchesSession(filename, sessionId) {
  if (!filename.startsWith("rollout-") || !filename.endsWith(".jsonl")) {
    return false;
  }
  const stem = filename.slice(0, -".jsonl".length);
  return stem === sessionId || stem.endsWith(`-${sessionId}`);
}
function eventType(record) {
  return record.type === "event_msg" ? nonEmptyString(record.payload.type) ?? "" : record.type;
}
function recordSessionId(record) {
  return nonEmptyString(record.payload.id) ?? nonEmptyString(record.payload.session_id);
}
function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function extractText2(value, depth = 0) {
  if (depth > 32) return "";
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => extractText2(item, depth + 1)).filter(Boolean).join("\n");
  }
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const record = value;
  for (const key of ["text", "content", "message"]) {
    const text = extractText2(record[key], depth + 1);
    if (text) {
      return text;
    }
  }
  return "";
}
function boundedInteger(value, fallback) {
  return value === void 0 || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
}
function pathIsWithin(root, candidate) {
  const path = relative(resolve3(root), resolve3(candidate));
  return path === "" || !isAbsolute2(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

// plugins/openobserve/src/index.ts
var MAX_HOOK_INPUT_BYTES = 1048576;
var MAX_TRANSCRIPT_BYTES = 64 * 1048576;
var HookRunError = class extends Error {
  constructor(message, strict, options) {
    super(message, options);
    this.strict = strict;
    this.name = "HookRunError";
  }
};
async function runHook(input, options = {}) {
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
        console.error(`[openobserve-codex] ${redactAndTruncate(diagnostic, 1024)}`);
      }
    }
    const exported = await exportTurnOnce(config, session, turn, {
      fetch: options.fetch
    });
    if (exported.error) {
      throw new Error(exported.error);
    }
    return {
      status: exported.deduplicated ? "deduplicated" : "exported",
      export: exported,
      diagnostics: session.diagnostics
    };
  } catch (error) {
    if (error instanceof HookRunError) throw error;
    const message = error instanceof Error ? error.message : "unknown hook failure";
    throw new HookRunError(message, strict, { cause: error });
  }
}
function parseStopHookInput(input) {
  if (Buffer.byteLength(input, "utf8") > MAX_HOOK_INPUT_BYTES) {
    throw new Error("Stop hook input exceeds the supported size");
  }
  let value;
  try {
    value = JSON.parse(input);
  } catch (error) {
    throw new Error("Stop hook input is not valid JSON", { cause: error });
  }
  if (!isRecord3(value)) {
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
  const lastAssistantMessage2 = nullableString(value, "last_assistant_message");
  return {
    session_id: sessionId,
    turn_id: turnId,
    cwd,
    model,
    transcript_path: transcriptPath,
    hook_event_name: "Stop",
    last_assistant_message: lastAssistantMessage2,
    ...typeof value.permission_mode === "string" ? { permission_mode: value.permission_mode } : {},
    ...typeof value.stop_hook_active === "boolean" ? { stop_hook_active: value.stop_hook_active } : {}
  };
}
async function main() {
  try {
    await runHook(await readStdin());
  } catch (error) {
    const hookError = error instanceof HookRunError ? error : new HookRunError(error instanceof Error ? error.message : "unknown hook failure", false);
    console.error(`[openobserve-codex] ${hookError.message}`);
    if (hookError.strict) process.exitCode = 1;
  }
}
async function readStdin() {
  const chunks = [];
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
function requiredString(value, key) {
  const field = value[key];
  if (typeof field !== "string" || field.trim() === "") {
    throw new Error(`${key} must be a non-empty string`);
  }
  return field;
}
function nullableString(value, key) {
  const field = value[key];
  if (field === null || field === void 0) return null;
  if (typeof field !== "string") throw new Error(`${key} must be a string or null`);
  return field;
}
function parseEnvironmentBoolean(value) {
  if (!value) return false;
  return ["true", "1"].includes(value.trim().toLowerCase());
}
function safeIdentifier(value) {
  return value.replace(/[^A-Za-z0-9._:-]/g, "?").slice(0, 128);
}
async function readTrustedTranscript(transcriptPath, env) {
  if (!isAbsolute3(transcriptPath)) {
    throw new Error("Stop-hook transcript path must be absolute");
  }
  const codexHome = resolve4(env.CODEX_HOME ?? join3(homedir2(), ".codex"));
  const sessionsRoot = await realpath(join3(codexHome, "sessions"));
  const canonicalPath = await realpath(transcriptPath);
  const pathWithinSessions = relative2(sessionsRoot, canonicalPath);
  if (pathWithinSessions === ".." || pathWithinSessions.startsWith(`..${sep2}`) || isAbsolute3(pathWithinSessions)) {
    throw new Error("Stop-hook transcript path must be inside the Codex sessions directory");
  }
  const details = await stat4(canonicalPath);
  if (!details.isFile()) {
    throw new Error("Stop-hook transcript path must identify a regular file");
  }
  if (details.size > MAX_TRANSCRIPT_BYTES) {
    throw new Error(`Stop-hook transcript exceeds ${MAX_TRANSCRIPT_BYTES} bytes`);
  }
  const contents = await readFile4(canonicalPath, "utf8");
  if (Buffer.byteLength(contents, "utf8") > MAX_TRANSCRIPT_BYTES) {
    throw new Error(`Stop-hook transcript exceeds ${MAX_TRANSCRIPT_BYTES} bytes`);
  }
  return { path: canonicalPath, contents };
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var invokedPath = process.argv[1] ? resolve4(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  await main();
}
export {
  HookRunError,
  parseStopHookInput,
  runHook
};
