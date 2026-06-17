/**
 * Resolve the trustworthy client IP from a (possibly spoofed) `X-Forwarded-For`
 * header, for use as a rate-limiting / cooldown key.
 *
 * `X-Forwarded-For` is a comma-separated chain `client, proxy1, proxy2, ...`.
 * Everything to the LEFT of what our own infrastructure appended is fully
 * client-controlled and MUST NOT be trusted — an attacker can prepend arbitrary
 * values to mint a fresh "IP" per request and bypass every per-IP limit.
 *
 * Our reverse proxy (see `deploy/nginx-ocp.conf`, which uses nginx's
 * `$proxy_add_x_forwarded_for`) APPENDS the real peer address as the RIGHT-most
 * element. So with `trustedHops` reverse proxies in front of us, the real client
 * address is the `trustedHops`-th entry counted from the right.
 *
 * Behaviour:
 * - `trustedHops <= 0` or no header  → use the direct socket peer (`directIp`).
 * - fewer hops present than expected → the chain was forged/short; fail safe to
 *   `directIp` rather than trusting an attacker-supplied prefix.
 *
 * This mirrors Express's `trust proxy: <n>` semantics. Defaults to a single
 * trusted hop, matching the checked-in nginx deployment.
 */
export function clientIpFromForwarded(
  forwardedHeader: string | string[] | undefined,
  directIp: string,
  trustedHops = 1
): string {
  const fallback = directIp || "unknown";
  if (trustedHops <= 0) return fallback;

  const raw = Array.isArray(forwardedHeader) ? forwardedHeader.join(",") : forwardedHeader;
  if (!raw) return fallback;

  const hops = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (hops.length === 0) return fallback;

  // Index of the entry the outermost trusted proxy appended on the client's behalf.
  const idx = hops.length - trustedHops;
  if (idx < 0) return fallback;

  return hops[idx] ?? fallback;
}
