import type { WebClient } from "@slack/web-api";
import { markdownToMrkdwn, splitMrkdwn, formatToolStart, formatToolEnd } from "./formatter.js";

export interface StreamingState {
  channelId: string;
  threadTs: string;
  initialMessageTs: string;
  currentMessageTs: string;
  rawMarkdown: string;
  toolLines: string[];
  postedMessageTs: string[];
  timer: ReturnType<typeof setTimeout> | null;
  retryCount: number;
}

export class StreamingUpdater {
  private _client: WebClient;
  private _throttleMs: number;
  private _msgLimit: number;

  constructor(client: WebClient, throttleMs = 3000, msgLimit = 3900) {
    this._client = client;
    this._throttleMs = throttleMs;
    this._msgLimit = msgLimit;
  }

  async begin(channelId: string, threadTs: string): Promise<StreamingState> {
    const res = await this._client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "⏳ Thinking...",
    });

    await this._client.reactions.add({
      channel: channelId,
      timestamp: res.ts!,
      name: "hourglass_flowing_sand",
    });

    return {
      channelId,
      threadTs,
      initialMessageTs: res.ts!,
      currentMessageTs: res.ts!,
      rawMarkdown: "",
      toolLines: [],
      postedMessageTs: [],
      timer: null,
      retryCount: 0,
    };
  }

  appendText(state: StreamingState, delta: string): void {
    state.rawMarkdown += delta;
    this._scheduleFlush(state);
  }

  appendToolStart(state: StreamingState, toolName: string, args: unknown): void {
    state.toolLines.push(formatToolStart(toolName, args));
    this._immediateFlush(state);
  }

  appendToolEnd(state: StreamingState, toolName: string, isError: boolean): void {
    const endLine = formatToolEnd(toolName, isError);
    // Replace the matching 🔧 line with the result icon
    const idx = state.toolLines.findIndex((l) => l.includes(`\`${toolName}\``) && l.includes("🔧"));
    if (idx !== -1) {
      state.toolLines[idx] = endLine;
    } else {
      state.toolLines.push(endLine);
    }
    this._immediateFlush(state);
  }

  appendRetry(state: StreamingState, attempt: number): void {
    state.retryCount = attempt;
    state.rawMarkdown += `\n_↩️ Retrying (${attempt}/3)..._\n`;
    this._scheduleFlush(state);
  }

  async finalize(state: StreamingState): Promise<void> {
    this._cancelTimer(state);
    await this._flush(state, false);

    await this._client.reactions.remove({
      channel: state.channelId,
      timestamp: state.initialMessageTs,
      name: "hourglass_flowing_sand",
    });

    await this._client.reactions.add({
      channel: state.channelId,
      timestamp: state.initialMessageTs,
      name: "white_check_mark",
    });
  }

  async error(state: StreamingState, err: Error): Promise<void> {
    this._cancelTimer(state);
    await this._client.chat.postMessage({
      channel: state.channelId,
      thread_ts: state.threadTs,
      text: `❌ Error: ${err.message}`,
    });

    try {
      await this._client.reactions.remove({
        channel: state.channelId,
        timestamp: state.initialMessageTs,
        name: "hourglass_flowing_sand",
      });
    } catch {
      // reaction may already be removed
    }
  }

  private _scheduleFlush(state: StreamingState): void {
    if (state.timer !== null) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      this._flush(state, true).catch((err) => console.error("[StreamingUpdater] flush error:", err));
    }, this._throttleMs);
  }

  private _immediateFlush(state: StreamingState): void {
    this._cancelTimer(state);
    this._flush(state, true).catch((err) => console.error("[StreamingUpdater] flush error:", err));
  }

  private _cancelTimer(state: StreamingState): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private async _flush(state: StreamingState, partial: boolean): Promise<void> {
    const body = state.rawMarkdown.trim();
    const toolBlock = state.toolLines.join("\n");
    const combined = toolBlock ? `${body}\n\n${toolBlock}` : body;
    if (!combined) return;

    const mrkdwn = markdownToMrkdwn(combined, partial);
    const chunks = splitMrkdwn(mrkdwn, this._msgLimit);

    // Update the current message with the first chunk
    await this._client.chat.update({
      channel: state.channelId,
      ts: state.currentMessageTs,
      text: chunks[0],
    });

    // Post remaining chunks as new thread replies
    for (let i = 1; i < chunks.length; i++) {
      const res = await this._client.chat.postMessage({
        channel: state.channelId,
        thread_ts: state.threadTs,
        text: chunks[i],
      });
      state.postedMessageTs.push(state.currentMessageTs);
      state.currentMessageTs = res.ts!;
    }
  }
}
