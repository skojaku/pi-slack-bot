import { slackifyMarkdown } from "slackify-markdown";

/**
 * Convert markdown to Slack mrkdwn.
 * If partial=true, close any unclosed triple-backtick code blocks first
 * so slackify-markdown doesn't produce broken output mid-stream.
 */
export function markdownToMrkdwn(markdown: string, partial?: boolean): string {
  let md = markdown;
  if (partial) {
    const fenceCount = (md.match(/```/g) ?? []).length;
    if (fenceCount % 2 !== 0) md += "\n```";
  }
  return slackifyMarkdown(md);
}

/**
 * Split mrkdwn into chunks ≤ limit chars.
 * Split priority: paragraph break > line break > space > hard cut.
 * Never splits inside a code block (counts ``` pairs).
 */
export function splitMrkdwn(mrkdwn: string, limit = 3900): string[] {
  if (mrkdwn.length <= limit) return [mrkdwn];

  const chunks: string[] = [];
  let remaining = mrkdwn;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);

    // Find a safe split point — not inside a code block
    const splitAt = findSplitPoint(window);
    const chunk = remaining.slice(0, splitAt).trimEnd();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}

function findSplitPoint(text: string): number {
  // Try paragraph break first, then line break, then space
  for (const sep of ["\n\n", "\n", " "]) {
    const idx = lastSafeSplit(text, sep);
    if (idx > 0) return idx + sep.length;
  }
  // Hard cut
  return text.length;
}

/**
 * Find the last occurrence of sep that is NOT inside a code block.
 * Returns the index of sep, or -1 if none found.
 */
function lastSafeSplit(text: string, sep: string): number {
  let best = -1;
  let inCode = false;
  let i = 0;

  while (i < text.length) {
    if (text.startsWith("```", i)) {
      inCode = !inCode;
      i += 3;
      continue;
    }
    if (!inCode && text.startsWith(sep, i)) {
      best = i;
      i += sep.length;
      continue;
    }
    i++;
  }

  return best;
}

/**
 * Format a tool execution start line.
 * → "> 🔧 `tool_name`(arg1, arg2)"
 */
export function formatToolStart(toolName: string, args: unknown): string {
  const argStr = formatArgs(args);
  return `> 🔧 \`${toolName}\`(${argStr})`;
}

/**
 * Format a tool execution end line.
 * → "> ✅ `tool_name`" or "> ❌ `tool_name`"
 */
export function formatToolEnd(toolName: string, isError: boolean): string {
  const icon = isError ? "❌" : "✅";
  return `> ${icon} \`${toolName}\``;
}

function formatArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return String(args);

  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return "";

  return entries
    .slice(0, 3)
    .map(([, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return s.length > 40 ? s.slice(0, 37) + "..." : s;
    })
    .join(", ");
}
