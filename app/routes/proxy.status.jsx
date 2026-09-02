import { authenticate } from "../shopify.server";
import {
  json,
  loggedInCustomerId,
  readArtistQuery,
} from "../lib/app-proxy.server";
import {
  ArtistFollowError,
  customerGidFromId,
  isFollowing,
  resolveArtist,
} from "../lib/artist-follow.server";

/**
 * GET /apps/artist-follow/status?type=<metaobject type>&handle=<artist handle>
 *
 * Returns whether the logged-in customer follows the current artist.
 * Logged-out visitors get { logged_in: false, following: false } so the
 * storefront can render the button without an extra round trip.
 */
export const loader = async ({ request }) => {
  // Throws 400 on invalid signature.
  const { admin, session } = await authenticate.public.appProxy(request);

  const customerId = loggedInCustomerId(request);
  if (!customerId) {
    return json({ logged_in: false, following: false });
  }

  if (!admin) {
    // Offline session missing — misconfiguration, not the shopper's fault.
    return json(
      { logged_in: true, following: false, error: "app_unavailable" },
      { status: 503 },
    );
  }

  const { type, handle } = readArtistQuery(request);

  try {
    const artist = await resolveArtist(admin, { type, handle });
    if (!artist) {
      return json(
        { logged_in: true, following: false, error: "artist_not_found" },
        { status: 404 },
      );
    }

    const following = await isFollowing(admin, {
      customerGid: customerGidFromId(customerId),
      artistGid: artist.id,
    });

    return json({ logged_in: true, following });
  } catch (error) {
    return handleError(error, session?.shop);
  }
};

function handleError(error, shop) {
  const status = error instanceof ArtistFollowError ? error.status : 500;
  console.error("[artist-follow] status error", {
    shop,
    code: error?.code,
    message: error?.message,
    details: error?.details,
  });
  return json({ error: "status_failed" }, { status });
}
