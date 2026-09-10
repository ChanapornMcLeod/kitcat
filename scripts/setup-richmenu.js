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
const DONE_NAME = "kitcat-driver-menu-done";
const KEEP = new Set([NAME, DONE_NAME]);

async function api(pathname, opts = {}) {
  const res = await fetch(API + pathname, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${pathname} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function render(svg) {
  const jpg = svg.replace(/\.svg$/, ".jpg");
  execSync(`sips -s format jpeg -s formatOptions 80 "${path.join(__dirname, svg)}" --out "${path.join(__dirname, jpg)}" > /dev/null`);
  return fs.readFileSync(path.join(__dirname, jpg));
}

async function createMenu(img, body) {
  const { richMenuId } = await api("/richmenu", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const res = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: "POST", headers: { "Content-Type": "image/jpeg", Authorization: `Bearer ${TOKEN}` }, body: img,
  });
  if (!res.ok) throw new Error(`upload content -> ${res.status}: ${await res.text()}`);
  return richMenuId;
}

(async () => {
  // 1. render images (JPEG: LINE cap is 1MB; flat-color JPEG is tiny)
  const mainImg = await render("richmenu.svg");
  const doneImg = await render("richmenu-done.svg");
  console.log(`🖼  main menu ${mainImg.length}B · done-state menu ${doneImg.length}B`);

  // 2. remove previous kitcat menus that we're NOT recreating now
  const { richmenus } = await api("/richmenu/list");
  for (const m of richmenus.filter((m) => (m.name || "").startsWith("kitcat-") && !KEEP.has(m.name))) {
    await api(`/richmenu/${m.richMenuId}`, { method: "DELETE" });
    console.log(`🗑  deleted stale menu ${m.richMenuId} (${m.name})`);
  }
  // delete existing copies of the two we manage so we recreate fresh
  for (const name of KEEP) {
    const ex = richmenus.find((m) => m.name === name);
    if (ex) await api(`/richmenu/${ex.richMenuId}`, { method: "DELETE" });
  }

  const areas4 = (extraUri) => [
    { bounds: { x: 0, y: 0, width: 625, height: 843 }, action: { type: "postback", label: "Report service done", data: "action=done" } },
    { bounds: { x: 625, y: 0, width: 625, height: 843 }, action: { type: "postback", label: "Send photo", data: "action=photo" } },
    { bounds: { x: 1250, y: 0, width: 625, height: 843 }, action: { type: "postback", label: "My status", data: "action=status" } },
    { bounds: { x: 1875, y: 0, width: 625, height: 843 }, action: { type: "uri", label: "Open web app", uri: extraUri } },
  ];

  // 3a. MAIN menu (default, shown to everyone; selected:true = auto-expand the bar)
  const mainId = await createMenu(mainImg, {
    size: { width: 2500, height: 843 },
    selected: true,
    chatBarColor: "#232b36",
    chatBarText: "KitCat Menu",
    name: NAME,
    areas: areas4(WEBAPP_URL),
  });
  await api(`/user/all/richmenu/${mainId}`, { method: "POST" });
  fs.writeFileSync(path.join(ROOT, "richmenu-id.txt"), mainId + "\n");
  console.log(`✅ Main menu created, auto-expand, attached to ALL chats: ${mainId}`);

  // 3b. DONE-state menu (server swaps a user onto this after they report)
  const doneId = await createMenu(doneImg, {
    size: { width: 2500, height: 843 },
    selected: true,
    chatBarColor: "#14532d",
    chatBarText: "Reported ✓",
    name: DONE_NAME,
    areas: [
      { bounds: { x: 0, y: 0, width: 1250, height: 843 }, action: { type: "postback", label: "Reported", data: "action=status" } },
      { bounds: { x: 1250, y: 0, width: 1250, height: 843 }, action: { type: "postback", label: "Report another", data: "action=back_to_main" } },
    ],
  });
  fs.writeFileSync(path.join(ROOT, "richmenu-done-id.txt"), doneId + "\n");
  console.log(`✅ Done-state menu created (not attached; server swaps per-user): ${doneId}`);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
