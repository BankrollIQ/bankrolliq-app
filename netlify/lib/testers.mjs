// Free tester (beta) access, managed from /admin.html without redeploying.
// Stored as one small record in Blobs: { [email]: { expires, note, added } }.
import { normalizeEmail } from "./auth.mjs";
import { getJSON, setJSON } from "./store.mjs";

const KEY = "all";

export async function listTesters() {
  return (await getJSON("testers", KEY)) || {};
}

export async function getTester(email, now = Date.now()) {
  const t = (await listTesters())[email];
  return t && t.expires > now ? t : null;
}

export async function addTester(rawEmail, days, note = "") {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new Error("invalid_email");
  const d = Math.round(Number(days));
  if (!(d >= 1 && d <= 365)) throw new Error("days_must_be_1_to_365");
  const all = await listTesters();
  all[email] = { expires: Date.now() + d * 86400000, note: String(note || "").slice(0, 120), added: Date.now() };
  await setJSON("testers", KEY, all);
  return { email, ...all[email] };
}

export async function removeTester(rawEmail) {
  const email = normalizeEmail(rawEmail);
  const all = await listTesters();
  if (email && all[email]) {
    delete all[email];
    await setJSON("testers", KEY, all);
    return true;
  }
  return false;
}
