import { App } from "@slack/bolt";
import { homedir } from "os";
import type { Config } from "./config.js";
import { BotSessionManager, SessionLimitError } from "./session-manager.js";

export function createApp(config: Config): { app: App; sessionManager: BotSessionManager } {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  const sessionManager = new BotSessionManager(config, app.client);

  app.event("message", async ({ event, client }) => {
    if (!("user" in event) || !("text" in event)) return;
    if (event.subtype === "bot_message") return;
    if (event.user !== config.slackUserId) return;

    const channel = event.channel;
    const threadTs = ("thread_ts" in event ? event.thread_ts : undefined) ?? event.ts;
    const text = event.text ?? "";

    let session;
    try {
      session = await sessionManager.getOrCreate({
        threadTs,
        channelId: channel,
        cwd: homedir(),
      });
    } catch (err) {
      if (err instanceof SessionLimitError) {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: "⚠️ Too many active sessions. Try again later.",
        });
        return;
      }
      throw err;
    }

    session.enqueue(() => session.prompt(text));
  });

  return { app, sessionManager };
}
