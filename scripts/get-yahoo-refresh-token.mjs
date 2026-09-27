#!/usr/bin/env node
//
// One-time helper: turns a Yahoo authorization code into the long-lived
// refresh token the GitHub Action needs. Run this on your own machine, not
// in CI -- it is the only step that needs you present.
//
// Usage:
//   1. node scripts/get-yahoo-refresh-token.mjs <client_id> <client_secret>
//      It prints a URL. Open it, sign in, approve, and Yahoo shows you a code.
//   2. node scripts/get-yahoo-refresh-token.mjs <client_id> <client_secret> <code>
//      It prints the refresh token to save as a repository secret.
//
// Nothing here is stored or sent anywhere except Yahoo.

const [clientId, clientSecret, code] = process.argv.slice(2);

if (!clientId || !clientSecret) {
  console.error("Usage: node scripts/get-yahoo-refresh-token.mjs <client_id> <client_secret> [auth_code]");
  process.exit(1);
}

if (!code) {
  const url = "https://api.login.yahoo.com/oauth2/request_auth" +
    "?client_id=" + encodeURIComponent(clientId) +
    "&redirect_uri=oob&response_type=code&language=en-us";
  console.log("\n1. Open this URL and approve access:\n");
  console.log("   " + url);
  console.log("\n2. Yahoo will show you a short code. Then run:\n");
  console.log("   node scripts/get-yahoo-refresh-token.mjs <client_id> <client_secret> <that_code>\n");
  process.exit(0);
}

const body = new URLSearchParams({
  grant_type: "authorization_code",
  redirect_uri: "oob",
  code
});

const res = await fetch("https://api.login.yahoo.com/oauth2/get_token", {
  method: "POST",
  headers: {
    Authorization: "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64"),
    "Content-Type": "application/x-www-form-urlencoded"
  },
  body
});

const text = await res.text();
if (!res.ok) {
  console.error("Yahoo rejected the exchange (" + res.status + "):");
  console.error(text);
  console.error("\nAuthorization codes expire quickly -- if it's been a few minutes, start over at step 1.");
  process.exit(1);
}

const json = JSON.parse(text);
console.log("\nSuccess. Save this as the YAHOO_REFRESH_TOKEN repository secret:\n");
console.log("   " + json.refresh_token + "\n");
console.log("(Access tokens last about an hour; the Action refreshes them itself using this.)\n");
