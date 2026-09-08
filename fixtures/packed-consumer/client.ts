import { expectedVersion } from "./version";
import { createAuthClient } from "better-auth/vue";
import { tauriClient, PACKAGE_VERSION } from "@dreamshive/better-auth-tauri/client";
import type { BetterAuthClientPlugin } from "better-auth/client";

const plugin = tauriClient({
  scheme: "sokudo",
  storage: { getItem: () => null, setItem: () => {} },
});
const checked: BetterAuthClientPlugin = plugin;
void checked;
const client = createAuthClient({ plugins: [plugin] });
const cookie: Promise<string> = client.getCookie();
if (await cookie !== "") throw new Error("Expected an empty cookie jar");
if (typeof client.signIn.social !== "function") throw new Error("Missing social sign-in");
if (PACKAGE_VERSION !== expectedVersion) throw new Error("Published version constant is stale");
