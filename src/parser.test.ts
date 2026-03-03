import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "os";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { parseMessage, fuzzyMatch, scanProjects } from "./parser.js";

describe("parseMessage", () => {
  it("returns full text as prompt when no token", () => {
    const r = parseMessage("", []);
    assert.equal(r.cwd, null);
    assert.equal(r.prompt, "");
    assert.deepEqual(r.candidates, []);
  });

  it("resolves valid absolute path as cwd", () => {
    const dir = tmpdir();
    const r = parseMessage(`${dir} do something`, []);
    assert.equal(r.cwd, dir);
    assert.equal(r.prompt, "do something");
    assert.deepEqual(r.candidates, []);
  });

  it("expands ~ to home dir", () => {
    // ~ itself is the home dir
    const r = parseMessage("~ list files", []);
    assert.ok(r.cwd !== null, "should resolve ~ to home dir");
    assert.ok(!r.cwd!.startsWith("~"));
    assert.equal(r.prompt, "list files");
  });

  it("returns full text as prompt when path not found", () => {
    const r = parseMessage("/nonexistent/path/xyz do something", []);
    assert.equal(r.cwd, null);
    assert.equal(r.prompt, "/nonexistent/path/xyz do something");
  });

  it("fuzzy matches against known projects", () => {
    const projects = ["/workplace/my-cool-project", "/workplace/other-thing"];
    const r = parseMessage("cool do something", projects);
    assert.equal(r.cwd, null);
    assert.ok(r.candidates.includes("/workplace/my-cool-project"));
    assert.equal(r.prompt, "cool do something");
  });

  it("returns empty candidates when no fuzzy match", () => {
    const projects = ["/workplace/alpha", "/workplace/beta"];
    const r = parseMessage("zzznomatch do something", projects);
    assert.deepEqual(r.candidates, []);
    assert.equal(r.prompt, "zzznomatch do something");
  });
});

describe("fuzzyMatch", () => {
  const projects = [
    "/workplace/pi-slack-bot",
    "/workplace/pi-core",
    "/workplace/my-service",
    "/workplace/another-service",
    "/workplace/test-app",
    "/workplace/extra-app",
  ];

  it("matches by basename substring", () => {
    const r = fuzzyMatch("slack", projects);
    assert.ok(r.includes("/workplace/pi-slack-bot"));
  });

  it("is case-insensitive", () => {
    const r = fuzzyMatch("SLACK", projects);
    assert.ok(r.includes("/workplace/pi-slack-bot"));
  });

  it("returns up to 5 results", () => {
    // "app" matches test-app and extra-app, "service" matches two, "pi" matches two
    const r = fuzzyMatch("a", projects); // matches many
    assert.ok(r.length <= 5);
  });

  it("returns empty array when no match", () => {
    const r = fuzzyMatch("zzznomatch", projects);
    assert.deepEqual(r, []);
  });

  it("matches partial basename", () => {
    const r = fuzzyMatch("pi-", projects);
    assert.ok(r.length >= 2);
  });
});

describe("scanProjects", () => {
  it("returns subdirectories of workspace dirs", () => {
    const base = join(tmpdir(), `scan-test-${Date.now()}`);
    mkdirSync(join(base, "proj-a"), { recursive: true });
    mkdirSync(join(base, "proj-b"), { recursive: true });

    try {
      const results = scanProjects([base]);
      assert.ok(results.some((p) => p.endsWith("proj-a")));
      assert.ok(results.some((p) => p.endsWith("proj-b")));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("skips non-existent dirs without throwing", () => {
    assert.doesNotThrow(() => scanProjects(["/nonexistent/path/xyz"]));
  });

  it("returns empty array for empty workspace dir", () => {
    const base = join(tmpdir(), `scan-empty-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    try {
      const results = scanProjects([base]);
      assert.deepEqual(results, []);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
