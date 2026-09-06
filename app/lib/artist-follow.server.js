/**
 * Core server logic for the "Follow Artist" feature.
 *
 * Source of truth: the customer metafield `custom.followed_artists`
 * (type `list.metaobject_reference`, referencing the Artist metaobject).
 *
 * Nothing in here trusts data from the browser other than the Artist the
 * customer is looking at. The authenticated customer is always resolved from
 * the signed App Proxy `logged_in_customer_id` parameter by the caller.
 */

import {
  APP_ARTIST_METAOBJECT_TYPE,
  CUSTOMER_METAFIELD,
  NOTIFICATIONS_DEFAULT_LOOKBACK_DAYS,
  NOTIFICATIONS_SEEN_METAFIELD,
  PRODUCT_ARTIST_METAFIELD,
} from "./artist-follow-constants";

export {
  APP_ARTIST_METAOBJECT_TYPE,
  CUSTOMER_METAFIELD,
  PRODUCT_ARTIST_METAFIELD,
};

/** Error carrying GraphQL userErrors / transport errors without leaking to storefront. */
export class ArtistFollowError extends Error {
  constructor(message, { status = 500, code = "internal_error", details } = {}) {
    super(message);
    this.name = "ArtistFollowError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Run an Admin GraphQL operation and surface transport-level errors. */
async function adminGraphql(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const body = await response.json();
  if (body?.errors?.length) {
    throw new ArtistFollowError("Admin GraphQL request failed", {
      code: "graphql_error",
      details: body.errors,
    });
  }
  return body.data;
}

/* -------------------------------------------------------------------------- */
/*  Metafield / metaobject definition discovery                               */
/* -------------------------------------------------------------------------- */

const CONFIG_QUERY = `#graphql
  query ArtistFollowConfig {
    productArtist: metafieldDefinitions(
      first: 1
      ownerType: PRODUCT
      namespace: "custom"
      key: "artist"
    ) {
      nodes {
        id
        name
        namespace
        key
        type { name }
        validations { name value }
      }
    }
    customerFollowed: metafieldDefinitions(
      first: 1
      ownerType: CUSTOMER
      namespace: "custom"
      key: "followed_artists"
    ) {
      nodes {
        id
        name
        namespace
        key
        type { name }
        validations { name value }
      }
    }
  }
`;

const METAOBJECT_DEFINITION_BY_TYPE_QUERY = `#graphql
  query MetaobjectDefinitionByType($type: String!) {
    metaobjectDefinitionByType(type: $type) {
      id
      name
      type
      access { admin storefront }
      capabilities {
        publishable { enabled }
        translatable { enabled }
        renderable { enabled }
        onlineStore { enabled data { urlHandle } }
      }
      fieldDefinitions { key name type { name } required }
    }
  }
`;

const METAOBJECT_DEFINITIONS_QUERY = `#graphql
  query ArtistMetaobjectDefinitions {
    metaobjectDefinitions(first: 100) {
      nodes {
        id
        name
        type
        access { admin storefront }
        capabilities {
          publishable { enabled }
          translatable { enabled }
          renderable { enabled }
          onlineStore { enabled data { urlHandle } }
        }
      }
    }
  }
`;

const METAOBJECT_DEFINITION_BY_ID_QUERY = `#graphql
  query MetaobjectDefinition($id: ID!) {
    metaobjectDefinition(id: $id) {
      id
      name
      type
      access { admin storefront }
      capabilities {
        publishable { enabled }
        translatable { enabled }
        renderable { enabled }
        onlineStore { enabled data { urlHandle } }
      }
    }
  }
`;

const CREATE_ARTIST_DEFINITION_MUTATION = `#graphql
  mutation CreateAppArtistDefinition($definition: MetaobjectDefinitionCreateInput!) {
    metaobjectDefinitionCreate(definition: $definition) {
      metaobjectDefinition {
        id
        name
        type
        capabilities {
          publishable { enabled }
          translatable { enabled }
          renderable { enabled }
          onlineStore { enabled data { urlHandle } }
        }
      }
      userErrors { field message code }
    }
  }
`;

const UPDATE_ARTIST_DEFINITION_MUTATION = `#graphql
  mutation UpdateAppArtistDefinition($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
    metaobjectDefinitionUpdate(id: $id, definition: $definition) {
      metaobjectDefinition {
        id
        name
        type
        capabilities {
          publishable { enabled }
          translatable { enabled }
          renderable { enabled }
          onlineStore { enabled data { urlHandle } }
        }
      }
      userErrors { field message code }
    }
  }
`;

function isAppArtistType(type) {
  if (!type) return false;
  const t = type.toLowerCase();
  // Exact app shorthand, or deployed form: app--<api_key>--artist
  return t === APP_ARTIST_METAOBJECT_TYPE || /^app--[a-f0-9]+--artist$/.test(t);
}

function artistOptionsSummary(definition) {
  const caps = definition?.capabilities || {};
  return {
    publishable: Boolean(caps.publishable?.enabled),
    translatable: Boolean(caps.translatable?.enabled),
    renderable: Boolean(caps.renderable?.enabled),
    onlineStore: Boolean(caps.onlineStore?.enabled),
    storefront: definition?.access?.storefront === "PUBLIC_READ",
    urlHandle: caps.onlineStore?.data?.urlHandle || null,
  };
}

/**
 * Find the Artist metaobject definition.
 * Prefers the app-owned `$app:artist`.
 * Falls back to Product `custom.artist` validation, then merchant type `artist`.
 */
export async function resolveArtistDefinition(admin, config) {
  // 1. App-owned definition (preferred).
  const byType = await adminGraphql(admin, METAOBJECT_DEFINITION_BY_TYPE_QUERY, {
    type: APP_ARTIST_METAOBJECT_TYPE,
  });
  if (byType?.metaobjectDefinitionByType) {
    return byType.metaobjectDefinitionByType;
  }

  const listed = await adminGraphql(admin, METAOBJECT_DEFINITIONS_QUERY, {});
  const nodes = listed?.metaobjectDefinitions?.nodes ?? [];
  const appOwned =
    nodes.find((n) => isAppArtistType(n.type)) ||
    nodes.find(
      (n) =>
        n.name?.toLowerCase() === "artist" &&
        String(n.type || "").toLowerCase().startsWith("app--"),
    );
  if (appOwned) return appOwned;

  // 2. Product custom.artist validation (may still point at merchant Artist).
  const productDef = config?.productArtist?.nodes?.[0];
  const validationId = productDef?.validations?.find(
    (v) => v.name === "metaobject_definition_id",
  )?.value;

  if (validationId) {
    const data = await adminGraphql(admin, METAOBJECT_DEFINITION_BY_ID_QUERY, {
      id: validationId,
    });
    if (data?.metaobjectDefinition) {
      return data.metaobjectDefinition;
    }
  }

  // 3. Last resort: merchant-owned type "artist".
  return (
    nodes.find((n) => n.type?.toLowerCase() === "artist") ||
    nodes.find((n) => n.name?.toLowerCase() === "artist") ||
    null
  );
}

/**
 * Inspect the store configuration for the admin setup page.
 * Never throws for "not configured" states — it reports them.
 */
export async function getConfigStatus(admin) {
  const config = await adminGraphql(admin, CONFIG_QUERY, {});

  const productArtist = config?.productArtist?.nodes?.[0] ?? null;
  const customerFollowed = config?.customerFollowed?.nodes?.[0] ?? null;

  const artistDefinition = await resolveArtistDefinition(admin, config);
  const usingAppArtist = isAppArtistType(artistDefinition?.type);
  const options = artistOptionsSummary(artistDefinition);
  const optionsReady =
    usingAppArtist &&
    options.publishable &&
    options.translatable &&
    options.renderable &&
    options.onlineStore &&
    options.storefront;

  const productRefId = productArtist?.validations?.find(
    (v) => v.name === "metaobject_definition_id",
  )?.value;
  const productPointsAtAppArtist =
    Boolean(productRefId) &&
    Boolean(artistDefinition?.id) &&
    productRefId === artistDefinition.id &&
    usingAppArtist;

  const customerRefId = customerFollowed?.validations?.find(
    (v) => v.name === "metaobject_definition_id",
  )?.value;
  const customerPointsAtAppArtist =
    Boolean(customerRefId) &&
    Boolean(artistDefinition?.id) &&
    customerRefId === artistDefinition.id &&
    usingAppArtist;

  const customerTypeOk =
    customerFollowed?.type?.name === CUSTOMER_METAFIELD.type;

  return {
    artistMetaobject: {
      ok: Boolean(artistDefinition),
      usingAppArtist,
      optionsReady,
      options,
      expectedType: APP_ARTIST_METAOBJECT_TYPE,
      definition: artistDefinition,
    },
    productArtistMetafield: {
      ok: Boolean(productArtist),
      pointsAtAppArtist: productPointsAtAppArtist,
      definition: productArtist,
    },
    customerFollowedMetafield: {
      exists: Boolean(customerFollowed),
      ok: Boolean(customerFollowed) && customerTypeOk,
      typeMismatch: Boolean(customerFollowed) && !customerTypeOk,
      pointsAtAppArtist: customerPointsAtAppArtist,
      actualType: customerFollowed?.type?.name ?? null,
      definition: customerFollowed,
    },
  };
}

/** Create or update `$app:artist` with the screenshot fields + metaobject options. */
export async function ensureArtistMetaobjectDefinition(admin) {
  const existing = await adminGraphql(admin, METAOBJECT_DEFINITION_BY_TYPE_QUERY, {
    type: APP_ARTIST_METAOBJECT_TYPE,
  });
  let definition = existing?.metaobjectDefinitionByType;

  if (!definition) {
    const listed = await adminGraphql(admin, METAOBJECT_DEFINITIONS_QUERY, {});
    definition =
      (listed?.metaobjectDefinitions?.nodes ?? []).find((n) =>
        isAppArtistType(n.type),
      ) || null;
  }

  const desiredCapabilities = {
    publishable: { enabled: true },
    translatable: { enabled: true },
    renderable: {
      enabled: true,
      data: { metaTitleKey: "name", metaDescriptionKey: "bio" },
    },
    onlineStore: {
      enabled: true,
      data: { urlHandle: "artists" },
    },
  };

  if (!definition) {
    const createInput = {
      name: "Artist",
      type: APP_ARTIST_METAOBJECT_TYPE,
      description: "Artist profile used by the Follow Artist feature",
      displayNameKey: "name",
      access: {
        admin: "MERCHANT_READ_WRITE",
        storefront: "PUBLIC_READ",
      },
      capabilities: desiredCapabilities,
      fieldDefinitions: [
        {
          key: "name",
          name: "Name",
          type: "single_line_text_field",
          required: true,
        },
        {
          key: "image",
          name: "Image",
          type: "file_reference",
          required: true,
          validations: [{ name: "file_type_options", value: '["Image"]' }],
        },
        {
          key: "bio",
          name: "Bio",
          type: "multi_line_text_field",
          required: true,
        },
        {
          key: "collection",
          name: "Collection",
          type: "collection_reference",
          required: true,
        },
      ],
    };

    const data = await adminGraphql(admin, CREATE_ARTIST_DEFINITION_MUTATION, {
      definition: createInput,
    });
    const result = data.metaobjectDefinitionCreate;
    if (result.userErrors?.length) {
      return {
        status: "error",
        reason: "artist_create_failed",
        message: result.userErrors.map((e) => e.message).join("; "),
      };
    }
    return { status: "created", definition: result.metaobjectDefinition };
  }

  // Exists — enable missing options (Online Store especially).
  const options = artistOptionsSummary(definition);
  if (
    options.publishable &&
    options.translatable &&
    options.renderable &&
    options.onlineStore &&
    options.storefront
  ) {
    return { status: "exists", definition };
  }

  const data = await adminGraphql(admin, UPDATE_ARTIST_DEFINITION_MUTATION, {
    id: definition.id,
    definition: {
      access: {
        admin: "MERCHANT_READ_WRITE",
        storefront: "PUBLIC_READ",
      },
      capabilities: desiredCapabilities,
    },
  });
  const result = data.metaobjectDefinitionUpdate;
  if (result.userErrors?.length) {
    const managed = result.userErrors.some(
      (e) => e.code === "APP_CONFIG_MANAGED" || /app configuration/i.test(e.message),
    );
    return {
      status: "error",
      reason: managed ? "artist_config_managed" : "artist_update_failed",
      message: managed
        ? "Artist is still managed by shopify.app.toml. Remove [metaobjects.app.artist] from the TOML, run `shopify app deploy --allow-updates --allow-deletes`, then click Run setup again."
        : result.userErrors.map((e) => e.message).join("; "),
    };
  }
  return { status: "updated", definition: result.metaobjectDefinition };
}

const CREATE_DEFINITION_MUTATION = `#graphql
  mutation CreateFollowedArtistsDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        name
        namespace
        key
        type { name }
      }
      userErrors { field message code }
    }
  }
`;

/** Create Product `custom.artist` referencing the app Artist, if missing. */
export async function ensureProductArtistMetafield(admin, artistDefinition) {
  if (!artistDefinition?.id) {
    return {
      status: "error",
      reason: "artist_definition_missing",
      message: "Artist metaobject must exist before creating Product custom.artist.",
    };
  }

  const status = await getConfigStatus(admin);
  if (status.productArtistMetafield.pointsAtAppArtist) {
    return { status: "exists", definition: status.productArtistMetafield.definition };
  }

  if (status.productArtistMetafield.ok && !status.productArtistMetafield.pointsAtAppArtist) {
    return {
      status: "error",
      reason: "product_artist_wrong_reference",
      message:
        'Product metafield "custom.artist" already exists but points at a different metaobject. In Settings → Custom data → Products → artist, change the reference to the app Artist ($app:artist), or delete that definition and click Run setup again.',
    };
  }

  const definition = {
    name: "Artist",
    namespace: PRODUCT_ARTIST_METAFIELD.namespace,
    key: PRODUCT_ARTIST_METAFIELD.key,
    ownerType: "PRODUCT",
    type: "metaobject_reference",
    description: "Artist who created this product.",
    validations: [
      { name: "metaobject_definition_id", value: artistDefinition.id },
    ],
  };

  const data = await adminGraphql(admin, CREATE_DEFINITION_MUTATION, { definition });
  const result = data.metafieldDefinitionCreate;
  if (result.userErrors?.length) {
    const taken = result.userErrors.some((e) => e.code === "TAKEN");
    if (taken) return { status: "exists" };
    return {
      status: "error",
      reason: "product_create_failed",
      message: result.userErrors.map((e) => e.message).join("; "),
    };
  }
  return { status: "created", definition: result.createdDefinition };
}

/**
 * Idempotently ensure the `custom.followed_artists` customer metafield
 * definition exists with the correct type and Artist reference.
 */
export async function ensureCustomerFollowedArtistsDefinition(admin, artistDefinition) {
  const status = await getConfigStatus(admin);
  const artist = artistDefinition || status.artistMetaobject.definition;

  if (status.customerFollowedMetafield.typeMismatch) {
    return {
      status: "error",
      reason: "type_mismatch",
      message: `A customer metafield "custom.followed_artists" already exists with type "${status.customerFollowedMetafield.actualType}". Expected "${CUSTOMER_METAFIELD.type}". Please remove or fix the existing definition; the app will not modify it automatically.`,
    };
  }

  if (
    status.customerFollowedMetafield.ok &&
    status.customerFollowedMetafield.pointsAtAppArtist
  ) {
    return { status: "exists", definition: status.customerFollowedMetafield.definition };
  }

  if (
    status.customerFollowedMetafield.ok &&
    !status.customerFollowedMetafield.pointsAtAppArtist
  ) {
    return {
      status: "error",
      reason: "customer_wrong_reference",
      message:
        'Customer metafield "custom.followed_artists" already exists but points at a different Artist. Delete it in Settings → Custom data → Customers, then click Run setup again.',
    };
  }

  if (!artist?.id) {
    return {
      status: "error",
      reason: "artist_definition_missing",
      message: `Could not locate the app Artist metaobject (${APP_ARTIST_METAOBJECT_TYPE}). Click Run setup to create it.`,
    };
  }

  const definition = {
    name: CUSTOMER_METAFIELD.name,
    namespace: CUSTOMER_METAFIELD.namespace,
    key: CUSTOMER_METAFIELD.key,
    ownerType: CUSTOMER_METAFIELD.ownerType,
    type: CUSTOMER_METAFIELD.type,
    description: "Artists this customer follows (used by Shopify Flow).",
    validations: [
      { name: "metaobject_definition_id", value: artist.id },
    ],
  };

  const data = await adminGraphql(admin, CREATE_DEFINITION_MUTATION, { definition });
  const result = data.metafieldDefinitionCreate;

  if (result.userErrors?.length) {
    const taken = result.userErrors.some((e) => e.code === "TAKEN");
    if (taken) return { status: "exists" };
    return {
      status: "error",
      reason: "create_failed",
      message: result.userErrors.map((e) => e.message).join("; "),
    };
  }

  return { status: "created", definition: result.createdDefinition };
}

/**
 * Full setup: Artist options → Product custom.artist → Customer followed_artists.
 */
export async function runArtistFollowSetup(admin) {
  const steps = [];

  const artistResult = await ensureArtistMetaobjectDefinition(admin);
  steps.push({ step: "artist", ...artistResult });
  if (artistResult.status === "error") {
    return { status: "error", message: artistResult.message, steps };
  }

  const artistDefinition = artistResult.definition;
  const productResult = await ensureProductArtistMetafield(admin, artistDefinition);
  steps.push({ step: "product", ...productResult });
  if (productResult.status === "error") {
    return { status: "error", message: productResult.message, steps };
  }

  const customerResult = await ensureCustomerFollowedArtistsDefinition(
    admin,
    artistDefinition,
  );
  steps.push({ step: "customer", ...customerResult });
  if (customerResult.status === "error") {
    return { status: "error", message: customerResult.message, steps };
  }

  const anyCreated = steps.some((s) => s.status === "created" || s.status === "updated");
  return {
    status: anyCreated ? "created" : "exists",
    message: anyCreated
      ? "Setup completed: Artist options, Product custom.artist, and Customer followed_artists are ready."
      : "Everything was already configured.",
    steps,
  };
}

/* -------------------------------------------------------------------------- */
/*  Artist resolution                                                         */
/* -------------------------------------------------------------------------- */

const METAOBJECT_BY_HANDLE_QUERY = `#graphql
  query ArtistByHandle($handle: MetaobjectHandleInput!) {
    metaobjectByHandle(handle: $handle) {
      id
      handle
      type
      displayName
    }
  }
`;

/**
 * Resolve and validate the Artist the storefront is asking about.
 * The browser only supplies the metaobject `type` + `handle` (from the current
 * page); the backend turns that into a real, existing metaobject GID.
 *
 * @returns {Promise<{id: string, handle: string, type: string} | null>}
 */
export async function resolveArtist(admin, { type, handle }) {
  if (!type || !handle) return null;
  const data = await adminGraphql(admin, METAOBJECT_BY_HANDLE_QUERY, {
    handle: { type, handle },
  });
  return data?.metaobjectByHandle ?? null;
}

/* -------------------------------------------------------------------------- */
/*  Read / write the customer's followed artists                              */
/* -------------------------------------------------------------------------- */

const READ_FOLLOWED_QUERY = `#graphql
  query CustomerFollowedArtists($id: ID!) {
    customer(id: $id) {
      id
      metafield(namespace: "custom", key: "followed_artists") {
        id
        type
        value
        references(first: 250) {
          nodes {
            ... on Metaobject { id }
          }
        }
      }
    }
  }
`;

const SET_FOLLOWED_MUTATION = `#graphql
  mutation SetCustomerFollowedArtists($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value }
      userErrors { field message code }
    }
  }
`;

/**
 * Read the customer's current followed-artist GIDs.
 * Tolerates a missing metafield and malformed JSON.
 *
 * @returns {Promise<{ customerExists: boolean, gids: string[] }>}
 */
export async function getFollowedArtists(admin, customerGid) {
  const data = await adminGraphql(admin, READ_FOLLOWED_QUERY, { id: customerGid });

  if (!data?.customer) {
    return { customerExists: false, gids: [] };
  }

  const metafield = data.customer.metafield;
  if (!metafield) {
    return { customerExists: true, gids: [] };
  }

  let gids = [];
  try {
    const parsed = JSON.parse(metafield.value);
    if (Array.isArray(parsed)) {
      gids = parsed.filter((v) => typeof v === "string");
    }
  } catch {
    // Malformed value — fall back to the resolved references so we never
    // clobber the list with garbage on the next write.
    gids = (metafield.references?.nodes ?? []).map((n) => n.id).filter(Boolean);
  }

  return { customerExists: true, gids: dedupe(gids) };
}

async function writeFollowedArtists(admin, customerGid, gids) {
  const value = JSON.stringify(dedupe(gids));
  const data = await adminGraphql(admin, SET_FOLLOWED_MUTATION, {
    metafields: [
      {
        ownerId: customerGid,
        namespace: CUSTOMER_METAFIELD.namespace,
        key: CUSTOMER_METAFIELD.key,
        type: CUSTOMER_METAFIELD.type,
        value,
      },
    ],
  });

  const errors = data.metafieldsSet.userErrors;
  if (errors?.length) {
    throw new ArtistFollowError("Failed to update followed artists", {
      code: "metafield_write_failed",
      details: errors,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Follow / unfollow (idempotent, serialized per customer)                   */
/* -------------------------------------------------------------------------- */

/**
 * Add the artist to the customer's list. Idempotent: following twice is a no-op.
 * Serialized per customer to avoid lost updates from concurrent requests.
 */
export async function followArtist(admin, { lockKey, customerGid, artistGid }) {
  return withCustomerLock(lockKey, async () => {
    const { gids } = await getFollowedArtists(admin, customerGid);
    if (gids.includes(artistGid)) {
      return { following: true, changed: false };
    }
    await writeFollowedArtists(admin, customerGid, [...gids, artistGid]);
    return { following: true, changed: true };
  });
}

/**
 * Remove the artist from the customer's list. Idempotent: unfollowing an
 * artist that isn't present still returns { following: false }.
 */
export async function unfollowArtist(admin, { lockKey, customerGid, artistGid }) {
  return withCustomerLock(lockKey, async () => {
    const { gids } = await getFollowedArtists(admin, customerGid);
    if (!gids.includes(artistGid)) {
      return { following: false, changed: false };
    }
    await writeFollowedArtists(
      admin,
      customerGid,
      gids.filter((id) => id !== artistGid),
    );
    return { following: false, changed: true };
  });
}

/**
 * Is the customer currently following the artist? (read-only, no lock needed)
 */
export async function isFollowing(admin, { customerGid, artistGid }) {
  const { gids } = await getFollowedArtists(admin, customerGid);
  return gids.includes(artistGid);
}

/* -------------------------------------------------------------------------- */
/*  Notifications: followed artists + new products from them                  */
/* -------------------------------------------------------------------------- */

const NOTIFICATIONS_QUERY = `#graphql
  query ArtistNotifications($id: ID!) {
    customer(id: $id) {
      id
      followed: metafield(namespace: "custom", key: "followed_artists") {
        references(first: 100) {
          nodes {
            ... on Metaobject {
              id
              handle
              displayName
              image: field(key: "image") {
                reference {
                  ... on MediaImage { image { url(transform: { maxWidth: 96, maxHeight: 96 }) } }
                }
              }
            }
          }
        }
      }
      seen: metafield(namespace: "custom", key: "artist_notifications_seen_at") {
        value
      }
    }
  }
`;

const ARTIST_PRODUCTS_QUERY = `#graphql
  query ArtistNewProducts($query: String!) {
    products(first: 250, sortKey: CREATED_AT, reverse: true, query: $query) {
      nodes {
        id
        title
        handle
        status
        onlineStoreUrl
        createdAt
        publishedAt
        featuredMedia {
          preview { image { url(transform: { maxWidth: 128, maxHeight: 128 }) } }
        }
        artist: metafield(namespace: "custom", key: "artist") {
          reference {
            ... on Metaobject { id }
          }
        }
      }
    }
  }
`;

// How many products (by followed artists) to surface in the panel.
const NOTIFICATIONS_LIMIT = 30;

/**
 * Build the notifications payload for a customer:
 *  - `artists`: the artists they follow (name, handle, image)
 *  - `notifications`: products published by those artists since the customer
 *    last opened the panel (their `artist_notifications_seen_at` timestamp)
 *
 * The source of truth is Shopify data only — no separate table.
 */
export async function getArtistNotifications(admin, customerGid) {
  const data = await adminGraphql(admin, NOTIFICATIONS_QUERY, { id: customerGid });

  if (!data?.customer) {
    return { customerExists: false, artists: [], notifications: [], unseenCount: 0, lastSeen: null };
  }

  const followedNodes = data.customer.followed?.references?.nodes ?? [];
  const artists = followedNodes.filter(Boolean).map((node) => ({
    id: node.id,
    handle: node.handle,
    name: node.displayName,
    image_url: node.image?.reference?.image?.url ?? null,
  }));
  const followedById = new Map(artists.map((a) => [a.id, a]));

  const seenValue = data.customer.seen?.value ?? null;
  const since = seenValue
    ? new Date(seenValue)
    : new Date(Date.now() - NOTIFICATIONS_DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  let notifications = [];
  let unseenCount = 0;
  if (followedById.size > 0) {
    try {
      // Active products only (drafts/archived shouldn't be advertised), newest
      // first. We list every product by a followed artist (so the panel isn't
      // empty) and flag which ones are "new" since the last-seen timestamp.
      const productData = await adminGraphql(admin, ARTIST_PRODUCTS_QUERY, {
        query: "status:active",
      });
      const nodes = productData?.products?.nodes ?? [];
      for (const product of nodes) {
        const artistId = product.artist?.reference?.id;
        if (!artistId || !followedById.has(artistId)) continue;

        // publishedAt can be null even for active products; fall back to
        // createdAt so newly added products are never missed.
        const timestamp = product.publishedAt || product.createdAt;
        const isNew = timestamp ? new Date(timestamp) > since : false;
        if (isNew) unseenCount += 1;

        const artist = followedById.get(artistId);
        notifications.push({
          product_id: product.id,
          title: product.title,
          url: product.onlineStoreUrl || `/products/${product.handle}`,
          image_url: product.featuredMedia?.preview?.image?.url ?? null,
          published_at: timestamp,
          is_new: isNew,
          artist_id: artistId,
          artist_name: artist.name,
          artist_handle: artist.handle,
        });

        if (notifications.length >= NOTIFICATIONS_LIMIT) break;
      }
    } catch (error) {
      // Never fail the whole panel if the product lookup errors; still show
      // the followed artists.
      console.error("[artist-follow] notifications product query failed", {
        message: error?.message,
      });
    }
  }

  return {
    customerExists: true,
    artists,
    notifications,
    unseenCount,
    lastSeen: seenValue,
  };
}

/**
 * Mark all notifications as seen by stamping "now" on the customer.
 * Stored as an unstructured `date_time` metafield (no definition needed).
 */
export async function markNotificationsSeen(admin, customerGid) {
  const nowIso = new Date().toISOString();
  const data = await adminGraphql(admin, SET_FOLLOWED_MUTATION, {
    metafields: [
      {
        ownerId: customerGid,
        namespace: NOTIFICATIONS_SEEN_METAFIELD.namespace,
        key: NOTIFICATIONS_SEEN_METAFIELD.key,
        type: NOTIFICATIONS_SEEN_METAFIELD.type,
        value: nowIso,
      },
    ],
  });

  const errors = data.metafieldsSet.userErrors;
  if (errors?.length) {
    throw new ArtistFollowError("Failed to mark notifications seen", {
      code: "metafield_write_failed",
      details: errors,
    });
  }
  return { seenAt: nowIso };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function customerGidFromId(numericId) {
  return `gid://shopify/Customer/${numericId}`;
}

function dedupe(list) {
  return [...new Set(list)];
}

/**
 * Per-customer serialization.
 *
 * Shopify metafields have no compare-and-swap / version token, so concurrent
 * read-modify-write cycles from *different* app instances can still race (see
 * README "Race conditions"). Within a single instance we chain operations for
 * the same customer so multi-click and overlapping follow/unfollow requests do
 * not lose updates or create duplicates.
 */
const customerLocks = new Map();

function withCustomerLock(key, task) {
  const previous = customerLocks.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  // Keep the chain alive but swallow rejections so one failure doesn't poison
  // the next queued task; clean up the map once this is the tail.
  const tail = run.catch(() => {}).finally(() => {
    if (customerLocks.get(key) === tail) {
      customerLocks.delete(key);
    }
  });
  customerLocks.set(key, tail);
  return run;
}
