// Netlify Blobs access. Production and previews use separate store names so a Deploy Preview
// can never overwrite production reports, sessions or entitlements (site-wide stores are shared).
import { getStore } from "@netlify/blobs";

let override = null;
export function __setStoreFactory(fn) {
  override = fn; // tests only
}

let deployContext = "production";
export function setDeployContext(ctx) {
  if (ctx) deployContext = ctx;
}

export function store(name) {
  const full = deployContext === "production" ? `arb-${name}` : `arb-preview-${name}`;
  if (override) return override(full);
  return getStore({ name: full, consistency: "strong" });
}

export async function getJSON(name, key) {
  return store(name).get(key, { type: "json" });
}

export async function setJSON(name, key, value) {
  return store(name).setJSON(key, value);
}

export async function del(name, key) {
  return store(name).delete(key);
}
