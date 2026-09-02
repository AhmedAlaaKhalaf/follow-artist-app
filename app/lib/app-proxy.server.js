/**
 * Shared helpers for the App Proxy storefront endpoints.
 *
 * Security model:
 *  - `authenticate.public.appProxy` validates the request HMAC. If it is
 *    invalid the helper throws a 400 Response before we run any logic.
 *  - The authenticated customer is taken ONLY from `logged_in_customer_id`,
 *    which Shopify appends to the (signed) query string. The browser cannot
 *    forge it without invalidating the signature, so a malicious user cannot
 *    act on behalf of another customer.
 */

/** JSON response with storefront-safe, non-cacheable headers. */
export function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });
}

/** The signed, trusted customer id (or null when logged out). */
export function loggedInCustomerId(request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("logged_in_customer_id");
  return id && id.trim() !== "" ? id.trim() : null;
}

/** Read the Artist identifier the storefront sent (from a POST body). */
export async function readArtistPayload(request) {
  const contentType = request.headers.get("content-type") || "";
  try {
    if (contentType.includes("application/json")) {
      const body = await request.json();
      return normalizeArtist(body);
    }
    const form = await request.formData();
    return normalizeArtist(Object.fromEntries(form));
  } catch {
    return { type: "", handle: "" };
  }
}

/** Read the Artist identifier from the query string (for GET /status). */
export function readArtistQuery(request) {
  const url = new URL(request.url);
  return normalizeArtist({
    type: url.searchParams.get("type"),
    handle: url.searchParams.get("handle"),
  });
}

function normalizeArtist(source = {}) {
  return {
    type: String(source.type ?? "").trim(),
    handle: String(source.handle ?? "").trim(),
  };
}
