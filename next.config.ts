import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every /v1 response depends on the caller's key and live DB state, and the
  // dashboard reads session cookies, so nothing here is safely cacheable.
  // cacheComponents stays off to keep rendering fully dynamic and predictable.
  poweredByHeader: false,
  serverExternalPackages: ["pg"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
