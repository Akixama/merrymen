"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { iosBetaCount, joinIosBeta } from "@/lib/gateway";

/**
 * The iOS beta waiting list.
 *
 * WHAT THIS IS NOT: a build you can install. There is no iOS build yet, and
 * shipping one needs a paid Apple Developer membership and TestFlight review, so
 * the copy promises a message when there is something to install and nothing
 * more. A waiting list that implies an imminent invite is a small lie that gets
 * discovered on day one.
 *
 * The `company` input is a honeypot — hidden from people, tempting to bots. It
 * is hidden with off-screen positioning rather than `display:none`, because some
 * bots skip inputs that are display:none, and marked aria-hidden + tabIndex -1 +
 * autoComplete off so no screen reader announces it and no keyboard lands on it.
 */
export function IosBetaForm() {
  const [email, setEmail] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const live = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const ac = new AbortController();
    void iosBetaCount(ac.signal).then(setCount);
    return () => ac.abort();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (state === "sending") return;
    setState("sending");
    setMessage("");

    const r = await joinIosBeta(email, honeypot);
    if (!r.ok) {
      setState("error");
      setMessage(r.message);
      return;
    }
    setState("done");
    setCount(r.count);
    // "Already on it" is not an error and must not read like one — signing up
    // twice is a thing people do when they cannot remember whether they did.
    setMessage(r.already ? "You're already on the list — we'll email you." : "You're on the list. We'll email you when there's a build.");
  }

  return (
    <div className="beta-signup">
      {state === "done" ? (
        <p className="beta-done" role="status">
          <Icon name="shield" size={18} /> {message}
        </p>
      ) : (
        <form onSubmit={submit} noValidate>
          <div className="beta-row">
            <label className="sr-only" htmlFor="ios-beta-email">
              Email address
            </label>
            <input
              id="ios-beta-email"
              className="beta-input"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              maxLength={254}
              required
              onChange={(ev) => {
                setEmail(ev.target.value);
                if (state === "error") setState("idle");
              }}
              aria-describedby="ios-beta-note"
              aria-invalid={state === "error"}
            />
            <button className="btn btn-primary has-box" type="submit" disabled={state === "sending"}>
              {state === "sending" ? "Adding…" : "Notify me"}
              <span className="box">
                <Icon name="arrow" size={16} />
              </span>
            </button>
          </div>

          {/* Honeypot. Not display:none on purpose — see the note above. */}
          <input
            className="beta-hp"
            type="text"
            name="company"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            value={honeypot}
            onChange={(ev) => setHoneypot(ev.target.value)}
          />

          <p className="beta-note" id="ios-beta-note" ref={live} role={state === "error" ? "alert" : undefined}>
            {state === "error" ? (
              <span className="beta-error">{message}</span>
            ) : (
              <>
                Your email, and nothing else — no IP, no tracking, no newsletter. Used once, to tell
                you there&apos;s a build. Ask any time and it&apos;s deleted.{" "}
                <a className="link" href="/privacy">
                  How we handle it
                </a>
                .
              </>
            )}
          </p>
        </form>
      )}

      {count !== null && count > 0 && (
        <p className="beta-count">
          {count} {count === 1 ? "person is" : "people are"} waiting.
        </p>
      )}
    </div>
  );
}
