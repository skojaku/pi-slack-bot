import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markdownToMrkdwn, splitMrkdwn, formatToolStart, formatToolEnd } from "./formatter.js";

describe("markdownToMrkdwn", () => {
  it("converts bold", () => {
    const result = markdownToMrkdwn("**hello**");
    assert.ok(result.includes("*hello*"), `got: ${result}`);
  });

  it("converts italic", () => {
    const result = markdownToMrkdwn("_hello_");
    assert.ok(result.includes("_hello_"), `got: ${result}`);
  });

  it("converts inline code", () => {
    const result = markdownToMrkdwn("`code`");
    assert.ok(result.includes("`code`"), `got: ${result}`);
  });

  it("converts links", () => {
    const result = markdownToMrkdwn("[text](https://example.com)");
    assert.ok(result.includes("<https://example.com|text>"), `got: ${result}`);
  });

  it("partial=true closes unclosed code block", () => {
    const partial = "some text\n```\ncode here";
    const result = markdownToMrkdwn(partial, true);
    // Should not throw and should produce valid output
    assert.ok(typeof result === "string");
    assert.ok(result.includes("code here"), `got: ${result}`);
  });

  it("partial=false leaves unclosed block as-is (may produce odd output but no crash)", () => {
    const partial = "text\n```\ncode";
    assert.doesNotThrow(() => markdownToMrkdwn(partial, false));
  });

  it("even fence count not modified by partial=true", () => {
    const md = "```\ncode\n```";
    const r1 = markdownToMrkdwn(md, false);
    const r2 = markdownToMrkdwn(md, true);
    assert.equal(r1, r2);
  });
});

describe("splitMrkdwn", () => {
  it("returns single chunk when under limit", () => {
    const chunks = splitMrkdwn("hello world", 3900);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "hello world");
  });

  it("splits at paragraph boundary", () => {
    const a = "a".repeat(2000);
    const b = "b".repeat(2000);
    const text = `${a}\n\n${b}`;
    const chunks = splitMrkdwn(text, 3900);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], a);
    assert.equal(chunks[1], b);
  });

  it("splits at line boundary when no paragraph", () => {
    const a = "a".repeat(2000);
    const b = "b".repeat(2000);
    const text = `${a}\n${b}`;
    const chunks = splitMrkdwn(text, 3900);
    assert.equal(chunks.length, 2);
  });

  it("hard cuts when no whitespace", () => {
    const text = "a".repeat(5000);
    const chunks = splitMrkdwn(text, 3900);
    assert.ok(chunks.length >= 2);
    for (const c of chunks) assert.ok(c.length <= 3900);
  });

  it("never splits inside a code block that fits within limit", () => {
    // "before" paragraph + code block (fits in 3900) + "after" paragraph
    // Total > 3900 so a split is needed, but the code block itself fits
    const code = "x".repeat(500);
    const before = "b".repeat(2000);
    const after = "a".repeat(2000);
    const text = `${before}\n\n\`\`\`\n${code}\n\`\`\`\n\n${after}`;
    const chunks = splitMrkdwn(text, 3900);
    // Each chunk must have an even number of ``` fences
    for (const c of chunks) {
      const fences = (c.match(/```/g) ?? []).length;
      assert.equal(fences % 2, 0, `odd fences in chunk: ${c.slice(0, 100)}`);
    }
  });

  it("all chunks within limit", () => {
    const text = "word ".repeat(2000);
    const chunks = splitMrkdwn(text, 3900);
    for (const c of chunks) assert.ok(c.length <= 3900, `chunk too long: ${c.length}`);
  });
});

describe("formatToolStart", () => {
  it("formats tool name and args", () => {
    const result = formatToolStart("read", { path: "/foo/bar.ts" });
    assert.equal(result, "> 🔧 `read`(/foo/bar.ts)");
  });

  it("handles empty args", () => {
    const result = formatToolStart("list", {});
    assert.equal(result, "> 🔧 `list`()");
  });

  it("truncates long arg values", () => {
    const result = formatToolStart("bash", { command: "a".repeat(100) });
    assert.ok(result.includes("..."), `got: ${result}`);
  });
});

describe("formatToolEnd", () => {
  it("formats success", () => {
    assert.equal(formatToolEnd("read", false), "> ✅ `read`");
  });

  it("formats error", () => {
    assert.equal(formatToolEnd("read", true), "> ❌ `read`");
  });
});
