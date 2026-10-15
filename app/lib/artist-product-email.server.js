/**
 * Email followers when a product by an artist they follow goes live.
 *
 * Triggered from the products/create and products/update webhooks. Followers
 * are found through the `follows-artist-{handle}` customer tags (see
 * artist-follow-tags.server.js). Each product is announced at most once,
 * guarded by the ProductEmailLog unique (shop, productGid) row. Every webhook
 * outcome is stored in EmailWebhookEvent so the admin page can show why a
 * product was or wasn't announced.
 */

import db from "../db.server";
import { PRODUCT_ARTIST_METAFIELD, followTagForHandle } from "./artist-follow-constants";
import { emailConfig, renderArtistProductEmail, sendEmails } from "./resend.server";

// Only announce products published recently, so editing an older product
// (which fires products/update) never emails everyone.
const DEFAULT_MAX_PRODUCT_AGE_HOURS = 48;
const EVENTS_KEPT_PER_SHOP = 50;

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
      handle
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

const LATEST_PRODUCTS_QUERY = `#graphql
  query ArtistEmailLatestProducts {
    products(first: 25, sortKey: UPDATED_AT, reverse: true, query: "status:active") {
      nodes {
        id
        artist: metafield(namespace: "${PRODUCT_ARTIST_METAFIELD.namespace}", key: "${PRODUCT_ARTIST_METAFIELD.key}") {
          reference { ... on Metaobject { id } }
        }
      }
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
  const counts = { tagged: 0, noEmail: 0, unsubscribed: 0, notSubscribed: 0 };
  let after = null;
  do {
    const data = await gql(admin, FOLLOWERS_QUERY, { query: `tag:'${tag}'`, after });
    const page = data?.customers;
    for (const customer of page?.nodes ?? []) {
      counts.tagged += 1;
      const address = customer.defaultEmailAddress;
      const email = address?.emailAddress?.trim().toLowerCase();
      if (!email) {
        counts.noEmail += 1;
        continue;
      }
      if (seen.has(email)) continue;
      const state = address.marketingState;
      if (SKIP_STATES.has(state)) {
        counts.unsubscribed += 1;
        continue;
      }
      if (requireConsent && state !== "SUBSCRIBED") {
        counts.notSubscribed += 1;
        continue;
      }
      seen.add(email);
      recipients.push({ email, unsubscribeUrl: address.marketingUnsubscribeUrl || null });
    }
    after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return { recipients, counts };
}

function noRecipientsDetail(artistHandle, counts) {
  const tag = followTagForHandle(artistHandle);
  if (!counts.tagged) {
    return `No customers have the tag "${tag}". Follow the artist, or click Rebuild follow tags.`;
  }
  const parts = [`${counts.tagged} follower(s) tagged "${tag}" but none can be emailed`];
  if (counts.notSubscribed) {
    parts.push(`${counts.notSubscribed} not subscribed to email marketing (subscribe them, or set EMAIL_REQUIRE_MARKETING_CONSENT=false)`);
  }
  if (counts.unsubscribed) parts.push(`${counts.unsubscribed} unsubscribed`);
  if (counts.noEmail) parts.push(`${counts.noEmail} without an email address`);
  return `${parts.join("; ")}.`;
}

/**
 * @param {{ admin: any, shop: string, productGid: string, ignoreAge?: boolean }} args
 * @returns {Promise<{ status: "sent"|"skipped", reason?: string, detail?: string, sent?: number, failed?: number }>}
 */
export async function handleProductWebhook({ admin, shop, productGid, ignoreAge = false }) {
  const config = emailConfig();
  if (!config.enabled) {
    return { status: "skipped", reason: "disabled", detail: "EMAIL_NOTIFICATIONS_ENABLED is not \"true\" on the server." };
  }
  if (!config.ready) {
    return { status: "skipped", reason: "resend_not_configured", detail: "RESEND_API_KEY or RESEND_FROM_EMAIL is missing on the server." };
  }

  const already = await db.productEmailLog.findUnique({
    where: { shop_productGid: { shop, productGid } },
  });
  if (already) {
    // An earlier attempt that reached nobody (e.g. before tags existed) must
    // not block the product forever.
    const reachedNobody = already.recipients === 0 && already.status !== "sending";
    if (!reachedNobody) {
      return { status: "skipped", reason: "already_sent", detail: `Already announced to ${already.recipients} follower(s).` };
    }
    await db.productEmailLog.delete({ where: { id: already.id } }).catch(() => {});
  }

  const data = await gql(admin, PRODUCT_QUERY, { id: productGid });
  const product = data?.product;
  if (!product) return { status: "skipped", reason: "product_not_found" };
  if (product.status !== "ACTIVE") return { status: "skipped", reason: "not_active", detail: `Product status is ${product.status}.` };

  const artist = product.artist?.reference;
  if (!artist?.id || !artist.handle) {
    return { status: "skipped", reason: "no_artist", detail: "Product has no custom.artist value." };
  }

  // publishedAt is the Online Store publication date; null means not published there yet.
  const publishedAt = product.publishedAt ? new Date(product.publishedAt) : null;
  if (!publishedAt) {
    return { status: "skipped", reason: "not_published", detail: "Product is not published to the Online Store sales channel." };
  }
  if (!ignoreAge && Date.now() - publishedAt.getTime() > maxAgeMs()) {
    return { status: "skipped", reason: "too_old", detail: `Published ${publishedAt.toISOString()}, older than the announcement window.` };
  }

  const { recipients, counts } = await loadFollowers(admin, artist.handle, config.requireMarketingConsent);
  if (!recipients.length) {
    return { status: "skipped", reason: "no_recipients", detail: noRecipientsDetail(artist.handle, counts) };
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
    const shopUrl = (data.shop?.primaryDomain?.url || `https://${shop}`).replace(/\/$/, "");
    const base = {
      shopName: data.shop?.name || shop,
      artistName: artist.displayName || artist.handle,
      artistUrl: `${shopUrl}/artists/${artist.handle}`,
      productTitle: product.title,
      productUrl: product.onlineStoreUrl || `${shopUrl}/products/${product.handle}`,
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
    return {
      status: "sent",
      sent: result.sent,
      failed: result.failed,
      detail: `Sent to ${result.sent} follower(s) of ${base.artistName}${result.failed ? `, ${result.failed} failed (see Resend dashboard)` : ""}.`,
    };
  } catch (error) {
    await db.productEmailLog
      .update({ where: { shop_productGid: { shop, productGid } }, data: { status: "failed" } })
      .catch(() => {});
    throw error;
  }
}

/** Store the outcome of one webhook/manual run; keeps only the newest events per shop. */
export async function recordEmailEvent({ shop, productGid, source, outcome, detail }) {
  try {
    await db.emailWebhookEvent.create({
      data: { shop, productGid: productGid || "", source, outcome, detail: detail || "" },
    });
    const stale = await db.emailWebhookEvent.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      skip: EVENTS_KEPT_PER_SHOP,
      select: { id: true },
    });
    if (stale.length) {
      await db.emailWebhookEvent.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    }
  } catch (error) {
    console.error("[artist-email] could not record event", { message: error?.message });
  }
}

/** Run the pipeline and record its outcome; never throws. */
export async function runAndRecord({ admin, shop, productGid, source, ignoreAge = false }) {
  let result;
  try {
    result = await handleProductWebhook({ admin, shop, productGid, ignoreAge });
  } catch (error) {
    console.error("[artist-email] announcement failed", { shop, productGid, message: error?.message });
    result = { status: "error", reason: "error", detail: error?.message || "Unexpected error" };
  }
  await recordEmailEvent({
    shop,
    productGid,
    source,
    outcome: result.status === "skipped" ? `skipped: ${result.reason}` : result.status,
    detail: result.detail,
  });
  return result;
}

/** Manual trigger: announce the most recently updated Active product that has an artist. */
export async function announceLatestProduct(admin, shop) {
  const data = await gql(admin, LATEST_PRODUCTS_QUERY, {});
  const product = (data?.products?.nodes ?? []).find((p) => p.artist?.reference?.id);
  if (!product) {
    return { status: "skipped", reason: "no_product", detail: "No Active product with custom.artist found." };
  }
  return runAndRecord({ admin, shop, productGid: product.id, source: "manual", ignoreAge: true });
}

/** Recent announcements for the admin page. */
export async function recentProductEmails(shop, take = 10) {
  return db.productEmailLog.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take,
  });
}

/** Recent webhook/manual outcomes for the admin page. */
export async function recentEmailEvents(shop, take = 15) {
  return db.emailWebhookEvent.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take,
  });
}
