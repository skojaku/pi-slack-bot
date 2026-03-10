import { describe, it, vi, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  discoverRalphPresets,
  postRalphPicker,
  handleRalphPresetSelect,
  tryConsumeRalphPrompt,
  postPromptPicker,
  handlePromptSelect,
  getPendingRalph,
  removePendingRalph,
  getPendingPromptPick,
  removePendingPromptPick,
  _setPendingRalph,
  _setPendingPromptPick,
} from "./command-picker.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeMockClient() {
  const posted: any[] = [];
  const updated: any[] = [];
  return {
    posted,
    updated,
    chat: {
      postMessage: vi.fn(async (opts: any) => {
        const ts = `msg-${posted.length}`;
        posted.push({ ...opts, ts });
        return { ts };
      }),
      update: vi.fn(async (opts: any) => {
        updated.push(opts);
        return { ok: true };
      }),
    },
  } as any;
}

function makeMockSession(cwd: string, templates: any[] = []) {
  return {
    cwd,
    promptTemplates: templates,
    enqueue: vi.fn((fn: () => Promise<void>) => fn()),
    prompt: vi.fn(async (_text: string) => {}),
  } as any;
}

/* ------------------------------------------------------------------ */
/*  Ralph preset discovery                                             */
/* ------------------------------------------------------------------ */

describe("discoverRalphPresets", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = join(tmpdir(), `ralph-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(tmpBase, ".pi", "ralph", "presets"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("discovers presets from project directory", () => {
    writeFileSync(
      join(tmpBase, ".pi", "ralph", "presets", "test-preset.yml"),
      `event_loop:
  starting_event: "start"
  completion_promise: "DONE"
  max_iterations: 10

hats:
  builder:
    name: "⚙️ Builder"
    triggers: ["start"]
    publishes: ["done"]
    instructions: "Build it"
  reviewer:
    name: "📝 Reviewer"
    triggers: ["done"]
    publishes: ["complete"]
    instructions: "Review it"
`,
    );

    const presets = discoverRalphPresets(tmpBase);
    const testPreset = presets.find((p) => p.name === "test-preset");
    assert.ok(testPreset, "should find test-preset");
    assert.ok(testPreset.hats.includes("⚙️ Builder"));
    assert.ok(testPreset.hats.includes("📝 Reviewer"));
    assert.ok(testPreset.description.includes("→"));
  });

  it("skips files without hats or event_loop", () => {
    writeFileSync(
      join(tmpBase, ".pi", "ralph", "presets", "bad.yml"),
      "some: random\nyaml: file\n",
    );

    const presets = discoverRalphPresets(tmpBase);
    const bad = presets.find((p) => p.name === "bad");
    assert.equal(bad, undefined);
  });

  it("returns array (may contain built-in presets) for any cwd", () => {
    const presets = discoverRalphPresets("/nonexistent/path");
    assert.ok(Array.isArray(presets));
  });
});

/* ------------------------------------------------------------------ */
/*  Ralph preset picker                                                */
/* ------------------------------------------------------------------ */

describe("postRalphPicker", () => {
  it("posts a message with preset buttons", async () => {
    const client = makeMockClient();
    // Use homedir as cwd to pick up built-in presets
    const session = makeMockSession(process.cwd());

    await postRalphPicker(client, "C1", "T1", session);

    assert.ok(client.posted.length > 0);
    const msg = client.posted[0];
    assert.equal(msg.channel, "C1");
    assert.equal(msg.thread_ts, "T1");
    assert.ok(msg.blocks.length > 0);

    // Should have an actions block with buttons
    const actionsBlock = msg.blocks.find((b: any) => b.type === "actions");
    assert.ok(actionsBlock, "should have an actions block");
    assert.ok(actionsBlock.elements.length > 0, "should have buttons");
  });

  it("stores pending entry keyed by message ts", async () => {
    const client = makeMockClient();
    const session = makeMockSession(process.cwd());

    await postRalphPicker(client, "C1", "T1", session);

    const messageTs = client.posted[0]?.ts;
    if (messageTs) {
      const pending = getPendingRalph(messageTs);
      assert.ok(pending);
      assert.equal(pending.threadTs, "T1");
      assert.equal(pending.channelId, "C1");
      // Clean up
      removePendingRalph(messageTs);
    }
  });
});

describe("handleRalphPresetSelect", () => {
  it("updates message and stores selected preset", async () => {
    const client = makeMockClient();
    const session = makeMockSession("/tmp");
    const messageTs = "ralph-test-1";

    _setPendingRalph(messageTs, {
      threadTs: "T1",
      channelId: "C1",
      client,
      session,
      pickerMessageTs: messageTs,
    });

    await handleRalphPresetSelect(messageTs, "feature");

    // Check preset was stored
    const pending = getPendingRalph(messageTs);
    assert.ok(pending);
    assert.equal(pending.selectedPreset, "feature");

    // Check message was updated
    assert.ok(client.updated.length > 0);
    assert.ok(client.updated[0].text.includes("feature"));

    // Clean up
    removePendingRalph(messageTs);
  });

  it("ignores unknown message ts", async () => {
    await handleRalphPresetSelect("nonexistent", "feature");
    // Should not throw
  });
});

describe("tryConsumeRalphPrompt", () => {
  it("returns command when matching pending ralph prompt found", () => {
    const session = makeMockSession("/tmp");
    const messageTs = "ralph-consume-1";

    _setPendingRalph(messageTs, {
      threadTs: "T1",
      channelId: "C1",
      client: {} as any,
      session,
      pickerMessageTs: messageTs,
      selectedPreset: "feature",
    });

    const result = tryConsumeRalphPrompt("T1", "build a login form");
    assert.ok(result);
    assert.equal(result.command, "/ralph feature build a login form");
    assert.equal(result.session, session);

    // Should be consumed
    assert.equal(getPendingRalph(messageTs), undefined);
  });

  it("returns null when no pending ralph prompt", () => {
    const result = tryConsumeRalphPrompt("unknown-thread", "some text");
    assert.equal(result, null);
  });

  it("returns null when preset not yet selected", () => {
    const session = makeMockSession("/tmp");
    const messageTs = "ralph-consume-2";

    _setPendingRalph(messageTs, {
      threadTs: "T2",
      channelId: "C1",
      client: {} as any,
      session,
      pickerMessageTs: messageTs,
      // No selectedPreset
    });

    const result = tryConsumeRalphPrompt("T2", "some text");
    assert.equal(result, null);

    // Clean up
    removePendingRalph(messageTs);
  });
});

/* ------------------------------------------------------------------ */
/*  Prompt template picker                                             */
/* ------------------------------------------------------------------ */

describe("postPromptPicker", () => {
  it("posts buttons for available templates", async () => {
    const client = makeMockClient();
    const session = makeMockSession("/tmp", [
      { name: "review", description: "Code review", content: "", source: "", filePath: "" },
      { name: "test", description: "Generate tests", content: "", source: "", filePath: "" },
    ]);

    await postPromptPicker(client, "C1", "T1", session);

    assert.ok(client.posted.length > 0);
    const msg = client.posted[0];
    assert.ok(msg.blocks.length > 0);

    // Find the actions block with buttons
    const actionsBlock = msg.blocks.find((b: any) => b.type === "actions");
    assert.ok(actionsBlock);
    assert.equal(actionsBlock.elements.length, 2);
    assert.equal(actionsBlock.elements[0].text.text, "/review");
    assert.equal(actionsBlock.elements[0].value, "review");
    assert.equal(actionsBlock.elements[1].text.text, "/test");
    assert.equal(actionsBlock.elements[1].value, "test");
  });

  it("posts error when no templates available", async () => {
    const client = makeMockClient();
    const session = makeMockSession("/tmp", []);

    await postPromptPicker(client, "C1", "T1", session);

    assert.ok(client.posted.length > 0);
    assert.ok(client.posted[0].text.includes("No prompt templates"));
  });

  it("stores pending entry keyed by message ts", async () => {
    const client = makeMockClient();
    const session = makeMockSession("/tmp", [
      { name: "review", description: "Code review", content: "", source: "", filePath: "" },
    ]);

    await postPromptPicker(client, "C1", "T1", session);

    const messageTs = client.posted[0]?.ts;
    if (messageTs) {
      const pending = getPendingPromptPick(messageTs);
      assert.ok(pending);
      assert.equal(pending.threadTs, "T1");
      removePendingPromptPick(messageTs);
    }
  });
});

describe("handlePromptSelect", () => {
  it("updates message and enqueues the template command", async () => {
    const client = makeMockClient();
    const session = makeMockSession("/tmp");
    const messageTs = "prompt-test-1";

    _setPendingPromptPick(messageTs, {
      threadTs: "T1",
      channelId: "C1",
      client,
      session,
      pickerMessageTs: messageTs,
    });

    await handlePromptSelect(messageTs, "review");

    // Should be consumed
    assert.equal(getPendingPromptPick(messageTs), undefined);

    // Should have updated the message
    assert.ok(client.updated.length > 0);
    assert.ok(client.updated[0].text.includes("/review"));

    // Should have called prompt via enqueue
    assert.equal(session.prompt.mock.calls.length, 1);
    assert.equal(session.prompt.mock.calls[0][0], "/review");
  });

  it("ignores unknown message ts", async () => {
    await handlePromptSelect("nonexistent", "review");
    // Should not throw
  });
});
