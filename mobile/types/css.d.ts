/**
 * Ambient types for the CSS the SDK 57 template imports.
 *
 * The template ships `src/global.css` and `animated-icon.module.css` and imports
 * both, but nothing declares them, so a clean scaffold does not typecheck. Expo
 * normally supplies these through a generated `expo-env.d.ts`, which only appears
 * after `expo start` / `expo prebuild` — `expo export` does not create it. Rather
 * than depend on a generated file existing, declare them here.
 */

declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}

// Side-effect CSS imports (`import '@/global.css'`) carry no value.
declare module "*.css";
