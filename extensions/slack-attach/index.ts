import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import WebSocket from "ws";

export default function slackAttach(pi: ExtensionAPI) {
  let ws: WebSocket | null = null;
  let connected = false;

  pi.registerCommand("attach", {
    description: "Attach this session to a Slack DM thread",
    handler: async (args, ctx) => {
      const botUrl = args.trim() || process.env.PI_SLACK_BOT_URL || "ws://localhost:3001";

      if (connected && ws) {
        ctx.ui.notify("Already attached. Use /detach first.", "warning");
        return;
      }

      ws = new WebSocket(botUrl);

      ws.on("open", () => {
        connected = true;
        ctx.ui.setStatus("slack", ctx.ui.theme.fg("accent", "🔗 Slack"));
        ctx.ui.notify(`Connected to ${botUrl}`, "info");

        ws!.send(JSON.stringify({
          type: "register",
          sessionId: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
        }));
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "user_message") {
          pi.sendUserMessage(msg.text);
        } else if (msg.type === "thread_created") {
          ctx.ui.notify(`Slack thread: ${msg.threadUrl}`, "info");
        } else if (msg.type === "cancel") {
          ctx.abort();
        }
      });

      ws.on("close", () => {
        connected = false;
        ws = null;
        ctx.ui.setStatus("slack", "");
        ctx.ui.notify("Disconnected from Slack bot", "warning");
      });

      ws.on("error", (err) => {
        ctx.ui.notify(`Slack connection error: ${err.message}`, "error");
      });
    },
  });

  pi.registerCommand("detach", {
    description: "Detach from Slack DM thread",
    handler: async (_args, ctx) => {
      if (ws) {
        try {
          ws.send(JSON.stringify({ type: "detach" }));
        } catch {
          // ws may already be closing
        }
        ws.close();
        ws = null;
        connected = false;
        ctx.ui.setStatus("slack", "");
        ctx.ui.notify("Detached from Slack", "info");
      } else {
        ctx.ui.notify("Not attached", "warning");
      }
    },
  });

  // Forward agent events to Slack bot
  pi.on("message_update", async (event) => {
    if (!connected || !ws) return;
    if (event.assistantMessageEvent.type === "text_delta") {
      ws.send(JSON.stringify({
        type: "text_delta",
        delta: event.assistantMessageEvent.delta,
      }));
    }
  });

  pi.on("tool_execution_start", async (event) => {
    if (!connected || !ws) return;
    ws.send(JSON.stringify({
      type: "tool_start",
      toolName: event.toolName,
      args: event.args,
    }));
  });

  pi.on("tool_execution_end", async (event) => {
    if (!connected || !ws) return;
    ws.send(JSON.stringify({
      type: "tool_end",
      toolName: event.toolName,
      isError: event.isError,
    }));
  });

  pi.on("agent_start", async () => {
    if (!connected || !ws) return;
    ws.send(JSON.stringify({ type: "agent_start" }));
  });

  pi.on("agent_end", async () => {
    if (!connected || !ws) return;
    ws.send(JSON.stringify({ type: "agent_end" }));
  });

  pi.on("auto_retry_start", async () => {
    if (!connected || !ws) return;
    ws.send(JSON.stringify({ type: "retry_start" }));
  });

  pi.on("session_shutdown", async () => {
    if (ws) {
      ws.close();
      ws = null;
      connected = false;
    }
  });
}
