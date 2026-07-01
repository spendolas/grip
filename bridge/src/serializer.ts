// Helpers for the bridge side. The plugin does the heavy serialization
// (it owns the Plugin API objects); these utilities are duplicated there.
// Kept here so tools.ts and tests can import the same conversion logic.

export function rgbaToHex(r: number, g: number, b: number): string {
  const to = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.replace('#', '');
  const full =
    m.length === 3
      ? m
          .split('')
          .map((c) => c + c)
          .join('')
      : m;
  if (full.length !== 6) throw new Error(`Invalid hex color: ${hex}`);
  const n = parseInt(full, 16);
  return {
    r: ((n >> 16) & 0xff) / 255,
    g: ((n >> 8) & 0xff) / 255,
    b: (n & 0xff) / 255,
  };
}

export function clampDepth(depth: number | undefined, fallback = 3): number {
  if (depth === undefined) return fallback;
  if (depth === -1) return Number.POSITIVE_INFINITY;
  if (depth < 1) return 1;
  return Math.floor(depth);
}
