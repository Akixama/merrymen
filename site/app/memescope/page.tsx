import type { Metadata } from "next";
import Link from "next/link";
import { MemescopeClient } from "@/components/MemescopeClient";

export const metadata: Metadata = {
  title: "Memescope — new pools on Robinhood Chain",
  description:
    "Every pool opened on Robinhood Chain in the last twelve hours, newest first, with names read from the token contracts themselves.",
};

export default function Memescope() {
  return (
    <section className="scope-page">
      <div className="wrap">
        <div className="section-head">
          <div className="tag" data-reveal="fade"><span className="n">—</span> memescope</div>
          <h1 data-reveal="mask">What just launched.</h1>
          <p className="watch-lede" data-reveal="up">
            Every pool opened on Robinhood Chain in the last twelve hours, newest first. This is the
            same feed a merryman watches when scouting — the difference is that an agent then has to
            get past its own guards before it can touch any of it.
          </p>
        </div>

        <MemescopeClient />

        <div className="watch-notes">
          <h3>A new pool is not an opportunity</h3>
          <p>
            Most of what appears here is worthless, and some of it is designed to take your money —
            a pool can be opened with no real liquidity, or with a token that can&apos;t be sold once
            bought. This page reports what happened on-chain. It is not a recommendation, and nothing
            on it has been vetted.
          </p>
          <h3>Where the names come from</h3>
          <p>
            Symbols are read from each <strong>token contract</strong>, not from any index or listing
            — so what you see is what the token itself claims. That claim is written by whoever
            deployed it, which is why names are stripped to plain characters before display: it stops
            a token dressing itself up as a familiar one using invisible or right-to-left characters.
            An address that won&apos;t answer at all shows as <em>unreadable</em>, which is itself
            worth knowing.
          </p>
          <h3>What a merryman does with this</h3>
          <p>
            In <strong>scout mode</strong> an agent may take small positions in tokens it can price,
            inside a separate budget it cannot exceed, and only when it can also confirm it would be
            able to sell again. Anything it can&apos;t value is quarantined at cost rather than
            counted as profit. <Link className="link" href="/docs#safety">The safety model</Link>{" "}
            explains the wall in full, and you can{" "}
            <Link className="link" href="/watch">watch an agent trade live</Link> if you&apos;d rather
            see it than read about it.
          </p>
        </div>
      </div>
    </section>
  );
}
