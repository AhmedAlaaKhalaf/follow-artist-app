import { authenticate } from "../shopify.server";
import { recordEmailEvent, runAndRecord } from "../lib/artist-product-email.server";

/**
 * products/create + products/update → email followers of the product's artist.
 * Acknowledge immediately (Shopify expects a response within 5s); the fan-out
 * runs in the background, is deduped per product, and its outcome is recorded
 * for the admin page.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  const productGid = payload?.admin_graphql_api_id;
  const status = String(payload?.status || "").toLowerCase();
  const source = String(topic || "webhook").toLowerCase();

  if (!admin) {
    void recordEmailEvent({
      shop,
      productGid,
      source,
      outcome: "skipped: no_session",
      detail: "No app session for this shop. Open the app in Shopify Admin once.",
    });
  } else if (productGid && status === "active") {
    void runAndRecord({ admin, shop, productGid, source });
  } else if (productGid) {
    void recordEmailEvent({
      shop,
      productGid,
      source,
      outcome: "skipped: not_active",
      detail: `Product status is ${status || "unknown"}.`,
    });
  }

  return new Response();
};
