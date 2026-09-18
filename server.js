require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const line = require("@line/bot-sdk");
const tms = require("./tms");
const session = require("./session");
const flex = require("./flex");

const app = express();
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const config = { channelAccessToken: TOKEN, channelSecret: process.env.LINE_CHANNEL_SECRET };
if (!config.channelAccessToken || !config.channelSecret) {
  console.warn("⚠️  Missing LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_SECRET in .env");
}
const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: TOKEN });

const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// Driver link store: LINE userId -> TMS driverRef. Persisted to disk.
// Functionality2 populates it; TMS also knows the link via api6.
// ─────────────────────────────────────────────────────────────────────────────
const LINK_FILE = path.join(__dirname, "data-driver-links.json");
let links = {};
try { links = JSON.parse(fs.readFileSync(LINK_FILE, "utf8")); } catch { links = {}; }
function saveLinks() { try { fs.writeFileSync(LINK_FILE, JSON.stringify(links, null, 2)); } catch (e) { console.error("links persist failed:", String(e)); } }
const driverRefFor = (userId) => links[userId] || null;

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
        "Hi! 👋 I'm the KitCat maintenance bot.\n🔧 Submit vehicle maintenance or 🪪 register your driver ID from the menu below.");
    case "postback":
      return handlePostback(event);
    case "message":
      if (event.message.type === "text") return handleText(event);
      if (event.message.type === "image") return handleImage(event);
      return replyText(event.replyToken, `📥 Received a ${event.message.type} message.`);
    default:
      console.log(`   (ignored event type: ${event.type})`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POSTBACK: structured taps (menu entries, list selections, confirm, cancel)
// ─────────────────────────────────────────────────────────────────────────────
async function handlePostback(event) {
  const userId = event.source.userId;
  const params = Object.fromEntries(new URLSearchParams(event.postback.data || ""));
  const ref = driverRefFor(userId);

  switch (params.action) {
    // ---- Functionality1: submit maintenance ----
    case "submit": {
      if (!ref) return replyText(event.replyToken, "🪪 Please register your driver ID first — tap 'Register driver ID'.");
      const r = await tms.listMaintenanceSchedules(ref, userId);
      if (!r.ok) return replyText(event.replyToken, `⚠️ Couldn't load your schedules (TMS ${r.status}). Try again later.`);
      if (!r.items.length) {
        // No schedules -> fall back to vehicle picker (api3 -> api4 -> api5)
        return startVehicleFlow(event, ref);
      }
      session.set(userId, "pick_schedule", { mode: "api2", schedules: r.items });
      return reply(event.replyToken, flex.listPicker({
        title: "🔧 Maintenance schedules",
        subtitle: `Pick the schedule to report (${r.items.length})`,
        items: r.items, dataPrefix: "action=pick_schedule",
        emptyText: "No schedules.", footerNote: true,
      }));
    }

    case "pick_schedule": {
      const s = session.get(userId);
      const scheduleId = params.id;
      // Stale tap (session expired) or driver re-linked after the picker was
      // shown, or driver unregistered: restart cleanly instead of guessing.
      if (!ref) return replyText(event.replyToken, "🪪 Please register your driver ID first — tap 'Register driver ID'.");
      if (!s?.ctx?.schedules?.length) return handlePostback({ ...event, postback: { data: "action=submit" } });
      const sched = s.ctx.schedules.find((x) => String(x.id) === String(scheduleId)) || { label: scheduleId };
      session.set(userId, "mileage", { mode: "api2", schedules: s.ctx.schedules, schedule: sched });
      return replyText(event.replyToken, `🚗 ${sched.label}\n\n👉 Type the current odometer reading (km):`);
    }

    case "pick_vehicle": {
      const ref2 = driverRefFor(userId);
      const vehicleId = params.id;
      const s0 = session.get(userId) || { ctx: {} };
      const vehicle = (s0.ctx.vehicles || []).find((x) => String(x.id) === String(vehicleId)) || { label: vehicleId };
      const t = await tms.listMaintenanceTypes(vehicleId, ref2, userId);
      if (!t.ok) return replyText(event.replyToken, `⚠️ Couldn't load maintenance types (TMS ${t.status}).`);
      if (!t.items.length) return replyText(event.replyToken, "No maintenance types for that vehicle.");
      session.set(userId, "pick_type", { mode: "api5", vehicles: s0.ctx.vehicles || [], vehicleId, vehicle, types: t.items });
      return reply(event.replyToken, flex.listPicker({
        title: "🛠️ Maintenance type",
        subtitle: `Pick the service performed (${t.items.length})`,
        items: t.items, dataPrefix: "action=pick_type", emptyText: "None.", footerNote: true,
      }));
    }

    case "pick_type": {
      const s = session.get(userId);
      const typeId = params.id;
      const type = (s?.ctx?.types || []).find((x) => String(x.id) === String(typeId)) || { label: typeId };
      session.set(userId, "mileage", { ...(s?.ctx || {}), type });
      return replyText(event.replyToken, `🛠️ ${type.label}\n\n👉 Type the current odometer reading (km):`);
    }

    case "confirm": {
      const s = session.get(userId);
      if (!s) return replyText(event.replyToken, "⏱️ Session expired — start again with 'submit'.");
      return finalizeSubmit(event, s);
    }

    // ---- Functionality2: register driver ----
    case "register":
      session.set(userId, "driver_ref");
      return replyText(event.replyToken, "🪪 Type your driver reference from TMS (e.g. DRV-0042):");

    // ---- shared ----
    case "self_service":
      session.updateCtx(userId, { selfService: true });
      return showSummary(event, userId);

    case "cancel":
      session.clear(userId);
      return replyText(event.replyToken, "🚫 Cancelled. Tap 🔧 Submit anytime.");

    case "status": {
      if (!ref) return replyText(event.replyToken, "🪪 Not registered yet — tap 'Register driver ID'.");
      return replyText(event.replyToken, `🚗 You are linked to driver ${ref}.`);
    }

    case "back_to_main":
      return replyText(event.replyToken, "↩️ Back to the main menu — tap 🔧 Submit anytime.");

    default:
      return replyText(event.replyToken, `❓ Unknown action "${params.action}".`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEXT: either free commands, or session input (mileage / shop / driver ref)
// ─────────────────────────────────────────────────────────────────────────────
async function handleText(event) {
  const userId = event.source.userId;
  const raw = event.message.text.trim();
  const t = raw.toLowerCase();
  console.log(`💬 ${userId}: "${raw}"`);

  // Session input takes priority when the user is mid-flow.
  const s = session.get(userId);
  if (s && s.step !== "idle") {
    return handleSessionInput(event, s, raw);
  }

  // Commands
  if (t === "menu") return reply(event.replyToken, flex.mainMenu());
  if (t === "submit" || t === "maintenance") {
    return handlePostback({ ...event, postback: { data: "action=submit" } });
  }
  if (t === "register") {
    return handlePostback({ ...event, postback: { data: "action=register" } });
  }
  if (t === "status") {
    const ref = driverRefFor(userId);
    return replyText(event.replyToken, ref ? `🚗 Linked to driver ${ref}.` : "🪪 Not registered yet — send 'register'.");
  }
  if (t === "cancel") { session.clear(userId); return replyText(event.replyToken, "🚫 Cancelled."); }

  return replyText(event.replyToken,
    `Got it: "${raw}" 👍\nTap 🔧 Submit to report a maintenance service.`);
}

async function handleSessionInput(event, s, raw) {
  const userId = event.source.userId;
  switch (s.step) {
    case "pick_schedule": {
      // also allow typing an index number
      return pickByIndex(event, s.ctx.schedules || [], raw, "pick_schedule");
    }
    case "pick_vehicle":
      return pickByIndex(event, s.ctx.vehicles || [], raw, "pick_vehicle");
    case "pick_type":
      return pickByIndex(event, s.ctx.types || [], raw, "pick_type");
    case "mileage": {
      const km = Number(raw.replace(/[^0-9.]/g, ""));
      if (!km || km <= 0) return replyText(event.replyToken, "⚠️ Enter a valid mileage number (km). Or send 'cancel'.");
      session.updateCtx(userId, { mileage: km });
      session.set(userId, "shop", { ...(session.get(userId)?.ctx || {}) });
      return reply(event.replyToken, askShopWithQuickReply(userId));
    }
    case "shop": {
      if (!raw) return replyText(event.replyToken, "⚠️ Type the shop name, or tap Self-service.");
      session.updateCtx(userId, { shopName: raw });
      return showSummary(event, userId);
    }
    case "driver_ref": {
      if (!raw) return replyText(event.replyToken, "⚠️ Type your driver reference, or 'cancel'.");
      const r = await tms.registerDriver(userId, raw);
      if (r.ok) { links[userId] = raw; saveLinks(); session.clear(userId);
        return replyText(event.replyToken, `✅ Linked! You are driver ${raw} in TMS.` + (tms.TMS_LIVE ? "" : " (demo)"));
      }
      return replyText(event.replyToken, `⚠️ TMS rejected the registration (status ${r.status}). Check the reference and try again.`);
    }
    default:
      return replyText(event.replyToken, "Type 'menu' to start.");
  }
}

// Helper: user typed a number/name matching a list item -> reuse the tap logic.
async function pickByIndex(event, items, raw, action) {
  const idx = Number(raw) - 1;
  const item = (idx >= 0 && idx < items.length) ? items[idx]
    : items.find((x) => String(x.label).toLowerCase().includes(raw.toLowerCase()));
  if (!item) return replyText(event.replyToken, "⚠️ Pick one by typing its number (or tap the button). Send 'cancel' to stop.");
  return handlePostback({ ...event, postback: { data: `action=${action}&id=${encodeURIComponent(item.id)}` } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow helpers
// ─────────────────────────────────────────────────────────────────────────────
async function startVehicleFlow(event, ref) {
  const userId = event.source.userId;
  const v = await tms.listVehicles(ref, userId);
  if (!v.ok) return replyText(event.replyToken, `⚠️ Couldn't load vehicles (TMS ${v.status}).`);
  if (!v.items.length) return replyText(event.replyToken, "No schedules and no vehicles — tell staff directly.");
  session.set(userId, "pick_vehicle", { mode: "api5", vehicles: v.items });
  return reply(event.replyToken, flex.listPicker({
    title: "🚗 Pick a vehicle",
    subtitle: `No open schedule — creating a new one. Pick vehicle (${v.items.length})`,
    items: v.items, dataPrefix: "action=pick_vehicle", emptyText: "None.", footerNote: true,
  }));
}

// Shop step: quick-reply chip for self-service, or just type the shop name.
function askShopWithQuickReply(userId) {
  const km = session.get(userId)?.ctx?.mileage ?? "";
  return {
    type: "text",
    text: `🏪 Who did the service?\n• Tap Self-service (did it yourself), or\n• Type the shop / provider name\n\n🚗 Odometer: ${km} km`,
    quickReply: {
      items: [
        { type: "action", action: { type: "postback", label: "🙌 Self-service", data: "action=self_service" } },
      ],
    },
  };
}

function showSummary(event, userId) {
  const s = session.get(userId);
  const c = s.ctx;
  const mode = c.mode === "api5" ? "create new (api5)" : "update existing (api2)";
  return reply(event.replyToken, flex.summaryCard({
    title: "📋 Confirm submission",
    rows: [
      ["Vehicle", c.schedule?.label || c.types?.find?.((x) => String(x.id) === String(c.type?.id))?.label || c.vehicleId || "—"],
      ["Type", c.type?.label || (c.mode === "api2" ? "Existing schedule" : "—")],
      ["Odometer", (c.mileage ?? "—") + " km"],
      ["Shop", c.selfService ? "Self-service" : (c.shopName || "—")],
      ["Action", mode],
    ],
    confirmLabel: "✅ Confirm & submit",
    confirmData: "action=confirm",
  }));
}

async function finalizeSubmit(event, s) {
  const userId = event.source.userId;
  const c = s.ctx;
  const ref = driverRefFor(userId);
  const payload = {
    driverRef: ref, lineUserId: userId,
    mileage: c.mileage, shopName: c.selfService ? null : c.shopName, selfService: !!c.selfService,
  };
  let r;
  if (c.mode === "api5") {
    r = await tms.createMaintenance({ ...payload, vehicleId: c.vehicleId, maintenanceTypeId: c.type?.id });
  } else {
    r = await tms.submitMaintenance({ ...payload, scheduleId: c.schedule?.id });
  }
  session.clear(userId);
  if (!r.ok) return replyText(event.replyToken, `⚠️ TMS submission failed (status ${r.status}). Your data is kept in the log — please retry or tell staff.`);
  return replyText(event.replyToken,
    `✅ Submitted for staff review!\n` +
    (c.mode === "api5" ? `🆕 New maintenance schedule created for ${c.vehicleId}.\n` : `📝 Schedule ${c.schedule?.id} updated.\n`) +
    `🚗 ${c.schedule?.label || c.vehicleId || ""} · ${c.mileage} km · ${c.selfService ? "Self-service" : c.shopName}` +
    (tms.TMS_LIVE ? "" : "  (demo)"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Photo handling: save locally; attach to current session if submitting POD
// ─────────────────────────────────────────────────────────────────────────────
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
    const s = session.get(userId);
    if (s && s.step !== "idle") {
      session.updateCtx(userId, { photo: path.basename(file) });
      return replyText(event.replyToken, `📸 POD photo saved (${(buf.length / 1024).toFixed(0)} KB) — attached to your submission. Continue: type the next answer.`);
    }
    return replyText(event.replyToken, `📸 Photo saved (${(buf.length / 1024).toFixed(0)} KB). Send 'submit' to attach it to a maintenance report.`);
  } catch (e) {
    console.error("❌ image handling failed:", String(e));
    return replyText(event.replyToken, "⚠️ Couldn't process that photo.");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reply helpers
// ─────────────────────────────────────────────────────────────────────────────
function reply(replyToken, message) {
  return client.replyMessage({ replyToken, messages: [message] })
    .catch((e) => console.error("❌ reply failed:", e?.body || String(e)));
}
function replyText(replyToken, text) {
  return reply(replyToken, { type: "text", text })
    .then(() => console.log(`↩️  "${text.slice(0, 60)}"`));
}

app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 KitCat webhook running on http://localhost:${process.env.PORT || 3000}`);
  console.log(`   TMS integration: ${tms.TMS_LIVE ? "LIVE" : "MOCK (set TMS_BASE + TMS_API_TOKEN in .env)"}`);
});
