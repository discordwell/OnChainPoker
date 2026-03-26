/**
 * Imperative toast notification system.
 * Usage: const toast = useToast(); toast.success("Done!");
 */
import { useCallback, useSyncExternalStore } from "react";

export type ToastKind = "success" | "error" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  expiresAt: number;
}

let nextId = 1;
let toasts: Toast[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

function addToast(kind: ToastKind, message: string, durationMs = 4000) {
  const id = nextId++;
  toasts = [...toasts, { id, kind, message, expiresAt: Date.now() + durationMs }];
  notify();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
  }, durationMs);
}

function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  notify();
}

function getSnapshot() {
  return toasts;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useToast() {
  const current = useSyncExternalStore(subscribe, getSnapshot);

  const success = useCallback((msg: string, ms?: number) => addToast("success", msg, ms), []);
  const error = useCallback((msg: string, ms?: number) => addToast("error", msg, ms ?? 6000), []);
  const info = useCallback((msg: string, ms?: number) => addToast("info", msg, ms), []);

  return { toasts: current, success, error, info, dismiss };
}
