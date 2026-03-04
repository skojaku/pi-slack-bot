import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { AttachServer } from "./attach-server.js";
import type { Config } from "./config.js";

// --- Mock WebSocket / WebSocketServer ---

class MockWebSocket extends EventEmitter {
  sent: string[] = [];
  readyState = 1; // OPEN

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    this.emit("close");
  }

  // Simulate receiving a message from the extension
  receiveMessage(msg: object) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
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
    attachPort: 0, // won't actually bind
    ...overrides,
  };
}

function makeClient() {
  return {
    conversations: {
      open: mock.fn(async () => ({ channel: { id: "D_DM_CHAN" } })),
    },
    chat: {
      postMessage: mock.fn(async () => ({ ts: "thread-ts-1" })),
      update: mock.fn(async () => ({})),
    },
    reactions: {
      add: mock.fn(async () => ({})),
      remove: mock.fn(async () => ({})),
    },
  } as any;
}

// We test AttachServer by directly calling its internal methods via the
// WebSocket event flow. We bypass the real WebSocketServer by not calling
// start() and instead simulating the connection lifecycle.

function createServerWithMockWss(config?: Partial<Config>) {
  const client = makeClient();
  const server = new AttachServer(makeConfig(config), client);
  return { server, client };
}

// Helper: simulate a full register flow by triggering the ws "message" event
// through the server's connection handler. Since we can't call start() without
// binding a port, we access the internal _handleMessage via the public API
// after manually wiring a MockWebSocket.

// We'll use a different approach: create the server, call start() on a random
// port, then connect a real-ish mock. But that's complex. Instead, let's test
// the public API methods and use a helper that registers a session by poking
// the internals.

async function registerSession(
  server: AttachServer,
  client: any,
  ws: MockWebSocket,
  cwd = "/home/user/project",
): Promise<string> {
  // We need to trigger the connection handler. Since we can't without start(),
  // we'll use the fact that AttachServer stores sessions in a Map and the
  // register flow is triggered by a WebSocket message.
  //
  // Approach: call start() with port 0 (OS picks a free port), then simulate.
  // But that's heavy for unit tests. Instead, let's test via the actual
  // WebSocket event flow by extracting the handler.

  // Actually, the cleanest approach: start the server on port 0, get the
  // assigned port, connect a real WebSocket. But that requires async setup.
  // For unit tests, let's just test the public interface by manually invoking
  // the private handler through the connection event.

  // We'll monkey-patch: create a real WSS on port 0, emit a connection event.
  // The server's start() sets up the WSS and the connection handler.

  // Simplest: just call start(), then emit "connection" on the internal _wss.
  (server as any)._wss = new EventEmitter(); // fake WSS
  (server as any)._wss.close = () => {};

  // Trigger the connection handler by emitting "connection"
  // But start() sets up the handler... Let's call start() with a mock WSS.

  // Better approach: call start() but override the port to 0
  // Actually let's just directly test the flow:

  // 1. Manually trigger the "connection" event path
  const connectionHandler = setupConnectionHandler(server);
  connectionHandler(ws);

  // 2. Send register message
  ws.receiveMessage({ type: "register", sessionId: "sess-1", cwd });

  // Wait for async handling
  await new Promise((r) => setTimeout(r, 20));

  // The threadTs from the mock client
  return "thread-ts-1";
}

function setupConnectionHandler(server: AttachServer): (ws: MockWebSocket) => void {
  // Replace _wss with a fake that captures the connection handler
  const fakeWss = new EventEmitter();
  (fakeWss as any).close = () => {};
  (server as any)._wss = fakeWss;

  // Call start() logic by emitting on the fake WSS
  // Actually, we need to set up the handler. Let's just replicate what start() does
  // by triggering the "connection" event after calling start() with a patched WSS.

  // Cleanest: override WebSocketServer constructor. But that's complex.
  // Let's just directly invoke the server's connection handling.

  // The server's start() does: this._wss = new WebSocketServer({port}); this._wss.on("connection", handler)
  // We can't call start() without binding. So let's extract the handler by
  // calling start() with a monkey-patched WebSocketServer.

  // Final approach: just test through the real start() with port 0.
  // Port 0 = OS assigns a free port. This is standard for tests.
  return () => {}; // placeholder, we'll use a better approach below
}

// ============================================================
// Better approach: start server on port 0, use real WebSocket
// ============================================================

import { WebSocket } from "ws";

async function startServer(config?: Partial<Config>) {
  const client = makeClient();
  const cfg = makeConfig({ attachPort: 0, ...config });
  const server = new AttachServer(cfg, client);

  // Monkey-patch to use port 0
  (server as any)._config = { ...cfg, attachPort: 0 };
  server.start();

  // Get the actual port
  const wss = (server as any)._wss;
  const addr = wss.address();
  const port = typeof addr === "object" ? addr.port : 0;

  return { server, client, port };
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once("message", (data) => {
      resolve(JSON.parse(data.toString()));
    });
  });
}

describe("AttachServer", () => {
  let server: AttachServer;
  let port: number;
  let client: any;

  afterEach(() => {
    if (server) server.stop();
  });

  describe("register flow", () => {
    it("creates DM thread and sends thread_created back", async () => {
      ({ server, client, port } = await startServer());
      const ws = await connectWs(port);

      const responsePromise = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "register", sessionId: "sess-1", cwd: "/home/user/project" }));

      const response = await responsePromise;

      // Should have opened a DM conversation
      assert.equal(client.conversations.open.mock.callCount(), 1);
      assert.deepEqual(client.conversations.open.mock.calls[0].arguments[0], {
        users: "U123",
      });

      // Should have posted thread starter
      assert.equal(client.chat.postMessage.mock.callCount(), 1);
      const postCall = client.chat.postMessage.mock.calls[0].arguments[0];
      assert.equal(postCall.channel, "D_DM_CHAN");
      assert.ok(postCall.text.includes("Session attached"));
      assert.ok(postCall.text.includes("/home/user/project"));

      // Should send thread_created back
      assert.equal(response.type, "thread_created");
      assert.equal(response.threadTs, "thread-ts-1");
      assert.ok(response.threadUrl.includes("D_DM_CHAN"));

      // hasSession should return true
      assert.equal(server.hasSession("thread-ts-1"), true);
      assert.equal(server.hasSession("nonexistent"), false);

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    });

    it("stores session in map after register", async () => {
      ({ server, client, port } = await startServer());
      const ws = await connectWs(port);

      ws.send(JSON.stringify({ type: "register", sessionId: "sess-1", cwd: "/tmp" }));

      // Wait for register to complete
      const response = await waitForMessage(ws);
      assert.equal(response.type, "thread_created");
      assert.equal(server.hasSession("thread-ts-1"), true);

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    });
  });

  describe("agent_start", () => {
    it("triggers updater.begin and stores streaming state", async () => {
      ({ server, client, port } = await startServer());
      const ws = await connectWs(port);

      ws.send(JSON.stringify({ type: "register", sessionId: "s1", cwd: "/tmp" }));
      await waitForMessage(ws); // thread_created

      // Reset postMessage mock count after register
      const postCountAfterRegister = client.chat.postMessage.mock.callCount();

      ws.send(JSON.stringify({ type: "agent_start" }));
      await new Promise((r) => setTimeout(r, 50));

      // Should have posted "⏳ Thinking..." via updater.begin
      assert.equal(client.chat.postMessage.mock.callCount(), postCountAfterRegister + 1);
      const thinkingPost = client.chat.postMessage.mock.calls[postCountAfterRegister].arguments[0];
      assert.equal(thinkingPost.text, "⏳ Thinking...");
      assert.equal(thinkingPost.thread_ts, "thread-ts-1");

      // Should have added hourglass reaction
      assert.equal(client.reactions.add.mock.callCount(), 1);

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    });
  });

  describe("text_delta", () => {
    it("triggers updater.appendText", async () => {
      ({ server, client, port } = await startServer());

      // Use a very short throttle so flush happens quickly
      (server as any)._updater = new (await import("./streaming-updater.js")).StreamingUpdater(
        client, 50, 3900,
      );

      const ws = await connectWs(port);

      ws.send(JSON.stringify({ type: "register", sessionId: "s1", cwd: "/tmp" }));
      await waitForMessage(ws);

      ws.send(JSON.stringify({ type: "agent_start" }));
      await new Promise((r) => setTimeout(r, 50));

      ws.send(JSON.stringify({ type: "text_delta", delta: "Hello world" }));
      // Wait for throttle flush
      await new Promise((r) => setTimeout(r, 100));

      // chat.update should have been called with the text
      assert.ok(client.chat.update.mock.callCount() >= 1);
      const updateCall = client.chat.update.mock.calls[0].arguments[0];
      assert.ok(updateCall.text.includes("Hello world"));

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    });
  });

  describe("agent_end", () => {
    it("triggers updater.finalize", async () => {
      ({ server, client, port } = await startServer());

      (server as any)._updater = new (await import("./streaming-updater.js")).StreamingUpdater(
        client, 50, 3900,
      );

      const ws = await connectWs(port);

      ws.send(JSON.stringify({ type: "register", sessionId: "s1", cwd: "/tmp" }));
      await waitForMessage(ws);

      ws.send(JSON.stringify({ type: "agent_start" }));
      await new Promise((r) => setTimeout(r, 50));

      ws.send(JSON.stringify({ type: "text_delta", delta: "Done" }));
      await new Promise((r) => setTimeout(r, 20));

      ws.send(JSON.stringify({ type: "agent_end" }));
      await new Promise((r) => setTimeout(r, 100));

      // finalize should swap reactions: remove hourglass, add checkmark
      assert.ok(client.reactions.remove.mock.callCount() >= 1);
      const removeCall = client.reactions.remove.mock.calls[0].arguments[0];
      assert.equal(removeCall.name, "hourglass_flowing_sand");

      // checkmark added
      const addCalls = client.reactions.add.mock.calls;
      const lastAdd = addCalls[addCalls.length - 1].arguments[0];
      assert.equal(lastAdd.name, "white_check_mark");

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    });
  });

  describe("sendUserMessage", () => {
    it("sends user_message to the correct WebSocket", async () => {
      ({ server, client, port } = await startServer());
      const ws = await connectWs(port);

      ws.send(JSON.stringify({ type: "register", sessionId: "s1", cwd: "/tmp" }));
      await waitForMessage(ws); // thread_created

      const msgPromise = waitForMessage(ws);
      server.sendUserMessage("thread-ts-1", "hello from slack");
      const msg = await msgPromise;

      assert.equal(msg.type, "user_message");
      assert.equal(msg.text, "hello from slack");
      assert.ok(msg.ts);

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    });

    it("does nothing for unknown threadTs", () => {
      const { server: s } = createServerWithMockWss();
      // Should not throw
      s.sendUserMessage("nonexistent", "hello");
    });
  });

  describe("sendCancel", () => {
    it("sends cancel to the correct WebSocket", async () => {
      ({ server, client, port } = await startServer());
      const ws = await connectWs(port);

      ws.send(JSON.stringify({ type: "register", sessionId: "s1", cwd: "/tmp" }));
      await waitForMessage(ws);

      const msgPromise = waitForMessage(ws);
      server.sendCancel("thread-ts-1");
      const msg = await msgPromise;

      assert.equal(msg.type, "cancel");

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    });
  });

  describe("hasSession", () => {
    it("returns true for registered session, false for unknown", async () => {
      ({ server, client, port } = await startServer());
      assert.equal(server.hasSession("thread-ts-1"), false);

      const ws = await connectWs(port);
      ws.send(JSON.stringify({ type: "register", sessionId: "s1", cwd: "/tmp" }));
      await waitForMessage(ws);

      assert.equal(server.hasSession("thread-ts-1"), true);
      assert.equal(server.hasSession("other"), false);

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    });
  });

  describe("disconnect", () => {
    it("posts detach notice and removes session on ws close", async () => {
      ({ server, client, port } = await startServer());
      const ws = await connectWs(port);

      ws.send(JSON.stringify({ type: "register", sessionId: "s1", cwd: "/tmp" }));
      await waitForMessage(ws);

      assert.equal(server.hasSession("thread-ts-1"), true);
      const postCountBefore = client.chat.postMessage.mock.callCount();

      ws.close();
      await new Promise((r) => setTimeout(r, 100));

      // Should have posted detach notice
      assert.equal(client.chat.postMessage.mock.callCount(), postCountBefore + 1);
      const detachPost = client.chat.postMessage.mock.calls[postCountBefore].arguments[0];
      assert.ok(detachPost.text.includes("Session detached"));
      assert.equal(detachPost.thread_ts, "thread-ts-1");

      // Session should be removed
      assert.equal(server.hasSession("thread-ts-1"), false);
    });
  });

  describe("stop", () => {
    it("closes all connections and clears sessions", async () => {
      ({ server, client, port } = await startServer());
      const ws = await connectWs(port);

      ws.send(JSON.stringify({ type: "register", sessionId: "s1", cwd: "/tmp" }));
      await waitForMessage(ws);

      assert.equal(server.hasSession("thread-ts-1"), true);

      server.stop();
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(server.hasSession("thread-ts-1"), false);
    });
  });
});
