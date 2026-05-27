// Tremor Raw chart utilities — vendored from tremorlabs/tremor (Apache-2.0),
// rewired to Conan's semantic chart tokens. The color names map to the
// --color-chart-1..5 CSS vars in ui/src/index.css, so charts honor the light
// default and the .dark toggle automatically (the vars resolve per-scope).

export type ColorUtility = "bg" | "stroke" | "fill" | "text";

export const chartColors = {
  chart1: {
    bg: "bg-[var(--color-chart-1)]",
    stroke: "stroke-[var(--color-chart-1)]",
    fill: "fill-[var(--color-chart-1)]",
    text: "text-[var(--color-chart-1)]",
  },
  chart2: {
    bg: "bg-[var(--color-chart-2)]",
    stroke: "stroke-[var(--color-chart-2)]",
    fill: "fill-[var(--color-chart-2)]",
    text: "text-[var(--color-chart-2)]",
  },
  chart3: {
    bg: "bg-[var(--color-chart-3)]",
    stroke: "stroke-[var(--color-chart-3)]",
    fill: "fill-[var(--color-chart-3)]",
    text: "text-[var(--color-chart-3)]",
  },
  chart4: {
    bg: "bg-[var(--color-chart-4)]",
    stroke: "stroke-[var(--color-chart-4)]",
    fill: "fill-[var(--color-chart-4)]",
    text: "text-[var(--color-chart-4)]",
  },
  chart5: {
    bg: "bg-[var(--color-chart-5)]",
    stroke: "stroke-[var(--color-chart-5)]",
    fill: "fill-[var(--color-chart-5)]",
    text: "text-[var(--color-chart-5)]",
  },
} as const satisfies {
  [color: string]: {
    [key in ColorUtility]: string;
  };
};

export type AvailableChartColorsKeys = keyof typeof chartColors;

export const AvailableChartColors: AvailableChartColorsKeys[] = Object.keys(
  chartColors,
) as Array<AvailableChartColorsKeys>;

export const constructCategoryColors = (
  categories: string[],
  colors: AvailableChartColorsKeys[],
): Map<string, AvailableChartColorsKeys> => {
  const categoryColors = new Map<string, AvailableChartColorsKeys>();
  const palette = colors.length ? colors : AvailableChartColors;
  categories.forEach((category, index) => {
    categoryColors.set(category, palette[index % palette.length]!);
  });
  return categoryColors;
};

export const getColorClassName = (
  color: AvailableChartColorsKeys,
  type: ColorUtility,
): string => {
  const fallbackColor: Record<ColorUtility, string> = {
    bg: "bg-muted",
    stroke: "stroke-muted-foreground",
    fill: "fill-muted-foreground",
    text: "text-muted-foreground",
  };
  return chartColors[color]?.[type] ?? fallbackColor[type];
};

// Tremor getYAxisDomain [v0.0.0]
export const getYAxisDomain = (
  autoMinValue: boolean,
  minValue: number | undefined,
  maxValue: number | undefined,
) => {
  const minDomain = autoMinValue ? "auto" : (minValue ?? 0);
  const maxDomain = maxValue ?? "auto";
  return [minDomain, maxDomain];
};

// Tremor hasOnlyOneValueForKey [v0.1.0]
export function hasOnlyOneValueForKey(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  array: any[],
  keyToCheck: string,
): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const val: any[] = [];

  for (const obj of array) {
    if (Object.prototype.hasOwnProperty.call(obj, keyToCheck)) {
      val.push(obj[keyToCheck]);
      if (val.length > 1) {
        return false;
      }
    }
  }

  return true;
}
