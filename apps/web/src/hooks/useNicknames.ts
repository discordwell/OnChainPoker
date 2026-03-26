/**
 * Manages player nicknames — fetched from coordinator, cached locally.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_COORDINATOR_HTTP_URL } from "../lib/constants";

export function useNicknames() {
  const [nicknames, setNicknames] = useState<Map<string, string>>(new Map());
  const fetchedRef = useRef(false);

  // Fetch all nicknames on mount
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    fetch(`${DEFAULT_COORDINATOR_HTTP_URL}/v1/nicknames`)
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        setNicknames(new Map(Object.entries(data)));
      })
      .catch(() => {});
  }, []);

  const getDisplayName = useCallback(
    (address: string): string => {
      const nick = nicknames.get(address);
      if (nick) return nick;
      if (!address || address.length < 16) return address || "";
      return `${address.slice(0, 8)}...${address.slice(-4)}`;
    },
    [nicknames],
  );

  const setNickname = useCallback(
    async (address: string, nickname: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const res = await fetch(`${DEFAULT_COORDINATOR_HTTP_URL}/v1/nicknames/${address}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nickname }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "failed" }));
          return { ok: false, error: err.error ?? "failed" };
        }
        setNicknames((prev) => new Map(prev).set(address, nickname));
        return { ok: true };
      } catch {
        return { ok: false, error: "network error" };
      }
    },
    [],
  );

  return { nicknames, getDisplayName, setNickname };
}
