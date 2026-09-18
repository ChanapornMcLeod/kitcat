// LINE Flex Message builders — all dynamic UI lives here.
// Every button uses a postback with `data` the server understands.

const ACCENT = { brand: "#2ea86a", blue: "#4a90d9", amber: "#e8a13d", red: "#d9534f" };

// A scrollable list card of tappable items (schedules / vehicles / types).
// items: [{ id, label, sub }], dataPrefix: e.g. "action=pick_schedule"
function listPicker({ title, subtitle, items, dataPrefix, emptyText, footerNote }) {
  if (!items.length) {
    return flexBubble(title, [text(emptyText || "Nothing to choose from.", { color: "#888" })]);
  }
  const rows = items.map((it, i) => ({
    type: "box", layout: "vertical", spacing: "xs",
    margin: i === 0 ? "none" : "md",
    contents: [
      { type: "text", text: it.label, weight: "bold", size: "md", wrap: true },
      ...(it.sub ? [{ type: "text", text: it.sub, size: "xs", color: "#888888", wrap: true }] : []),
      {
        type: "button", style: "primary", color: ACCENT.brand, height: "sm",
        action: { type: "postback", label: "Select", data: `${dataPrefix}&id=${encodeURIComponent(it.id)}`, displayText: `Select ${it.label}` },
      },
    ],
  }));
  const bodyRows = [
    { type: "text", text: subtitle || `Select one (${items.length})`, size: "sm", color: "#888888", wrap: true },
    ...rows,
  ];
  const body = { type: "box", layout: "vertical", spacing: "md", contents: bodyRows };
  const bubble = { type: "bubble", header: header(title), body };
  if (footerNote) {
    bubble.footer = {
      type: "box", layout: "vertical",
      contents: [{ type: "button", style: "secondary", action: { type: "postback", label: "Cancel", data: "action=cancel", displayText: "Cancel" } }],
    };
  }
  return { type: "flex", altText: title, contents: bubble };
}

// Summary card shown right before submit.
function summaryCard({ title, rows, confirmLabel, confirmData }) {
  const body = {
    type: "box", layout: "vertical", spacing: "sm",
    contents: rows.map(([k, v]) => ({
      type: "box", layout: "horizontal", spacing: "md",
      contents: [
        { type: "text", text: k, size: "sm", color: "#888888", flex: 3 },
        { type: "text", text: String(v ?? "—"), size: "sm", wrap: true, flex: 7 },
      ],
    })),
  };
  return {
    type: "flex", altText: title,
    contents: {
      type: "bubble", header: header(title), body,
      footer: {
        type: "box", layout: "vertical", spacing: "sm",
        contents: [
          { type: "button", style: "primary", color: ACCENT.brand, action: { type: "postback", label: confirmLabel, data: confirmData, displayText: confirmLabel } },
          { type: "button", style: "secondary", action: { type: "postback", label: "Cancel", data: "action=cancel", displayText: "Cancel" } },
        ],
      },
    },
  };
}

// Main entry menu (text-command friendly; rich menu is the mobile fast-path).
function mainMenu() {
  const post = (label, action, color) => ({
    type: "button", style: "primary", color,
    action: { type: "postback", label, data: `action=${action}`, displayText: label },
  });
  return {
    type: "flex", altText: "KitCat menu",
    contents: {
      type: "bubble", header: header("🐱 KitCat"), 
      body: {
        type: "box", layout: "vertical", spacing: "md",
        contents: [
          post("🔧 Submit maintenance", "submit", ACCENT.brand),
          post("🪪 Register driver ID", "register", ACCENT.blue),
          post("🚗 My status", "status", ACCENT.amber),
        ],
      },
    },
  };
}

// ---- helpers ----
function header(title) {
  return { type: "box", layout: "vertical", contents: [{ type: "text", text: title, weight: "bold", size: "lg" }] };
}
function text(t, o = {}) {
  return { type: "text", text: t, wrap: true, ...o };
}
function flexBubble(title, contents) {
  return { type: "flex", altText: title, contents: { type: "bubble", header: header(title), body: { type: "box", layout: "vertical", spacing: "md", contents } } };
}

module.exports = { listPicker, summaryCard, mainMenu };
