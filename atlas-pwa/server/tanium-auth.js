// Supplies the bearer token Claude's MCP connector presents to the Tanium
// Atlas MCP server. Two options:
//   1. A static token:          TANIUM_MCP_TOKEN
//   2. An Atlas OAuth client:   TANIUM_OAUTH_TOKEN_URL + TANIUM_OAUTH_CLIENT_ID
//                               + TANIUM_OAUTH_CLIENT_SECRET (+ TANIUM_OAUTH_SCOPE)
//      The client-credentials grant is used and the token is cached until
//      shortly before it expires.

let cached = null; // { token, expiresAt }

export function taniumConfigured() {
  return Boolean(
    process.env.TANIUM_MCP_URL &&
      (process.env.TANIUM_MCP_TOKEN ||
        (process.env.TANIUM_OAUTH_TOKEN_URL &&
          process.env.TANIUM_OAUTH_CLIENT_ID &&
          process.env.TANIUM_OAUTH_CLIENT_SECRET)),
  );
}

export async function getTaniumToken() {
  if (process.env.TANIUM_MCP_TOKEN) return process.env.TANIUM_MCP_TOKEN;
  if (!process.env.TANIUM_OAUTH_TOKEN_URL) return null;

  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (process.env.TANIUM_OAUTH_SCOPE) body.set("scope", process.env.TANIUM_OAUTH_SCOPE);
  const basic = Buffer.from(
    `${process.env.TANIUM_OAUTH_CLIENT_ID}:${process.env.TANIUM_OAUTH_CLIENT_SECRET}`,
  ).toString("base64");

  const res = await fetch(process.env.TANIUM_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Tanium OAuth token request failed (${res.status})`);
  }
  const json = await res.json();
  const ttl = Number(json.expires_in) || 3600;
  cached = { token: json.access_token, expiresAt: Date.now() + Math.max(30, ttl - 60) * 1000 };
  return cached.token;
}
