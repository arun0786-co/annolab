// Default class colors. Eight hues in a fixed order that was checked for colour-vision-deficiency
// separation on adjacent slots, with a separate step per theme. Light steps are what the schema
// stores; the dark step for the same slot is substituted when the dark theme is active.

export const PALETTE_LIGHT = ["#257de0", "#f47230", "#00b894", "#f2a600", "#ee7fac", "#008a17", "#6a4ce2", "#ec4647"];
export const PALETTE_DARK = ["#338ced", "#e76624", "#00a888", "#d28e05", "#e24d8b", "#0aac23", "#9887ef", "#eb6263"];

/** Surfaces the palette is checked against (must match --bg in styles.css). */
export const SURFACE_LIGHT = "#ffffff";
export const SURFACE_DARK = "#161719";

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Text ink (near-black or white) with the higher contrast on a fill of `hex`. */
export function inkOn(hex: string): string {
  return contrast(hex, "#111111") >= contrast(hex, "#ffffff") ? "#111111" : "#ffffff";
}

export type Theme = "light" | "dark";

/** Colour to draw for a schema colour in the given theme. Custom colours pass through. */
export function displayColor(hex: string, theme: Theme): string {
  const i = PALETTE_LIGHT.indexOf(hex.toLowerCase());
  if (i < 0) return hex;
  return theme === "dark" ? PALETTE_DARK[i] : PALETTE_LIGHT[i];
}

/** First palette slot not already used, in fixed order; wraps only after all eight are taken. */
export function nextColor(used: string[]): string {
  const u = new Set(used.map((c) => c.toLowerCase()));
  return PALETTE_LIGHT.find((c) => !u.has(c)) ?? PALETTE_LIGHT[used.length % PALETTE_LIGHT.length];
}

// Annotator overlay colours in review reuse the palette order so each person keeps one hue.
export function annotatorColor(index: number, theme: Theme): string {
  const p = theme === "dark" ? PALETTE_DARK : PALETTE_LIGHT;
  return p[index % p.length];
}
