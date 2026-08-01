import { createServer } from "node:http";
// Relative, never the @merrymen/core alias: the alias lives in a dev tsconfig
// and does not resolve inside the installed package, where the worker would
// then die at startup — silently, because the dashboard keeps running.
// Guarded by imports.test.ts.
import {
  buildAuthorizeRequest,
  discoverAuthServer,
  exchangeCode,
  type AuthServerMeta,
  type TokenSet,
} from "../../../packages/core/src/index";

/**
 * The desktop half of the Robinhood OAuth flow: catching the redirect.
 *
 * WHY THIS IS NOT IN packages/core. Everything portable — discovery, PKCE, the
 * authorize URL, the token exchange — lives there and is shared with the phone.
 * This file imports `node:http`, which would break the Metro bundle the moment
 * core pulled it in, so the one host-specific step lives on the host.
 *
 * The phone does the equivalent with a registered URL scheme
 * (`merrymen://oauth/callback`) via expo-auth-session; it calls the SAME core
 * functions and only differs in how the code comes back.
 *
 * A LOOPBACK REDIRECT IS UNVERIFIED AGAINST THE LIVE SERVER. The spike never
 * got past Robinhood's Agentic-account setup gate, so we have never seen this
 * redirect accepted (spikes/robinhood-mcp/README.md). Registration echoing our
 * redirect_uri back proves nothing — it echoes anything. If Robinhood rejects
 * `127.0.0.1` for the shared client, this whole path dies and desktop has to
 * fall back to a manual paste. Find out before building on it.
 */

export interface LoopbackAuthResult {
  tokens: TokenSet;
  meta: AuthServerMeta;
}

export interface LoopbackAuthOptions {
  /** Port for the temporary catcher. Must match a redirect the server accepts. */
  port?: number;
  /** How long to wait for the human. */
  timeoutMs?: number;
  /** Called with the URL to open — the caller decides whether to launch a browser. */
  onAuthorizeUrl: (url: string) => void;
}

/**
 * Run the full flow and return the tokens. Never persists anything: storage is
 * the caller's decision, because on this venue that decision is the whole
 * security question.
 */
export async function authorizeViaLoopback(opts: LoopbackAuthOptions): Promise<LoopbackAuthResult> {
  const port = opts.port ?? 8765;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const meta = await discoverAuthServer();
  const req = buildAuthorizeRequest(meta, redirectUri);

  const codePromise = waitForCode(port, req.state, opts.timeoutMs ?? 10 * 60_000);
  opts.onAuthorizeUrl(req.url);
  const code = await codePromise;

  const tokens = await exchangeCode(meta, { code, verifier: req.verifier, redirectUri });
  return { tokens, meta };
}

function waitForCode(port: number, expectedState: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn();
    };

    const server = createServer((httpReq, res) => {
      const url = new URL(httpReq.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<body style="font:16px system-ui;background:#0d1512;color:#e9f2ec;padding:40px">${
          error ? `Authorization failed: ${escapeHtml(error)}` : "Authorized. You can close this tab."
        }</body>`,
      );

      if (error) return done(() => reject(new Error(`authorization denied: ${error}`)));
      // A mismatched state means this response is not ours — it could be a
      // planted request hitting our open port. Discard rather than redeem it.
      if (state !== expectedState) return done(() => reject(new Error("state mismatch — discarding response")));
      if (!code) return done(() => reject(new Error("redirect carried no code")));
      done(() => resolve(code));
    });

    server.on("error", (e) => done(() => reject(e)));
    // Loopback only. Binding 0.0.0.0 would expose the catcher to the network.
    server.listen(port, "127.0.0.1");
    const timer = setTimeout(
      () => done(() => reject(new Error("timed out waiting for the browser redirect"))),
      timeoutMs,
    );
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
