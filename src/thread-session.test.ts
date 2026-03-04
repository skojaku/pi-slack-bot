import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { ThreadSession } from "./thread-session.js";

// Minimal mock AgentSession
function makeMockAgentSession() {
  return {
    subscribe: mock.fn(() => () => {}),
    prompt: mock.fn(async () => {}),
    abort: mock.fn(async () => {}),
    dispose: mock.fn(() => {}),
    newSession: mock.fn(async () => true),
    isStreaming: false,
    messages: [],
    model: undefined,
    thinkingLevel: "off" as const,
  };
}

function makeMockUpdater() {
  return {
    begin: mock.fn(async () => ({
      channelId: "C1",
      threadTs: "ts1",
      currentMessageTs: "msg-1",
      rawMarkdown: "",
      toolLines: [],
      postedMessageTs: [],
      timer: null,
      retryCount: 0,
    })),
    appendText: mock.fn(() => {}),
    appendToolStart: mock.fn(() => {}),
    appendToolEnd: mock.fn(() => {}),
    finalize: mock.fn(async () => {}),
    error: mock.fn(async () => {}),
  };
}

function makeSession(agentSession = makeMockAgentSession(), updater = makeMockUpdater()) {
  const client = { chat: { postMessage: mock.fn(async () => ({ ts: "1" })) } } as any;
  return {
    session: new ThreadSession("ts1", "C1", "/tmp", client, agentSession as any, updater as any),
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

describe("ThreadSession prompt event wiring", () => {
  it("tool_execution_start calls appendToolStart on updater", async () => {
    let handler: (event: any) => void = () => {};
    const agentSession = makeMockAgentSession();
    (agentSession as any).subscribe = mock.fn((cb: any) => { handler = cb; return () => {}; });
    (agentSession as any).prompt = mock.fn(async () => {
      handler({ type: "tool_execution_start", toolCallId: "tc1", toolName: "read_file", args: { path: "/foo.ts" } });
    });

    const updater = makeMockUpdater();
    const { session } = makeSession(agentSession, updater);

    await session.prompt("read /foo.ts");

    assert.equal(updater.appendToolStart.mock.callCount(), 1);
    const tsArgs = updater.appendToolStart.mock.calls[0].arguments as unknown as any[];
    assert.equal(tsArgs[1], "read_file");
    assert.deepEqual(tsArgs[2], { path: "/foo.ts" });
  });

  it("tool_execution_end calls appendToolEnd on updater", async () => {
    let handler: (event: any) => void = () => {};
    const agentSession = makeMockAgentSession();
    (agentSession as any).subscribe = mock.fn((cb: any) => { handler = cb; return () => {}; });
    (agentSession as any).prompt = mock.fn(async () => {
      handler({ type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", result: {}, isError: true });
    });

    const updater = makeMockUpdater();
    const { session } = makeSession(agentSession, updater);

    await session.prompt("run ls");

    assert.equal(updater.appendToolEnd.mock.callCount(), 1);
    const teArgs = updater.appendToolEnd.mock.calls[0].arguments as unknown as any[];
    assert.equal(teArgs[1], "bash");
    assert.equal(teArgs[2], true);
  });

  it("text_delta still calls appendText on updater", async () => {
    let handler: (event: any) => void = () => {};
    const agentSession = makeMockAgentSession();
    (agentSession as any).subscribe = mock.fn((cb: any) => { handler = cb; return () => {}; });
    (agentSession as any).prompt = mock.fn(async () => {
      handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
    });

    const updater = makeMockUpdater();
    const { session } = makeSession(agentSession, updater);

    await session.prompt("hi");

    assert.equal(updater.appendText.mock.callCount(), 1);
    const atArgs = updater.appendText.mock.calls[0].arguments as unknown as any[];
    assert.equal(atArgs[1], "hello");
  });
});
