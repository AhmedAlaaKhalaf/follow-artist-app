# Follow Artist app

A small, secure Shopify app that lets logged-in customers **follow / unfollow artists** on Artist metaobject pages. Follows are stored on the customer as `custom.followed_artists` (a `list.metaobject_reference`), ready for a future **Shopify Flow** that emails followers when an artist publishes a new product.

This app **does not** send email — it only maintains the follow relationship.

- [What the app does](#what-the-app-does)
- [Architecture](#architecture)
- [Required Shopify configuration](#required-shopify-configuration)
- [API scopes](#api-scopes)
- [App Proxy](#app-proxy)
- [Customer metafield (auto-created)](#customer-metafield-auto-created)
- [Theme app extension](#theme-app-extension)
- [How the Artist is detected](#how-the-artist-is-detected)
- [Storefront API (Follow / Unfollow / Status)](#storefront-api)
- [Security](#security-considerations)
- [Idempotency & race conditions](#idempotency--race-conditions)
- [Local development](#local-development)
- [Production deployment](#production-deployment)
- [Environment variables](#environment-variables)
- [Merchant setup steps (where to click)](#merchant-setup-steps-where-to-click)
- [Testing](#testing)
- [Shopify Flow integration](#shopify-flow-integration)

## What the app does

1. **Follow** an artist (adds the Artist metaobject reference to the customer).
2. **Unfollow** an artist (removes it).
3. **Read follow status** for the current artist.
4. Maintains `Customer.custom.followed_artists`.
5. Optional **notification bell**: shows followed artists and new products they published (see [Notification bell](#notification-bell)).

Everything else (emails/notifications) is intentionally out of scope and left to Shopify Flow.

## Architecture

| Concern | Choice |
| --- | --- |
| Framework | React Router 7 (`@shopify/shopify-app-react-router`) |
| Admin API | GraphQL, `2026-07` (`ApiVersion.July26`) |
| Auth | Shopify managed OAuth (embedded app) + **App Proxy** for storefront |
| Storefront ↔ backend | Shopify **App Proxy** (`/apps/artist-follow/*`) |
| Source of truth | Customer metafield `custom.followed_artists` (no extra DB table) |
| Session storage | Prisma / SQLite (template default, unchanged) |
| Button | Theme App Extension app block (auto-detects the artist) |

Key files added by this feature:

```
app/lib/artist-follow-constants.js   # client-safe constants
app/lib/artist-follow.server.js      # all Admin GraphQL + follow/unfollow logic
app/lib/app-proxy.server.js          # App Proxy request helpers (customer id, json)
app/lib/follow-endpoint.server.js    # shared follow/unfollow handler
app/routes/proxy.status.jsx          # GET  /apps/artist-follow/status
app/routes/proxy.follow.jsx          # POST /apps/artist-follow/follow
app/routes/proxy.unfollow.jsx        # POST /apps/artist-follow/unfollow
app/routes/app.artist-follow.jsx     # Admin "Artist Follow" setup page
extensions/follow-artist-button/     # Theme app extension (block + JS + CSS)
```

## Required Shopify configuration

The app **reads** (and never modifies) two things you already have:

- **Artist metaobject** definition (published to the Online Store, URLs like `/artists/ahmed-khalaf`).
- **Product** metafield `custom.artist` of type `metaobject_reference` → Artist.

The app **creates** (idempotently) one thing:

- **Customer** metafield definition `custom.followed_artists`, type `list.metaobject_reference`, referencing the Artist metaobject.

The Admin **Artist Follow** page reports the status of all four items and creates the customer metafield if it is missing.

## API scopes

Configured in `shopify.app.toml` (`access_scopes`):

| Scope | Why |
| --- | --- |
| `read_customers`, `write_customers` | Read/write the customer `custom.followed_artists` metafield and manage its definition (owner `CUSTOMER`). |
| `read_metaobjects` (via `write_metaobjects`) | Resolve & validate Artist metaobjects. |
| `write_metaobject_definitions` | Template-managed app metaobject definition. |
| `write_products` | Template demo only. The Follow feature only *reads* the Product `custom.artist` relationship (`read_products` would suffice). |

> **Protected customer data:** customer metafields are protected customer data. For a published/production app you must request **Protected customer data access** for your app in the Partner Dashboard. Development stores work without it.

## App Proxy

Declared in `shopify.app.toml`:

```toml
[app_proxy]
url = "https://example.com/proxy"
subpath = "artist-follow"
prefix = "apps"
```

Because `url` starts with `application_url`, `shopify app dev` automatically swaps the origin for the dev tunnel (the `/proxy` path is preserved). Storefront → backend mapping:

| Storefront | Backend route |
| --- | --- |
| `GET /apps/artist-follow/status` | `app/routes/proxy.status.jsx` |
| `POST /apps/artist-follow/follow` | `app/routes/proxy.follow.jsx` |
| `POST /apps/artist-follow/unfollow` | `app/routes/proxy.unfollow.jsx` |

Every request is verified with `authenticate.public.appProxy(request)` (HMAC signature). Invalid signatures get a `400`.

## Customer metafield (auto-created)

The app creates the definition via `metafieldDefinitionCreate` with:

```jsonc
{
  "name": "Followed artists",
  "namespace": "custom",
  "key": "followed_artists",
  "ownerType": "CUSTOMER",
  "type": "list.metaobject_reference",
  "access": { "admin": "MERCHANT_READ_WRITE" },
  "validations": [
    { "name": "metaobject_definition_id", "value": "gid://shopify/MetaobjectDefinition/…" }
  ]
}
```

The `metaobject_definition_id` is discovered from your **Product `custom.artist`** definition (authoritative), falling back to a metaobject definition whose type/name is `artist`.

Safety rules enforced in `ensureCustomerFollowedArtistsDefinition`:

- Checks for an existing definition **before** creating (no duplicates).
- If it exists with a **different type**, the app **does not** modify it and surfaces a clear configuration error.
- Runs on install (`afterAuth` hook, best-effort) and on demand from the Admin page.

The stored value is a JSON-encoded list of metaobject GIDs, e.g.

```json
["gid://shopify/Metaobject/1","gid://shopify/Metaobject/2"]
```

## Theme app extension

`extensions/follow-artist-button` provides a **Follow Artist** app block, restricted to metaobject templates:

```json
"enabled_on": { "templates": ["metaobject"] }
```

- `blocks/follow-artist.liquid` — renders the button + reads the current metaobject.
- `assets/follow-artist.js` — button state machine (loads status, follow/unfollow, guards double clicks).
- `assets/follow-artist.css` — minimal, theme-friendly styles (override freely).

## How the Artist is detected

No Artist ID is ever hardcoded or entered by the merchant. On a metaobject template, Liquid exposes the current entry as `metaobject`:

```liquid
data-artist-type="{{ metaobject.system.type }}"
data-artist-handle="{{ metaobject.system.handle }}"
```

The browser sends only `{ type, handle }`. The backend resolves the real GID with `metaobjectByHandle` and validates it exists. If it doesn't → `404 artist_not_found`.

## Storefront API

All responses are JSON with `Cache-Control: no-store`.

### `GET /apps/artist-follow/status?type=<type>&handle=<handle>`

```json
{ "logged_in": true, "following": true }
```

Logged-out visitors get `{ "logged_in": false, "following": false }` (no extra work).

### `POST /apps/artist-follow/follow`  — body `{ "type": "...", "handle": "..." }`

```json
{ "following": true }
```

### `POST /apps/artist-follow/unfollow`  — body `{ "type": "...", "handle": "..." }`

```json
{ "following": false }
```

Error responses use appropriate status codes and safe messages, never secrets or stack traces:

| Status | `error` | When |
| --- | --- | --- |
| 400 | (HMAC) | Invalid App Proxy signature |
| 401 | `login_required` | Not logged in (follow/unfollow) |
| 404 | `artist_not_found` | Artist handle/type doesn't resolve |
| 405 | `method_not_allowed` | Wrong HTTP method |
| 503 | `app_unavailable` | Offline session missing (misconfiguration) |
| 500 | `*_failed` | Unexpected error (details logged server-side only) |

## Notification bell

A **header bell icon** for logged-in customers. Opening it shows the artists they follow and products those artists have published; an unread badge counts products that are new since the customer last opened the panel.

It ships as a **self-contained Liquid snippet** (its own CSS + JS, no app assets required) so you can place it anywhere in your header, next to the search/cart icons:

- `theme-snippets/artist-notification-bell.liquid` — copy this file into your theme as `snippets/artist-notification-bell.liquid`.
- Then add this **shortcode** in the header, next to search / cart:

```liquid
{% render 'artist-notification-bell' %}
```

Optional:

```liquid
{% render 'artist-notification-bell', proxy: '/apps/artist-follow', artist_base: '/artists' %}
```

### API

`GET /apps/artist-follow/notifications`

```json
{
  "logged_in": true,
  "unseen_count": 1,
  "artists": [{ "id": "gid://…", "name": "Ahmed Khalaf", "handle": "ahmed-khalaf", "image_url": "…" }],
  "notifications": [
    { "product_id": "gid://…", "title": "Blue Horizon", "url": "/products/blue-horizon", "image_url": "…", "published_at": "…", "artist_name": "Ahmed Khalaf", "artist_handle": "ahmed-khalaf" }
  ]
}
```

`POST /apps/artist-follow/notifications` → marks notifications seen (resets the badge): `{ "ok": true }`.

### How "new products" is computed

No extra database. On open, the backend:

1. Reads the customer's followed artists (`custom.followed_artists`).
2. Reads their last-seen timestamp (`custom.artist_notifications_seen_at`, an unstructured `date_time` metafield the app writes — no definition needed). First-time visitors use a 30-day look-back.
3. Queries recent **active** products (`sortKey: CREATED_AT`, up to 250) and keeps those whose `custom.artist` is a followed artist. **Every** such product is listed in the panel (so it's never empty), and each is flagged `is_new` when its `publishedAt`/`createdAt` is after the last-seen timestamp. The unread badge counts the `is_new` ones.

> **Product must be Active.** Draft/archived products are intentionally excluded (a "View product" link to an unpublished product would 404). Ensure the product's `custom.artist` references a followed artist and the product status is **Active**.

This complements — and does not replace — the Shopify Flow email workflow. It requires `read_products` (covered by the template's `write_products`) and the same Protected customer data access as the follow feature.

### Enabling the bell

Copy `theme-snippets/artist-notification-bell.liquid` into `snippets/artist-notification-bell.liquid`, then paste `{% render 'artist-notification-bell' %}` in the header. It renders only for logged-in customers.

## Security considerations

- **Customer identity is never trusted from the browser.** It comes from `logged_in_customer_id`, which Shopify appends to the **signed** App Proxy query string. Forging it invalidates the HMAC → `400`.
- Admin API tokens / secrets stay on the server; the storefront JS only knows the artist `type`/`handle`.
- The backend resolves & validates the Artist GID server-side; the browser cannot inject arbitrary GIDs.
- A customer can only ever modify **their own** `followed_artists`.
- Malformed/oversized requests are handled without throwing internals to the shopper.

## Idempotency & race conditions

- **Follow** dedupes: following an already-followed artist is a no-op and still returns `{ following: true }`.
- **Unfollow** of an absent artist still returns `{ following: false }`.
- The button disables while a request is in flight and guards against duplicate clicks.
- Server-side, reads/writes for the same customer are **serialized in-process** (`withCustomerLock`) so overlapping requests don't lose updates.

> **Shopify limitation:** metafields have no compare-and-swap / version token. The in-process lock prevents lost updates within a single app instance. If you run **multiple instances**, two simultaneous read-modify-write cycles from different instances could still race. Mitigations if you scale horizontally: a shared lock (e.g. Redis), sticky routing per customer, or moving to a dedicated store. For a single-instance deployment (the template default) this is not a concern.

## Local development

```shell
npm install
npm run dev      # shopify app dev
```

Then press `P` to open and install the app on your dev store. On install, the app attempts to create the customer metafield definition automatically. Open **Apps → follow-artist-app → Artist Follow** to verify configuration.

> **Note — React Router CSRF / `allowedActionOrigins`:** React Router 7.12+ rejects `action` requests whose `Origin` header doesn't match the request URL origin (a `400 Bad Request` from `singleFetchAction`). Embedded admin actions and App Proxy POSTs legitimately arrive from other origins (the CLI Cloudflare tunnel, `admin.shopify.com`, the shop's `*.myshopify.com`), so `react-router.config.js` allows those origins. The endpoints stay protected by Shopify's session-token JWT (admin) and App Proxy HMAC (storefront), which the origin check does not replace. **Editing `react-router.config.js` requires a full dev-server restart** — it is not hot-reloaded.

## Production deployment

```shell
npm run deploy   # pushes app config (incl. App Proxy) + the theme extension
npm run build && npm run start
```

Set `application_url` / `app_proxy.url` to your production host, run `deploy`, and ensure `NODE_ENV=production`. See the template's [Deployment](#deployment) section below for hosting options.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `SHOPIFY_API_KEY` | App client id (provided by CLI) |
| `SHOPIFY_API_SECRET` | App secret — also used to verify App Proxy HMAC |
| `SHOPIFY_APP_URL` | Public app URL |
| `SCOPES` | Access scopes (kept in sync with `shopify.app.toml`) |
| `SHOP_CUSTOM_DOMAIN` | Optional custom shop domain |

## Merchant setup steps (where to click)

1. **Verify custom data**
   - `Settings → Custom data → Products` → confirm **artist** (`custom.artist`, metaobject reference → Artist).
   - `Settings → Custom data → Metaobjects` → confirm your **Artist** metaobject (published as Online Store pages).
2. **Create the customer metafield** (automatic)
   - Open the app → **Artist Follow** page → it shows a checklist. If “Customer custom.followed_artists metafield” is ✗, click **Create customer metafield**. Status should become **READY**.
   - You can confirm at `Settings → Custom data → Customers → Followed artists`.
3. **Add the Follow button to the Artist template**
   - `Online Store → Themes → Customize`.
   - In the top template picker, choose your **Artist** metaobject template (e.g. *Metaobject → Artist*), and open a real artist entry so it renders.
   - Click **Add section / Add block** in the area where you want the button → **Apps** → **Follow Artist**.
   - Save. (No Artist ID to enter — it auto-detects.)
   - Deep link shortcut: `https://<shop>.myshopify.com/admin/themes/current/editor?template=metaobject&addAppBlockId=<API_KEY>/follow-artist&target=mainSection`

## Testing

Manual test matrix (dev store):

1. **Logged-out** on an Artist page → button shows **Follow Artist**; click → redirected to customer login.
2. **Logged-in, not following** → **+ Follow Artist**; click → `custom.followed_artists` contains that artist; button → **✓ Following**.
3. **Reload** → still **✓ Following**.
4. **Click Following** → artist removed; button → **+ Follow Artist**.
5. **Follow several artists** → list contains all of them.
6. **Unfollow one** → only that one is removed.
7. **Rapid multi-click Follow** → no duplicate references (idempotent + in-flight guard).
8. **Different customer** → independent follow state.
9. **Artist B** unaffected by following Artist A.
10. **Nonexistent artist** (bad handle) → `404 artist_not_found`, button restores gracefully.

Static checks:

```shell
npm run lint
npm run typecheck
npm run build
```

## Shopify Flow integration

Intended future workflow (built in Flow, **not** in this app):

```
Customer follows Artist
   → Customer.custom.followed_artists updated
Artist publishes a new product (Product.custom.artist = Artist)
   → Flow finds customers whose followed_artists includes that Artist
   → Flow sends them an email
```

Because follows live on a standard `custom` customer metafield, Flow can read them directly. This app is only responsible for keeping that metafield accurate.

---

# Shopify App Template - React Router

This is a template for building a [Shopify app](https://shopify.dev/docs/apps/getting-started) using [React Router](https://reactrouter.com/). It was forked from the [Shopify Remix app template](https://github.com/Shopify/shopify-app-template-remix) and converted to React Router.

Rather than cloning this repo, follow the [Quick Start steps](https://github.com/Shopify/shopify-app-template-react-router#quick-start).

Visit the [`shopify.dev` documentation](https://shopify.dev/docs/api/shopify-app-react-router) for more details on the React Router app package.

## Upgrading from Remix

If you have an existing Remix app that you want to upgrade to React Router, please follow the [upgrade guide](https://github.com/Shopify/shopify-app-template-react-router/wiki/Upgrading-from-Remix). Otherwise, please follow the quick start guide below.

## Quick start

### Prerequisites

Before you begin, you'll need to [download and install the Shopify CLI](https://shopify.dev/docs/apps/tools/cli/getting-started) if you haven't already.

### Setup

```shell
shopify app init --template=https://github.com/Shopify/shopify-app-template-react-router
```

### Local Development

```shell
shopify app dev
```

Press P to open the URL to your app. Once you click install, you can start development.

Local development is powered by [the Shopify CLI](https://shopify.dev/docs/apps/tools/cli). It logs into your account, connects to an app, provides environment variables, updates remote config, creates a tunnel and provides commands to generate extensions.

### Authenticating and querying data

To authenticate and query data you can use the `shopify` const that is exported from `/app/shopify.server.js`:

```js
export async function loader({ request }) {
  const { admin } = await shopify.authenticate.admin(request);

  const response = await admin.graphql(`
    {
      products(first: 25) {
        nodes {
          title
          description
        }
      }
    }`);

  const {
    data: {
      products: { nodes },
    },
  } = await response.json();

  return nodes;
}
```

This template comes pre-configured with examples of:

1. Setting up your Shopify app in [/app/shopify.server.ts](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/shopify.server.ts)
2. Querying data using Graphql. Please see: [/app/routes/app.\_index.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/app._index.tsx).
3. Responding to webhooks. Please see [/app/routes/webhooks.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/webhooks.app.uninstalled.tsx).
4. Using metafields, metaobjects, and declarative custom data definitions. Please see [/app/routes/app.\_index.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/app._index.tsx) and [shopify.app.toml](https://github.com/Shopify/shopify-app-template-react-router/blob/main/shopify.app.toml).

Please read the [documentation for @shopify/shopify-app-react-router](https://shopify.dev/docs/api/shopify-app-react-router) to see what other API's are available.

## Shopify Dev MCP

This template is configured with the Shopify Dev MCP. This instructs [Cursor](https://cursor.com/), [GitHub Copilot](https://github.com/features/copilot) and [Claude Code](https://claude.com/product/claude-code) and [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) to use the Shopify Dev MCP.

For more information on the Shopify Dev MCP please read [the documentation](https://shopify.dev/docs/apps/build/devmcp).

## Deployment

### Application Storage

This template uses [Prisma](https://www.prisma.io/) to store session data, by default using an [SQLite](https://www.sqlite.org/index.html) database.
The database is defined as a Prisma schema in `prisma/schema.prisma`.

This use of SQLite works in production if your app runs as a single instance.
The database that works best for you depends on the data your app needs and how it is queried.
Here’s a short list of databases providers that provide a free tier to get started:

| Database   | Type             | Hosters                                                                                                                                                                                                                                    |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MySQL      | SQL              | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-mysql), [Planet Scale](https://planetscale.com/), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/mysql) |
| PostgreSQL | SQL              | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-postgresql), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/postgres)                                   |
| Redis      | Key-value        | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-redis), [Amazon MemoryDB](https://aws.amazon.com/memorydb/)                                                                                                        |
| MongoDB    | NoSQL / Document | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-mongodb), [MongoDB Atlas](https://www.mongodb.com/atlas/database)                                                                                                  |

To use one of these, you can use a different [datasource provider](https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference#datasource) in your `schema.prisma` file, or a different [SessionStorage adapter package](https://github.com/Shopify/shopify-api-js/blob/main/packages/shopify-api/docs/guides/session-storage.md).

### Build

Build the app by running the command below with the package manager of your choice:

Using yarn:

```shell
yarn build
```

Using npm:

```shell
npm run build
```

Using pnpm:

```shell
pnpm run build
```

## Hosting

When you're ready to set up your app in production, you can follow [our deployment documentation](https://shopify.dev/docs/apps/launch/deployment) to host it externally. From there, you have a few options:

- [Google Cloud Run](https://shopify.dev/docs/apps/launch/deployment/deploy-to-google-cloud-run): This tutorial is written specifically for this example repo, and is compatible with the extended steps included in the subsequent [**Build your app**](tutorial) in the **Getting started** docs. It is the most detailed tutorial for taking a React Router-based Shopify app and deploying it to production. It includes configuring permissions and secrets, setting up a production database, and even hosting your apps behind a load balancer across multiple regions.
- [Fly.io](https://fly.io/docs/js/shopify/): Leverages the Fly.io CLI to quickly launch Shopify apps to a single machine.
- [Render](https://render.com/docs/deploy-shopify-app): This tutorial guides you through using Docker to deploy and install apps on a Dev store.
- [Manual deployment guide](https://shopify.dev/docs/apps/launch/deployment/deploy-to-hosting-service): This resource provides general guidance on the requirements of deployment including environment variables, secrets, and persistent data.

When you reach the step for [setting up environment variables](https://shopify.dev/docs/apps/deployment/web#set-env-vars), you also need to set the variable `NODE_ENV=production`.

## Gotchas / Troubleshooting

### Database tables don't exist

If you get an error like:

```
The table `main.Session` does not exist in the current database.
```

Create the database for Prisma. Run the `setup` script in `package.json` using `npm`, `yarn` or `pnpm`.

### Navigating/redirecting breaks an embedded app

Embedded apps must maintain the user session, which can be tricky inside an iFrame. To avoid issues:

1. Use `Link` from `react-router` or `@shopify/polaris`. Do not use `<a>`.
2. Use `redirect` returned from `authenticate.admin`. Do not use `redirect` from `react-router`
3. Use `useSubmit` from `react-router`.

This only applies if your app is embedded, which it will be by default.

### Webhooks: shop-specific webhook subscriptions aren't updated

If you are registering webhooks in the `afterAuth` hook, using `shopify.registerWebhooks`, you may find that your subscriptions aren't being updated.

Instead of using the `afterAuth` hook declare app-specific webhooks in the `shopify.app.toml` file. This approach is easier since Shopify will automatically sync changes every time you run `deploy` (e.g: `npm run deploy`). Please read these guides to understand more:

1. [app-specific vs shop-specific webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe#app-specific-subscriptions)
2. [Create a subscription tutorial](https://shopify.dev/docs/apps/build/webhooks/subscribe/get-started?deliveryMethod=https)

If you do need shop-specific webhooks, keep in mind that the package calls `afterAuth` in 2 scenarios:

- After installing the app
- When an access token expires

During normal development, the app won't need to re-authenticate most of the time, so shop-specific subscriptions aren't updated. To force your app to update the subscriptions, uninstall and reinstall the app. Revisiting the app will call the `afterAuth` hook.

### Webhooks: Admin created webhook failing HMAC validation

Webhooks subscriptions created in the [Shopify admin](https://help.shopify.com/en/manual/orders/notifications/webhooks) will fail HMAC validation. This is because the webhook payload is not signed with your app's secret key.

The recommended solution is to use [app-specific webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe#app-specific-subscriptions) defined in your toml file instead. Test your webhooks by triggering events manually in the Shopify admin(e.g. Updating the product title to trigger a `PRODUCTS_UPDATE`).

### Webhooks: Admin object undefined on webhook events triggered by the CLI

When you trigger a webhook event using the Shopify CLI, the `admin` object will be `undefined`. This is because the CLI triggers an event with a valid, but non-existent, shop. The `admin` object is only available when the webhook is triggered by a shop that has installed the app. This is expected.

Webhooks triggered by the CLI are intended for initial experimentation testing of your webhook configuration. For more information on how to test your webhooks, see the [Shopify CLI documentation](https://shopify.dev/docs/apps/tools/cli/commands#webhook-trigger).

### Incorrect GraphQL Hints

By default the [graphql.vscode-graphql](https://marketplace.visualstudio.com/items?itemName=GraphQL.vscode-graphql) extension for will assume that GraphQL queries or mutations are for the [Shopify Admin API](https://shopify.dev/docs/api/admin). This is a sensible default, but it may not be true if:

1. You use another Shopify API such as the storefront API.
2. You use a third party GraphQL API.

If so, please update [.graphqlrc.ts](https://github.com/Shopify/shopify-app-template-react-router/blob/main/.graphqlrc.ts).

### Using Defer & await for streaming responses

By default the CLI uses a cloudflare tunnel. Unfortunately cloudflare tunnels wait for the Response stream to finish, then sends one chunk. This will not affect production.

To test [streaming using await](https://reactrouter.com/api/components/Await#await) during local development we recommend [localhost based development](https://shopify.dev/docs/apps/build/cli-for-apps/networking-options#localhost-based-development).

### "nbf" claim timestamp check failed

This is because a JWT token is expired. If you are consistently getting this error, it could be that the clock on your machine is not in sync with the server. To fix this ensure you have enabled "Set time and date automatically" in the "Date and Time" settings on your computer.

### Using MongoDB and Prisma

If you choose to use MongoDB with Prisma, there are some gotchas in Prisma's MongoDB support to be aware of. Please see the [Prisma SessionStorage README](https://www.npmjs.com/package/@shopify/shopify-app-session-storage-prisma#mongodb).

### Unable to require(`C:\...\query_engine-windows.dll.node`).

Unable to require(`C:\...\query_engine-windows.dll.node`).
The Prisma engines do not seem to be compatible with your system.

query_engine-windows.dll.node is not a valid Win32 application.

**Fix:** Set the environment variable:

```shell
PRISMA_CLIENT_ENGINE_TYPE=binary
```

This forces Prisma to use the binary engine mode, which runs the query engine as a separate process and can work via emulation on Windows ARM64.

## Resources

React Router:

- [React Router docs](https://reactrouter.com/home)

Shopify:

- [Intro to Shopify apps](https://shopify.dev/docs/apps/getting-started)
- [Shopify App React Router docs](https://shopify.dev/docs/api/shopify-app-react-router)
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli)
- [Shopify App Bridge](https://shopify.dev/docs/api/app-bridge-library).
- [Polaris Web Components](https://shopify.dev/docs/api/app-home/polaris-web-components).
- [App extensions](https://shopify.dev/docs/apps/app-extensions/list)
- [Shopify Functions](https://shopify.dev/docs/api/functions)

Internationalization:

- [Internationalizing your app](https://shopify.dev/docs/apps/best-practices/internationalization/getting-started)
