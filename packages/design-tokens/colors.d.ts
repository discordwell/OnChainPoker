/**
 * Returns a deterministic HSL color string for a wallet address.
 * Tuned for good contrast on dark backgrounds.
 */
export declare function addressToColor(address: string): string;

/**
 * Returns a deterministic numeric hex color for a wallet address.
 * Useful for PixiJS which needs numeric colors.
 */
export declare function addressToHex(address: string): number;
