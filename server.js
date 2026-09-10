require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const line = require("@line/bot-sdk");

const app = express();

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const config = {
  channelAccessToken: TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
if (!config.channelAccessToken || !config.channelSecret) {
  console.warn("⚠️  Missing LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_SECRET in .env");
}

const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: TOKEN });

// ─────────────────────────────────────────────────────────────────────────────
// YOUR WEB APP INTEGRATION — the single point of contact.
// Set WEBAPP_URL + WEBAPP_API_TOKEN in .env to go live; until then calls
// are logged in MOCK mode. Every feature funnels through callWebApp().
// ─────────────────────────────────────────────────────────────────────────────
const WEBAPP_URL = (process.env.WEBAPP_URL || "").replace(/\/+$/, "");
const WEBAPP_TOKEN = process.env.WEBAPP_API_TOKEN || "";
const WEBAPP_LIVE = WEBAPP_URL && !/example\.com/.test(WEBAPP_URL);

async function callWebApp(pathname, payload) {
  if (!WEBAPP_LIVE) {
    console.log(`[MOCK webapp] POST ${pathname}`, JSON.stringify(payload));
    return { ok: true, mock: true, body: "" };
  }
  try {
    const res = await fetch(`${WEBAPP_URL}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(WEBAPP_TOKEN ? { Authorization: `Bearer ${WEBAPP_TOKEN}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.text()).slice(0, 500);
    console.log(`[webapp] POST ${pathname} -> ${res.status}`);
    return { ok: res.ok, mock: false, status: res.status, body };
  } catch (e) {
    console.error(`[webapp] POST ${pathname} FAILED:`, String(e));
    return { ok: false, mock: false, status: 0, body: String(e) };
  }
}

const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const photoCount = new Map(); // userId -> count (demo in-memory state)

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC RICH MENU — the bottom bar is a static image, but WHICH menu a
// user sees is fully dynamic: we link/unlink rich menu IDs per user at runtime.
// IDs come from files written by scripts/setup-richmenu.js.
// ─────────────────────────────────────────────────────────────────────────────
const readId = (f) => { try { return fs.readFileSync(path.join(__dirname, f), "utf8").trim(); } catch { return ""; } };
const RICH_MAIN = readId("richmenu-id.txt");        // default 4-tile menu
const RICH_DONE = readId("richmenu-done-id.txt");    // shown after a report

// Link a specific rich menu to ONE user (overrides the default for them).
async function linkRichMenu(userId, richMenuId) {
  if (!richMenuId) return;
  try {
    await fetch(`https://api.line.me/v2/bot/user/${userId}/richmenu/${richMenuId}`, {
      method: "POST", headers: { Authorization: `Bearer ${TOKEN}` },
    });
    console.log(`🧩 linked rich menu ${richMenuId} -> ${userId}`);
  } catch (e) { console.error("rich menu link failed:", String(e)); }
}
// Clear a user's personal menu so they fall back to the default main menu.
async function resetRichMenu(userId) {
  try {
    await fetch(`https://api.line.me/v2/bot/user/${userId}/richmenu`, {
      method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` },
    });
    console.log(`🧩 reset rich menu to default for ${userId}`);
  } catch (e) { console.error("rich menu reset failed:", String(e)); }
}


// ─────────────────────────────────────────────────────────────────────────────
// ACTION TABLE — new features live here.
// A rich-menu button / flex button / text alias fires `action=<key>`;
// add a handler row below. That's all a new feature needs.
// postback data format:  action=<key>&<extra>=<value>&...
// ─────────────────────────────────────────────────────────────────────────────
const ACTIONS = {
  done: async ({ userId, params }) => {
    const r = await callWebApp("/api/line/service-completions", {
      driverLineUserId: userId,
      reportedAt: new Date().toISOString(),
      note: params.note || null,
    });
    // Dynamic rich menu demo: swap THIS driver's bottom bar to the "Reported ✓"
    // state so it reflects where they are in the flow — no chat spam needed.
    if (RICH_DONE) await linkRichMenu(userId, RICH_DONE);
    if (r.mock) return "✅ Service completion logged (demo — web app not connected yet).\nSet WEBAPP_URL in .env and I'll post it there for real!";
    return r.ok
      ? "✅ Your service completion was submitted to the app. Staff have been notified!"
      : `⚠️ Could not reach the app server (status ${r.status}). Your report is in our log — please retry or tell staff directly.`;
  },

  status: async ({ userId }) => {
    const r = await callWebApp("/api/line/driver-status", { driverLineUserId: userId });
    if (r.mock) return "🚗 (demo) Status check received — once WEBAPP_URL is set, this returns your real assignment/vehicle info.";
    return r.ok ? `🚗 ${r.body || "Status received."}` : `⚠️ Status lookup failed (status ${r.status}).`;
  },

  photo: async () =>
    "📷 Just send the photo(s) straight into this chat — I'll save them and forward to the app automatically.",

  // Swap the driver's bottom bar back to the default 4-tile menu.
  back_to_main: async ({ userId }) => {
    await resetRichMenu(userId);
    return "↩️ Back to the main menu — tap the bar below to report another service.";
  },
};

function parsePostbackData(data) {
  return Object.fromEntries(new URLSearchParams(data || ""));
}

async function runAction(event, params) {
  const fn = ACTIONS[params.action];
  const text = fn
    ? await fn({ userId: event.source.userId, params })
    : `❓ Unknown action "${params.action}". Type "menu" for options.`;
  return replyText(event.replyToken, text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook
// ─────────────────────────────────────────────────────────────────────────────
app.post("/webhook", line.middleware(config), (req, res) => {
  console.log("📨 Webhook hit:", req.body.events.map((e) => e.type).join(", "));
  Promise.all(req.body.events.map(handleEvent)).catch((err) => {
    console.error("❌ Error handling events:", err?.body || err);
  });
  res.sendStatus(200);
});

app.get("/", (_req, res) => res.send("kitcat LINE bot is running"));

async function handleEvent(event) {
  switch (event.type) {
    case "follow":
      return replyText(event.replyToken,
        "Hi! 👋 I'm the KitCat assistant.\nUse the menu bar below 👇 or send any message / photo.");
    case "postback":
      return runAction(event, parsePostbackData(event.postback.data));
    case "message":
      if (event.message.type === "text") return handleText(event);
      if (event.message.type === "image") return handleImage(event);
      return replyText(event.replyToken, `📥 Received a ${event.message.type} message.`);
    default:
      console.log(`   (ignored event type: ${event.type})`);
  }
}

async function handleText(event) {
  const t = event.message.text.trim().toLowerCase();
  const userId = event.source.userId;
  console.log(`💬 ${userId}: "${event.message.text.trim()}"`);

  if (t === "menu" || t.startsWith("menu")) {
    return client.replyMessage({ replyToken: event.replyToken, messages: [buildMenu()] });
  }
  if (t === "done" || t === "service done" || t.startsWith("done:")) {
    return runAction(event, { action: "done", note: t.includes(":") ? t.split(":").slice(1).join(":") : null });
  }
  if (t === "status") return runAction(event, { action: "status" });
  if (t === "photo") return runAction(event, { action: "photo" });

  // Low-interference default: the always-on rich menu bar already carries the
  // actions, so we DON'T re-push a menu card / quickReply on every message.
  return replyText(event.replyToken,
    `Got it: "${event.message.text.trim()}" 👍\nUse the KitCat menu below to report a service.`);
}

async function handleImage(event) {
  const userId = event.source.userId;
  const messageId = event.message.id;
  try {
    const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) throw new Error(`content fetch ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get("content-type") || "image/jpeg";
    const ext = ct.includes("png") ? "png" : ct.includes("gif") ? "gif" : "jpg";
    const file = path.join(UPLOAD_DIR, `${Date.now()}-${userId.slice(1, 9)}.${ext}`);
    fs.writeFileSync(file, buf);

    const n = (photoCount.get(userId) || 0) + 1;
    photoCount.set(userId, n);

    const r = await callWebApp("/api/line/driver-photos", {
      driverLineUserId: userId,
      messageId,
      fileName: path.basename(file),
      bytes: buf.length,
      sequence: n,
    });
    return replyText(event.replyToken,
      `📸 Photo #${n} saved (${(buf.length / 1024).toFixed(0)} KB)` +
      (r.mock ? " — webapp forwarding is in DEMO mode." : " — forwarded to the app ✅"));
  } catch (e) {
    console.error("❌ image handling failed:", String(e));
    return replyText(event.replyToken, "⚠️ Couldn't process that photo — staff have been notified via log.");
  }
}

function replyText(replyToken, text) {
  return client.replyMessage({ replyToken, messages: [{ type: "text", text }] })
    .then(() => console.log(`↩️  replied: "${text.slice(0, 60)}"`))
    .catch((e) => console.error("❌ reply failed:", e?.body || String(e)));
}

// Flex menu (same action= keys as the rich menu — single source of truth)
function buildMenu() {
  const post = (label, action, color) => ({
    type: "button", style: "primary", color,
    action: { type: "postback", label, data: `action=${action}`, displayText: label },
  });
  return {
    type: "flex",
    altText: "KitCat menu",
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical",
        contents: [
          { type: "text", text: "🐱 KitCat", weight: "bold", size: "lg" },
          { type: "text", text: "Driver actions", size: "sm", color: "#888888" },
        ],
      },
      body: {
        type: "box", layout: "vertical", spacing: "md",
        contents: [
          post("✅ Service done", "done", "#2ea86a"),
          post("📷 Photo help", "photo", "#4a90d9"),
          post("🚗 My status", "status", "#e8a13d"),
          { type: "button", style: "secondary", action: { type: "uri", label: "🌐 Open web app", uri: WEBAPP_URL || "https://example.com" } },
        ],
      },
    },
  };
}

app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Server listening on http://localhost:${process.env.PORT || 3000}`);
  console.log(`   Webapp integration: ${WEBAPP_LIVE ? WEBAPP_URL : "MOCK (set WEBAPP_URL in .env)"}`);
});
