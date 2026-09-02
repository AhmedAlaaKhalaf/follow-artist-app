import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Related: https://github.com/remix-run/remix/issues/2835#issuecomment-1144102176
// Shopify CLI may pass HOST as a tunnel URL. Only remap it when it looks like a
// real URL/hostname — never when HOST is a bind address like 0.0.0.0 (Railway).
const hostEnv = process.env.HOST;
const isBindAddress =
  !hostEnv ||
  hostEnv === "0.0.0.0" ||
  hostEnv === "::" ||
  hostEnv === "*";

if (
  hostEnv &&
  !isBindAddress &&
  (!process.env.SHOPIFY_APP_URL ||
    process.env.SHOPIFY_APP_URL === hostEnv)
) {
  process.env.SHOPIFY_APP_URL = hostEnv;
  delete process.env.HOST;
}

function appHostname() {
  const raw = process.env.SHOPIFY_APP_URL || "http://localhost";
  try {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withProtocol).hostname;
  } catch {
    return "localhost";
  }
}

const host = appHostname();
let hmrConfig;

if (host === "localhost") {
  hmrConfig = {
    protocol: "ws",
    host: "localhost",
    port: 64999,
    clientPort: 64999,
  };
} else {
  hmrConfig = {
    protocol: "wss",
    host: host,
    port: parseInt(process.env.FRONTEND_PORT) || 8002,
    clientPort: 443,
  };
}

export default defineConfig({
  server: {
    allowedHosts: [host],
    cors: {
      preflightContinue: true,
    },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: {
      // See https://vitejs.dev/config/server-options.html#server-fs-allow for more information
      allow: ["app", "node_modules"],
    },
  },
  plugins: [reactRouter(), tsconfigPaths()],
  build: {
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    include: ["@shopify/app-bridge-react"],
  },
});
