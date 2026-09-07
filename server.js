require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.warn("⚠️  Missing LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_SECRET in .env");
}

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

// LINE sends JSON webhooks; the SDK middleware verifies the signature.
app.post("/webhook", line.middleware(config), (req, res) => {
  console.log("📨 Webhook hit:", req.body.events.map(e => e.type).join(", "));

  // Respond 200 immediately, process events asynchronously (never crash on send failures).
  Promise.all(req.body.events.map(handleEvent)).catch((err) => {
    console.error("❌ Error handling events:", err?.body || err);
  });
  res.sendStatus(200);
});

// Simple health check endpoint.
app.get("/", (_req, res) => res.send("kitcat LINE bot is running"));

async function handleEvent(event) {
  if (event.type === "message" && event.message.type === "text") {
    return handleText(event);
  }
  if (event.type === "follow") {
    return client.replyMessage({ replyToken: event.replyToken, messages: [{ type: "text", text: "Hi! 👋 Send me any message and I'll reply with buttons." }] });
  }
}

async function handleText(event) {
  const userText = event.message.text.trim();
  console.log(`💬 User ${event.source.userId} said: "${userText}"`);

  if (userText.toLowerCase() === "menu" || userText.toLowerCase().startsWith("menu")) {
    return client.replyMessage({ replyToken: event.replyToken, messages: [buildFlexMenu()] });
  }
  if (userText.startsWith("action:")) {
    const action = userText.split(":")[1];
    const text = action === "time"
      ? `🕐 It is ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Bangkok" })}`
      : `You tapped: ${action} 🎉`;
    return client.replyMessage({ replyToken: event.replyToken, messages: [{ type: "text", text }] });
  }
  if (userText.toLowerCase() === "time") {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: `🕐 It is ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Bangkok" })}` }],
    });
  }

  // Default: reply with a quick-reply button bar + text.
  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [{
    type: "text",
    text: `You said: "${userText}"\n\nTap a button below 👇`,
    quickReply: {
      items: [
        {
          type: "action",
          action: { type: "message", label: "📋 Show Menu", text: "menu" },
        },
        {
          type: "action",
          action: { type: "message", label: "🕐 What time is it?", text: "time" },
        },
        {
          type: "action",
          action: { type: "message", label: "👋 Wave hello", text: "hello" },
        },
      ],
    },
    }],
  });
}

function buildFlexMenu() {
  const button = (label, text, color) => ({
    type: "button",
    style: "primary",
    color,
    action: { type: "message", label, text },
  });

  return {
    type: "flex",
    altText: "Kitcat menu",
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "🐱 Kitcat Bot", weight: "bold", size: "lg" },
          { type: "text", text: "Pick an action", size: "sm", color: "#888888" },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          button("✅ Confirm", "action:confirm", "#2ea86a"),
          button("🕐 Show the time", "action:time", "#4a90d9"),
          button("❌ Cancel", "action:cancel", "#d9534f"),
        ],
      },
    },
  };
}

app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Server listening on http://localhost:${process.env.PORT || 3000}`);
  console.log(`   Webhook endpoint: http://localhost:${process.env.PORT || 3000}/webhook`);
});
