import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { ensureCustomerFollowedArtistsDefinition } from "./lib/artist-follow.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    // On install / re-auth, best-effort create the customer
    // `custom.followed_artists` metafield definition. Never block auth if the
    // store isn't fully configured yet — the admin setup page reports and fixes.
    afterAuth: async ({ session, admin }) => {
      try {
        const result = await ensureCustomerFollowedArtistsDefinition(admin);
        if (result.status === "error") {
          console.warn("[artist-follow] setup incomplete after auth", {
            shop: session.shop,
            reason: result.reason,
            message: result.message,
          });
        }
      } catch (error) {
        console.error("[artist-follow] afterAuth setup failed", {
          shop: session.shop,
          message: error?.message,
        });
      }
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
