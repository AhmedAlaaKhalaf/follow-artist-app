/**
 * Customer tag index for followed artists.
 *
 * Each follow is mirrored as a customer tag `follows-artist-{handle}` so the
 * app (email) or Shopify Flow can search "customers who follow artist X".
 * `custom.followed_artists` remains the source of truth for the follow button
 * and notification bell; nothing here reads or writes that metafield.
 */

import { CUSTOMER_METAFIELD, FOLLOW_TAG_PREFIX, followTagForHandle } from "./artist-follow-constants";

const THROTTLE_RETRIES = 5;

async function gql(admin, query, variables) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await admin.graphql(query, { variables });
    const body = await response.json();
    const errors = body?.errors ?? [];
    const throttled = errors.some((e) => e?.extensions?.code === "THROTTLED");
    if (throttled && attempt < THROTTLE_RETRIES) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (errors.length) {
      throw new Error(errors.map((e) => e.message).filter(Boolean).join("; ") || "Admin GraphQL request failed");
    }
    return body.data;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TAGS_ADD_MUTATION = `#graphql
  mutation FollowTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

const TAGS_REMOVE_MUTATION = `#graphql
  mutation FollowTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

async function changeTags(admin, mutation, field, customerGid, tags) {
  if (!tags.length) return;
  const data = await gql(admin, mutation, { id: customerGid, tags });
  const errors = data?.[field]?.userErrors ?? [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
}

/**
 * Best-effort: add or remove the follow tag for one customer.
 * Never throws — a tag failure must not affect the follow/unfollow response.
 */
export async function syncFollowTag(admin, { customerGid, artistHandle, following }) {
  if (!admin || !customerGid || !artistHandle) return;
  const tag = followTagForHandle(artistHandle);
  try {
    if (following) {
      await changeTags(admin, TAGS_ADD_MUTATION, "tagsAdd", customerGid, [tag]);
    } else {
      await changeTags(admin, TAGS_REMOVE_MUTATION, "tagsRemove", customerGid, [tag]);
    }
  } catch (error) {
    console.warn("[artist-follow] follow tag sync failed", {
      customerGid,
      tag,
      following,
      message: error?.message,
    });
  }
}

const CUSTOMERS_PAGE_QUERY = `#graphql
  query FollowTagCustomers($after: String) {
    customers(first: 100, after: $after) {
      nodes {
        id
        tags
        followed: metafield(namespace: "${CUSTOMER_METAFIELD.namespace}", key: "${CUSTOMER_METAFIELD.key}") {
          value
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const METAOBJECT_HANDLES_QUERY = `#graphql
  query FollowTagArtistHandles($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Metaobject { id handle }
    }
  }
`;

function parseGids(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((v) => typeof v === "string" && v.startsWith("gid://shopify/Metaobject/"))
      : [];
  } catch {
    return [];
  }
}

async function resolveHandles(admin, gids, cache) {
  const missing = gids.filter((id) => !cache.has(id));
  for (let i = 0; i < missing.length; i += 100) {
    const ids = missing.slice(i, i + 100);
    const data = await gql(admin, METAOBJECT_HANDLES_QUERY, { ids });
    for (const id of ids) cache.set(id, null);
    for (const node of data?.nodes ?? []) {
      if (node?.id && node.handle) cache.set(node.id, node.handle);
    }
  }
}

/**
 * Make every customer's `follows-artist-*` tags match their
 * `custom.followed_artists` list. Only tags with our prefix are ever removed.
 */
export async function rebuildFollowTags(admin) {
  const handleCache = new Map();
  const summary = { customersScanned: 0, customersUpdated: 0, tagsAdded: 0, tagsRemoved: 0, failures: 0 };

  let after = null;
  do {
    const data = await gql(admin, CUSTOMERS_PAGE_QUERY, { after });
    const page = data?.customers;
    const nodes = page?.nodes ?? [];

    const pageGids = [...new Set(nodes.flatMap((n) => parseGids(n.followed?.value)))];
    await resolveHandles(admin, pageGids, handleCache);

    for (const customer of nodes) {
      summary.customersScanned += 1;
      const desired = new Set(
        parseGids(customer.followed?.value)
          .map((gid) => handleCache.get(gid))
          .filter(Boolean)
          .map(followTagForHandle),
      );
      const existing = new Set(
        (customer.tags ?? []).map((t) => t.toLowerCase()).filter((t) => t.startsWith(FOLLOW_TAG_PREFIX)),
      );
      const toAdd = [...desired].filter((t) => !existing.has(t));
      const toRemove = [...existing].filter((t) => !desired.has(t));
      if (!toAdd.length && !toRemove.length) continue;

      try {
        await changeTags(admin, TAGS_ADD_MUTATION, "tagsAdd", customer.id, toAdd);
        await changeTags(admin, TAGS_REMOVE_MUTATION, "tagsRemove", customer.id, toRemove);
        summary.customersUpdated += 1;
        summary.tagsAdded += toAdd.length;
        summary.tagsRemoved += toRemove.length;
      } catch (error) {
        summary.failures += 1;
        console.warn("[artist-follow] rebuild tags failed for customer", {
          customerGid: customer.id,
          message: error?.message,
        });
      }
    }

    after = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  return summary;
}
