import { authenticate } from "../shopify.server";
import { json, loggedInCustomerId } from "../lib/app-proxy.server";
import {
  ArtistFollowError,
  customerGidFromId,
  getArtistNotifications,
  markNotificationsSeen,
} from "../lib/artist-follow.server";

/**
 * GET /apps/artist-follow/notifications
 *
 * Returns the customer's followed artists and any new products published by
 * them since the customer last opened the notifications panel.
 */
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.public.appProxy(request);

  const customerId = loggedInCustomerId(request);
  if (!customerId) {
    return json({ logged_in: false, unseen_count: 0, artists: [], notifications: [] });
  }

  if (!admin) {
    return json({ logged_in: true, error: "app_unavailable" }, { status: 503 });
  }

  try {
    const result = await getArtistNotifications(admin, customerGidFromId(customerId));
    return json({
      logged_in: true,
      unseen_count: result.unseenCount,
      artists: result.artists,
      notifications: result.notifications,
    });
  } catch (error) {
    const status = error instanceof ArtistFollowError ? error.status : 500;
    console.error("[artist-follow] notifications error", {
      shop: session?.shop,
      code: error?.code,
      message: error?.message,
    });
    return json({ logged_in: true, error: "notifications_failed" }, { status });
  }
};

/**
 * POST /apps/artist-follow/notifications
 *
 * Marks notifications as seen (resets the unread badge).
 */
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.public.appProxy(request);

  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, { status: 405 });
  }

  const customerId = loggedInCustomerId(request);
  if (!customerId) {
    return json({ error: "login_required" }, { status: 401 });
  }

  if (!admin) {
    return json({ error: "app_unavailable" }, { status: 503 });
  }

  try {
    const result = await markNotificationsSeen(admin, customerGidFromId(customerId));
    return json({ ok: true, seen_at: result.seenAt });
  } catch (error) {
    const status = error instanceof ArtistFollowError ? error.status : 500;
    console.error("[artist-follow] notifications seen error", {
      shop: session?.shop,
      code: error?.code,
      message: error?.message,
    });
    return json({ error: "seen_failed" }, { status });
  }
};
