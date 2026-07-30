import { Stack } from "expo-router";
import { C } from "@/ui/tokens";

/**
 * Onboarding is a Stack, not tabs, and the back gesture is off on purpose.
 *
 * This flow creates a key and then makes the owner prove they have written it
 * down. Letting someone swipe back out of the middle of it produces the worst
 * possible state: a key that exists and controls funds, with no backup and no
 * screen left telling them so. Forward or explicit cancel, nothing else.
 */
export default function OnboardingLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        gestureEnabled: false,
        contentStyle: { backgroundColor: C.bg },
        animation: "slide_from_right",
      }}
    />
  );
}
