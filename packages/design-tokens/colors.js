/**
 * Deterministic address-to-color mapping.
 * Produces visually distinct, dark-background-friendly HSL colors from wallet addresses.
 */

/**
 * Simple FNV-1a 32-bit hash of a string.
 * @param {string} s
 * @returns {number}
 */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Returns a deterministic HSL color string for a wallet address.
 * Saturation and lightness are tuned for good contrast on dark backgrounds.
 * @param {string} address — e.g. "ocp1abc..."
 * @returns {string} — e.g. "hsl(217, 65%, 62%)"
 */
export function addressToColor(address) {
  const hash = fnv1a(address);
  const hue = hash % 360;
  const saturation = 55 + (hash >> 8) % 20;   // 55-74%
  const lightness = 55 + (hash >> 16) % 15;   // 55-69%
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

/**
 * Returns a deterministic hex color (no alpha) for a wallet address.
 * Useful for PixiJS which needs numeric colors.
 * @param {string} address
 * @returns {number} — e.g. 0x4a8fc2
 */
export function addressToHex(address) {
  const hash = fnv1a(address);
  const hue = hash % 360;
  const saturation = (55 + (hash >> 8) % 20) / 100;
  const lightness = (55 + (hash >> 16) % 15) / 100;
  // HSL to RGB conversion
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - c / 2;
  let r, g, b;
  if (hue < 60) { r = c; g = x; b = 0; }
  else if (hue < 120) { r = x; g = c; b = 0; }
  else if (hue < 180) { r = 0; g = c; b = x; }
  else if (hue < 240) { r = 0; g = x; b = c; }
  else if (hue < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  const ri = Math.round((r + m) * 255);
  const gi = Math.round((g + m) * 255);
  const bi = Math.round((b + m) * 255);
  return (ri << 16) | (gi << 8) | bi;
}
