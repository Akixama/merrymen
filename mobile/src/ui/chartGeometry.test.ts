import { describe, expect, it } from "vitest";
import { areaGeometry } from "./chartGeometry";

/**
 * Chart maths, where every bug is invisible.
 *
 * A NaN in a path string doesn't throw — React Native Svg just draws nothing, and
 * a blank card reads as "no data" rather than "broken". So these check the shape
 * of the output, not merely that a call returned.
 */

const hasNaN = (d: string) => /NaN|Infinity|undefined/.test(d);

describe("areaGeometry", () => {
  it("returns null rather than a degenerate shape for too little data", () => {
    expect(areaGeometry([], 100, 50)).toBeNull();
    expect(areaGeometry([5], 100, 50)).toBeNull();
    // Padding taller than the box would give a negative drawing height.
    expect(areaGeometry([1, 2], 100, 8, 6)).toBeNull();
  });

  it("draws a FLAT series instead of producing NaN", () => {
    // The most ordinary state there is: an agent that hasn't traded today. A
    // naive (v-min)/(max-min) divides by zero here.
    const g = areaGeometry([500, 500, 500, 500], 200, 60);
    expect(g).not.toBeNull();
    expect(hasNaN(g!.line)).toBe(false);
    expect(hasNaN(g!.area)).toBe(false);
    expect(g!.up).toBe(true);
  });

  it("survives a series that is flat AT zero", () => {
    // Here even the proportional fallback (1% of the value) is 0.
    const g = areaGeometry([0, 0, 0], 100, 40);
    expect(g).not.toBeNull();
    expect(hasNaN(g!.line)).toBe(false);
  });

  it("calls it down only when it actually ends lower", () => {
    expect(areaGeometry([100, 90], 100, 40)!.up).toBe(false);
    expect(areaGeometry([100, 110], 100, 40)!.up).toBe(true);
    // Ending exactly level is not a loss.
    expect(areaGeometry([100, 80, 100], 100, 40)!.up).toBe(true);
  });

  it("keeps the baseline inside the box even when the curve only falls", () => {
    // The start is the maximum here, so if the baseline weren't included in the
    // range it would sit above the frame and be clipped.
    const g = areaGeometry([100, 90, 80, 70], 100, 60, 6)!;
    expect(g.base).toBeGreaterThanOrEqual(6);
    expect(g.base).toBeLessThanOrEqual(54);
  });

  it("closes the fill to the BASELINE, not the bottom edge", () => {
    const height = 60;
    const g = areaGeometry([100, 130, 120], 200, height, 6)!;
    // The area path ends by returning along y = base.
    expect(g.area.endsWith(`L200.0 ${g.base.toFixed(1)}L0 ${g.base.toFixed(1)}Z`)).toBe(true);
    // And that baseline is genuinely inside the box, not pinned to the floor.
    expect(g.base).toBeLessThan(height);
  });

  it("spans the full width, first point to last", () => {
    const g = areaGeometry([1, 2, 3, 4, 5], 300, 50)!;
    expect(g.line.startsWith("M0.0 ")).toBe(true);
    expect(g.line).toContain("L300.0 ");
  });

  it("handles negative equity without inverting the curve", () => {
    // A paper book can go under; the drawing must still be monotonic in value.
    const g = areaGeometry([-50, -20, 10], 100, 60, 6)!;
    const ys = [...g.line.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
    // Rising value must mean DECREASING y in SVG coordinates.
    expect(ys[0]).toBeGreaterThan(ys[1]);
    expect(ys[1]).toBeGreaterThan(ys[2]);
  });
});
