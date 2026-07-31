import { memo, useMemo } from "react";
import { View } from "react-native";
import Svg, { Defs, LinearGradient, Line, Path, Stop } from "react-native-svg";
import { areaGeometry } from "./chartGeometry";
import { C } from "./tokens";

/**
 * An equity curve, drawn as a filled area with a baseline.
 *
 * The maths lives in chartGeometry.ts and is unit-tested there — deliberately not
 * inline, because every failure mode in it is silent. A divide-by-zero on a flat
 * series puts every point at NaN and React Native Svg simply draws nothing, which
 * looks identical to "no data". A flat balance is a completely ordinary state for
 * an agent that hasn't traded today.
 *
 * Two choices carry the look:
 *
 *   THE BASELINE IS THE STARTING VALUE, not zero. Scaled from zero, every real
 *   move flattens into a line near the top. Anchored at where the money started,
 *   the shape IS the performance and the fill reads instantly as above or under
 *   water.
 *
 *   COLOUR COMES FROM THE OUTCOME, never from a prop. Up is green, down is red,
 *   and a caller cannot accidentally render a loss in green.
 *
 * Memoised on series identity, which the feed store keeps stable when nothing has
 * moved — so a poll that changed nothing doesn't rebuild two path strings.
 */
export const AreaChart = memo(function AreaChart({
  series,
  width,
  height = 96,
}: {
  series: number[];
  width: number;
  height?: number;
}) {
  const geom = useMemo(() => areaGeometry(series, width, height), [series, width, height]);

  if (!geom) return <View style={{ height }} />;

  const tone = geom.up ? C.green : C.red;
  // Gradient ids must differ between an up and a down chart, or two charts on the
  // same screen would share one definition and the second would inherit the
  // first's colour.
  const gradientId = `equity-${geom.up ? "up" : "down"}`;

  return (
    <Svg width={width} height={height}>
      <Defs>
        <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={tone} stopOpacity={0.28} />
          <Stop offset="1" stopColor={tone} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Path d={geom.area} fill={`url(#${gradientId})`} />
      {/* Where the money started, so "above water" is visible rather than a
          number you have to hold in your head. */}
      <Line x1={0} y1={geom.base} x2={width} y2={geom.base} stroke={C.border} strokeWidth={1} strokeDasharray="3 4" />
      <Path
        d={geom.line}
        stroke={tone}
        strokeWidth={1.75}
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </Svg>
  );
});
