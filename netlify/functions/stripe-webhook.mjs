// POST /api/stripe-webhook — keeps Pro entitlements in sync with Stripe subscription events.
// Configure in Stripe → Developers → Webhooks with events:
//   customer.subscription.created, customer.subscription.updated, customer.subscription.deleted,
//   customer.subscription.paused, customer.subscription.resumed, checkout.session.completed
import { env } from "../lib/config.mjs";
import { normalizeEmail } from "../lib/auth.mjs";
import { customerEmail, recordSubscription, refreshFromStripe, verifyStripeSignature } from "../lib/entitlement.mjs";
import { getJSON, setJSON } from "../lib/store.mjs";
import { init, json } from "../lib/http.mjs";

export default async (req, context) => {
  init(context);
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const raw = await req.text();
  if (!verifyStripeSignature(raw, req.headers.get("stripe-signature"), env("STRIPE_WEBHOOK_SECRET"))) {
    return json({ error: "invalid_signature" }, 400);
  }
  const event = JSON.parse(raw);
  // Idempotency: Stripe retries; ignore events already processed.
  if (await getJSON("webhooks", event.id)) return json({ received: true, duplicate: true });

  try {
    const obj = event.data?.object || {};
    if (event.type.startsWith("customer.subscription.")) {
      const email = normalizeEmail(await customerEmail(obj.customer));
      if (email) await recordSubscription(email, obj);
    } else if (event.type === "checkout.session.completed") {
      const email = normalizeEmail(obj.customer_details?.email || obj.customer_email);
      if (email) await refreshFromStripe(email);
    }
  } catch (e) {
    console.error("[stripe-webhook]", event.type, e.message);
    return json({ error: "processing_failed" }, 500); // Stripe will retry
  }
  await setJSON("webhooks", event.id, { type: event.type, at: Date.now() });
  return json({ received: true });
};

export const config = { path: "/api/stripe-webhook" };
