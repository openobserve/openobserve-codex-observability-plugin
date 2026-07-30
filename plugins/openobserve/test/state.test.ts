import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExportStateStore, StateError, transcriptTurnKey } from "../src/state.ts";

const TRACE_ONE = "1".repeat(32);
const TRACE_TWO = "2".repeat(32);

describe("export state", () => {
  let root: string;
  let stateDirectory: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "openobserve-codex-state-"));
    stateDirectory = join(root, "plugin-state");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keys entries by session, turn, and revision", () => {
    expect(transcriptTurnKey("session-1", "turn-1", "revision-1")).toHaveLength(64);
    expect(transcriptTurnKey("session-1", "turn-1", "revision-1")).not.toBe(
      transcriptTurnKey("session-1", "turn-2", "revision-1"),
    );
    expect(transcriptTurnKey("session-1", "turn-1", "revision-1")).not.toBe(
      transcriptTurnKey("session-2", "turn-1", "revision-1"),
    );
    expect(transcriptTurnKey("session-1", "turn-1", "revision-1")).not.toBe(
      transcriptTurnKey("session-1", "turn-1", "revision-2"),
    );
  });

  it("writes state atomically and preserves existing entries", async () => {
    const now = vi.fn().mockReturnValueOnce(1_700_000_000_000).mockReturnValue(1_700_000_001_000);
    const store = new ExportStateStore(stateDirectory, { now });

    await store.markTurnExported("/tmp/first.jsonl", "turn-1", TRACE_ONE);
    await store.markTurnExported("/tmp/second.jsonl", "turn-2", TRACE_TWO);

    expect(await store.hasTurn("/tmp/first.jsonl", "turn-1")).toBe(true);
    expect(await store.hasTurn("/tmp/second.jsonl", "turn-2")).toBe(true);
    expect(Object.keys((await store.load()).exportedTurns)).toHaveLength(2);
    expect(await readdir(stateDirectory)).toEqual(["export-state.json"]);
  });

  it("marks only after a successful operation", async () => {
    const store = new ExportStateStore(stateDirectory);
    await expect(
      store.runTurnOnce("session-1", "turn-1", "revision-1", async () => {
        throw new Error("request failed");
      }),
    ).rejects.toThrow("request failed");
    expect(await store.hasTurn("session-1", "turn-1", "revision-1")).toBe(false);

    const result = await store.runTurnOnce(
      "session-1",
      "turn-1",
      "revision-1",
      async () => TRACE_ONE,
    );
    expect(result.exported).toBe(true);
    expect(await store.hasTurn("session-1", "turn-1", "revision-1")).toBe(true);
  });

  it("serializes concurrent attempts so an export runs once", async () => {
    const firstStore = new ExportStateStore(stateDirectory);
    const secondStore = new ExportStateStore(stateDirectory);
    const operation = vi.fn(async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      return TRACE_ONE;
    });

    const results = await Promise.all([
      firstStore.runTurnOnce("session-1", "turn-1", "revision-1", operation),
      secondStore.runTurnOnce("session-1", "turn-1", "revision-1", operation),
    ]);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.exported).sort()).toEqual([false, true]);
  });

  it("does not overwrite malformed or unsupported state", async () => {
    await mkdir(stateDirectory);
    await writeFile(join(stateDirectory, "export-state.json"), '{"version":2}', "utf8");
    const store = new ExportStateStore(stateDirectory);

    await expect(store.load()).rejects.toBeInstanceOf(StateError);
    await expect(
      store.markTurnExported("/tmp/session.jsonl", "turn-1", TRACE_ONE),
    ).rejects.toBeInstanceOf(StateError);
  });

  it("rejects invalid identities and trace IDs", async () => {
    const store = new ExportStateStore(stateDirectory);
    expect(() => transcriptTurnKey("", "turn-1")).toThrow("session ID");
    expect(() => transcriptTurnKey("session-1", "")).toThrow("turn ID");
    await expect(
      store.markTurnExported("/tmp/session.jsonl", "turn-1", "not-a-trace"),
    ).rejects.toThrow("trace ID");
  });
});
