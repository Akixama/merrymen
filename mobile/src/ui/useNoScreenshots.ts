import { useEffect } from "react";
import { Platform } from "react-native";
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from "expo-screen-capture";

/**
 * Block screenshots, screen recording and the recents thumbnail while a screen
 * showing the recovery phrase is mounted.
 *
 * WHY NOT expo-screen-capture's OWN usePreventScreenCapture. Its web build is
 * `export default {}` — the same stub pattern as expo-secure-store — so
 * `preventScreenCaptureAsync` finds no native method and THROWS
 * UnavailabilityError. The library's hook calls it from an effect and does not
 * catch, so on web the throw surfaces as an unhandled page error. The module's
 * own doc comment says `@platform android` `@platform ios`; there is no web
 * story, and the hook does not know that.
 *
 * Web is the only environment this app has ever been verified in, so a hook
 * that kills the page there is not usable. Hence the platform guard and the
 * swallowed rejection: on a phone this is real protection, and everywhere else
 * it is nothing, which is the honest outcome — a browser cannot stop a
 * screenshot and pretending otherwise would be worse than not trying.
 *
 * The key namespaces each screen's request. expo-screen-capture reference-counts
 * by key, so a screen releasing its own does not lift protection another screen
 * is still asking for.
 */
export function useNoScreenshots(key: string): void {
  useEffect(() => {
    if (Platform.OS === "web") return;
    void preventScreenCaptureAsync(key).catch(() => {});
    return () => {
      void allowScreenCaptureAsync(key).catch(() => {});
    };
  }, [key]);
}
