// POST /api/feedback — signed-in Pro members and testers send feedback; it's stored and emailed to FEEDBACK_EMAIL.
// GET  /api/feedback — operator only (x-admin-secret): latest feedback.
import crypto from "node:crypto";
import { rateLimit, sessionFromRequest } from "../lib/auth.mjs";
import { env } from "../lib/config.mjs";
import { getProAccess } from "../lib/entitlement.mjs";
import { adminLocked, isAdmin } from "../lib/admin.mjs";
import { getJSON, setJSON } from "../lib/store.mjs";
import { init, json, sameOrigin } from "../lib/http.mjs";

const clip = (v, n) => String(v ?? "").trim().slice(0, n);
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function emailOwner(entry) {
  const to = env("FEEDBACK_EMAIL"), key = env("RESEND_API_KEY"), from = env("EMAIL_FROM");
  if (!to || !key || !from) return false;
  const lines = [
    ["From", entry.email], ["Access", entry.access], ["Rating", entry.rating ? `${entry.rating}/5` : "—"],
    ["Most useful", entry.useful], ["Change or improve", entry.improve], ["Confusing / missing", entry.confusing],
    ["Would pay", entry.wouldPay],
  ];
  const html = `<h2>BankrollIQ Arbitrage Daily feedback</h2><table cellpadding="6">${lines.map(([k, v]) => `<tr><td><b>${k}</b></td><td>${esc(v || "—").replace(/\n/g, "<br>")}</td></tr>`).join("")}</table>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], reply_to: entry.email, subject: `Feedback from ${entry.email}`, html }),
  });
  return res.ok;
}

export default async (req, context) => {
  init(context);
  if (req.method === "GET") {
    if (await adminLocked(req, context)) return json({ error: "too_many_requests" }, 429);
    if (!(await isAdmin(req, context))) return json({ error: "forbidden" }, 403);
    return json({ feedback: (await getJSON("feedback", "index")) || [] });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!sameOrigin(req)) return json({ error: "bad_origin" }, 403);
  const session = sessionFromRequest(req);
  if (!session) return json({ error: "signin_required" }, 401);
  const access = await getProAccess(session.email);
  if (!access.pro) return json({ error: "pro_required" }, 403);
  if (!(await rateLimit(`feedback:${session.email}`, 10, 86400))) return json({ error: "rate_limited", message: "Thanks — you've sent a lot of feedback today. Try again tomorrow." }, 429);

  const b = await req.json().catch(() => ({}));
  const rating = Number(b.rating);
  const entry = {
    id: crypto.randomUUID(), at: new Date().toISOString(), email: session.email, access: access.source,
    rating: rating >= 1 && rating <= 5 ? Math.round(rating) : null,
    useful: clip(b.useful, 2000), improve: clip(b.improve, 2000), confusing: clip(b.confusing, 2000), wouldPay: clip(b.wouldPay, 200),
  };
  if (!entry.useful && !entry.improve && !entry.confusing && !entry.rating) return json({ error: "empty", message: "Please answer at least one question." }, 400);
  const index = (await getJSON("feedback", "index")) || [];
  await setJSON("feedback", "index", [entry, ...index].slice(0, 500));
  const emailed = await emailOwner(entry).catch(() => false);
  return json({ ok: true, emailed });
};

export const config = { path: "/api/feedback" };
