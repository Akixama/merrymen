"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { EXPLORER, ageOf } from "@/lib/chain";
import { fetchScope, type ScopePool } from "@/lib/gateway";

/** Matches the gateway's shared-cache TTL — polling faster returns the same bytes. */
const POLL_MS = 45_000;

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

function quoteLabel(quote: string): string {
  return quote.toLowerCase() === USDG ? "USDG" : "WETH";
}

function PoolRow({ p }: { p: ScopePool }) {
  const short = `${p.token.slice(0, 8)}…${p.token.slice(-6)}`;
  return (
    <li className="scope-row">
      <div className="scope-sym">
        {/* The gateway already stripped this to [A-Za-z0-9._-] and capped it —
            a token's name is written by whoever deployed it. */}
        {p.symbol ?? <span className="scope-unknown">unreadable</span>}
        <span className="scope-pair">/{quoteLabel(p.quote)}</span>
      </div>
      <div className="scope-age">{ageOf(p.createdAt)}</div>
      <a className="scope-addr" href={`${EXPLORER}/token/${p.token}`} target="_blank" rel="noreferrer">
        {short}
      </a>
      <a className="scope-link" href={`${EXPLORER}/tx/${p.txHash}`} target="_blank" rel="noreferrer">
        pool <Icon name="arrow" size={12} />
      </a>
    </li>
  );
}

export function MemescopeClient() {
  const [pools, setPools] = useState<ScopePool[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      const out = await fetchScope(controller.signal);
      if (!alive) return;
      if (out.ok) {
        setPools(out.data.pools);
        setStale(Boolean(out.data.stale));
        setNote(null);
      } else {
        // Keep whatever is already on screen. A scope that pauses is far better
        // than a list that empties itself because one poll missed.
        setNote(out.message);
        if (pools === null) setPools([]);
      }
      timer = setTimeout(tick, POLL_MS);
    }

    tick();
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (pools === null) {
    return <p className="scope-status"><span className="watch-dot watch-dot-loading" aria-hidden /> reading the chain…</p>;
  }

  const stamps = pools.map((p) => p.createdAt).filter((t) => Number.isFinite(t) && t > 0);
  const newest = stamps.length ? Math.max(...stamps) : null;
  const oldest = stamps.length ? Math.min(...stamps) : null;

  return (
    <>
      <div className="scope-status">
        <span className={`watch-dot watch-dot-${note ? "error" : "live"}`} aria-hidden />
        {/* Report the span actually returned, never a window we merely asked
            for. The upstream caps the number of events, and this chain opens
            pools fast enough that the cap — not the time window — is what
            decides how far back the list reaches. */}
        {note ? note : `${pools.length} launch${pools.length === 1 ? "" : "es"}${oldest ? ` · newest ${ageOf(newest!)}, oldest ${ageOf(oldest)}` : ""}`}
        {stale && !note && <span className="watch-warn"> · showing the last good read</span>}
      </div>

      {pools.length > 0 ? (
        <ul className="scope">
          {pools.map((p) => (
            <PoolRow key={`${p.token}-${p.txHash}`} p={p} />
          ))}
        </ul>
      ) : (
        !note && <p className="scope-empty">No new pools right now. Quiet chain.</p>
      )}
    </>
  );
}
