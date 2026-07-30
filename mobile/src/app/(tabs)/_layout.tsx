import AppTabs from "@/components/app-tabs";

/**
 * The tab bar, and ONLY the tabbed screens.
 *
 * Band and Tape live in this group; settings, probe, recover and onboarding sit
 * outside it under the root Stack. That separation is the point: NativeTabs
 * renders the triggers it is given, and a route file sitting in the same
 * directory without a matching trigger is ambiguous — at best an undeclared tab,
 * at worst unreachable. Keeping non-tab screens out of the group means every file
 * in here has a trigger and every file outside is pushed as a normal screen.
 */
export default function TabsLayout() {
  return <AppTabs />;
}
