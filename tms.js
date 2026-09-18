// TMS API layer — the single adapter between the LINE bot and the TMS.
//
// The requirements define 6 TMS operations (api1..api6). Each is a named
// function below that POSTs to `${TMS_BASE}${paths[op]}` with a JSON body
// and returns a NORMALIZED result so the rest of the bot never worries about
// the real payload shape:
//
//   { ok, status, error, data }   — data is an array of items (or object for submits)
//
// Until TMS_BASE is configured (or left as a placeholder) every call runs in
// MOCK mode: it logs the call and returns realistic sample data so the whole
// LINE flow is testable end-to-end today.
//
// >>> When the real TMS API is given, only this file changes:
//     1. set TMS_BASE + TMS_API_TOKEN in .env
//     2. adjust TMS_PATHS if the endpoint paths differ
//     3. adjust normalizeList() / normalizeSubmit() if the response shape differs
//     4. (optional) switch to a per-driver token in headers if TMS needs it

const TMS_BASE = (process.env.TMS_BASE || "").replace(/\/+$/, "");
const TMS_TOKEN = process.env.TMS_API_TOKEN || "";
const TMS_LIVE = !!TMS_BASE && !/example\.com/.test(TMS_BASE);

// op -> path. Paths are guesses; real ones come with the API spec.
const TMS_PATHS = {
  listMaintenanceSchedules: "/api/line/maintenance-schedules", // api1
  submitMaintenance: "/api/line/maintenance-submit",           // api2
  listVehicles: "/api/line/vehicles",                          // api3
  listMaintenanceTypes: "/api/line/maintenance-types",         // api4
  createMaintenance: "/api/line/maintenance-create",           // api5
  registerDriver: "/api/line/register-driver",                 // api6
};

async function tms(op, body) {
  const path = TMS_PATHS[op];
  if (!TMS_LIVE) {
    const data = mock(op, body);
    console.log(`[TMS MOCK] ${op}`, JSON.stringify(body), "->", JSON.stringify(data).slice(0, 200));
    return { ok: true, status: 200, error: null, data };
  }
  try {
    const res = await fetch(`${TMS_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(TMS_TOKEN ? { Authorization: `Bearer ${TMS_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    console.log(`[TMS] ${op} -> ${res.status}`);
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300), data: null };
    const json = text ? JSON.parse(text) : {};
    return { ok: true, status: res.status, error: null, data: json };
  } catch (e) {
    console.error(`[TMS] ${op} FAILED:`, String(e));
    return { ok: false, status: 0, error: String(e), data: null };
  }
}

// ---- Normalizers: map whatever TMS returns to stable fields the bot uses. ----
// The bot assumes each list item has { id, label, sub } and each submit result
// has an { id } or { ok } marker. Adjust these two functions to your TMS shape.
function normalizeList(data, mapper) {
  // Accept { items: [...] } | { data: [...] } | [...] | { schedules: [...] } etc.
  const arr = Array.isArray(data) ? data
    : Array.isArray(data?.items) ? data.items
    : Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.list) ? data.list
    : [];
  return arr.map((raw, i) => mapper(raw, i));
}

const mapSchedule = (s, i) => ({
  id: s.id ?? s.scheduleId ?? s.maintenanceId ?? i,
  label: s.label ?? s.vehicle ?? s.vehiclePlate ?? s.title ?? `#${i + 1}`,
  sub: s.sub ?? s.date ?? s.dueDate ?? s.status ?? "",
});
const mapVehicle = (v, i) => ({
  id: v.id ?? v.vehicleId ?? v.plate ?? v.plateNo ?? i,
  label: v.label ?? v.plate ?? v.plateNo ?? v.name ?? `#${i + 1}`,
  sub: v.sub ?? v.model ?? v.nickname ?? "",
});
const mapType = (t, i) => ({
  id: t.id ?? t.typeId ?? t.code ?? i,
  label: t.label ?? t.name ?? t.type ?? `#${i + 1}`,
  sub: t.sub ?? t.description ?? "",
});

// ---- Public API used by the server ----
async function listMaintenanceSchedules(driverRef, lineUserId) {
  const r = await tms("listMaintenanceSchedules", { driverRef, lineUserId });
  if (!r.ok) return { ok: false, status: r.status, error: r.error, items: [] };
  return { ok: true, items: normalizeList(r.data, mapSchedule) };
}
async function submitMaintenance(p) {
  // p: { driverRef, lineUserId, scheduleId, mileage, shopName, selfService }
  const r = await tms("submitMaintenance", p);
  return { ok: r.ok, status: r.status, error: r.error };
}
async function listVehicles(driverRef, lineUserId) {
  const r = await tms("listVehicles", { driverRef, lineUserId });
  if (!r.ok) return { ok: false, status: r.status, error: r.error, items: [] };
  return { ok: true, items: normalizeList(r.data, mapVehicle) };
}
async function listMaintenanceTypes(vehicleId, driverRef, lineUserId) {
  const r = await tms("listMaintenanceTypes", { vehicleId, driverRef, lineUserId });
  if (!r.ok) return { ok: false, status: r.status, error: r.error, items: [] };
  return { ok: true, items: normalizeList(r.data, mapType) };
}
async function createMaintenance(p) {
  // p: { driverRef, lineUserId, vehicleId, maintenanceTypeId, mileage, shopName, selfService }
  const r = await tms("createMaintenance", p);
  return { ok: r.ok, status: r.status, error: r.error };
}
async function registerDriver(lineUserId, driverRef) {
  const r = await tms("registerDriver", { lineUserId, driverRef });
  return { ok: r.ok, status: r.status, error: r.error };
}

// ---- MOCK data so the flow is testable before the real API exists ----
function mock(op, body) {
  switch (op) {
    case "listMaintenanceSchedules":
      return {
        items: [
          { id: "SCHED-1001", vehicle: "กข 1234 Bangkok", dueDate: "Due: 2026-09-12" },
          { id: "SCHED-1002", vehicle: "ABC 5678 Chiang Mai", dueDate: "Due: 2026-09-15" },
          { id: "SCHED-1003", vehicle: "1กก 9999 Phuket", dueDate: "Overdue 3 days" },
        ],
      };
    case "listVehicles":
      return {
        items: [
          { id: "VEH-77", plate: "กข 1234 Bangkok", model: "Isuzu D-Max" },
          { id: "VEH-88", plate: "ABC 5678 Chiang Mai", model: "Toyota Hilux" },
        ],
      };
    case "listMaintenanceTypes":
      return {
        items: [
          { id: "MT-OIL", name: "Oil change", description: "~500 THB" },
          { id: "MT-TIRE", name: "Tire rotation", description: "~300 THB" },
          { id: "MT-BRAKE", name: "Brake service", description: "~1,200 THB" },
        ],
      };
    case "submitMaintenance":
      return { id: body.scheduleId, status: "submitted-for-review" };
    case "createMaintenance":
      return { id: "SCHED-NEW-" + body.vehicleId, status: "created-for-review" };
    case "registerDriver":
      return { driverRef: body.driverRef, linked: true };
    default:
      return {};
  }
}

module.exports = {
  TMS_LIVE,
  listMaintenanceSchedules,
  submitMaintenance,
  listVehicles,
  listMaintenanceTypes,
  createMaintenance,
  registerDriver,
};
