/**
 * Deterministic 5x5 symmetric identicon from a wallet address.
 * Renders to a data URL (tiny PNG-like via canvas) for use in PixiJS or HTML.
 */

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Generate a 5x5 symmetric identicon as a data URL.
 * The pattern is vertically symmetric (left half mirrors right half).
 * @param address Wallet address string
 * @param size Pixel size of the output image (default 40)
 * @returns data:image/png;base64,... URL
 */
export function generateIdenticon(address: string, size = 40): string {
  const hash = fnv1a(address);
  const hash2 = fnv1a(address + "salt");

  // Derive hue from hash
  const hue = hash % 360;
  const sat = 50 + (hash >> 8) % 30; // 50-79%
  const lum = 45 + (hash >> 16) % 20; // 45-64%

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  // Background
  ctx.fillStyle = `hsl(${hue}, ${sat}%, ${Math.max(15, lum - 30)}%)`;
  ctx.fillRect(0, 0, size, size);

  // Foreground color
  ctx.fillStyle = `hsl(${hue}, ${sat}%, ${lum}%)`;

  const cellSize = size / 5;
  // Generate 15 bits for a 5x5 symmetric pattern (only need 3 columns + center)
  const bits = hash2;

  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      const bitIdx = row * 3 + col;
      if ((bits >> bitIdx) & 1) {
        // Draw on the left side
        ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
        // Mirror on the right side
        ctx.fillRect((4 - col) * cellSize, row * cellSize, cellSize, cellSize);
      }
    }
  }

  return canvas.toDataURL("image/png");
}

/**
 * Generate an identicon as a PixiJS-compatible numeric color + pattern.
 * Returns the dominant hue for use as a border/accent color.
 */
export function identiconHue(address: string): number {
  return fnv1a(address) % 360;
}
