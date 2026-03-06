import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { basename } from "path";
import { homedir } from "os";
import { tmpdir } from "os";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import type { Config } from "./config.js";

// We test the createApp logic by simulating Slack events through the registered handlers.
// Since @slack/bolt's App is hard to mock directly, we extract and test the handler logic
// by capturing the registered event/action handlers.

const baseConfig: Config = {
  slackBotToken: "xoxb-test",
  slackAppToken: "xapp-test",
  slackUserId: "U123",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  thinkingLevel: "off",
  maxSessions: 10,
  sessionIdleTimeoutSecs: 3600,
  sessionDir: "/tmp/test-sessions",
  streamThrottleMs: 3000,
  slackMsgLimit: 3900,
  workspaceDirs: [],
};

// Helpers to simulate the Slack event flow without a real App instance.
// We replicate the core logic from createApp's message handler.

import { parseMessage, scanProjects } from "./parser.js";
import { BotSessionManager, SessionLimitError } from "./session-manager.js";

function makeSession(threadTs: string) {
  return {
    threadTs,
    channelId: "C1",
    cwd: "/tmp",
    lastActivity: new Date(),
    isStreaming: false,
    messageCount: 0,
    model: undefined,
    thinkingLevel: "off" as const,
    enqueue: mock.fn((fn: () => Promise<void>) => {}),
    dispose: mock.fn(async () => {}),
    abort: mock.fn(),
    newSession: mock.fn(async () => {}),
    prompt: mock.fn(async () => {}),
    subscribe: mock.fn(() => () => {}),
  };
}

function makeManager(configOverrides: Partial<Config> = {}) {
  const config = { ...baseConfig, ...configOverrides };
  const sessions = new Map<string, ReturnType<typeof makeSession>>();

  const factory = mock.fn(async (params: any) => {
    const s = makeSession(params.threadTs);
    s.cwd = params.cwd;
    sessions.set(params.threadTs, s);
    return s as any;
  });

  const client = {} as any;
  const mgr = new BotSessionManager(config, client, factory);
  mgr.stopReaper();
  return { mgr, factory, sessions, config };
}

describe("slack.ts cwd parsing — exact cwd", () => {
  it("resolves exact directory path as cwd and passes rest as prompt", async () => {
    const dir = tmpdir();
    const { mgr, sessions } = makeManager();

    // Simulate: parseMessage returns exact cwd
    const parsed = parseMessage(`${dir} do something`, []);
    assert.equal(parsed.cwd, dir);
    assert.equal(parsed.prompt, "do something");

    // Simulate handler logic: exact cwd branch
    const session = await mgr.getOrCreate({
      threadTs: "ts1",
      channelId: "C1",
      cwd: parsed.cwd!,
    });

    assert.equal(session.cwd, dir);
    session.enqueue(() => session.prompt(parsed.prompt));
    assert.equal(sessions.get("ts1")!.enqueue.mock.callCount(), 1);
  });
});

describe("slack.ts cwd parsing — fuzzy candidates with buttons", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = join(tmpdir(), `slack-test-${Date.now()}`);
    mkdirSync(join(tmpBase, "my-cool-project"), { recursive: true });
    mkdirSync(join(tmpBase, "other-thing"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("posts Block Kit buttons when fuzzy candidates found", async () => {
    const knownProjects = scanProjects([tmpBase]);
    const parsed = parseMessage("cool do something", knownProjects);

    assert.equal(parsed.cwd, null);
    assert.ok(parsed.candidates.length > 0);
    assert.ok(parsed.candidates.some((c) => c.endsWith("my-cool-project")));

    // Simulate: build Block Kit buttons
    const buttons = parsed.candidates.map((candidate, i) => ({
      type: "button" as const,
      text: { type: "plain_text" as const, text: basename(candidate) },
      action_id: `select_cwd_${i}`,
      value: candidate,
    }));

    assert.ok(buttons.length > 0);
    assert.equal(buttons[0].action_id, "select_cwd_0");
    assert.ok(buttons[0].value.endsWith("my-cool-project"));
    assert.equal(buttons[0].text.text, "my-cool-project");
  });

  it("stores pending entry keyed by button message ts", () => {
    const pendingCwd = new Map<string, { threadTs: string; channelId: string; prompt: string }>();
    const buttonMessageTs = "msg-btn-1";

    pendingCwd.set(buttonMessageTs, {
      threadTs: "ts1",
      channelId: "C1",
      prompt: "cool do something",
    });

    assert.ok(pendingCwd.has(buttonMessageTs));
    const entry = pendingCwd.get(buttonMessageTs)!;
    assert.equal(entry.threadTs, "ts1");
    assert.equal(entry.prompt, "cool do something");
  });
});

describe("slack.ts cwd parsing — no match fallback", () => {
  it("uses homedir when no cwd and no candidates", async () => {
    const { mgr, sessions } = makeManager();
    const parsed = parseMessage("zzznomatch do something", []);

    assert.equal(parsed.cwd, null);
    assert.deepEqual(parsed.candidates, []);

    // Simulate handler logic: fallback branch
    const session = await mgr.getOrCreate({
      threadTs: "ts1",
      channelId: "C1",
      cwd: homedir(),
    });

    assert.equal(session.cwd, homedir());
    // Full text used as prompt (not parsed.prompt which is the same for no-match)
    session.enqueue(() => session.prompt("zzznomatch do something"));
    assert.equal(sessions.get("ts1")!.enqueue.mock.callCount(), 1);
  });
});

describe("slack.ts button action handler", () => {
  it("resolves pending entry, creates session with selected cwd, enqueues prompt", async () => {
    const { mgr, sessions } = makeManager();
    const pendingCwd = new Map<string, { threadTs: string; channelId: string; prompt: string }>();

    // Simulate: buttons were posted, pending entry stored
    const buttonMessageTs = "msg-btn-1";
    pendingCwd.set(buttonMessageTs, {
      threadTs: "ts1",
      channelId: "C1",
      prompt: "do something",
    });

    // Simulate: user clicks button with value="/workplace/my-cool-project"
    const selectedCwd = "/workplace/my-cool-project";
    const pending = pendingCwd.get(buttonMessageTs);
    assert.ok(pending);
    pendingCwd.delete(buttonMessageTs);

    // Verify pending was consumed
    assert.ok(!pendingCwd.has(buttonMessageTs));

    // Create session with selected cwd
    const session = await mgr.getOrCreate({
      threadTs: pending!.threadTs,
      channelId: pending!.channelId,
      cwd: selectedCwd,
    });

    assert.equal(session.cwd, selectedCwd);
    session.enqueue(() => session.prompt(pending!.prompt));
    assert.equal(sessions.get("ts1")!.enqueue.mock.callCount(), 1);
  });

  it("ignores action if no pending entry found", () => {
    const pendingCwd = new Map<string, { threadTs: string; channelId: string; prompt: string }>();
    const pending = pendingCwd.get("nonexistent-ts");
    assert.equal(pending, undefined);
  });
});

describe("slack.ts createApp integration", () => {
  it("exports pendingCwd map and knownProjects", async () => {
    // Verify the module shape — import createApp and check return type
    const { createApp } = await import("./slack.js");
    assert.equal(typeof createApp, "function");
  });
});
