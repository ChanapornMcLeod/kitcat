#!/usr/bin/env node
// One-shot rich menu setup for LINE:
//  1. renders scripts/richmenu.svg -> richmenu.png (macOS sips)
//  2. deletes previous kitcat-* rich menus
//  3. creates the menu, uploads the image, links it to ALL chats (default)
// Run: node scripts/setup-richmenu.js      (re-run any time you redesign)
require("dotenv").config();
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const WEBAPP_URL = (process.env.WEBAPP_URL || "https://example.com").replace(/\/+$/, "");
const API = "https://api.line.me/v2/bot";
const ROOT = path.join(__dirname, "..");
const NAME = "kitcat-driver-menu-v1";

async function api(pathname, opts = {}) {
  const res = await fetch(API + pathname, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${pathname} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

(async () => {
  // 1. render image (JPEG: LINE cap is 1MB; flat-color JPEG is tiny)
  execSync(`sips -s format jpeg -s formatOptions 80 "${path.join(__dirname, "richmenu.svg")}" --out "${path.join(__dirname, "richmenu.jpg")}" > /dev/null`);
  const img = fs.readFileSync(path.join(__dirname, "richmenu.jpg"));
  console.log(`🖼  rich menu image: ${img.length} bytes`);

  // 2. remove previous kitcat menus
  const { richmenus } = await api("/richmenu/list");
  for (const m of richmenus.filter((m) => (m.name || "").startsWith("kitcat-") && m.name !== NAME)) {
    await api(`/richmenu/${m.richMenuId}`, { method: "DELETE" });
    console.log(`🗑  deleted old menu ${m.richMenuId} (${m.name})`);
  }

  // 3. create + upload + attach
  const exists = richmenus.find((m) => m.name === NAME);
  if (exists) await api(`/richmenu/${exists.richMenuId}`, { method: "DELETE" });

  const { richMenuId } = await api("/richmenu", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      size: { width: 2500, height: 843 },
      selected: false,
      chatBarColor: "#232b36",
      chatBarText: "KitCat Menu",
      name: NAME,
      areas: [
        { bounds: { x: 0, y: 0, width: 625, height: 843 }, action: { type: "postback", label: "Report service done", data: "action=done" } },
        { bounds: { x: 625, y: 0, width: 625, height: 843 }, action: { type: "postback", label: "Send photo", data: "action=photo" } },
        { bounds: { x: 1250, y: 0, width: 625, height: 843 }, action: { type: "postback", label: "My status", data: "action=status" } },
        { bounds: { x: 1875, y: 0, width: 625, height: 843 }, action: { type: "uri", label: "Open web app", uri: WEBAPP_URL } },
      ],
    }),
  });

  await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg", Authorization: `Bearer ${TOKEN}` },
    body: img,
  }).then(async (res) => { if (!res.ok) throw new Error(`upload content -> ${res.status}: ${await res.text()}`); });
  await api(`/user/all/richmenu/${richMenuId}`, { method: "POST" });

  fs.writeFileSync(path.join(ROOT, "richmenu-id.txt"), richMenuId + "\n");
  console.log(`✅ Rich menu created & attached to ALL chats: ${richMenuId}`);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
