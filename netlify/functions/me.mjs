// GET /api/me — who is signed in and whether they currently have Pro (checked server-side).
import { sessionFromRequest } from "../lib/auth.mjs";
import { getProAccess } from "../lib/entitlement.mjs";
import { init, json } from "../lib/http.mjs";

export default async (req, context) => {
  init(context);
  const session = sessionFromRequest(req);
  if (!session) return json({ signedIn: false, pro: false });
  const access = await getProAccess(session.email);
  return json({ signedIn: true, email: session.email, pro: access.pro, access: access.source, expires: access.expires || null });
};

export const config = { path: "/api/me" };
