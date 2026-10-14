import { authenticate } from "../shopify.server";
import { handleProductWebhook } from "../lib/artist-product-email.server";

/**
 * products/create + products/update → email followers of the product's artist.
 * Acknowledge immediately (Shopify expects a response within 5s); the fan-out
 * runs in the background and is deduped per product.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  const productGid = payload?.admin_graphql_api_id;
  const isActive = String(payload?.status || "").toLowerCase() === "active";

  if (admin && productGid && isActive) {
    handleProductWebhook({ admin, shop, productGid }).catch((error) => {
      console.error("[artist-email] product webhook failed", {
        shop,
        topic,
        productGid,
        message: error?.message,
      });
    });
  }

  return new Response();
};
