/** Colours, matched to the dashboard so the phone and the desktop feel like one product. */
export const C = {
  bg: "#0d1512",
  bg1: "#111a16",
  bg2: "#16211c",
  bg3: "#1d2b25",
  border: "#26362f",
  text: "#e9f2ec",
  text2: "#c3cec4",
  dim: "#94a89e",
  /**
   * The quietest text rung. Was #647a70, which measured 4.03:1 on bg, 3.60:1 on
   * bg2 and 3.19:1 on bg3 — under WCAG AA's 4.5:1 at every size this app uses it,
   * and it is the colour of the tape's transaction hashes and of the sentence
   * warning that anyone holding the link code can claim your agent. The lowest
   * contrast in the app should not be on a theft warning.
   *
   * #7f958b clears 4.5:1 on all three surfaces while staying visibly quieter than
   * `dim` — the rung still reads as "background information", it just survives
   * being read outdoors.
   */
  faint: "#7f958b",
  green: "#34d399",
  red: "#fb7185",
  gold: "#eab308",
} as const;

/**
 * One vertical spacing scale. Screens previously stacked marginBottom + container
 * gap + marginTop, which produced sibling gaps of 30 / 26 / 20dp on a single short
 * column — differences small enough to read as mistakes rather than intent.
 */
export const S = {
  /** Between tightly-related lines (a label and its value). */
  tight: 4,
  /** Between elements inside one group. */
  step: 8,
  /** Between groups. */
  group: 16,
  /** Between sections — a new idea starts here. */
  section: 28,
} as const;

/** The screen's horizontal margin. Everything on a screen shares this left edge. */
export const GUTTER = 20;
