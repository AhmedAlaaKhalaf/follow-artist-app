/** @type {import('@react-router/dev/config').Config} */
export default {
  // React Router 7.12+ adds CSRF protection to actions: a POST whose `origin`
  // header doesn't match the request URL's origin is rejected with 400
  // "Bad Request". Shopify embedded apps run inside the Admin iframe, so action
  // requests legitimately arrive with an Admin `origin` (e.g. admin.shopify.com)
  // while the request URL is the app's tunnel/host. Allow the Admin origins
  // Shopify uses (mirrors the `frame-ancestors` CSP set by
  // @shopify/shopify-app-react-router) so embedded actions work.
  //
  // Shopify's embedded App Bridge iframe issues action/data requests with an
  // opaque `Origin: null` (sandboxed iframe), so "null" must be allowed too.
  // These actions are still protected by Shopify's session-token (JWT) auth in
  // `authenticate.admin`, which the origin check does not replace.
  allowedActionOrigins: [
    "null",
    "admin.shopify.com",
    "*.myshopify.com",
    "*.spin.dev",
    "admin.myshopify.io",
    "admin.shop.dev",
    // Local dev is served through the Shopify CLI Cloudflare tunnel, whose
    // origin differs from the internal request URL.
    "*.trycloudflare.com",
  ],
};
