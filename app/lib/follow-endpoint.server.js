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
  let admin;
  let session;
  try {
    // Throws Response (400) on invalid signature.
    ({ admin, session } = await authenticate.public.appProxy(request));
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error(`[artist-follow] ${mode} auth error`, {
      message: error?.message,
      stack: error?.stack,
    });
    return json(
      { error: "auth_failed", message: "Could not authenticate the request." },
      { status: 401 },
    );
  }

  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, { status: 405 });
  }

  const customerId = loggedInCustomerId(request);
  if (!customerId) {
    return json(
      { error: "login_required", message: "Please log in to follow artists." },
      { status: 401 },
    );
  }

  if (!admin) {
    return json(
      {
        error: "app_unavailable",
        message:
          "App session is missing. Open the follow-artist app once in Shopify Admin, then try again.",
      },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const shop =
    session?.shop || url.searchParams.get("shop") || "unknown-shop";

  const { type, handle } = await readArtistPayload(request);
  if (!type || !handle) {
    return json(
      { error: "invalid_artist", message: "Missing artist type or handle." },
      { status: 400 },
    );
  }

  try {
    const artist = await resolveArtist(admin, { type, handle });
    if (!artist) {
      return json(
        {
          error: "artist_not_found",
          message: `Artist not found (type=${type}, handle=${handle}).`,
        },
        { status: 404 },
      );
    }

    const args = {
      lockKey: `${shop}:${customerId}`,
      customerGid: customerGidFromId(customerId),
      artistGid: artist.id,
    };

    const result =
      mode === "follow"
        ? await followArtist(admin, args)
        : await unfollowArtist(admin, args);

    return json({ following: result.following });
  } catch (error) {
    const status =
      error instanceof ArtistFollowError && error.status
        ? error.status
        : 500;
    console.error(`[artist-follow] ${mode} error`, {
      shop,
      type,
      handle,
      code: error?.code,
      message: error?.message,
      details: error?.details,
      stack: error?.stack,
    });
    return json(
      {
        error: error?.code || `${mode}_failed`,
        message:
          (error instanceof ArtistFollowError && error.message) ||
          error?.message ||
          "Something went wrong. Please try again.",
      },
      { status },
    );
  }
}
