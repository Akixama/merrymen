import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE PERMISSION THAT KILLED 0.1.0 AND 0.1.1.
 *
 * expo-screen-capture was added to stop the recovery phrase being screenshotted.
 * Inspecting the APK afterwards showed it had pulled in DETECT_SCREEN_CAPTURE,
 * which looked like an unexplained permission for a wallet, so it was blocked.
 *
 * It is not optional. ScreenCaptureModule.kt registers the callback in OnCreate:
 *
 *     OnCreate {
 *       if (Build.VERSION.SDK_INT >= UPSIDE_DOWN_CAKE) {   // Android 14+
 *         screenCaptureCallback = Activity.ScreenCaptureCallback { emitEvent() }
 *         registerCallback()        // unconditional — no permission check
 *       }
 *
 * That runs at MODULE CREATION, on startup, whether or not the app ever calls
 * preventScreenCaptureAsync. registerScreenCaptureCallback requires the
 * permission, so without it Android throws a SecurityException, which surfaces
 * as an uncaught JS exception before the runtime is ready and aborts the
 * process. From the device log:
 *
 *     Abort message: 'terminating due to uncaught exception … JavascriptException:
 *     [runtime not ready]: Error: Exception in HostFunction: Permission Denial:
 *     registerScreenCaptureObserver … requires android.permission.DETECT_SCREEN_CAPTURE
 *
 * DETECT_SCREEN_CAPTURE is protection level "normal": no prompt, no dialog, and
 * it grants no access to any content. It only lets the OS tell the app that a
 * screenshot happened — which for a wallet is a feature, not a liability.
 *
 * The blocks that REMAIN are all still correct: SYSTEM_ALERT_WINDOW (overlay
 * phishing), the storage pair, VIBRATE (nothing vibrates), and
 * READ_MEDIA_IMAGES (real photo access, and only consulted on API 33 exactly,
 * where blocking it merely disables detection rather than throwing).
 */
const APP_JSON = join(__dirname, "..", "..", "app.json");
const PKG_JSON = join(__dirname, "..", "..", "package.json");

describe("android.blockedPermissions", () => {
  const app = JSON.parse(readFileSync(APP_JSON, "utf8"));
  const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8"));
  const blocked: string[] = app.expo.android.blockedPermissions ?? [];

  it("does NOT block DETECT_SCREEN_CAPTURE while expo-screen-capture is installed", () => {
    if (!pkg.dependencies["expo-screen-capture"]) return; // module gone, hazard gone
    expect(blocked).not.toContain("android.permission.DETECT_SCREEN_CAPTURE");
  });

  it("still blocks the ones that are genuinely unnecessary", () => {
    for (const p of [
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.VIBRATE",
      "android.permission.READ_MEDIA_IMAGES",
    ]) {
      expect(blocked).toContain(p);
    }
  });

  it("the upstream registration is still unconditional, so this guard is still needed", () => {
    const kt = join(
      __dirname,
      "..",
      "..",
      "node_modules",
      "expo-screen-capture",
      "android",
      "src",
      "main",
      "java",
      "expo",
      "modules",
      "screencapture",
      "ScreenCaptureModule.kt",
    );
    const src = readFileSync(kt, "utf8");
    // registerCallback() sits inside OnCreate with no checkSelfPermission guard.
    const onCreate = src.slice(src.indexOf("OnCreate {"), src.indexOf("AsyncFunction("));
    expect(onCreate).toContain("registerCallback()");
    expect(onCreate).not.toContain("checkSelfPermission");
  });
});
