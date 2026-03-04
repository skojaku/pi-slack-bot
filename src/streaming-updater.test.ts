import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { StreamingUpdater } from "./streaming-updater.js";
import type { StreamingState } from "./streaming-updater.js";

function makeClient() {
  return {
    chat: {
      postMessage: mock.fn(async () => ({ ts: "msg-1" })),
      update: mock.fn(async () => ({})),
    },
    reactions: {
      add: mock.fn(async () => ({})),
      remove: mock.fn(async () => ({})),
    },
  } as any;
}

describe("StreamingUpdater", () => {
  let realSetTimeout: typeof globalThis.setTimeout;
  let realClearTimeout: typeof globalThis.clearTimeout;
  let timers: Array<{ cb: () => void; delay: number; id: number }>;
  let nextId: number;

  beforeEach(() => {
    realSetTimeout = globalThis.setTimeout;
    realClearTimeout = globalThis.clearTimeout;
    timers = [];
    nextId = 1;

    // @ts-ignore — fake timers
    globalThis.setTimeout = (cb: () => void, delay: number) => {
      const id = nextId++;
      timers.push({ cb, delay, id });
      return id;
    };
    // @ts-ignore
    globalThis.clearTimeout = (id: number) => {
      timers = timers.filter((t) => t.id !== id);
    };
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });

  function flushTimers() {
    while (timers.length > 0) {
      const t = timers.shift()!;
      t.cb();
    }
  }

  it("begin posts thinking message and adds reaction", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);

    const state = await updater.begin("C1", "ts1");

    assert.equal(client.chat.postMessage.mock.callCount(), 1);
    assert.deepEqual(client.chat.postMessage.mock.calls[0].arguments[0], {
      channel: "C1",
      thread_ts: "ts1",
      text: "⏳ Thinking...",
    });
    assert.equal(client.reactions.add.mock.callCount(), 1);
    assert.equal(state.currentMessageTs, "msg-1");
    assert.equal(state.rawMarkdown, "");
  });

  it("multiple deltas within one throttle window produce single chat.update", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    updater.appendText(state, "Hello ");
    updater.appendText(state, "world");
    updater.appendText(state, "!");

    // Only one timer should be scheduled
    assert.equal(timers.length, 1);

    // Fire the timer
    flushTimers();

    // Wait for the async flush
    await new Promise((r) => realSetTimeout(r, 10));

    assert.equal(client.chat.update.mock.callCount(), 1);
    const updateCall = client.chat.update.mock.calls[0].arguments[0];
    assert.equal(updateCall.ts, "msg-1");
    assert.ok(updateCall.text.includes("Hello world!"));
  });

  it("deltas across two throttle windows produce two chat.update calls", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    // First window
    updater.appendText(state, "First");
    assert.equal(timers.length, 1);
    flushTimers();
    await new Promise((r) => realSetTimeout(r, 10));

    assert.equal(client.chat.update.mock.callCount(), 1);

    // Second window
    updater.appendText(state, " Second");
    assert.equal(timers.length, 1);
    flushTimers();
    await new Promise((r) => realSetTimeout(r, 10));

    assert.equal(client.chat.update.mock.callCount(), 2);
  });

  it("finalize does final flush and swaps reactions", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    updater.appendText(state, "Done");
    // Timer is pending but finalize should cancel it and flush
    assert.equal(timers.length, 1);

    await updater.finalize(state);

    // Timer should be cancelled
    assert.equal(timers.length, 0);

    // Final flush happened
    assert.equal(client.chat.update.mock.callCount(), 1);

    // Reactions swapped: hourglass removed, checkmark added
    assert.equal(client.reactions.remove.mock.callCount(), 1);
    assert.equal(
      client.reactions.remove.mock.calls[0].arguments[0].name,
      "hourglass_flowing_sand",
    );
    assert.equal(client.reactions.add.mock.callCount(), 2); // 1 from begin + 1 from finalize
    assert.equal(
      client.reactions.add.mock.calls[1].arguments[0].name,
      "white_check_mark",
    );
  });

  it("error posts error message and removes hourglass", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    await updater.error(state, new Error("something broke"));

    assert.equal(client.chat.postMessage.mock.callCount(), 2); // begin + error
    const errCall = client.chat.postMessage.mock.calls[1].arguments[0];
    assert.equal(errCall.text, "❌ Error: something broke");
    assert.equal(errCall.thread_ts, "ts1");

    assert.equal(client.reactions.remove.mock.callCount(), 1);
  });

  it("appendToolStart and appendToolEnd appear in flushed output", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    updater.appendText(state, "Working...");
    updater.appendToolStart(state, "read_file", { path: "/foo.ts" });

    // Tool start triggers immediate flush (no timer needed)
    await new Promise((r) => realSetTimeout(r, 10));

    const text1 = client.chat.update.mock.calls[0].arguments[0].text;
    assert.ok(text1.includes("🔧"), "should contain tool start icon");
    assert.ok(text1.includes("read_file"), "should contain tool name");

    updater.appendToolEnd(state, "read_file", false);
    await new Promise((r) => realSetTimeout(r, 10));

    const text2 = client.chat.update.mock.calls[1].arguments[0].text;
    assert.ok(text2.includes("✅"), "should contain success icon");
    assert.ok(!text2.includes("🔧"), "wrench should be replaced");
  });

  it("tool start triggers immediate flush bypassing throttle timer", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    updater.appendText(state, "Some text");
    // appendText schedules a throttled timer
    assert.equal(timers.length, 1);

    updater.appendToolStart(state, "bash", { command: "ls" });
    // Immediate flush should cancel the pending timer
    assert.equal(timers.length, 0);

    await new Promise((r) => realSetTimeout(r, 10));
    assert.equal(client.chat.update.mock.callCount(), 1);
    const text = client.chat.update.mock.calls[0].arguments[0].text;
    assert.ok(text.includes("Some text"), "should include text content");
    assert.ok(text.includes("bash"), "should include tool name");
  });

  it("tool end triggers immediate flush bypassing throttle timer", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    updater.appendToolStart(state, "read_file", { path: "/a.ts" });
    await new Promise((r) => realSetTimeout(r, 10));
    assert.equal(client.chat.update.mock.callCount(), 1);

    // Append text to schedule a throttle timer
    updater.appendText(state, "reading...");
    assert.equal(timers.length, 1);

    updater.appendToolEnd(state, "read_file", true);
    // Timer cancelled by immediate flush
    assert.equal(timers.length, 0);

    await new Promise((r) => realSetTimeout(r, 10));
    assert.equal(client.chat.update.mock.callCount(), 2);
    const text = client.chat.update.mock.calls[1].arguments[0].text;
    assert.ok(text.includes("❌"), "should contain error icon");
    assert.ok(!text.includes("🔧"), "wrench should be replaced");
  });

  it("tool lines appear after text content in flushed output", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    updater.appendText(state, "Here is some text");
    updater.appendToolStart(state, "write_file", { path: "/b.ts" });

    await new Promise((r) => realSetTimeout(r, 10));

    const text = client.chat.update.mock.calls[0].arguments[0].text;
    const textIdx = text.indexOf("Here is some text");
    const toolIdx = text.indexOf("write_file");
    assert.ok(textIdx >= 0, "text content should be present");
    assert.ok(toolIdx >= 0, "tool line should be present");
    assert.ok(textIdx < toolIdx, "text content should appear before tool lines");
  });

  it("empty content does not trigger chat.update", async () => {
    const client = makeClient();
    const updater = new StreamingUpdater(client, 3000);
    const state = await updater.begin("C1", "ts1");

    // Schedule a flush with empty content
    state.timer = null;
    await updater.finalize(state);

    assert.equal(client.chat.update.mock.callCount(), 0);
  });

  it("content exceeding msgLimit triggers split and posts overflow as new messages", async () => {
    const client = makeClient();
    let postCount = 0;
    client.chat.postMessage = mock.fn(async () => ({ ts: `msg-${++postCount}` }));

    // Use a small limit to easily trigger splitting
    const updater = new StreamingUpdater(client, 3000, 100);
    const state = await updater.begin("C1", "ts1");

    // Generate content that exceeds 100 chars — two paragraphs
    const para1 = "A".repeat(60);
    const para2 = "B".repeat(60);
    updater.appendText(state, `${para1}\n\n${para2}`);

    flushTimers();
    await new Promise((r) => realSetTimeout(r, 10));

    // First chunk via chat.update on the original message
    assert.equal(client.chat.update.mock.callCount(), 1);
    assert.equal(client.chat.update.mock.calls[0].arguments[0].ts, "msg-1");

    // Overflow chunk(s) posted as new thread replies
    // postMessage: 1 from begin + at least 1 overflow
    assert.ok(client.chat.postMessage.mock.callCount() >= 2, "should post overflow chunk(s)");

    // The overflow postMessage should be in the same thread
    const overflowCall = client.chat.postMessage.mock.calls[1].arguments[0];
    assert.equal(overflowCall.thread_ts, "ts1");
  });

  it("currentMessageTs updated to last overflow message ts", async () => {
    const client = makeClient();
    let postCount = 0;
    client.chat.postMessage = mock.fn(async () => ({ ts: `msg-${++postCount}` }));

    const updater = new StreamingUpdater(client, 3000, 100);
    const state = await updater.begin("C1", "ts1");

    assert.equal(state.currentMessageTs, "msg-1");

    const para1 = "A".repeat(60);
    const para2 = "B".repeat(60);
    updater.appendText(state, `${para1}\n\n${para2}`);

    flushTimers();
    await new Promise((r) => realSetTimeout(r, 10));

    // currentMessageTs should have moved to the last posted overflow
    assert.notEqual(state.currentMessageTs, "msg-1");
    // postedMessageTs should track the previous message(s)
    assert.ok(state.postedMessageTs.includes("msg-1"), "original ts should be in postedMessageTs");
  });

  it("finalize reactions target initialMessageTs even after split", async () => {
    const client = makeClient();
    let postCount = 0;
    client.chat.postMessage = mock.fn(async () => ({ ts: `msg-${++postCount}` }));

    const updater = new StreamingUpdater(client, 3000, 100);
    const state = await updater.begin("C1", "ts1");

    const para1 = "A".repeat(60);
    const para2 = "B".repeat(60);
    updater.appendText(state, `${para1}\n\n${para2}`);

    await updater.finalize(state);

    // Reactions should target the initial message (msg-1), not the overflow
    const removeCall = client.reactions.remove.mock.calls[0].arguments[0];
    assert.equal(removeCall.timestamp, "msg-1");

    const addCalls = client.reactions.add.mock.calls;
    const checkmarkCall = addCalls[addCalls.length - 1].arguments[0];
    assert.equal(checkmarkCall.timestamp, "msg-1");
    assert.equal(checkmarkCall.name, "white_check_mark");
  });
});
