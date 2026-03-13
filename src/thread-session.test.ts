import { describe, it, vi, afterEach } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { ThreadSession, type Pin } from "./thread-session.js";

// Minimal mock AgentSession
function makeMockAgentSession() {
  return {
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(() => {}),
    newSession: vi.fn(async () => true),
    isStreaming: false,
    messages: [],
    model: undefined,
    thinkingLevel: "off" as const,
    getContextUsage: vi.fn(() => undefined),
    compact: vi.fn(async () => ({ summary: "", firstKeptEntryId: "1", tokensBefore: 0 })),
  };
}

function makeMockUpdater() {
  return {
    begin: vi.fn(async () => ({
      channelId: "C1",
      threadTs: "ts1",
      currentMessageTs: "msg-1",
      rawMarkdown: "",
      toolLines: [],
      postedMessageTs: [],
      timer: null,
      retryCount: 0,
    })),
    appendText: vi.fn(() => {}),
    appendToolStart: vi.fn(() => {}),
    appendToolEnd: vi.fn(() => {}),
    finalize: vi.fn(async () => {}),
    error: vi.fn(async () => {}),
  };
}

function makeSession(agentSession = makeMockAgentSession(), updater = makeMockUpdater(), sessionPath = "/tmp/sessions/ts1.jsonl") {
  const client = { chat: { postMessage: vi.fn(async () => ({ ts: "1" })) } } as any;
  return {
    session: new ThreadSession("ts1", "C1", "/tmp", sessionPath, client, agentSession as any, {} as any, updater as any, { create: async () => null } as any),
    client,
    agentSession,
    updater,
  };
}

describe("ThreadSession queue", () => {
  it("serializes tasks — second starts after first resolves", async () => {
    const { session } = makeSession();
    const order: number[] = [];

    let resolveFirst!: () => void;
    const first = new Promise<void>((res) => { resolveFirst = res; });

    session.enqueue(async () => { await first; order.push(1); });
    session.enqueue(async () => { order.push(2); });

    // Give the drain loop a tick to start
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(order, []);

    resolveFirst();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(order, [1, 2]);
  });

  it("error in one task does not stop subsequent tasks", async () => {
    const { session } = makeSession();
    const order: number[] = [];

    session.enqueue(async () => { throw new Error("boom"); });
    session.enqueue(async () => { order.push(2); });

    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(order, [2]);
  });

  it("updates lastActivity on enqueue", async () => {
    const { session } = makeSession();
    const before = session.lastActivity;
    await new Promise((r) => setTimeout(r, 5));
    session.enqueue(async () => {});
    assert.ok(session.lastActivity >= before);
  });
});

describe("isRalphLoopStart regex", () => {
  const regex = /^\/(ralph)\s+(?!stop\b|status\b|list\b|help\b|pause\b|resume\b|steer\b|presets\b|history\b|loops\b)\S+/i;

  it("matches ralph loop start commands", () => {
    assert.ok(regex.test("/ralph feature build X"));
    assert.ok(regex.test("/ralph bugfix fix the thing"));
    assert.ok(regex.test("/ralph mypreset"));
  });

  it("does not match ralph subcommands", () => {
    for (const sub of ["stop", "status", "list", "help", "pause", "resume", "steer", "presets", "history", "loops"]) {
      assert.ok(!regex.test(`/ralph ${sub}`), `should not match /ralph ${sub}`);
      assert.ok(!regex.test(`/ralph ${sub} some args`), `should not match /ralph ${sub} some args`);
    }
  });

  it("is case-insensitive", () => {
    assert.ok(!regex.test("/ralph PAUSE"));
    assert.ok(!regex.test("/ralph Resume"));
    assert.ok(regex.test("/RALPH feature do stuff"));
  });

  it("does not match bare /ralph with no args", () => {
    assert.ok(!regex.test("/ralph"));
    assert.ok(!regex.test("/ralph "));
  });
});

describe("isRalphMsg notification detection regex", () => {
  // Must match the regex in thread-session.ts noopUiContext.notify
  const isRalphMsg = (msg: string) =>
    /Ralph loop|ralph loop|[Ll]oop (paused|resumed|auto-resumed|ended|is not paused|is already running)|[Aa]vailable presets:|Preset:|No active loop|No loop state|No (iteration history|past loops|presets found)|Steering queued|Unknown preset|has no hats/i.test(msg);

  it("detects loop lifecycle notifications", () => {
    assert.ok(isRalphMsg("Ralph loop ended: Task complete ✓ (5 iterations, 120s)"));
    assert.ok(isRalphMsg("Ralph loop [3/100]: 🏗 Builder → 🔍 Reviewer (event: build.done)"));
    assert.ok(isRalphMsg("A loop is already running. Use /ralph stop first."));
    assert.ok(isRalphMsg("A Ralph loop is running. Use /ralph stop first."));
  });

  it("detects pause/resume notifications", () => {
    assert.ok(isRalphMsg("⏸ Loop paused. The loop will not auto-continue after this turn. Use /ralph resume to continue or send any message."));
    assert.ok(isRalphMsg("▶ Loop resumed. Will continue after this turn completes."));
    assert.ok(isRalphMsg("▶ Loop auto-resumed after user message"));
    assert.ok(isRalphMsg("Loop is not paused"));
  });

  it("detects status and steering notifications", () => {
    assert.ok(isRalphMsg("Preset: feature\nHat: Builder\nIteration: 3/100\nElapsed: 45s"));
    assert.ok(isRalphMsg("Steering queued (2 pending). Will be injected into the next hat."));
  });

  it("detects error/empty-state notifications", () => {
    assert.ok(isRalphMsg("No active loop"));
    assert.ok(isRalphMsg("No active loop to steer"));
    assert.ok(isRalphMsg("No active loop to pause"));
    assert.ok(isRalphMsg("No active loop to resume"));
    assert.ok(isRalphMsg("No loop state available"));
    assert.ok(isRalphMsg("No iteration history yet"));
    assert.ok(isRalphMsg("No past loops found"));
    assert.ok(isRalphMsg("No presets found"));
    assert.ok(isRalphMsg("No presets found. Add .yml files to ~/.pi/agent/ralph/presets/"));
    assert.ok(isRalphMsg("Unknown preset: foobar"));
    assert.ok(isRalphMsg("Preset has no hats defined"));
  });

  it("detects preset list notifications", () => {
    assert.ok(isRalphMsg("Available presets:\n  feature — Feature development\n  bugfix — Bug fixing"));
  });

  it("does not match non-ralph notifications", () => {
    assert.ok(!isRalphMsg("Connected to https://example.com"));
    assert.ok(!isRalphMsg("Disconnected from Slack bot"));
    assert.ok(!isRalphMsg("Slack thread: https://slack.com/thread/123"));
    assert.ok(!isRalphMsg("Not attached"));
    assert.ok(!isRalphMsg("Already attached. Use /detach first."));
    assert.ok(!isRalphMsg("Some random notification"));
  });
});

describe("noopUiContext theme contract", () => {
  // The noop theme must implement all methods ralph calls on ctx.ui.theme.
  // This mirrors the shape defined in thread-session.ts noopUiContext.theme.
  const noopTheme = {
    fg: (_c: string, t: string) => t,
    bg: (_c: string, t: string) => t,
    bold: (t: string) => t,
    italic: (t: string) => t,
    underline: (t: string) => t,
    inverse: (t: string) => t,
    strikethrough: (t: string) => t,
  };

  it("has all text formatting methods ralph uses", () => {
    // ralph calls theme.bold(), theme.fg(), theme.bg() extensively
    for (const method of ["fg", "bg", "bold", "italic", "underline", "inverse", "strikethrough"]) {
      assert.equal(typeof (noopTheme as any)[method], "function", `theme.${method} must be a function`);
    }
  });

  it("all methods pass through text unchanged", () => {
    assert.equal(noopTheme.fg("accent", "hello"), "hello");
    assert.equal(noopTheme.bg("selectedBg", "hello"), "hello");
    assert.equal(noopTheme.bold("hello"), "hello");
    assert.equal(noopTheme.italic("hello"), "hello");
    assert.equal(noopTheme.underline("hello"), "hello");
    assert.equal(noopTheme.inverse("hello"), "hello");
    assert.equal(noopTheme.strikethrough("hello"), "hello");
  });

  it("supports ralph bordered() pattern: theme.bold inside theme.fg", () => {
    // ralph does: theme.fg("accent", theme.bold("Title"))
    const result = noopTheme.fg("accent", noopTheme.bold("Title"));
    assert.equal(result, "Title");
  });
});

describe("ThreadSession prompt event wiring", () => {
  it("tool_execution_start calls appendToolStart on updater", async () => {
    let handler: (event: any) => void = () => {};
    const agentSession = makeMockAgentSession();
    (agentSession as any).subscribe = vi.fn((cb: any) => { handler = cb; return () => {}; });
    (agentSession as any).prompt = vi.fn(async () => {
      // Simulate agent_start → tool event → agent_end
      handler({ type: "agent_start" });
      // Wait for begin() to resolve
      await new Promise((r) => setTimeout(r, 10));
      handler({ type: "tool_execution_start", toolCallId: "tc1", toolName: "read_file", args: { path: "/foo.ts" } });
      handler({ type: "agent_end", messages: [] });
    });

    const updater = makeMockUpdater();
    const { session } = makeSession(agentSession, updater);
    // Manually set up the persistent subscriber (normally done by create())
    (session as any)._setupPersistentSubscriber();

    await session.prompt("read /foo.ts");

    assert.equal(updater.appendToolStart.mock.calls.length, 1);
    const tsArgs = updater.appendToolStart.mock.calls[0] as unknown as any[];
    assert.equal(tsArgs[1], "read_file");
    assert.deepEqual(tsArgs[2], { path: "/foo.ts" });
  });

  it("tool_execution_end calls appendToolEnd on updater", async () => {
    let handler: (event: any) => void = () => {};
    const agentSession = makeMockAgentSession();
    (agentSession as any).subscribe = vi.fn((cb: any) => { handler = cb; return () => {}; });
    (agentSession as any).prompt = vi.fn(async () => {
      handler({ type: "agent_start" });
      await new Promise((r) => setTimeout(r, 10));
      handler({ type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", result: {}, isError: true });
      handler({ type: "agent_end", messages: [] });
    });

    const updater = makeMockUpdater();
    const { session } = makeSession(agentSession, updater);
    (session as any)._setupPersistentSubscriber();

    await session.prompt("run ls");

    assert.equal(updater.appendToolEnd.mock.calls.length, 1);
    const teArgs = updater.appendToolEnd.mock.calls[0] as unknown as any[];
    assert.equal(teArgs[1], "bash");
    assert.equal(teArgs[2], true);
  });

  it("text_delta still calls appendText on updater", async () => {
    let handler: (event: any) => void = () => {};
    const agentSession = makeMockAgentSession();
    (agentSession as any).subscribe = vi.fn((cb: any) => { handler = cb; return () => {}; });
    (agentSession as any).prompt = vi.fn(async () => {
      handler({ type: "agent_start" });
      await new Promise((r) => setTimeout(r, 10));
      handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
      handler({ type: "agent_end", messages: [] });
    });

    const updater = makeMockUpdater();
    const { session } = makeSession(agentSession, updater);
    (session as any)._setupPersistentSubscriber();

    await session.prompt("hi");

    assert.equal(updater.appendText.mock.calls.length, 1);
    const atArgs = updater.appendText.mock.calls[0] as unknown as any[];
    assert.equal(atArgs[1], "hello");
  });

  it("handles extension-triggered follow-up turns (ralph loop pattern)", async () => {
    let handler: (event: any) => void = () => {};
    const agentSession = makeMockAgentSession();
    let turnCount = 0;

    (agentSession as any).subscribe = vi.fn((cb: any) => { handler = cb; return () => {}; });
    (agentSession as any).prompt = vi.fn(async () => {
      turnCount++;
      // First call: extension command, triggers a follow-up turn async
      if (turnCount === 1) {
        // Simulate extension triggering sendUserMessage after a delay
        setTimeout(async () => {
          // This simulates the internal prompt() from sendUserMessage
          handler({ type: "agent_start" });
          await new Promise((r) => setTimeout(r, 10));
          handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "turn1" } });
          handler({ type: "agent_end", messages: [] });
          // isStreaming goes false briefly, then extension fires another turn
          (agentSession as any).isStreaming = false;
        }, 50);
        return; // Extension command was "handled"
      }
    });

    const updater = makeMockUpdater();
    const { session } = makeSession(agentSession, updater);
    (session as any)._setupPersistentSubscriber();

    await session.prompt("/ralph feature build X");

    // Wait for the async follow-up turn
    await new Promise((r) => setTimeout(r, 300));

    // Ralph loop runs in background — streaming should be suppressed.
    // The persistent subscriber skips begin/update/finalize when _ralphBackgroundActive is true.
    assert.strictEqual(updater.begin.mock.calls.length, 0, "begin should NOT be called for background ralph turns");
    assert.strictEqual(updater.appendText.mock.calls.length, 0, "appendText should NOT be called for background ralph turns");
    assert.strictEqual(updater.finalize.mock.calls.length, 0, "finalize should NOT be called for background ralph turns");
    // But the ralph background flag should be set
    assert.ok((session as any)._ralphBackgroundActive, "ralph background mode should be active");
  });
});

// ── Pin persistence ─────────────────────────────────────────────────

describe("Pin persistence", () => {
  const tmpDir = os.tmpdir();
  const cleanupPaths: string[] = [];

  function tmpSessionPath(): string {
    const p = path.join(tmpDir, `test-session-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    cleanupPaths.push(p, p + ".pins.json");
    return p;
  }

  afterEach(() => {
    for (const p of cleanupPaths) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
    cleanupPaths.length = 0;
  });

  const samplePin: Pin = {
    timestamp: "2026-03-13T00:00:00.000Z",
    preview: "Hello world",
    permalink: "https://slack.com/archives/C1/p123",
  };

  it("starts with no pins", () => {
    const sessionPath = tmpSessionPath();
    const { session } = makeSession(undefined, undefined, sessionPath);
    assert.deepEqual(session.pins, []);
  });

  it("addPin persists to disk", async () => {
    const sessionPath = tmpSessionPath();
    const { session } = makeSession(undefined, undefined, sessionPath);

    session.addPin(samplePin);
    assert.deepEqual([...session.pins], [samplePin]);

    // Wait for async write
    await new Promise((r) => setTimeout(r, 50));

    const pinsPath = sessionPath + ".pins.json";
    assert.ok(fs.existsSync(pinsPath), "pins file should exist on disk");

    const data = JSON.parse(fs.readFileSync(pinsPath, "utf-8"));
    assert.deepEqual(data, [samplePin]);
  });

  it("loads pins from disk on construction", async () => {
    const sessionPath = tmpSessionPath();
    const pinsPath = sessionPath + ".pins.json";

    // Write pins file before creating the session
    fs.writeFileSync(pinsPath, JSON.stringify([samplePin]), "utf-8");

    const { session } = makeSession(undefined, undefined, sessionPath);
    assert.deepEqual([...session.pins], [samplePin]);
  });

  it("survives missing pins file gracefully", () => {
    const sessionPath = tmpSessionPath();
    // No pins file on disk
    const { session } = makeSession(undefined, undefined, sessionPath);
    assert.deepEqual(session.pins, []);
  });

  it("survives corrupt pins file gracefully", () => {
    const sessionPath = tmpSessionPath();
    const pinsPath = sessionPath + ".pins.json";
    fs.writeFileSync(pinsPath, "not json", "utf-8");

    const { session } = makeSession(undefined, undefined, sessionPath);
    assert.deepEqual(session.pins, []);
  });

  it("accumulates multiple pins", async () => {
    const sessionPath = tmpSessionPath();
    const { session } = makeSession(undefined, undefined, sessionPath);

    const pin2: Pin = { timestamp: "2026-03-13T01:00:00.000Z", preview: "Second", permalink: "https://slack.com/p2" };
    session.addPin(samplePin);
    session.addPin(pin2);

    assert.equal(session.pins.length, 2);

    // Wait for async writes
    await new Promise((r) => setTimeout(r, 50));

    const data = JSON.parse(fs.readFileSync(sessionPath + ".pins.json", "utf-8"));
    assert.equal(data.length, 2);
    assert.equal(data[0].preview, "Hello world");
    assert.equal(data[1].preview, "Second");
  });
});
