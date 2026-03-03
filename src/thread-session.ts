import path from "path";
import { createAgentSession, createCodingTools, SessionManager as PiSessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "@mariozechner/pi-coding-agent";
import type { WebClient } from "@slack/web-api";
import type { Config, ThinkingLevel } from "./config.js";

export interface ThreadSessionCreateParams {
  threadTs: string;
  channelId: string;
  cwd: string;
  config: Config;
  client: WebClient;
  sessionDir: string;
}

export class ThreadSession {
  readonly threadTs: string;
  readonly channelId: string;
  cwd: string;
  lastActivity: Date;

  private _agentSession: AgentSession;
  private _client: WebClient;
  private _tasks: Array<() => Promise<void>> = [];
  private _processing = false;

  constructor(
    threadTs: string,
    channelId: string,
    cwd: string,
    client: WebClient,
    agentSession: AgentSession,
  ) {
    this.threadTs = threadTs;
    this.channelId = channelId;
    this.cwd = cwd;
    this._client = client;
    this._agentSession = agentSession;
    this.lastActivity = new Date();
  }

  static async create(params: ThreadSessionCreateParams): Promise<ThreadSession> {
    const sessionFilePath = path.join(params.sessionDir, `${params.threadTs}.jsonl`);
    const piSessionManager = PiSessionManager.open(sessionFilePath);

    const { session } = await createAgentSession({
      cwd: params.cwd,
      sessionManager: piSessionManager,
      tools: createCodingTools(params.cwd),
    });

    return new ThreadSession(
      params.threadTs,
      params.channelId,
      params.cwd,
      params.client,
      session,
    );
  }

  enqueue(task: () => Promise<void>): void {
    this.lastActivity = new Date();
    this._tasks.push(task);
    if (!this._processing) void this._drain();
  }

  private async _drain(): Promise<void> {
    this._processing = true;
    while (this._tasks.length > 0) {
      const task = this._tasks.shift()!;
      try {
        await task();
      } catch (err) {
        console.error(`[ThreadSession ${this.threadTs}] Task error:`, err);
      }
    }
    this._processing = false;
  }

  async prompt(text: string): Promise<void> {
    let accumulated = "";
    const unsub = this._agentSession.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        accumulated += event.assistantMessageEvent.delta;
      }
    });
    try {
      await this._agentSession.prompt(text);
      if (accumulated) {
        await this._client.chat.postMessage({
          channel: this.channelId,
          thread_ts: this.threadTs,
          text: accumulated,
        });
      }
    } finally {
      unsub();
    }
  }

  abort(): void {
    void this._agentSession.abort();
  }

  async dispose(): Promise<void> {
    this._agentSession.dispose();
  }

  async newSession(): Promise<void> {
    await this._agentSession.newSession();
  }

  get isStreaming(): boolean {
    return this._agentSession.isStreaming;
  }

  get messageCount(): number {
    return this._agentSession.messages.length;
  }

  get model(): AgentSession["model"] {
    return this._agentSession.model;
  }

  get thinkingLevel(): ThinkingLevel {
    return this._agentSession.thinkingLevel as ThinkingLevel;
  }

  subscribe(handler: AgentSessionEventListener): () => void {
    return this._agentSession.subscribe(handler);
  }
}
