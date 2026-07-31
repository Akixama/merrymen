import { useEffect, useState } from "react";
import { router, useSegments } from "expo-router";
import { PREVIEW } from "@/dev/preview";
import { readOwner } from "./keystore";

/**
 * Decide, once per launch, where the owner should actually be.
 *
 *   no key at all      -> onboarding, to make one
 *   key destroyed      -> recovery. NEVER onboarding: generating a fresh key over
 *                         a funded account strands it permanently, and the whole
 *                         reason keystore.ts writes a separate marker is to make
 *                         this case distinguishable at all.
 *   key present        -> leave them alone
 *
 * Gated on the current route segment so it can't fight the user: without that
 * check, landing on /onboarding would re-read "no key", redirect to /onboarding
 * again, and loop forever.
 */
export function useOwnerGate(): { checked: boolean } {
  const segments = useSegments();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    // Design review in a browser, where there is no keystore to pass. Compiled
    // out of release builds — see dev/preview.ts. Nothing is faked: the key is
    // still absent, so signing still fails.
    if (PREVIEW) {
      setChecked(true);
      return;
    }

    let alive = true;
    void (async () => {
      const status = await readOwner();
      if (!alive) return;

      const top = segments[0];
      const inOnboarding = top === "onboarding";
      const inRecover = top === "recover";

      if (status.state === "empty" && !inOnboarding) {
        router.replace("/onboarding");
      } else if (status.state === "invalidated" && !inRecover) {
        router.replace("/recover");
      }
      setChecked(true);
    })();
    return () => {
      alive = false;
    };
    // Deliberately runs once. Re-running on every segment change would fight
    // navigation mid-flow — the flow itself decides where to go next.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { checked };
}
