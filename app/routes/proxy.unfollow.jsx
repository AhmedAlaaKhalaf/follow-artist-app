import { handleFollowMutation } from "../lib/follow-endpoint.server";
import { json } from "../lib/app-proxy.server";

/**
 * POST /apps/artist-follow/unfollow
 * Body: { type: <metaobject type>, handle: <artist handle> }
 */
export const action = async ({ request }) => {
  return handleFollowMutation(request, "unfollow");
};

// Reject GETs to the mutation endpoint cleanly.
export const loader = async () => {
  return json({ error: "method_not_allowed" }, { status: 405 });
};
