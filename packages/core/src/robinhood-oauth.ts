import { sha256 } from "@noble/hashes/sha256";

/**
 * OAuth 2.1 + PKCE against Robinhood's Agentic Trading MCP server.
 *
 * REACT-NATIVE SAFE, like the rest of packages/core: `@noble/hashes` (already in
 * the bundle via viem) for the challenge, `crypto.getRandomValues` for entropy,
 * and a hand-rolled base64url so nothing here needs Buffer or node:crypto.
 *
 * WHAT IS SHARED AND WHAT IS NOT. Discovery, PKCE, the authorize URL and the
 * token exchange are identical on every host, so they live here. Getting the
 * authorization code BACK is host-specific and deliberately absent:
 *
 *   desktop worker — a loopback listener on 127.0.0.1 (node:http, worker-only)
 *   phone          — a `merrymen://` scheme or universal link via expo-auth-session
 *
 * So the caller supplies `redirectUri` and returns the code by whatever means
 * its platform allows. That is the whole seam.
 *
 * FINDINGS FROM THE SPIKE THAT SHAPE THIS (spikes/robinhood-mcp/README.md):
 *
 *   The registration endpoint is a NO-OP. It returns the same shared client_id
 *   and the name "Robinhood Trading" whatever you send it, so there is nothing
 *   dynamic to register — the id is a constant and calling /register is a
 *   wasted round trip. It is exported below rather than fetched.
 *
 *   There is ONE scope, `internal`. No read-only grant exists, so a token that
 *   can read can also trade. Restraint lives in McpClient's allowMutating gate
 *   and in the policy layer, never in the scope.
 */

/** Discovered from /.well-known/oauth-authorization-server; pinned as the default. */
export const RH_MCP_URL = "https://agent.robinhood.com/mcp/trading";
export const RH_DISCOVERY_URL = "https://agent.robinhood.com/.well-known/oauth-authorization-server";

/**
 * The shared public client id every agent gets.
 *
 * Not a secret and not an identity: /register hands this exact string to
 * anyone, so it identifies "some MCP client", not merrymen. Pinned as a
 * constant because fetching it would imply it varies.
 */
export const RH_CLIENT_ID = "LtLiNmbs9owbYfWgBlC68Z2VujIPuvGoAiSYr8xW";

export interface AuthServerMeta {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface AuthorizeRequest {
  url: string;
  /** Hold these until the redirect comes back; both must be checked/used then. */
  state: string;
  verifier: string;
}

export interface TokenSet {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/** base64url over bytes — no Buffer, no btoa, works identically in Node and Hermes. */
export function base64url(bytes: Uint8Array): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += A[b0 >> 2];
    out += A[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += A[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += A[b2 & 63];
  }
  return out;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = globalThis.crypto;
  if (!c?.getRandomValues) {
    // Fail loudly. Silently falling back to Math.random here would produce a
    // guessable PKCE verifier and a guessable state, which is the whole
    // security of this flow. On the phone this is polyfilled at startup.
    throw new Error("crypto.getRandomValues unavailable — refusing to generate a weak PKCE verifier");
  }
  c.getRandomValues(out);
  return out;
}

/** RFC 7636 S256. The verifier is the secret; the challenge is what goes on the wire. */
export function createPkce(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(sha256(new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

export async function discoverAuthServer(
  fetchImpl: typeof fetch = globalThis.fetch,
  url = RH_DISCOVERY_URL,
): Promise<AuthServerMeta> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`OAuth discovery failed: HTTP ${res.status}`);
  const meta = (await res.json()) as AuthServerMeta;
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error("OAuth discovery returned no authorization_endpoint/token_endpoint");
  }
  // S256 is not optional for us — a server that only offered `plain` would
  // silently downgrade the flow, so refuse rather than proceed.
  const methods = meta.code_challenge_methods_supported;
  if (methods && !methods.includes("S256")) {
    throw new Error(`authorization server does not support PKCE S256 (offers: ${methods.join(", ")})`);
  }
  return meta;
}

export function buildAuthorizeRequest(meta: AuthServerMeta, redirectUri: string): AuthorizeRequest {
  const { verifier, challenge } = createPkce();
  const state = base64url(randomBytes(16));
  const url = new URL(meta.authorization_endpoint);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: RH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: (meta.scopes_supported ?? ["internal"]).join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { url: url.toString(), state, verifier };
}

/**
 * Swap the authorization code for a token.
 *
 * `token_endpoint_auth_method` is "none" — a public client, no secret — so PKCE
 * is the only thing binding this exchange to the request that started it. The
 * caller MUST have already checked that the returned `state` matches the one
 * from buildAuthorizeRequest; this function cannot check it for them.
 */
export async function exchangeCode(
  meta: AuthServerMeta,
  args: { code: string; verifier: string; redirectUri: string },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TokenSet> {
  const res = await fetchImpl(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
      client_id: RH_CLIENT_ID,
      code_verifier: args.verifier,
    }).toString(),
  });
  if (!res.ok) {
    // No body echo: a token endpoint's error payload can carry the code.
    throw new Error(`token exchange failed: HTTP ${res.status}`);
  }
  const tok = (await res.json()) as TokenSet;
  if (!tok?.access_token) throw new Error("token exchange returned no access_token");
  return tok;
}

export async function refreshToken(
  meta: AuthServerMeta,
  refresh: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TokenSet> {
  const res = await fetchImpl(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: RH_CLIENT_ID,
    }).toString(),
  });
  if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`);
  const tok = (await res.json()) as TokenSet;
  if (!tok?.access_token) throw new Error("token refresh returned no access_token");
  return tok;
}
