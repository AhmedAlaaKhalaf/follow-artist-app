import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getConfigStatus } from "../lib/artist-follow.server";
import { APP_ARTIST_METAOBJECT_TYPE } from "../lib/artist-follow-constants";
import { loadDashboard } from "../lib/dashboard.server";
import { emailConfig } from "../lib/resend.server";
import { setupChecks } from "../lib/setup-checks";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  let status = null;
  try {
    status = await getConfigStatus(admin);
  } catch (error) {
    console.error("[dashboard] config status failed", { message: error?.message });
  }

  const artistType =
    status?.artistMetaobject?.definition?.type || APP_ARTIST_METAOBJECT_TYPE;
  const dashboard = await loadDashboard(admin, session.shop, artistType);
  const config = emailConfig();

  return {
    ready: status ? setupChecks(status).ready : false,
    emailsOn: config.enabled && config.ready,
    dashboard,
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
  };
};

const numberFormat = new Intl.NumberFormat();

function renderMetric(label, value, icon) {
  return (
    <s-section>
      <s-stack direction="block" gap="small-200">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-icon type={icon} tone="subdued" size="small" />
          <s-text color="subdued">{label}</s-text>
        </s-stack>
        <s-heading>{numberFormat.format(value)}</s-heading>
      </s-stack>
    </s-section>
  );
}

function renderSetupStep({ done, title, description, action }) {
  return (
    <s-stack direction="inline" gap="base" alignItems="start" justifyContent="space-between">
      <s-stack direction="inline" gap="small-200" alignItems="start">
        <s-icon
          type={done ? "check-circle-filled" : "circle-dashed"}
          tone={done ? "success" : "subdued"}
        />
        <s-stack direction="block" gap="small-500">
          <s-text type="strong">{title}</s-text>
          <s-text color="subdued">{description}</s-text>
        </s-stack>
      </s-stack>
      {action}
    </s-stack>
  );
}

export default function Home() {
  const { ready, emailsOn, dashboard, apiKey } = useLoaderData();
  const themeEditorUrl = `shopify:admin/themes/current/editor?template=metaobject&addAppBlockId=${apiKey}/follow-artist&target=mainSection`;

  return (
    <s-page heading="Artist Follow">
      <s-button slot="primary-action" href="/app/artist-follow">
        Settings
      </s-button>

      {!ready && (
        <s-banner tone="warning" heading="Finish setting up Artist Follow">
          <s-paragraph>
            A few store settings are missing. Customers can&apos;t follow
            artists until setup is complete.
          </s-paragraph>
          <s-button slot="secondary-actions" href="/app/artist-follow">
            Complete setup
          </s-button>
        </s-banner>
      )}

      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
        {renderMetric("Artists", dashboard.artistCount, "person")}
        {renderMetric("Follows", dashboard.followCount, "heart")}
        {renderMetric("Announcements", dashboard.announcements, "megaphone")}
        {renderMetric("Emails sent", dashboard.emailsSent, "email")}
      </s-grid>

      <s-section heading="Top artists">
        {dashboard.topArtists.length ? (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Artist</s-table-header>
              <s-table-header listSlot="secondary" format="numeric">
                Followers
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {dashboard.topArtists.map((artist) => (
                <s-table-row key={artist.id}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-avatar
                        size="small"
                        initials={artist.name.slice(0, 2).toUpperCase()}
                        {...(artist.imageUrl ? { src: artist.imageUrl } : {})}
                        alt={artist.name}
                      />
                      <s-text>{artist.name}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{numberFormat.format(artist.followers)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-paragraph color="subdued">
            Add artist profiles in Content → Metaobjects → Artist to see them here.
          </s-paragraph>
        )}
      </s-section>

      <s-section heading="Recent announcements">
        {dashboard.recentAnnouncements.length ? (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header listSlot="kicker">Artist</s-table-header>
              <s-table-header listSlot="inline" format="numeric">
                Recipients
              </s-table-header>
              <s-table-header listSlot="secondary">Sent</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {dashboard.recentAnnouncements.map((item) => (
                <s-table-row key={item.id}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-thumbnail
                        size="small-200"
                        alt={item.productTitle}
                        {...(item.imageUrl ? { src: item.imageUrl } : {})}
                      />
                      <s-link href={`shopify:admin/products/${item.productId}`}>
                        {item.productTitle}
                      </s-link>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{item.artistName}</s-table-cell>
                  <s-table-cell>{numberFormat.format(item.recipients)}</s-table-cell>
                  <s-table-cell>{new Date(item.sentAt).toLocaleDateString()}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-paragraph color="subdued">
            When you publish a product by an artist, their followers are emailed
            automatically. Announcements will appear here.
          </s-paragraph>
        )}
      </s-section>

      <s-section slot="aside" heading="Get started">
        <s-stack direction="block" gap="base">
          {renderSetupStep({
            done: ready,
            title: "Complete store setup",
            description: "Create the artist and follower settings in one click.",
            action: !ready && (
              <s-button href="/app/artist-follow" variant="tertiary">
                Set up
              </s-button>
            ),
          })}
          <s-divider />
          {renderSetupStep({
            done: false,
            title: "Add the Follow button",
            description: "Add the Follow Artist block to your artist page template.",
            action: (
              <s-button href={themeEditorUrl} target="_blank" variant="tertiary">
                Add
              </s-button>
            ),
          })}
          <s-divider />
          {renderSetupStep({
            done: false,
            title: "Add the notification bell",
            description: "Place the artist notification bell in your theme header.",
          })}
          <s-divider />
          {renderSetupStep({
            done: emailsOn,
            title: "Email followers",
            description: "Followers get an email when an artist publishes a new product.",
            action: (
              <s-button href="/app/artist-follow" variant="tertiary">
                {emailsOn ? "Manage" : "Set up"}
              </s-button>
            ),
          })}
        </s-stack>
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
