import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ExportState } from "./types.ts";

const STATE_FILE_NAME = "export-state.json";
const LOCK_DIRECTORY_NAME = ".export-state.lock";
const LOCK_OWNER_FILE_NAME = "owner";
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 300_000;
const LOCK_RETRY_MS = 20;
const MAX_STATE_BYTES = 8 * 1_048_576;
const MAX_STATE_ENTRIES = 10_000;
let temporaryFileSequence = 0;

export interface StateStoreOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
  now?: () => number;
}

export interface ExportedTurn {
  traceId: string;
  exportedAt: string;
}

export interface RunTurnOnceResult {
  exported: boolean;
  entry: ExportedTurn;
}

export class StateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StateError";
  }
}

export class ExportStateStore {
  readonly statePath: string;
  readonly lockPath: string;

  private readonly stateDirectory: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly now: () => number;
  private readonly lockOwner = `${process.pid}:${randomUUID()}`;

  constructor(stateDirectory: string, options: StateStoreOptions = {}) {
    this.stateDirectory = resolve(stateDirectory);
    this.statePath = resolve(this.stateDirectory, STATE_FILE_NAME);
    this.lockPath = resolve(this.stateDirectory, LOCK_DIRECTORY_NAME);
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.now = options.now ?? Date.now;
  }

  async load(): Promise<ExportState> {
    return readState(this.statePath);
  }

  async getTurn(
    sessionId: string,
    turnId: string,
    revision = "",
  ): Promise<ExportedTurn | undefined> {
    const state = await this.load();
    return state.exportedTurns[transcriptTurnKey(sessionId, turnId, revision)];
  }

  async hasTurn(sessionId: string, turnId: string, revision = ""): Promise<boolean> {
    return (await this.getTurn(sessionId, turnId, revision)) !== undefined;
  }

  async markTurnExported(
    sessionId: string,
    turnId: string,
    traceId: string,
    revision = "",
  ): Promise<ExportedTurn> {
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

  async runTurnOnce(
    sessionId: string,
    turnId: string,
    revision: string,
    exportOperation: () => Promise<string>,
  ): Promise<RunTurnOnceResult> {
    return this.withLock(async () => {
      const state = await readState(this.statePath);
      const key = transcriptTurnKey(sessionId, turnId, revision);
      const existing = state.exportedTurns[key];
      if (existing) return { exported: false, entry: existing };

      // The callback must complete before the durable marker is written.
      const traceId = await exportOperation();
      assertTraceId(traceId);
      const entry = { traceId, exportedAt: new Date(this.now()).toISOString() };
      state.exportedTurns[key] = entry;
      await writeStateAtomically(this.stateDirectory, this.statePath, state);
      return { exported: true, entry };
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(this.stateDirectory, 0o700);
    await this.acquireLock();
    try {
      return await operation();
    } finally {
      await this.releaseLock();
    }
  }

  private async acquireLock(): Promise<void> {
    const deadline = this.now() + this.lockTimeoutMs;
    while (true) {
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
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
        await writeFile(resolve(this.lockPath, LOCK_OWNER_FILE_NAME), this.lockOwner, {
          encoding: "utf8",
          mode: 0o600,
        });
        return;
      } catch (error) {
        await rm(this.lockPath, { recursive: true, force: true });
        throw new StateError(`unable to initialize state lock ${this.lockPath}`, { cause: error });
      }
    }
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const details = await stat(this.lockPath);
      if (this.now() - details.mtimeMs > this.staleLockMs) {
        await rm(this.lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }

  private async releaseLock(): Promise<void> {
    try {
      const owner = await readFile(resolve(this.lockPath, LOCK_OWNER_FILE_NAME), "utf8");
      if (owner === this.lockOwner) {
        await rm(this.lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }
}

export const StateStore = ExportStateStore;

export function transcriptTurnKey(sessionId: string, turnId: string, revision = ""): string {
  if (sessionId.trim() === "") throw new StateError("session ID must not be empty");
  if (turnId.trim() === "") throw new StateError("turn ID must not be empty");
  return createHash("sha256")
    .update(`session\0${sessionId}\0turn\0${turnId}\0revision\0${revision}`)
    .digest("hex");
}

export async function loadState(stateDirectory: string): Promise<ExportState> {
  return new ExportStateStore(stateDirectory).load();
}

export async function isTurnExported(
  stateDirectory: string,
  sessionId: string,
  turnId: string,
  revision = "",
): Promise<boolean> {
  return new ExportStateStore(stateDirectory).hasTurn(sessionId, turnId, revision);
}

export async function markTurnExported(
  stateDirectory: string,
  sessionId: string,
  turnId: string,
  traceId: string,
  revision = "",
): Promise<ExportedTurn> {
  return new ExportStateStore(stateDirectory).markTurnExported(
    sessionId,
    turnId,
    traceId,
    revision,
  );
}

async function readState(statePath: string): Promise<ExportState> {
  try {
    const details = await lstat(statePath);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new StateError(`export state ${statePath} must be a regular file`);
    }
    if (details.size > MAX_STATE_BYTES) {
      throw new StateError(`export state ${statePath} exceeds ${MAX_STATE_BYTES} bytes`);
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    return emptyState();
  }
  let contents: string;
  try {
    contents = await readFile(statePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return emptyState();
    throw new StateError(`unable to read export state ${statePath}`, { cause: error });
  }

  let value: unknown;
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

async function writeStateAtomically(
  stateDirectory: string,
  statePath: string,
  state: ExportState,
): Promise<void> {
  const orderedState: ExportState = {
    version: 1,
    exportedTurns: Object.fromEntries(
      Object.entries(state.exportedTurns)
        .sort(([, left], [, right]) => Date.parse(right.exportedAt) - Date.parse(left.exportedAt))
        .slice(0, MAX_STATE_ENTRIES)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  };
  temporaryFileSequence += 1;
  const temporaryPath = resolve(
    stateDirectory,
    `.${STATE_FILE_NAME}.${process.pid}.${temporaryFileSequence}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(orderedState, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, statePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw new StateError(`unable to update export state ${statePath}`, { cause: error });
  }
}

function emptyState(): ExportState {
  return { version: 1, exportedTurns: {} };
}

function isExportState(value: unknown): value is ExportState {
  if (!isObject(value) || value.version !== 1 || !isObject(value.exportedTurns)) return false;
  return Object.values(value.exportedTurns).every(
    (entry) =>
      isObject(entry) &&
      typeof entry.traceId === "string" &&
      /^[0-9a-f]{32}$/.test(entry.traceId) &&
      typeof entry.exportedAt === "string" &&
      Number.isFinite(Date.parse(entry.exportedAt)),
  );
}

function assertTraceId(traceId: string): void {
  if (!/^[0-9a-f]{32}$/.test(traceId) || /^0+$/.test(traceId)) {
    throw new StateError("trace ID must be 32 lowercase hexadecimal characters and non-zero");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
