import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Clearance for the parts of the screen the OS owns.
 *
 * Every screen in this app sets `headerShown: false`, so nothing is reserving the
 * status bar / notch or the home indicator on our behalf. Before this existed
 * each screen guessed with a hard-coded number — 16, 20, 56, 60 and 72 across
 * nine screens — which meant three things at once:
 *
 *   The Tape's only heading sat at 24.5-32.5dp, entirely inside a 47dp status bar
 *   (59dp with a Dynamic Island), so the screen lost its title on a real phone
 *   while looking perfect in a browser, where the inset is zero.
 *
 *   The top of the page jumped 36-40dp as you moved between the three tabs.
 *
 *   Both lists reserved 40dp at the bottom — less than the tab bar alone, never
 *   mind the home indicator under it — so the Band's last link was permanently
 *   behind the bar and could not be scrolled into reach.
 *
 * A guessed number cannot be right on every device, because the inset is not a
 * constant: 20dp on an SE, 47 on most notched phones, 59 on an Island. Ask.
 */

/** Space above a screen's first element: the OS inset, plus a consistent margin. */
export function useTopPad(extra = 12): number {
  return useSafeAreaInsets().top + extra;
}

/**
 * Space below the last element of a screen with NO tab bar — the pushed screens:
 * settings, chat, the probe, recovery, onboarding. Only the home indicator to
 * clear, so this is the inset plus room to breathe.
 */
export function useBottomPad(extra = 32): number {
  return useSafeAreaInsets().bottom + extra;
}

/**
 * Space below a scrolling list's last element.
 *
 * The tab bar floats over the content, so its height has to be cleared here or
 * the final row is unreachable. ~49dp of bar on iOS plus the home indicator,
 * plus breathing room so the last row doesn't sit flush against the bar.
 */
export function useListBottomPad(extra = 24): number {
  return useSafeAreaInsets().bottom + TAB_BAR_HEIGHT + extra;
}

/** iOS tab bar content height, excluding the home indicator the inset covers. */
export const TAB_BAR_HEIGHT = 49;
