# Spike: Robinhood Agentic Trading MCP

Reconnaissance on `https://agent.robinhood.com/mcp/trading` — can merrymen talk
to it, and what would that mean. Not wired into the worker, not published
(`package.json`'s `files` is an allowlist).

```bash
node spikes/robinhood-mcp/explore.mjs
```

It prints an authorization URL, waits on `127.0.0.1:8765` for the redirect,
exchanges the code, then lists the server's tools. You log in at robinhood.com;
this process only ever sees an authorization code. The token is held in memory
and never written to disk — re-running costs one browser click.

It never places, cancels or moves anything. `Mcp#call` throws on any tool
matching the deny list, and the script demonstrates that on itself before
finishing.

## What the unauthenticated probe established

| | |
|---|---|
| Transport | streamable HTTP (`GET` → 405 `allow: POST`) |
| Auth | OAuth 2.1, RFC 9728 challenge on 401 |
| Authorize | `https://robinhood.com/oauth` |
| Token | `https://api.robinhood.com/oauth2/token/` |
| Register | `https://agent.robinhood.com/oauth/trading/register` — **open** |
| Client type | public — no secret issued, `token_endpoint_auth_method: none` |
| PKCE | S256, required |
| Scopes | `internal` (one scope, all-or-nothing) |
| Redirect | loopback (`http://127.0.0.1:…`) accepted |

**The finding that matters:** dynamic client registration (RFC 7591) is open and
loopback redirects are accepted, so a self-hosted headless worker can mint its
own `client_id` with no partnership, no API-key application and no allowlist.
That was the main unknown, and the answer is yes.

**Two things worth knowing before building on it.**

`scopes_supported` is `["internal"]` — a single scope. There is no read-only
grant to ask for, so any client the owner authorizes can place orders. Whatever
restraint exists has to come from the client, which is exactly the gap
Robinhood names when they say they "do not control, supervise, monitor,
recommend, or audit these AI agents."

Registration echoes back `client_name: "Robinhood Trading"` regardless of what
the client sent — we registered as `merrymen (spike)` and got that name back. If
that name is what the consent screen shows, the owner cannot tell from it which
agent they are authorizing. Worth confirming visually during the browser step.

## Why this isn't just "point merrymen at it"

merrymen's wall is enforced by the account contract: EntryPoint 0.7 validates
the session key's policies, so a compromised agent cannot spend past the caps.
There is no equivalent to hand a brokerage. On this path the caps would be
enforced by `worker/src/policy.ts` — which exists, but which merrymen currently
describes as a *mirror* of an authoritative on-chain rule, and which would here
become the only rule alongside Robinhood's own account budget.

That is a custodial trust model. It is a reasonable one; it is not the one the
site sells. `site/` says non-custodial, keys-stay-on-your-machine, and "the
limits live in the account contract on-chain, not in this app" — all false for
this path. Splitting that copy per-path is a prerequisite, not a follow-up.
