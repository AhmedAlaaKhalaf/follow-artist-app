import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getConfigStatus } from "../lib/artist-follow.server";
import { APP_PROXY_BASE } from "../lib/artist-follow-constants";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  try {
    const status = await getConfigStatus(admin);
    return { status, ok: true };
  } catch {
    return { status: null, ok: false };
  }
};

function renderStatus(ok, label) {
  return (
    <s-stack direction="inline" gap="tight" alignItems="center">
      <s-text tone={ok ? "success" : "critical"}>{ok ? "✓" : "✗"}</s-text>
      <s-text>{label}</s-text>
    </s-stack>
  );
}

export default function Home() {
  const { status, ok } = useLoaderData();

  const artistOk = Boolean(status?.artistMetaobject?.ok);
  const productOk = Boolean(status?.productArtistMetafield?.ok);
  const customerOk = Boolean(status?.customerFollowedMetafield?.ok);
  const ready = ok && artistOk && productOk && customerOk;

  return (
    <s-page heading="Artist Follow">
      <s-button slot="primary-action" href="/app/artist-follow" variant="primary">
        Open settings
      </s-button>

      <s-section heading="Overview">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Let logged-in customers follow their favourite artists. Follows are
            stored on the customer as{" "}
            <s-text fontWeight="bold">custom.followed_artists</s-text> and power
            the storefront Follow button and the notification bell — ready for a
            Shopify Flow that emails followers about new products.
          </s-paragraph>
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-badge tone={ready ? "success" : "attention"}>
              {ready ? "READY" : "ACTION NEEDED"}
            </s-badge>
            {!ready && (
              <s-text tone="subdued">
                Finish setup on the settings page.
              </s-text>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Configuration">
        <s-stack direction="block" gap="base">
          {renderStatus(artistOk, "Artist metaobject definition")}
          {renderStatus(productOk, "Product custom.artist metafield")}
          {renderStatus(customerOk, "Customer custom.followed_artists metafield")}
          {renderStatus(true, `App Proxy (${APP_PROXY_BASE})`)}
        </s-stack>
        {!ready && (
          <s-box padding="base">
            <s-button href="/app/artist-follow" variant="primary">
              Go to setup
            </s-button>
          </s-box>
        )}
      </s-section>

      <s-section heading="Storefront setup">
        <s-ordered-list>
          <s-list-item>
            <s-text fontWeight="bold">Follow button</s-text> — Online Store →
            Themes → Customize → open an Artist template → Add block → Apps →
            Follow Artist.
          </s-list-item>
          <s-list-item>
            <s-text fontWeight="bold">Notification bell</s-text> — paste the
            header snippet (<s-text fontWeight="bold">
              theme-snippets/artist-notification-bell.liquid
            </s-text>
            ) into your header, next to the search/cart icons.
          </s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section slot="aside" heading="How it works">
        <s-unordered-list>
          <s-list-item>Follow / unfollow via secure App Proxy endpoints.</s-list-item>
          <s-list-item>Customer identity verified server-side.</s-list-item>
          <s-list-item>No extra database — Shopify data is the source of truth.</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Shopify Flow">
        <s-paragraph>
          Use <s-text fontWeight="bold">custom.followed_artists</s-text> in a
          Flow to email followers when an artist publishes a new product. This
          app maintains the data; it does not send email.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
