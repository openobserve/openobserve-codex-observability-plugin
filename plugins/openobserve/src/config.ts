import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

import type { OpenObserveConfig } from "./types.ts";

const DEFAULT_ENDPOINT = "http://localhost:5080";
const DEFAULT_MAX_CHARS = 32_768;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_INTEGER_SETTING = 1_000_000;
const MAX_TIMEOUT_MS = 15_000;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const RESERVED_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "host",
  "organization",
  "stream-name",
  "transfer-encoding",
]);

type ConfigLayer = Partial<Omit<OpenObserveConfig, "authorization" | "headers">> & {
  authorization?: string | null;
  headers?: Record<string, string>;
};

export interface LoadConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

export function defaultConfig(
  codexHome = join(homedir(), ".codex"),
  pluginData?: string,
): OpenObserveConfig {
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
    stateDirectory: pluginData || join(codexHome, "openobserve"),
  };
}

export function normalizeOtlpEndpoint(endpoint: string, organization: string): string {
  let url: URL;
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

export const normalizeEndpoint = normalizeOtlpEndpoint;

export async function loadConfig(options: LoadConfigOptions = {}): Promise<OpenObserveConfig> {
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

export async function loadTrustedFailOnError(options: LoadConfigOptions = {}): Promise<boolean> {
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

async function readConfigFile(path: string): Promise<Record<string, unknown> | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw new ConfigError(`unable to read configuration file ${path}`, { cause: error });
  }

  let value: unknown;
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

function parseFileLayer(value: Record<string, unknown>, source: string): ConfigLayer {
  const normalized = normalizeFileKeys(value, source);
  const layer: ConfigLayer = {};
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

function normalizeFileKeys(
  value: Record<string, unknown>,
  source: string,
): Record<string, unknown> {
  const aliases: Record<string, string> = {
    stream_name: "streamName",
    capture_content: "captureContent",
    capture_reasoning: "captureReasoning",
    capture_tool_content: "captureToolContent",
    max_chars: "maxChars",
    service_name: "serviceName",
    timeout_ms: "timeoutMs",
    fail_on_error: "failOnError",
    state_directory: "stateDirectory",
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

async function findProjectConfig(cwd: string): Promise<string | undefined> {
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
          cause: error,
        });
      }
    }
    if (current === root) return undefined;
    current = dirname(current);
  }
}

function parseEnvironment(env: NodeJS.ProcessEnv): ConfigLayer {
  const layer: ConfigLayer = {};
  readEnvBoolean(env, layer, "OPENOBSERVE_CODEX_ENABLED", "enabled");
  readEnvString(env, layer, "OPENOBSERVE_CODEX_ENDPOINT", "endpoint");
  readEnvString(env, layer, "OPENOBSERVE_CODEX_ORGANIZATION", "organization");
  readEnvString(env, layer, "OPENOBSERVE_CODEX_STREAM_NAME", "streamName");
  if (env.OPENOBSERVE_CODEX_AUTHORIZATION !== undefined) {
    layer.authorization = env.OPENOBSERVE_CODEX_AUTHORIZATION || null;
  }
  if (env.OPENOBSERVE_CODEX_HEADERS !== undefined) {
    let headers: unknown;
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

function applyLayer(config: OpenObserveConfig, layer: ConfigLayer): OpenObserveConfig {
  const { authorization, headers, ...values } = layer;
  const next: OpenObserveConfig = {
    ...config,
    ...values,
    headers: mergeHeaders(config.headers, headers),
  };
  if (authorization === null) {
    delete next.authorization;
  } else if (authorization !== undefined) {
    next.authorization = authorization;
  }
  return next;
}

function applyProjectLayer(
  config: OpenObserveConfig,
  layer: ConfigLayer,
  source: string,
): OpenObserveConfig {
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
    "stateDirectory",
  ] as const) {
    if (layer[key] !== undefined) {
      throw new ConfigError(`${source}: project configuration cannot set ${key}`);
    }
  }
  for (const key of [
    "enabled",
    "captureContent",
    "captureReasoning",
    "captureToolContent",
  ] as const) {
    if (layer[key] === true && config[key] === false) {
      throw new ConfigError(`${source}: project configuration cannot enable ${key}`);
    }
  }
  if (layer.maxChars !== undefined && layer.maxChars > config.maxChars) {
    throw new ConfigError(`${source}: project configuration cannot increase maxChars`);
  }
  return applyLayer(config, layer);
}

function mergeHeaders(
  current: Record<string, string>,
  overrides: Record<string, string> | undefined,
): Record<string, string> {
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

function validateConfig(config: OpenObserveConfig): void {
  assertNonEmpty(config.endpoint, "endpoint");
  assertHeaderValue(config.organization, "organization");
  assertHeaderValue(config.streamName, "streamName");
  assertHeaderValue(config.environment, "environment");
  assertHeaderValue(config.serviceName, "serviceName");
  assertNonEmpty(config.stateDirectory, "stateDirectory");
  assertPositiveInteger(config.maxChars, "maxChars");
  assertPositiveInteger(config.timeoutMs, "timeoutMs", MAX_TIMEOUT_MS);
  if (config.authorization !== undefined) {
    assertHeaderValue(config.authorization, "authorization");
  }
  parseHeaders(config.headers, "headers");
}

function readFileBoolean<K extends keyof ConfigLayer>(
  source: Record<string, unknown>,
  target: ConfigLayer,
  key: K,
  sourceName: string,
): void {
  if (!Object.hasOwn(source, key)) return;
  if (typeof source[key as string] !== "boolean") {
    throw new ConfigError(`${sourceName}: ${String(key)} must be a boolean`);
  }
  Object.assign(target, { [key]: source[key as string] });
}

function readFileInteger<K extends keyof ConfigLayer>(
  source: Record<string, unknown>,
  target: ConfigLayer,
  key: K,
  sourceName: string,
): void {
  if (!Object.hasOwn(source, key)) return;
  const value = source[key as string];
  if (typeof value !== "number") {
    throw new ConfigError(`${sourceName}: ${String(key)} must be an integer`);
  }
  assertPositiveInteger(value, `${sourceName}: ${String(key)}`);
  Object.assign(target, { [key]: value });
}

function readFileString<K extends keyof ConfigLayer>(
  source: Record<string, unknown>,
  target: ConfigLayer,
  key: K,
  sourceName: string,
): void {
  if (!Object.hasOwn(source, key)) return;
  const value = source[key as string];
  if (typeof value !== "string") {
    throw new ConfigError(`${sourceName}: ${String(key)} must be a string`);
  }
  Object.assign(target, { [key]: value });
}

function readFileAuthorization(
  source: Record<string, unknown>,
  target: ConfigLayer,
  sourceName: string,
): void {
  if (!Object.hasOwn(source, "authorization")) return;
  const value = source.authorization;
  if (value !== null && typeof value !== "string") {
    throw new ConfigError(`${sourceName}: authorization must be a string or null`);
  }
  target.authorization = value || null;
}

function readFileHeaders(
  source: Record<string, unknown>,
  target: ConfigLayer,
  sourceName: string,
): void {
  if (!Object.hasOwn(source, "headers")) return;
  target.headers = parseHeaders(source.headers, `${sourceName}: headers`);
}

function readEnvBoolean<K extends keyof ConfigLayer>(
  env: NodeJS.ProcessEnv,
  target: ConfigLayer,
  envName: string,
  key: K,
): void {
  const raw = env[envName];
  if (raw === undefined) return;
  const normalized = raw.trim().toLowerCase();
  if (normalized !== "true" && normalized !== "false" && normalized !== "1" && normalized !== "0") {
    throw new ConfigError(`${envName} must be true, false, 1, or 0`);
  }
  Object.assign(target, { [key]: normalized === "true" || normalized === "1" });
}

function readEnvInteger<K extends keyof ConfigLayer>(
  env: NodeJS.ProcessEnv,
  target: ConfigLayer,
  envName: string,
  key: K,
): void {
  const raw = env[envName];
  if (raw === undefined) return;
  if (!/^\d+$/.test(raw.trim())) {
    throw new ConfigError(`${envName} must be a positive integer`);
  }
  const value = Number(raw);
  assertPositiveInteger(value, envName);
  Object.assign(target, { [key]: value });
}

function readEnvString<K extends keyof ConfigLayer>(
  env: NodeJS.ProcessEnv,
  target: ConfigLayer,
  envName: string,
  key: K,
): void {
  const value = env[envName];
  if (value === undefined) return;
  Object.assign(target, { [key]: value });
}

function parseHeaders(value: unknown, source: string): Record<string, string> {
  if (!isPlainObject(value)) {
    throw new ConfigError(`${source} must be an object with string values`);
  }
  const headers: Record<string, string> = {};
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

function assertPositiveInteger(value: number, name: string, maximum = MAX_INTEGER_SETTING): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new ConfigError(`${name} must be a positive integer no greater than ${maximum}`);
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (value.trim() === "") {
    throw new ConfigError(`${name} must not be empty`);
  }
}

function assertHeaderValue(value: string, name: string): void {
  assertNonEmpty(value, name);
  if (/[\r\n]/.test(value)) {
    throw new ConfigError(`${name} must be a single-line string`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function assertPrivateConfigFile(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new ConfigError(
      `${path} contains credentials or custom headers and must not be accessible by group or other users`,
    );
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
