// /api/profile — Pro members and testers. GET → { books, catalog }  PUT {books:[keys]} → save.
import { BOOKS } from "../lib/config.mjs";
import { getProfile, saveProfile } from "../lib/bets.mjs";
import { init, json, requirePro, sameOrigin } from "../lib/http.mjs";

const catalog = BOOKS.map(({ key, title }) => ({ key, title }));

export default async (req, context) => {
  init(context);
  const gate = await requirePro(req);
  if (gate instanceof Response) return gate;
  if (req.method === "PUT") {
    if (!sameOrigin(req)) return json({ error: "bad_origin" }, 403);
    const b = await req.json().catch(() => ({}));
    const p = await saveProfile(gate.email, b.books, BOOKS.map((x) => x.key));
    return json({ books: p.books, catalog });
  }
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  return json({ books: (await getProfile(gate.email)).books, catalog });
};

export const config = { path: "/api/profile" };
