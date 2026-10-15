import { useEffect } from "react";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getConfigStatus,
  runArtistFollowSetup,
} from "../lib/artist-follow.server";
import { rebuildFollowTags } from "../lib/artist-follow-tags.server";
import { emailConfig, sendTestEmail } from "../lib/resend.server";
import { setupChecks } from "../lib/setup-checks";

function loadEmailSettings() {
  const config = emailConfig();
  return {
    enabled: config.enabled,
    hasApiKey: config.hasApiKey,
    from: config.from,
    requireMarketingConsent: config.requireMarketingConsent,
  };
}

const SHOP_EMAIL_QUERY = `#graphql
  query ArtistEmailShopContact { shop { email contactEmail } }
`;

async function handleIntent(intent, admin) {
  if (intent === "sync-followers") {
    try {
      const summary = await rebuildFollowTags(admin);
      const changed = summary.customersUpdated;
      return {
        notice: {
          ok: summary.failures === 0,
          message: changed
            ? `Followers synced. ${changed} customer${changed === 1 ? "" : "s"} updated.`
            : "Followers are already up to date.",
        },
      };
    } catch (error) {
      return { notice: { ok: false, message: describeError(error) } };
    }
  }

  if (intent === "test-email") {
    try {
      const response = await admin.graphql(SHOP_EMAIL_QUERY);
      const body = await response.json();
      const to = body?.data?.shop?.contactEmail || body?.data?.shop?.email;
      if (!to) {
        return { notice: { ok: false, message: "Add a store contact email in Settings → General first." } };
      }
      const result = await sendTestEmail(to);
      return { notice: { ok: result.ok, message: result.message } };
    } catch (error) {
      return { notice: { ok: false, message: describeError(error) } };
    }
  }

  return null;
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const email = loadEmailSettings();
  try {
    const status = await getConfigStatus(admin);
    return { status, loadError: null, email };
  } catch (error) {
    console.error("[artist-follow] admin loader error", {
      message: error?.message,
      details: error?.details,
    });
    return { status: null, loadError: describeError(error), email };
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const intentResult = await handleIntent(formData.get("intent"), admin);
  if (intentResult) return intentResult;

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
    let status = null;
    try {
      status = await getConfigStatus(admin);
    } catch {
      // keep null
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
  return error?.message || "Something went wrong while contacting Shopify.";
}

function renderStatusRow({ id, ok, label, description }) {
  return (
    <s-stack key={id} direction="inline" gap="base" alignItems="center" justifyContent="space-between">
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-icon
          type={ok ? "check-circle-filled" : "alert-circle"}
          tone={ok ? "success" : "critical"}
        />
        <s-stack direction="block" gap="small-500">
          <s-text type="strong">{label}</s-text>
          {description && <s-text color="subdued">{description}</s-text>}
        </s-stack>
      </s-stack>
    </s-stack>
  );
}

function renderSettingRow(label, value) {
  return (
    <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
      <s-text color="subdued">{label}</s-text>
      <s-text>{value}</s-text>
    </s-stack>
  );
}

export default function Settings() {
  const { status: initialStatus, loadError: initialLoadError, email } =
    useLoaderData();
  const setupFetcher = useFetcher();
  const toolsFetcher = useFetcher();
  const shopify = useAppBridge();

  const status = setupFetcher.data?.status ?? initialStatus;
  const result = setupFetcher.data?.result;
  const loadError = setupFetcher.data?.loadError ?? initialLoadError;
  const settingUp = setupFetcher.state !== "idle";

  const { checks, ready } = setupChecks(status);
  const typeMismatch = Boolean(status?.customerFollowedMetafield?.typeMismatch);

  const notice = toolsFetcher.data?.notice;
  const toolsBusy = toolsFetcher.state !== "idle";
  const pendingIntent = toolsBusy ? toolsFetcher.formData?.get("intent") : null;

  const emailConfigured = email.hasApiKey && Boolean(email.from);
  const emailsOn = email.enabled && emailConfigured;

  useEffect(() => {
    if (!result) return;
    if (result.status === "error") {
      shopify.toast.show(result.message || "Setup could not be completed", { isError: true });
    } else {
      shopify.toast.show("Setup complete");
    }
  }, [result, shopify]);

  useEffect(() => {
    if (!notice) return;
    shopify.toast.show(notice.message, notice.ok ? undefined : { isError: true });
  }, [notice, shopify]);

  const runSetup = () => setupFetcher.submit({}, { method: "POST" });
  const runTool = (intent) => toolsFetcher.submit({ intent }, { method: "POST" });

  return (
    <s-page heading="Settings">
      {loadError && (
        <s-banner tone="critical" heading="Couldn't load your store settings">
          <s-paragraph>{loadError}</s-paragraph>
          <s-paragraph>
            If you recently updated the app, reopen it and approve any new
            permissions.
          </s-paragraph>
        </s-banner>
      )}

      {result?.status === "error" && (
        <s-banner tone="critical" heading="Setup couldn't be completed">
          <s-paragraph>{result.message}</s-paragraph>
        </s-banner>
      )}

      {typeMismatch && (
        <s-banner tone="critical" heading="Conflicting customer field">
          <s-paragraph>
            Your store already has a customer field named &quot;Followed
            artists&quot; with a different type. Delete it in Settings → Custom
            data → Customers, then run setup again.
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Store setup">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-paragraph color="subdued">
              Artist Follow needs a few store settings to save artists and
              followers.
            </s-paragraph>
            <s-badge tone={ready ? "success" : "warning"}>
              {ready ? "Ready" : "Action needed"}
            </s-badge>
          </s-stack>
          <s-divider />
          {checks.map(renderStatusRow)}
          <s-stack direction="inline" gap="base">
            <s-button
              variant={ready ? "secondary" : "primary"}
              onClick={runSetup}
              {...(settingUp ? { loading: true } : {})}
            >
              {ready ? "Check again" : "Run setup"}
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Email notifications">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-paragraph color="subdued">
              Followers get an email when an artist they follow publishes a new
              product.
            </s-paragraph>
            <s-badge tone={emailsOn ? "success" : "neutral"}>
              {emailsOn ? "On" : "Off"}
            </s-badge>
          </s-stack>
          <s-divider />
          {renderSettingRow("Sender", email.from || "Not set")}
          {renderSettingRow(
            "Recipients",
            email.requireMarketingConsent
              ? "Followers subscribed to email marketing"
              : "All followers, except unsubscribed",
          )}
          {!emailConfigured && (
            <s-banner tone="info">
              <s-paragraph>
                Email sending isn&apos;t configured on the server yet. Add the
                Resend API key and sender address to the app&apos;s environment
                to turn on notifications.
              </s-paragraph>
            </s-banner>
          )}
          {emailConfigured && !email.enabled && (
            <s-banner tone="info">
              <s-paragraph>
                Email sending is paused on the server. Set
                EMAIL_NOTIFICATIONS_ENABLED to true to resume.
              </s-paragraph>
            </s-banner>
          )}
          <s-stack direction="inline" gap="base">
            <s-button
              variant="secondary"
              icon="email"
              onClick={() => runTool("test-email")}
              {...(pendingIntent === "test-email" ? { loading: true } : {})}
              {...(toolsBusy || !emailConfigured ? { disabled: true } : {})}
            >
              Send test email
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Followers">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Followers are kept in sync automatically. If you imported customers
            or edited follows manually, sync them so they receive announcements.
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-button
              variant="secondary"
              icon="refresh"
              onClick={() => runTool("sync-followers")}
              {...(pendingIntent === "sync-followers" ? { loading: true } : {})}
              {...(toolsBusy ? { disabled: true } : {})}
            >
              Sync followers
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="How it works">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="start">
            <s-icon type="heart" tone="subdued" />
            <s-paragraph>
              Customers follow artists from the artist page on your store.
            </s-paragraph>
          </s-stack>
          <s-stack direction="inline" gap="small-200" alignItems="start">
            <s-icon type="notification" tone="subdued" />
            <s-paragraph>
              New products from followed artists appear in the storefront
              notification bell.
            </s-paragraph>
          </s-stack>
          <s-stack direction="inline" gap="small-200" alignItems="start">
            <s-icon type="email" tone="subdued" />
            <s-paragraph>
              Followers get one email per new product, sent automatically.
            </s-paragraph>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
