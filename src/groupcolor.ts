/** Each folder group gets its own hue, kept per device, so groups do not share a colour. */
const KEY = "kermius.groupHues";

/** 64 hues spaced by the golden angle: neighbours in the list are far apart on the wheel. */
const PALETTE = Array.from({ length: 64 }, (_, k) => Math.round((k * 137.508) % 360));

function load(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

const hues = load();

export function groupHue(name: string): number {
  if (!name) return 0;
  if (hues[name] === undefined) {
    const used = new Set(Object.values(hues));
    // Beyond 64 groups the palette wraps around: colours repeat, but a group keeps its own once given.
    hues[name] = PALETTE.find((h) => !used.has(h)) ?? PALETTE[Object.keys(hues).length % PALETTE.length];
    try {
      localStorage.setItem(KEY, JSON.stringify(hues));
    } catch {
      /* private window: the colour lasts until the app restarts */
    }
  }
  return hues[name];
}
