require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const Anthropic = require("@anthropic-ai/sdk");
const { SYSTEM_PROMPT, TAKE_MESSAGE_TOOL, END_CALL_TOOL } = require("./persona");
const { notifyMessageTaken } = require("./notifications");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PORT = process.env.PORT || 3000;
// Set this to your deployed Railway URL once you have it, e.g. chyne-tire-ai-answering-production.up.railway.app
const PUBLIC_HOSTNAME = process.env.PUBLIC_HOSTNAME;

// ---- 1. Voice webhook: Twilio hits this when a call comes in ----
app.post("/voice", (req, res) => {
  const wsUrl = `wss://${PUBLIC_HOSTNAME}/relay`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${wsUrl}" welcomeGreeting="Hi, thanks for calling Chyne Tire! How can I help you today?" />
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

app.get("/", (req, res) => res.send("Chyne Tire AI answering - voice server is running."));

// ---- 2. WebSocket relay: Twilio ConversationRelay connects here per-call ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/relay" });

wss.on("connection", (ws) => {
  let history = [];
  let callSid = null;
  let callerNumber = null;
  let callEnding = false;
  let messageTaken = false;

  const SILENCE_TIMEOUT_MS = 20000;
  let silenceTimer = null;

  function resetSilenceTimer(extraDelayMs = 0) {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      callEnding = true;
      console.log(`Call ${callSid} ended: silence timeout`);
      ws.send(
        JSON.stringify({
          type: "text",
          token: "Looks like we may have gotten disconnected - feel free to call back anytime. Goodbye!",
          last: true,
        })
      );
      ws.send(JSON.stringify({ type: "end" }));
      ws.close();
    }, SILENCE_TIMEOUT_MS + extraDelayMs);
  }

  ws.on("message", async (raw) => {
    if (callEnding) return;

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.error("Bad message from Twilio:", raw.toString());
      return;
    }

    if (msg.type === "setup") {
      callSid = msg.callSid;
      callerNumber = msg.from;
      console.log(`Call started: ${callSid} from ${callerNumber}`);
      resetSilenceTimer();
      return;
    }

    if (msg.type === "prompt") {
      resetSilenceTimer();
      if (msg.last) {
        history.push({ role: "user", content: msg.voicePrompt });
        await respond(ws, history, "voice", callerNumber);
      }
      return;
    }

    if (msg.type === "interrupt") {
      const last = history[history.length - 1];
      if (last && last.role === "assistant" && typeof last.content === "string") {
        last.content = msg.utteranceUntilInterrupt || last.content;
      }
      return;
    }

    if (msg.type === "error") {
      console.error("ConversationRelay error:", msg.description);
    }
  });

  ws.on("close", () => {
    clearTimeout(silenceTimer);
    console.log(`Call ended: ${callSid}`);
  });

  async function respond(ws, history, channel, callerNumber) {
    try {
      const stream = anthropic.messages.stream({
        model: "claude-sonnet-5",
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        tools: [TAKE_MESSAGE_TOOL, END_CALL_TOOL],
        messages: history,
      });

      let fullText = "";
      stream.on("text", (textDelta) => {
        fullText += textDelta;
        ws.send(
          JSON.stringify({
            type: "text",
            token: textDelta,
            last: false,
          })
        );
      });

      const finalMessage = await stream.finalMessage();

      ws.send(JSON.stringify({ type: "text", token: "", last: true }));

      const spokenWordCount = fullText.split(/\s+/).filter(Boolean).length;
      const estimatedPlaybackMs = Math.max(1500, spokenWordCount * 400) + 800;
      resetSilenceTimer(estimatedPlaybackMs);

      const cleanContent = finalMessage.content.filter(
        (b) => b.type !== "thinking" && b.type !== "redacted_thinking"
      );
      history.push({ role: "assistant", content: cleanContent });

      const toolUse = finalMessage.content.find((b) => b.type === "tool_use" && b.name === "take_message");
      if (toolUse) {
        messageTaken = true;
        const { name, callback_number, request, requested_timing, vehicle_info, address } = toolUse.input;
        const result = await notifyMessageTaken({
          name,
          callback_number,
          request,
          requested_timing,
          vehicle_info,
          address,
          channel,
          callerNumber,
        });

        history.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: "Message recorded and delivered to the Chyne Tire team.",
            },
          ],
        });

        await respond(ws, history, channel, callerNumber);
        return;
      }

      const endCallToolUse = finalMessage.content.find((b) => b.type === "tool_use" && b.name === "end_call");
      if (endCallToolUse) {
        callEnding = true;
        clearTimeout(silenceTimer);

        let spokenGoodbye = fullText.trim();
        if (!spokenGoodbye) {
          console.log(`Call ${callSid}: end_call fired with no spoken goodbye - using fallback`);
          spokenGoodbye = "Thanks so much for calling - have a great day!";
          ws.send(JSON.stringify({ type: "text", token: spokenGoodbye, last: true }));
        }

        const wordCount = spokenGoodbye.split(/\s+/).filter(Boolean).length;
        const speakingDelayMs = Math.max(1500, wordCount * 400) + 800;

        console.log(`Call ${callSid} ending: AI called end_call, waiting ${speakingDelayMs}ms for goodbye to finish (message_taken=${messageTaken})`);
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "end" }));
          ws.close();
        }, speakingDelayMs);
      }
    } catch (err) {
      console.error("Error generating response:", err);
      ws.send(
        JSON.stringify({
          type: "text",
          token: "Sorry, I'm having trouble right now. Please try calling back in a few minutes.",
          last: true,
        })
      );
    }
  }
});

server.listen(PORT, () => {
  console.log(`Voice server listening on port ${PORT}`);
});
