import type { Metadata } from "next";
import Link from "next/link";
import { WatchClient } from "@/components/WatchClient";

export const metadata: Metadata = {
  title: "Watch a merryman trade — live, on-chain",
  description:
    "Paste a smart-account address and watch the agent trade in real time, read straight from Robinhood Chain in your browser. No account, no server in between.",
};

export default function Watch() {
  return (
    <section className="watch-page">
      <div className="wrap">
        <div className="section-head">
          <div className="tag" data-reveal="fade"><span className="n">—</span> live tape</div>
          <h1 data-reveal="mask">Watch it trade.</h1>
          <p className="watch-lede" data-reveal="up">
            Every trade a merryman makes is a transaction on Robinhood Chain, which means anyone can
            watch it happen — including you, without asking us for permission. Paste an account
            address and the tape below fills in as it trades.
          </p>
        </div>

        <WatchClient />

        <div className="watch-notes">
          <h3>Where do I find my merryman&apos;s address?</h3>
          <p>
            Your dashboard shows it at the top — it&apos;s the <strong>smart account</strong>, not the
            owner key you signed with. <Link className="link" href="/docs#wallet">The wallet docs</Link>{" "}
            walk through the difference.
          </p>
          <h3>Is it safe to share?</h3>
          <p>
            Yes. An address is public by design — it&apos;s what a block explorer shows, and it only
            ever lets someone <em>read</em>. It can&apos;t be used to move anything: spending needs a
            signature from a key that never leaves your machine, inside caps the account contract
            enforces on-chain. Sharing this link lets people watch, and nothing more.
          </p>
          <h3>Why is the tape empty?</h3>
          <p>
            Two ordinary reasons: the agent is in <strong>paper mode</strong>, which simulates fills
            and never touches the chain, or it&apos;s funded but hasn&apos;t opened a position yet.
            The tape shows this account&apos;s most recent token movements with no time limit, so an
            empty one means there have been none at all — the honest reading of a quiet account,
            not a failed load.
          </p>
        </div>
      </div>
    </section>
  );
}
