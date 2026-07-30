import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { parseRolloutJsonl, parseRolloutTranscript } from "./parser.ts";
import type {
  NormalizedSession,
  NormalizedSubagent,
  NormalizedToolCall,
  RolloutRecord,
  StopHookInput,
} from "./types.ts";

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_FILES = 2_048;
const DEFAULT_MAX_SCAN_DEPTH = 8;
const MAX_CHILD_TRANSCRIPT_BYTES = 64 * 1_048_576;
const START_EVENTS = new Set(["task_started", "turn_started"]);

export interface DiscoverSubagentsOptions {
  sessionsRoot?: string;
  maxDepth?: number;
  maxFiles?: number;
  maxScanDepth?: number;
}

interface ChildTool {
  callId: string;
  parentTurnId: string;
  sessionId: string;
}

interface LocateResult {
  paths: string[];
  fileLimitReached: boolean;
  scanDepthLimitReached: boolean;
  scanFailed: boolean;
}

class TranscriptLocator {
  private readonly transcriptPaths: string[] = [];
  private scanPromise?: Promise<void>;
  private filesSeen = 0;
  private fileLimitReached = false;
  private scanDepthLimitReached = false;
  private scanFailed = false;
  private readonly visitedDirectories = new Set<string>();

  constructor(
    private readonly sessionsRoot: string,
    private readonly maxFiles: number,
    private readonly maxScanDepth: number,
    private readonly preferredDirectory?: string,
  ) {}

  async locate(sessionId: string): Promise<LocateResult> {
    this.scanPromise ??= this.scan();
    await this.scanPromise;

    return {
      paths: this.transcriptPaths.filter((path) =>
        filenameMatchesSession(basename(path), sessionId),
      ),
      fileLimitReached: this.fileLimitReached,
      scanDepthLimitReached: this.scanDepthLimitReached,
      scanFailed: this.scanFailed,
    };
  }

  private async scan(): Promise<void> {
    if (this.preferredDirectory && pathIsWithin(this.sessionsRoot, this.preferredDirectory)) {
      await this.scanDirectory(this.preferredDirectory, 0);
    }
    await this.scanDirectory(this.sessionsRoot, 0);
  }

  private async scanDirectory(directory: string, depth: number): Promise<boolean> {
    const canonicalDirectory = resolve(directory);
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
        if (!(await this.scanDirectory(join(directory, entry.name), depth + 1))) {
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
        this.transcriptPaths.push(join(directory, entry.name));
      }
    }
    return true;
  }
}

export async function discoverSubagents(
  session: NormalizedSession,
  parentTranscriptPath: string,
  options: DiscoverSubagentsOptions = {},
): Promise<NormalizedSession> {
  if (childTools(session).length === 0) {
    return session;
  }

  const sessionsRoot = options.sessionsRoot
    ? resolve(options.sessionsRoot)
    : nearestSessionsRoot(parentTranscriptPath);
  if (!sessionsRoot) {
    appendDiagnostic(session, "Child transcript discovery could not locate a Codex sessions root");
    return session;
  }

  const maxDepth = boundedInteger(options.maxDepth, DEFAULT_MAX_DEPTH);
  const locator = new TranscriptLocator(
    sessionsRoot,
    boundedInteger(options.maxFiles, DEFAULT_MAX_FILES),
    boundedInteger(options.maxScanDepth, DEFAULT_MAX_SCAN_DEPTH),
    dirname(resolve(parentTranscriptPath)),
  );
  const loaded = new Map<string, NormalizedSession>([[session.id, session]]);

  await loadChildren(session, 0, new Set([session.id]), maxDepth, locator, loaded);
  return session;
}

async function loadChildren(
  parent: NormalizedSession,
  depth: number,
  ancestors: Set<string>,
  maxDepth: number,
  locator: TranscriptLocator,
  loaded: Map<string, NormalizedSession>,
): Promise<void> {
  for (const childTool of childTools(parent)) {
    if (ancestors.has(childTool.sessionId)) {
      appendDiagnostic(parent, `Child session cycle detected for tool call ${childTool.callId}`);
      continue;
    }
    if (depth >= maxDepth) {
      appendDiagnostic(
        parent,
        `Child session depth limit (${maxDepth}) reached for tool call ${childTool.callId}`,
      );
      continue;
    }

    const cached = loaded.get(childTool.sessionId);
    if (cached) {
      attachChild(parent, childTool.parentTurnId, childTool.callId, cached);
      continue;
    }

    const existing = parent.subagents.find(
      (subagent) =>
        subagent.parentCallId === childTool.callId &&
        subagent.parentTurnId === childTool.parentTurnId &&
        subagent.session.id === childTool.sessionId,
    );
    if (existing) {
      loaded.set(childTool.sessionId, existing.session);
      const nextAncestors = new Set(ancestors).add(childTool.sessionId);
      await loadChildren(existing.session, depth + 1, nextAncestors, maxDepth, locator, loaded);
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
        `Multiple child transcripts matched tool call ${childTool.callId}; one was used`,
      );
    }
    loaded.set(childTool.sessionId, child);
    attachChild(parent, childTool.parentTurnId, childTool.callId, child);

    const nextAncestors = new Set(ancestors).add(childTool.sessionId);
    await loadChildren(child, depth + 1, nextAncestors, maxDepth, locator, loaded);
  }
}

async function parseLocatedChild(
  paths: string[],
  childTool: ChildTool,
  parent: NormalizedSession,
): Promise<NormalizedSession | undefined> {
  for (const transcriptPath of paths) {
    let transcript: string;
    try {
      const details = await stat(transcriptPath);
      if (!details.isFile() || details.size > MAX_CHILD_TRANSCRIPT_BYTES) continue;
      transcript = await readFile(transcriptPath, "utf8");
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
  return undefined;
}

function deriveStopHook(
  transcript: string,
  transcriptPath: string,
  sessionId: string,
  parent: NormalizedSession,
): StopHookInput {
  const records = parseRolloutJsonl(transcript).records;
  const metadata =
    records.find(
      (record) => record.type === "session_meta" && recordSessionId(record) === sessionId,
    )?.payload ?? records.find((record) => record.type === "session_meta")?.payload;
  const turnId = lastTurnId(records) ?? `synthetic-stop-${sessionId}`;
  const model = lastModelForTurn(records, turnId) ?? parent.turns.at(-1)?.model ?? "unknown";

  return {
    session_id: sessionId,
    turn_id: turnId,
    transcript_path: transcriptPath,
    cwd: nonEmptyString(metadata?.cwd) ?? parent.cwd ?? dirname(transcriptPath),
    hook_event_name: "Stop",
    model,
    last_assistant_message: lastAssistantMessage(records, turnId),
  };
}

function lastTurnId(records: RolloutRecord[]): string | undefined {
  let turnId: string | undefined;
  for (const record of records) {
    const explicit = nonEmptyString(record.payload.turn_id);
    if (explicit) {
      turnId = explicit;
      continue;
    }
    if (START_EVENTS.has(eventType(record))) {
      turnId = nonEmptyString(record.payload.id) ?? turnId;
    }
  }
  return turnId;
}

function lastModelForTurn(records: RolloutRecord[], turnId: string): string | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record) {
      continue;
    }
    const recordTurnId =
      nonEmptyString(record.payload.turn_id) ??
      (START_EVENTS.has(eventType(record)) ? nonEmptyString(record.payload.id) : undefined);
    const model = nonEmptyString(record.payload.model);
    if (model && recordTurnId === turnId) {
      return model;
    }
  }
  return undefined;
}

function lastAssistantMessage(records: RolloutRecord[], turnId: string): string | null {
  let activeTurnId: string | undefined;
  let message: string | null = null;

  for (const record of records) {
    const type = eventType(record);
    const explicitTurnId = nonEmptyString(record.payload.turn_id);
    if (explicitTurnId) {
      activeTurnId = explicitTurnId;
    } else if (START_EVENTS.has(type)) {
      activeTurnId = nonEmptyString(record.payload.id) ?? activeTurnId;
    }
    if (activeTurnId !== turnId) {
      continue;
    }

    if (type === "agent_message") {
      message = extractText(record.payload.message) || message;
    } else if (type === "task_complete" || type === "turn_complete") {
      message = nonEmptyString(record.payload.last_agent_message) ?? message;
    } else if (
      record.type === "response_item" &&
      record.payload.type === "message" &&
      record.payload.role === "assistant"
    ) {
      message = extractText(record.payload.content) || message;
    }
  }
  return message;
}

function childTools(session: NormalizedSession): ChildTool[] {
  const tools = new Map<string, ChildTool>();
  for (const turn of session.turns) {
    for (const tool of turn.tools) {
      addChildTool(tools, turn.id, tool);
    }
  }
  return [...tools.values()];
}

function addChildTool(
  tools: Map<string, ChildTool>,
  parentTurnId: string,
  tool: NormalizedToolCall,
): void {
  const key = `${parentTurnId}\0${tool.callId}`;
  if (!tool.childSessionId || tools.has(key)) {
    return;
  }
  tools.set(key, { callId: tool.callId, parentTurnId, sessionId: tool.childSessionId });
}

function attachChild(
  parent: NormalizedSession,
  parentTurnId: string,
  parentCallId: string,
  child: NormalizedSession,
): void {
  const subagent: NormalizedSubagent = { parentCallId, parentTurnId, session: child };
  const existingIndex = parent.subagents.findIndex(
    (candidate) =>
      candidate.parentCallId === parentCallId && candidate.parentTurnId === parentTurnId,
  );
  if (existingIndex === -1) {
    parent.subagents.push(subagent);
  } else {
    parent.subagents[existingIndex] = subagent;
  }
}

function appendLocateDiagnostic(
  session: NormalizedSession,
  callId: string,
  located: LocateResult,
): void {
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

function appendDiagnostic(session: NormalizedSession, diagnostic: string): void {
  if (!session.diagnostics.includes(diagnostic)) {
    session.diagnostics.push(diagnostic);
  }
}

function nearestSessionsRoot(transcriptPath: string): string | undefined {
  let current = resolve(dirname(transcriptPath));
  const filesystemRoot = parse(current).root;
  while (true) {
    if (basename(current) === "sessions") {
      return current;
    }
    if (current === filesystemRoot) {
      return undefined;
    }
    current = dirname(current);
  }
}

function filenameMatchesSession(filename: string, sessionId: string): boolean {
  if (!filename.startsWith("rollout-") || !filename.endsWith(".jsonl")) {
    return false;
  }
  const stem = filename.slice(0, -".jsonl".length);
  return stem === sessionId || stem.endsWith(`-${sessionId}`);
}

function eventType(record: RolloutRecord): string {
  return record.type === "event_msg" ? (nonEmptyString(record.payload.type) ?? "") : record.type;
}

function recordSessionId(record: RolloutRecord): string | undefined {
  return nonEmptyString(record.payload.id) ?? nonEmptyString(record.payload.session_id);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractText(value: unknown, depth = 0): string {
  if (depth > 32) return "";
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => extractText(item, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const record = value as Record<string, unknown>;
  for (const key of ["text", "content", "message"]) {
    const text = extractText(record[key], depth + 1);
    if (text) {
      return text;
    }
  }
  return "";
}

function boundedInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
}

function pathIsWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}
