import { useEffect } from "react";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  ensureCustomerFollowedArtistsDefinition,
  getConfigStatus,
} from "../lib/artist-follow.server";
import {
  APP_PROXY_BASE,
  CUSTOMER_METAFIELD,
} from "../lib/artist-follow-constants";

const PROXY_PATH = APP_PROXY_BASE;

const EMPTY_STATUS = {
  artistMetaobject: { ok: false, definition: null },
  productArtistMetafield: { ok: false, definition: null },
  customerFollowedMetafield: {
    exists: false,
    ok: false,
    typeMismatch: false,
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
    console.error("[artist-follow] admin loader error", { message: error?.message });
    return { status: EMPTY_STATUS, loadError: describeError(error) };
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  try {
    const result = await ensureCustomerFollowedArtistsDefinition(admin);
    const status = await getConfigStatus(admin);
    return { result, status, loadError: null };
  } catch (error) {
    console.error("[artist-follow] admin action error", { message: error?.message });
    return {
      result: { status: "error", reason: "request_failed", message: describeError(error) },
      status: EMPTY_STATUS,
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

  const status = fetcher.data?.status ?? initialStatus;
  const result = fetcher.data?.result;
  const loadError = fetcher.data?.loadError ?? initialLoadError;
  const isSubmitting = fetcher.state !== "idle";

  const artistOk = status.artistMetaobject.ok;
  const productOk = status.productArtistMetafield.ok;
  const customerOk = status.customerFollowedMetafield.ok;
  const typeMismatch = status.customerFollowedMetafield.typeMismatch;

  const ready = artistOk && productOk && customerOk;

  useEffect(() => {
    if (result?.status === "created") {
      shopify.toast.show("Customer metafield definition created");
    } else if (result?.status === "error") {
      shopify.toast.show("Setup could not be completed", { isError: true });
    }
  }, [result, shopify]);

  const runSetup = () => fetcher.submit({}, { method: "POST" });

  return (
    <s-page heading="Artist Follow">
      <s-button
        slot="primary-action"
        onClick={runSetup}
        {...(isSubmitting ? { loading: true } : {})}
        {...(customerOk ? { variant: "secondary" } : {})}
      >
        {customerOk ? "Re-check configuration" : "Create customer metafield"}
      </s-button>

      {loadError && (
        <s-section heading="Could not load configuration">
          <s-banner tone="critical">
            <s-paragraph>{loadError}</s-paragraph>
            <s-paragraph>
              If you just changed the app&apos;s access scopes, reinstall the app
              (stop and restart <s-text fontWeight="bold">npm run dev</s-text>,
              then reopen and approve the new permissions).
            </s-paragraph>
          </s-banner>
        </s-section>
      )}

      <s-section heading="Configuration">
        <s-stack direction="block" gap="base">
          {renderCheck(artistOk, "Artist metaobject definition found")}
          {renderCheck(productOk, "Product custom.artist metafield found")}
          {renderCheck(
            customerOk,
            "Customer custom.followed_artists metafield found",
          )}
          {renderCheck(true, `App Proxy configured (${PROXY_PATH})`)}
        </s-stack>

        <s-box padding="base">
          <s-badge tone={ready ? "success" : "attention"}>
            Status: {ready ? "READY" : "ACTION NEEDED"}
          </s-badge>
        </s-box>
      </s-section>

      {!artistOk && (
        <s-section heading="Artist metaobject missing">
          <s-paragraph>
            The app could not locate the Artist metaobject definition. Make sure
            the Artist metaobject exists and that the Product{" "}
            <s-text fontWeight="bold">custom.artist</s-text> metafield references
            it. The app reads that reference to scope the customer metafield.
          </s-paragraph>
        </s-section>
      )}

      {!productOk && (
        <s-section heading="Product custom.artist metafield missing">
          <s-paragraph>
            The Product <s-text fontWeight="bold">custom.artist</s-text>{" "}
            metaobject-reference metafield was not found. This app does not
            create or modify it — please add it in{" "}
            <s-text fontWeight="bold">
              Settings → Custom data → Products
            </s-text>{" "}
            so it references the Artist metaobject.
          </s-paragraph>
        </s-section>
      )}

      {typeMismatch && (
        <s-section heading="Configuration error">
          <s-banner tone="critical">
            <s-paragraph>
              A customer metafield{" "}
              <s-text fontWeight="bold">custom.followed_artists</s-text> already
              exists with type{" "}
              <s-text fontWeight="bold">
                {status.customerFollowedMetafield.actualType}
              </s-text>
              , but this feature needs{" "}
              <s-text fontWeight="bold">{CUSTOMER_METAFIELD.type}</s-text>. The
              app will not modify it automatically. Remove or fix the existing
              definition in{" "}
              <s-text fontWeight="bold">
                Settings → Custom data → Customers
              </s-text>
              , then re-check.
            </s-paragraph>
          </s-banner>
        </s-section>
      )}

      {result?.status === "error" && !typeMismatch && (
        <s-section heading="Setup error">
          <s-banner tone="critical">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        </s-section>
      )}

      {!customerOk && !typeMismatch && (
        <s-section heading="Customer metafield missing">
          <s-paragraph>
            The customer metafield definition has not been created yet. Click{" "}
            <s-text fontWeight="bold">Create customer metafield</s-text> above —
            the app creates it for you via the Admin GraphQL API (it never
            duplicates an existing definition).
          </s-paragraph>
        </s-section>
      )}

      <s-section slot="aside" heading="Customer metafield">
        <s-stack direction="block" gap="tight">
          <s-paragraph>
            <s-text tone="subdued">Namespace / key</s-text>
            <br />
            <s-text fontWeight="bold">
              {CUSTOMER_METAFIELD.namespace}.{CUSTOMER_METAFIELD.key}
            </s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text tone="subdued">Type</s-text>
            <br />
            <s-text fontWeight="bold">{CUSTOMER_METAFIELD.type}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text tone="subdued">Reference</s-text>
            <br />
            <s-text fontWeight="bold">
              {status.artistMetaobject.definition?.name || "Artist"} metaobject
            </s-text>
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Add the button to your theme">
        <s-paragraph>
          Online Store → Themes → Customize → open an{" "}
          <s-text fontWeight="bold">Artist</s-text> page (metaobject template) →
          Add block → Apps → <s-text fontWeight="bold">Follow Artist</s-text>.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Shopify Flow">
        <s-paragraph>
          Followers are stored on the customer, ready for a Flow that emails
          followers when an artist publishes a new product. This app does not
          send any email.
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
