/**
 * Client-safe constants for the Follow Artist feature.
 *
 * Kept in a non-`.server` module so both server code and React components
 * (e.g. the admin setup page) can import them without pulling server-only
 * code into the client bundle.
 */

export const CUSTOMER_METAFIELD = {
  name: "Followed artists",
  namespace: "custom",
  key: "followed_artists",
  type: "list.metaobject_reference",
  ownerType: "CUSTOMER",
};

export const PRODUCT_ARTIST_METAFIELD = {
  namespace: "custom",
  key: "artist",
  ownerType: "PRODUCT",
};

// App-internal state: when the customer last opened the notifications panel.
// Stored as an unstructured customer metafield (no definition required).
export const NOTIFICATIONS_SEEN_METAFIELD = {
  namespace: "custom",
  key: "artist_notifications_seen_at",
  type: "date_time",
};

// How far back to look for "new" products the first time a customer opens the
// panel (before any "seen" timestamp exists).
export const NOTIFICATIONS_DEFAULT_LOOKBACK_DAYS = 30;

/** Storefront App Proxy base path (prefix + subpath from shopify.app.toml). */
export const APP_PROXY_BASE = "/apps/artist-follow";
