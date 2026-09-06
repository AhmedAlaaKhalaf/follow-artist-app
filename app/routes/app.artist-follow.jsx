import { useEffect } from "react";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getConfigStatus,
  runArtistFollowSetup,
} from "../lib/artist-follow.server";
import {
  APP_ARTIST_METAOBJECT_TYPE,
  APP_PROXY_BASE,
  CUSTOMER_METAFIELD,
} from "../lib/artist-follow-constants";

const PROXY_PATH = APP_PROXY_BASE;

const EMPTY_STATUS = {
  artistMetaobject: {
    ok: false,
    usingAppArtist: false,
    optionsReady: false,
    options: {},
    expectedType: APP_ARTIST_METAOBJECT_TYPE,
    definition: null,
  },
  productArtistMetafield: {
    ok: false,
    pointsAtAppArtist: false,
    definition: null,
  },
  customerFollowedMetafield: {
    exists: false,
    ok: false,
    typeMismatch: false,
    pointsAtAppArtist: false,
    actualType: null,
    definition: null,
  },
};

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  try {
    const status = await getConfigStatus(admin);
    return { status, loadError: null };
  } catch (error) {
    console.error("[artist-follow] admin loader error", {
      message: error?.message,
      details: error?.details,
    });
    return { status: EMPTY_STATUS, loadError: describeError(error) };
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  try {
    const result = await runArtistFollowSetup(admin);
    const status = await getConfigStatus(admin);
    return { result, status, loadError: null };
  } catch (error) {
    console.error("[artist-follow] admin action error", {
      message: error?.message,
      details: error?.details,
      stack: error?.stack,
    });
    let status = EMPTY_STATUS;
    try {
      status = await getConfigStatus(admin);
    } catch {
      // keep EMPTY_STATUS
    }
    return {
      result: {
        status: "error",
        reason: "request_failed",
        message: describeError(error),
      },
      status,
      loadError: null,
    };
  }
};

function describeError(error) {
  const details = error?.details;
  if (Array.isArray(details) && details[0]?.message) {
    return details.map((d) => d.message).join("; ");
  }
  return error?.message || "Unexpected error contacting the Shopify Admin API.";
}

function renderCheck(ok, label) {
  return (
    <s-stack direction="inline" gap="tight" alignItems="center">
      <s-text tone={ok ? "success" : "critical"}>{ok ? "✓" : "✗"}</s-text>
      <s-text>{label}</s-text>
    </s-stack>
  );
}

export default function ArtistFollowSetup() {
  const { status: initialStatus, loadError: initialLoadError } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const status = fetcher.data?.status ?? initialStatus ?? EMPTY_STATUS;
  const result = fetcher.data?.result;
  const loadError = fetcher.data?.loadError ?? initialLoadError;
  const isSubmitting = fetcher.state !== "idle";

  const artistOk = Boolean(status.artistMetaobject?.ok);
  const usingAppArtist = Boolean(status.artistMetaobject?.usingAppArtist);
  const optionsReady = Boolean(status.artistMetaobject?.optionsReady);
  const options = status.artistMetaobject?.options || {};
  const productOk = Boolean(status.productArtistMetafield?.ok);
  const productPointsAtApp = Boolean(
    status.productArtistMetafield?.pointsAtAppArtist,
  );
  const customerOk = Boolean(status.customerFollowedMetafield?.ok);
  const customerPointsAtApp = Boolean(
    status.customerFollowedMetafield?.pointsAtAppArtist,
  );
  const typeMismatch = Boolean(status.customerFollowedMetafield?.typeMismatch);
  const artistType =
    status.artistMetaobject?.definition?.type || APP_ARTIST_METAOBJECT_TYPE;
  const ready =
    artistOk &&
    usingAppArtist &&
    optionsReady &&
    productOk &&
    productPointsAtApp &&
    customerOk &&
    customerPointsAtApp;

  useEffect(() => {
    if (!result) return;
    if (result.status === "created" || result.status === "exists") {
      shopify.toast.show(result.message || "Setup complete");
    } else if (result.status === "error") {
      shopify.toast.show(result.message || "Setup could not be completed", {
        isError: true,
      });
    }
  }, [result, shopify]);

  const runSetup = () => fetcher.submit({}, { method: "POST" });

  return (
    <s-page heading="Artist Follow">
      <s-button
        slot="primary-action"
        onClick={runSetup}
        {...(isSubmitting ? { loading: true } : {})}
        {...(ready ? { variant: "secondary" } : {})}
      >
        {ready ? "Re-check configuration" : "Run setup"}
      </s-button>

      {loadError && (
        <s-section heading="Could not load configuration">
          <s-banner tone="critical">
            <s-paragraph>{loadError}</s-paragraph>
            <s-paragraph>
              If you just changed the app&apos;s access scopes, reopen the app
              and approve the new permissions.
            </s-paragraph>
          </s-banner>
        </s-section>
      )}

      <s-section heading="Configuration">
        <s-stack direction="block" gap="base">
          {renderCheck(
            artistOk && usingAppArtist,
            `Artist metaobject (${artistType})`,
          )}
          {renderCheck(optionsReady, "Artist metaobject options enabled")}
          {renderCheck(
            productOk && productPointsAtApp,
            "Product custom.artist → app Artist",
          )}
          {renderCheck(
            customerOk && customerPointsAtApp,
            "Customer custom.followed_artists → app Artist",
          )}
          {renderCheck(true, `App Proxy configured (${PROXY_PATH})`)}
        </s-stack>

        <s-box padding="base">
          <s-badge tone={ready ? "success" : "attention"}>
            Status: {ready ? "READY" : "ACTION NEEDED"}
          </s-badge>
        </s-box>
      </s-section>

      {usingAppArtist && !optionsReady && (
        <s-section heading="Artist options">
          <s-stack direction="block" gap="tight">
            {renderCheck(options.publishable, "Active-draft status")}
            {renderCheck(options.translatable, "Translations")}
            {renderCheck(options.renderable, "Renderable / SEO")}
            {renderCheck(options.onlineStore, "Publish as web pages (Online Store)")}
            {renderCheck(options.storefront, "Storefronts API access")}
          </s-stack>
          <s-paragraph>
            Click <s-text fontWeight="bold">Run setup</s-text> to enable these.
            Online Store pages will use URL handle{" "}
            <s-text fontWeight="bold">/artists/…</s-text>.
          </s-paragraph>
        </s-section>
      )}

      {result?.status === "error" && (
        <s-section heading="Setup error">
          <s-banner tone="critical">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        </s-section>
      )}

      {typeMismatch && (
        <s-section heading="Configuration error">
          <s-banner tone="critical">
            <s-paragraph>
              <s-text fontWeight="bold">custom.followed_artists</s-text> exists
              with type{" "}
              <s-text fontWeight="bold">
                {status.customerFollowedMetafield.actualType}
              </s-text>
              , but this feature needs{" "}
              <s-text fontWeight="bold">{CUSTOMER_METAFIELD.type}</s-text>.
              Remove it in Settings → Custom data → Customers, then Run setup.
            </s-paragraph>
          </s-banner>
        </s-section>
      )}

      <s-section slot="aside" heading="What Run setup does">
        <s-stack direction="block" gap="tight">
          <s-paragraph>
            1. Creates/updates <s-text fontWeight="bold">{APP_ARTIST_METAOBJECT_TYPE}</s-text>{" "}
            (name, image, bio, collection) and enables metaobject options
            including Online Store pages.
          </s-paragraph>
          <s-paragraph>
            2. Creates Product <s-text fontWeight="bold">custom.artist</s-text>{" "}
            pointing at that Artist (if missing).
          </s-paragraph>
          <s-paragraph>
            3. Creates Customer{" "}
            <s-text fontWeight="bold">custom.followed_artists</s-text> pointing
            at that Artist (if missing).
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
