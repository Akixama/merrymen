/**
 * Web has no native splash to bridge from, so there is nothing to overlay — the
 * bundle is already parsed by the time anything renders.
 *
 * The template shipped an animated Expo logo here. It was never referenced
 * outside its own file, so it went with the rest of the starter branding.
 */
export function AnimatedSplashOverlay() {
  return null;
}
