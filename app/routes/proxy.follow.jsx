import { handleFollowMutation } from "../lib/follow-endpoint.server";
import { json } from "../lib/app-proxy.server";

/**
 * POST /apps/artist-follow/follow
 * Body: { type: <metaobject type>, handle: <artist handle> }
 */
export const action = async ({ request }) => {
  return handleFollowMutation(request, "follow");
};

// Reject GETs to the mutation endpoint cleanly.
export const loader = async () => {
  return json({ error: "method_not_allowed" }, { status: 405 });
};
