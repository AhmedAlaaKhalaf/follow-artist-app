import { authenticate } from "../shopify.server";
import { json, loggedInCustomerId, readArtistPayload } from "./app-proxy.server";
import {
  ArtistFollowError,
  customerGidFromId,
  followArtist,
  resolveArtist,
  unfollowArtist,
} from "./artist-follow.server";

/**
 * Shared handler for POST /follow and POST /unfollow.
 *
 * @param {Request} request
 * @param {"follow"|"unfollow"} mode
 */
export async function handleFollowMutation(request, mode) {
  // Throws 400 on invalid signature.
  const { admin, session } = await authenticate.public.appProxy(request);

  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, { status: 405 });
  }

  const customerId = loggedInCustomerId(request);
  if (!customerId) {
    // Must be logged in to modify their own list.
    return json({ error: "login_required" }, { status: 401 });
  }

  if (!admin) {
    return json({ error: "app_unavailable" }, { status: 503 });
  }

  const { type, handle } = await readArtistPayload(request);

  try {
    const artist = await resolveArtist(admin, { type, handle });
    if (!artist) {
      return json({ error: "artist_not_found" }, { status: 404 });
    }

    const args = {
      lockKey: `${session.shop}:${customerId}`,
      customerGid: customerGidFromId(customerId),
      artistGid: artist.id,
    };

    const result =
      mode === "follow"
        ? await followArtist(admin, args)
        : await unfollowArtist(admin, args);

    return json({ following: result.following });
  } catch (error) {
    const status = error instanceof ArtistFollowError ? error.status : 500;
    console.error(`[artist-follow] ${mode} error`, {
      shop: session?.shop,
      code: error?.code,
      message: error?.message,
      details: error?.details,
    });
    return json({ error: `${mode}_failed` }, { status });
  }
}
