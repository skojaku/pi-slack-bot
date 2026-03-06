/**
 * Diff reviewer — generates git diffs and uploads them to paste.amazon.com
 * for syntax-highlighted review, posting the link to Slack.
 *
 * Handles three scenarios:
 * 1. Uncommitted changes → `git diff HEAD` + untracked files
 * 2. Agent committed during turn → `git diff <baseRef>` to capture committed + uncommitted
 * 3. No git repo → synthetic diffs from edit/write tool args
 *
 * Also provides an on-demand `!diff` command.
 */
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import type { WebClient } from "@slack/web-api";
import type { ToolCallRecord } from "./formatter.js";

/** Tool names that modify files on disk. */
const FILE_MUTATING_TOOLS = new Set(["edit", "write"]);

/**
 * Extract the list of file paths modified by edit/write tool calls.
 * Returns deduplicated paths in call order.
 */
export function extractModifiedFiles(records: ToolCallRecord[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const r of records) {
    if (!FILE_MUTATING_TOOLS.has(r.toolName)) continue;
    const args = r.args as Record<string, unknown> | null;
    const filePath = args?.path;
    if (typeof filePath !== "string") continue;
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    paths.push(filePath);
  }

  return paths;
}

/**
 * Check whether any tool records include file-mutating operations.
 */
export function hasFileModifications(records: ToolCallRecord[]): boolean {
  return records.some((r) => FILE_MUTATING_TOOLS.has(r.toolName));
}

export interface DiffResult {
  /** The raw unified diff output */
  diff: string;
  /** Number of files with changes */
  fileCount: number;
  /** Summary stats: insertions, deletions */
  stats: string;
}

/**
 * Get the current git HEAD SHA for a directory.
 * Returns null if not in a git repo or no commits exist.
 */
export function getHeadRef(cwd: string): string | null {
  try {
    return execSync("git rev-parse HEAD", { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return null;
  }
}

/**
 * Check if a directory is inside a git repo.
 */
export function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export interface GenerateDiffOptions {
  /**
   * Base commit to diff from (e.g. the HEAD SHA at agent turn start).
   * When set, the diff includes committed changes since this ref plus
   * any uncommitted working tree changes and untracked files.
   * When unset, only uncommitted changes and untracked files are shown.
   */
  baseRef?: string;
}

/**
 * Generate a git diff for the working directory.
 *
 * With baseRef: shows everything from that commit to current state
 * (committed + staged + unstaged + untracked).
 *
 * Without baseRef: shows only uncommitted changes
 * (staged + unstaged + untracked).
 *
 * Returns null if not in a git repo or no changes found.
 */
export function generateDiff(cwd: string, options?: GenerateDiffOptions): DiffResult | null {
  if (!isGitRepo(cwd)) return null;

  try {
    const baseRef = options?.baseRef;

    // Get diff of changes. When baseRef is provided, this captures both
    // committed changes (since baseRef) AND uncommitted working tree changes.
    // `git diff <ref>` compares <ref> to the working tree (not HEAD).
    let diff: string;
    const diffCmd = baseRef ? `git diff ${baseRef}` : "git diff HEAD";
    try {
      diff = execSync(diffCmd, { cwd, encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 });
    } catch {
      // Fall back for repos with no commits yet
      diff = execSync("git diff --cached", { cwd, encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 });
    }

    // Also pick up untracked new files by diffing them against /dev/null
    diff = appendUntrackedDiffs(diff, cwd);

    if (!diff.trim()) return null;

    return buildDiffResult(diff);
  } catch (err) {
    console.error("[DiffReviewer] Error generating diff:", err);
    return null;
  }
}

/**
 * Append diffs for untracked files (new files not yet `git add`-ed).
 */
function appendUntrackedDiffs(diff: string, cwd: string): string {
  const untracked = execSync("git ls-files --others --exclude-standard", {
    cwd,
    encoding: "utf-8",
  }).trim();

  if (!untracked) return diff;

  for (const file of untracked.split("\n").filter(Boolean)) {
    try {
      const fileDiff = execSync(`git diff --no-index /dev/null "${file}" || true`, {
        cwd,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
      });
      if (fileDiff.trim()) {
        diff += "\n" + fileDiff;
      }
    } catch {
      // Some files may not be diffable (binary, etc.), skip
    }
  }

  return diff;
}

/**
 * Generate a synthetic diff from edit/write tool records.
 * Used when the working directory is not a git repo.
 *
 * - `edit` calls have `path`, `oldText`, `newText` → inline replacement diff
 * - `write` calls have `path`, `content` → show full file as new content
 */
export function generateSyntheticDiff(records: ToolCallRecord[], cwd: string): DiffResult | null {
  const parts: string[] = [];

  // Deduplicate: for write calls to the same file, only show the last one.
  // For edit calls, show each one (they're incremental).
  const seenWrites = new Set<string>();

  // Process in reverse so we can skip earlier writes to the same file
  const reversed = [...records].reverse();
  const toProcess: ToolCallRecord[] = [];

  for (const r of reversed) {
    if (r.toolName === "write") {
      const args = r.args as Record<string, unknown> | null;
      const filePath = typeof args?.path === "string" ? args.path : null;
      if (!filePath || seenWrites.has(filePath)) continue;
      seenWrites.add(filePath);
      toProcess.unshift(r);
    } else if (r.toolName === "edit") {
      toProcess.unshift(r);
    }
  }

  for (const r of toProcess) {
    const args = r.args as Record<string, unknown> | null;
    if (!args) continue;
    const filePath = typeof args.path === "string" ? args.path : null;
    if (!filePath) continue;

    if (r.toolName === "edit") {
      const oldText = typeof args.oldText === "string" ? args.oldText : "";
      const newText = typeof args.newText === "string" ? args.newText : "";
      if (oldText || newText) {
        parts.push(formatEditDiff(filePath, oldText, newText));
      }
    } else if (r.toolName === "write") {
      const content = typeof args.content === "string" ? args.content : "";
      parts.push(formatNewFileDiff(filePath, content));
    }
  }

  if (parts.length === 0) return null;

  const diff = parts.join("\n");
  return buildDiffResult(diff);
}

/**
 * Format a synthetic diff for an edit (oldText → newText replacement).
 */
function formatEditDiff(path: string, oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const header = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];
  const body = [
    ...oldLines.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`),
  ];
  return [...header, ...body].join("\n");
}

/**
 * Format a synthetic diff for a new/overwritten file.
 */
function formatNewFileDiff(path: string, content: string): string {
  const lines = content.split("\n");
  const header = [
    `diff --git a/${path} b/${path}`,
    `new file mode 100644`,
    `--- /dev/null`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
  ];
  const body = lines.map((l) => `+${l}`);
  return [...header, ...body].join("\n");
}

/**
 * Build a DiffResult from raw unified diff content.
 */
function buildDiffResult(diff: string): DiffResult {
  const { fileCount, insertions, deletions } = computeDiffStats(diff);
  const statParts: string[] = [];
  statParts.push(`${fileCount} file${fileCount === 1 ? "" : "s"} changed`);
  if (insertions > 0) statParts.push(`${insertions} insertion${insertions === 1 ? "" : "s"}(+)`);
  if (deletions > 0) statParts.push(`${deletions} deletion${deletions === 1 ? "" : "s"}(-)`);
  return { diff, fileCount, stats: statParts.join(", ") };
}

/**
 * Compute diff stats by parsing the unified diff content directly.
 * This correctly counts untracked files (which `git diff HEAD --stat` misses).
 */
export function computeDiffStats(diff: string): {
  fileCount: number;
  insertions: number;
  deletions: number;
} {
  const lines = diff.split("\n");
  let fileCount = 0;
  let insertions = 0;
  let deletions = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ") || line.startsWith("diff --no-index ")) {
      fileCount++;
      inHunk = false;
    } else if (line.startsWith("@@ ")) {
      inHunk = true;
    } else if (inHunk) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        insertions++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        deletions++;
      }
    }
  }

  return { fileCount, insertions, deletions };
}

export interface PasteResult {
  /** The paste URL (e.g. https://paste.amazon.com/show/samfp/1234567890) */
  url: string;
}

/**
 * Create a paste on paste.amazon.com with the given content.
 * Returns the paste URL, or null if the upload fails.
 *
 * Uses midway cookie auth (must have valid midway session).
 */
export function createPaste(content: string, title: string, language = "diff"): PasteResult | null {
  const cookieFile = `${process.env.HOME}/.midway/cookie`;

  try {
    // Step 1: GET the page to obtain a CSRF authenticity token
    const pageHtml = execSync(
      `curl -s --anyauth --location-trusted --negotiate -u : ` +
      `--cookie "${cookieFile}" --cookie-jar "${cookieFile}" ` +
      `"https://paste.amazon.com/"`,
      { encoding: "utf-8", timeout: 15000 },
    );

    const tokenMatch = pageHtml.match(/name="authenticity_token"[^>]*value="([^"]+)"/);
    if (!tokenMatch) {
      console.error("[DiffReviewer] Could not extract CSRF token from paste.amazon.com");
      return null;
    }
    const token = tokenMatch[1];

    // Step 2: POST the paste content. Write content to a temp file to avoid
    // shell escaping issues with large diffs.
    const tmpFile = `/tmp/pi-diff-paste-${Date.now()}.txt`;
    writeFileSync(tmpFile, content, "utf-8");

    try {
      const headers = execSync(
        `curl -s --anyauth --location-trusted --negotiate -u : ` +
        `--cookie "${cookieFile}" --cookie-jar "${cookieFile}" ` +
        `-X POST "https://paste.amazon.com/create" ` +
        `--data-urlencode "authenticity_token=${token}" ` +
        `--data-urlencode "text@${tmpFile}" ` +
        `--data-urlencode "language=${language}" ` +
        `--data-urlencode "title=${title}" ` +
        `--data-urlencode "numbers=1" ` +
        `-D - -o /dev/null`,
        { encoding: "utf-8", timeout: 30000 },
      );

      const locationMatch = headers.match(/^location:\s*(.+)$/mi);
      if (!locationMatch) {
        console.error("[DiffReviewer] No redirect location from paste.amazon.com create");
        return null;
      }

      return { url: locationMatch[1].trim() };
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  } catch (err) {
    console.error("[DiffReviewer] Failed to create paste:", err);
    return null;
  }
}

/**
 * Upload a diff via paste.amazon.com (preferred) or Slack file snippet (fallback).
 */
async function uploadAndPost(
  client: WebClient,
  channelId: string,
  threadTs: string,
  result: DiffResult,
): Promise<void> {
  const title = `${result.fileCount} file${result.fileCount === 1 ? "" : "s"} changed`;

  // Try paste.amazon.com first for nice syntax-highlighted rendering
  const paste = createPaste(result.diff, title);
  if (paste) {
    const statsLine = result.stats ? `\n> ${result.stats}` : "";
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `📝 <${paste.url}|${title}>${statsLine}`,
      unfurl_links: false,
    });
    return;
  }

  // Fallback: upload as Slack file snippet
  console.warn("[DiffReviewer] paste.amazon.com failed, falling back to Slack file snippet");
  await client.files.uploadV2({
    channel_id: channelId,
    thread_ts: threadTs,
    content: result.diff,
    filename: "changes.diff",
    title: `📝 ${title}`,
    initial_comment: result.stats ? `> ${result.stats}` : undefined,
  });
}

export interface PostDiffOptions {
  /**
   * Base git ref from before the agent turn started.
   * Used to detect committed changes.
   */
  baseRef?: string | null;
  /**
   * Tool records from the agent turn.
   * Used for synthetic diffs when not in a git repo.
   */
  toolRecords?: ToolCallRecord[];
}

/**
 * Post a diff review for the current working directory.
 *
 * Strategy:
 * 1. Git repo with baseRef → diff from baseRef (catches commits + uncommitted)
 * 2. Git repo without baseRef → diff from HEAD (uncommitted only, for !diff command)
 * 3. No git repo with tool records → synthetic diff from edit/write args
 *
 * Returns true if a diff was posted, false if no changes found.
 */
export async function postDiffReview(
  client: WebClient,
  channelId: string,
  threadTs: string,
  cwd: string,
  options?: PostDiffOptions,
): Promise<boolean> {
  const baseRef = options?.baseRef ?? undefined;
  const toolRecords = options?.toolRecords;

  // Try git diff first (handles both committed and uncommitted)
  const gitResult = generateDiff(cwd, { baseRef });
  if (gitResult) {
    await uploadAndPost(client, channelId, threadTs, gitResult);
    return true;
  }

  // No git changes (or not a git repo) — try synthetic diff from tool records
  if (toolRecords && toolRecords.length > 0) {
    const syntheticResult = generateSyntheticDiff(toolRecords, cwd);
    if (syntheticResult) {
      await uploadAndPost(client, channelId, threadTs, syntheticResult);
      return true;
    }
  }

  return false;
}
