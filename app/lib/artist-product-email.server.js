/**
 * Email followers when a product by an artist they follow goes live.
 *
 * Triggered from the products/create and products/update webhooks. Followers
 * are found through the `follows-artist-{handle}` customer tags (see
 * artist-follow-tags.server.js). Each product is announced at most once,
 * guarded by the ProductEmailLog unique (shop, productGid) row.
 */

import db from "../db.server";
import { PRODUCT_ARTIST_METAFIELD, followTagForHandle } from "./artist-follow-constants";
import { emailConfig, renderArtistProductEmail, sendEmails } from "./resend.server";

// Only announce products published recently, so editing an older product
// (which fires products/update) never emails everyone.
const DEFAULT_MAX_PRODUCT_AGE_HOURS = 48;

const SKIP_STATES = new Set(["UNSUBSCRIBED", "REDACTED", "INVALID"]);

async function gql(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const body = await response.json();
  if (body?.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).filter(Boolean).join("; "));
  }
  return body.data;
}

const PRODUCT_QUERY = `#graphql
  query ArtistEmailProduct($id: ID!) {
    shop {
      name
      primaryDomain { url }
    }
    product(id: $id) {
      id
      title
      status
      onlineStoreUrl
      publishedAt
      featuredMedia {
        preview { image { url(transform: { maxWidth: 1024 }) } }
      }
      artist: metafield(namespace: "${PRODUCT_ARTIST_METAFIELD.namespace}", key: "${PRODUCT_ARTIST_METAFIELD.key}") {
        reference {
          ... on Metaobject { id handle displayName }
        }
      }
    }
  }
`;

const FOLLOWERS_QUERY = `#graphql
  query ArtistEmailFollowers($query: String!, $after: String) {
    customers(first: 100, after: $after, query: $query) {
      nodes {
        id
        defaultEmailAddress {
          emailAddress
          marketingState
          marketingUnsubscribeUrl
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function maxAgeMs() {
  const hours = Number(process.env.EMAIL_MAX_PRODUCT_AGE_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_MAX_PRODUCT_AGE_HOURS) * 3600 * 1000;
}

async function loadFollowers(admin, artistHandle, requireConsent) {
  const tag = followTagForHandle(artistHandle).replace(/'/g, "\\'");
  const recipients = [];
  const seen = new Set();
  let after = null;
  do {
    const data = await gql(admin, FOLLOWERS_QUERY, { query: `tag:'${tag}'`, after });
    const page = data?.customers;
    for (const customer of page?.nodes ?? []) {
      const address = customer.defaultEmailAddress;
      const email = address?.emailAddress?.trim().toLowerCase();
      if (!email || seen.has(email)) continue;
      const state = address.marketingState;
      if (SKIP_STATES.has(state)) continue;
      if (requireConsent && state !== "SUBSCRIBED") continue;
      seen.add(email);
      recipients.push({ email, unsubscribeUrl: address.marketingUnsubscribeUrl || null });
    }
    after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return recipients;
}

/**
 * @returns {Promise<{ status: string, reason?: string, sent?: number, failed?: number }>}
 */
export async function handleProductWebhook({ admin, shop, productGid }) {
  const config = emailConfig();
  if (!config.enabled) return { status: "skipped", reason: "disabled" };
  if (!config.ready) return { status: "skipped", reason: "resend_not_configured" };

  const already = await db.productEmailLog.findUnique({
    where: { shop_productGid: { shop, productGid } },
  });
  if (already) return { status: "skipped", reason: "already_sent" };

  const data = await gql(admin, PRODUCT_QUERY, { id: productGid });
  const product = data?.product;
  if (!product) return { status: "skipped", reason: "product_not_found" };
  if (product.status !== "ACTIVE") return { status: "skipped", reason: "not_active" };

  const artist = product.artist?.reference;
  if (!artist?.id || !artist.handle) return { status: "skipped", reason: "no_artist" };

  // Not on the Online Store yet: wait for the update that publishes it.
  if (!product.onlineStoreUrl) return { status: "skipped", reason: "not_published" };

  const publishedAt = product.publishedAt ? new Date(product.publishedAt) : null;
  if (!publishedAt || Date.now() - publishedAt.getTime() > maxAgeMs()) {
    return { status: "skipped", reason: "too_old" };
  }

  // Claim the product before sending; a concurrent webhook loses the race.
  try {
    await db.productEmailLog.create({
      data: { shop, productGid, artistGid: artist.id, status: "sending" },
    });
  } catch (error) {
    if (error?.code === "P2002") return { status: "skipped", reason: "already_sent" };
    throw error;
  }

  try {
    const recipients = await loadFollowers(admin, artist.handle, config.requireMarketingConsent);
    const shopUrl = (data.shop?.primaryDomain?.url || `https://${shop}`).replace(/\/$/, "");
    const base = {
      shopName: data.shop?.name || shop,
      artistName: artist.displayName || artist.handle,
      artistUrl: `${shopUrl}/artists/${artist.handle}`,
      productTitle: product.title,
      productUrl: product.onlineStoreUrl,
      imageUrl: product.featuredMedia?.preview?.image?.url || null,
    };

    const messages = recipients.map((r) => ({
      to: r.email,
      unsubscribeUrl: r.unsubscribeUrl,
      ...renderArtistProductEmail({ ...base, unsubscribeUrl: r.unsubscribeUrl }),
    }));

    const result = await sendEmails(messages, { idempotencyPrefix: `${shop}:${productGid}` });

    await db.productEmailLog.update({
      where: { shop_productGid: { shop, productGid } },
      data: {
        status: result.failed && !result.sent ? "failed" : "sent",
        recipients: result.sent,
        failed: result.failed,
      },
    });

    console.log("[artist-email] product announcement", {
      shop,
      productGid,
      artist: artist.handle,
      followers: recipients.length,
      sent: result.sent,
      failed: result.failed,
    });
    return { status: "sent", sent: result.sent, failed: result.failed };
  } catch (error) {
    await db.productEmailLog
      .update({ where: { shop_productGid: { shop, productGid } }, data: { status: "failed" } })
      .catch(() => {});
    throw error;
  }
}

/** Recent announcements for the admin page. */
export async function recentProductEmails(shop, take = 10) {
  return db.productEmailLog.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take,
  });
}
