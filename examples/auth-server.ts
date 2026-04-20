// Drop-in reference — copy into your Better Auth server config.

import { betterAuth } from "better-auth";
import { tauri } from "@dreamshive/better-auth-tauri";

export const auth = betterAuth({
  baseURL: "https://auth.example.com",
  basePath: "/",

  // Must trust the app's custom URI scheme so OAuth callback redirects
  // targeting `yourapp://...` aren't rejected.
  trustedOrigins: ["yourapp://"],

  // ... your database, email, social providers, session config, etc.

  plugins: [
    tauri(),
    // ... your other Better Auth plugins
  ],

  advanced: {
    cookies: {
      session_token: {
        name: "yourapp.session_token",
        attributes: {
          secure: process.env.NODE_ENV === "production",
          sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        },
      },
    },
  },
});

// Also update your HTTP server's CORS config to accept the custom headers:
//
//   cors({
//     origin: ["https://app.example.com", "yourapp://"],
//     credentials: true,
//     allowedHeaders: [
//       "Content-Type",
//       "Authorization",
//       "Cookie",
//       "tauri-origin",
//       "x-tauri-cookie",
//       "x-skip-oauth-proxy",
//     ],
//   })
