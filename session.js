// Conversation session store — tracks where each user is in a multi-step flow.
// In-memory is fine for a single-process bot. Swap `persist`/`load` for Redis/DB
// if you ever run multiple instances.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "data-sessions.json");
const TTL_MS = 30 * 60 * 1000; // sessions expire after 30 min idle

let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { sessions = {}; }

function persist() {
  try { fs.writeFileSync(FILE, JSON.stringify(sessions)); } catch (e) { console.error("session persist failed:", String(e)); }
}

function get(userId) {
  const s = sessions[userId];
  if (!s) return null;
  if (Date.now() - s.updatedAt > TTL_MS) { delete sessions[userId]; persist(); return null; }
  return s;
}

// step: 'idle' | 'pick_schedule' | 'pick_vehicle' | 'pick_type' | 'mileage' | 'shop' | 'self_service' | 'driver_ref'
// ctx:  { schedules, schedule, vehicleId, type, mileage, shopName, ... }
function set(userId, step, ctx = {}) {
  sessions[userId] = { step, ctx, updatedAt: Date.now() };
  persist();
}

function updateCtx(userId, patch) {
  if (!sessions[userId]) return;
  Object.assign(sessions[userId].ctx, patch);
  sessions[userId].updatedAt = Date.now();
  persist();
}

function clear(userId) { delete sessions[userId]; persist(); }

module.exports = { get, set, updateCtx, clear };
