import { describe, it, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { BotSessionManager, SessionLimitError } from "./session-manager.js";
import type { Config } from "./config.js";

const baseConfig: Config = {
  slackBotToken: "xoxb-test",
  slackAppToken: "xapp-test",
  slackUserId: "U123",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  thinkingLevel: "off",
  maxSessions: 2,
  sessionIdleTimeoutSecs: 3600,
  sessionDir: "/tmp/test-sessions",
  streamThrottleMs: 3000,
  slackMsgLimit: 3900,
  workspaceDirs: [],
};

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
    enqueue: vi.fn(),
    dispose: vi.fn(async () => {}),
    abort: vi.fn(),
    newSession: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  };
}

function makeManager(configOverrides: Partial<Config> = {}) {
  const config = { ...baseConfig, ...configOverrides };
  const client = {} as any;
  const sessions = new Map<string, ReturnType<typeof makeSession>>();

  const factory = vi.fn(async (params: any) => {
    const s = makeSession(params.threadTs);
    sessions.set(params.threadTs, s);
    return s as any;
  });

  const mgr = new BotSessionManager(config, client, factory);
  mgr.stopReaper(); // don't let the interval run during tests
  return { mgr, factory, sessions };
}

describe("BotSessionManager", () => {
  it("creates a new session and returns it", async () => {
    const { mgr, factory } = makeManager();
    const s = await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });
    assert.equal(s.threadTs, "ts1");
    assert.equal(factory.mock.calls.length, 1);
  });

  it("returns the same session for the same threadTs", async () => {
    const { mgr, factory } = makeManager();
    const s1 = await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });
    const s2 = await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });
    assert.equal(s1, s2);
    assert.equal(factory.mock.calls.length, 1);
  });

  it("throws SessionLimitError when at max capacity", async () => {
    const { mgr } = makeManager({ maxSessions: 2 });
    await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });
    await mgr.getOrCreate({ threadTs: "ts2", channelId: "C1", cwd: "/tmp" });
    await assert.rejects(
      () => mgr.getOrCreate({ threadTs: "ts3", channelId: "C1", cwd: "/tmp" }),
      SessionLimitError,
    );
  });

  it("dispose removes session from map and calls session.dispose", async () => {
    const { mgr, sessions } = makeManager();
    await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });
    assert.equal(mgr.count(), 1);

    await mgr.dispose("ts1");
    assert.equal(mgr.count(), 0);
    assert.equal(sessions.get("ts1")!.dispose.mock.calls.length, 1);
  });

  it("idle reaper disposes sessions past timeout", async () => {
    const { mgr, sessions } = makeManager({ sessionIdleTimeoutSecs: 1 });

    await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });
    // Backdate lastActivity to simulate idle
    sessions.get("ts1")!.lastActivity = new Date(Date.now() - 2000);

    // Manually trigger reap via private method
    await (mgr as any)._reap();

    assert.equal(mgr.count(), 0);
    assert.equal(sessions.get("ts1")!.dispose.mock.calls.length, 1);
  });

  it("disposeAll disposes every session", async () => {
    const { mgr, sessions } = makeManager();
    await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });
    await mgr.getOrCreate({ threadTs: "ts2", channelId: "C1", cwd: "/tmp" });

    await mgr.disposeAll();
    assert.equal(mgr.count(), 0);
    assert.equal(sessions.get("ts1")!.dispose.mock.calls.length, 1);
    assert.equal(sessions.get("ts2")!.dispose.mock.calls.length, 1);
  });

  it("list returns info for all sessions", async () => {
    const { mgr } = makeManager();
    await mgr.getOrCreate({ threadTs: "ts1", channelId: "C1", cwd: "/tmp" });
    const list = mgr.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].threadTs, "ts1");
  });
});
