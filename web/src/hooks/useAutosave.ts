import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";

export type SaveState = "saved" | "saving" | "pending" | "offline" | "error";

/**
 * Debounced save of `value`. Retries while offline. `flush` saves immediately and resolves when
 * the latest value is on the server (used before submit and when leaving the item).
 */
export function useAutosave<T>(value: T, save: (v: T) => Promise<unknown>, opts: { delay?: number; key: unknown }) {
  const delay = opts.delay ?? 700;
  const [state, setState] = useState<SaveState>("saved");
  const [lastError, setLastError] = useState<string | null>(null);
  const latest = useRef(value);
  const savedVersion = useRef(0);
  const version = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const inflight = useRef<Promise<void> | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const first = useRef(true);

  // A new item starts clean.
  useEffect(() => {
    first.current = true;
    version.current = 0;
    savedVersion.current = 0;
    setState("saved");
  }, [opts.key]);

  const run = useCallback(async (): Promise<void> => {
    if (inflight.current) {
      await inflight.current;
      if (version.current === savedVersion.current) return;
    }
    const v = version.current;
    setState("saving");
    const p = (async () => {
      try {
        await saveRef.current(latest.current);
        savedVersion.current = Math.max(savedVersion.current, v);
        setLastError(null);
        setState(version.current === savedVersion.current ? "saved" : "pending");
      } catch (e) {
        const offline = e instanceof ApiError ? e.offline : true;
        setState(offline ? "offline" : "error");
        setLastError((e as Error).message);
        throw e;
      }
    })();
    inflight.current = p.finally(() => {
      inflight.current = null;
    }).catch(() => undefined);
    await p;
  }, []);

  useEffect(() => {
    latest.current = value;
    if (first.current) {
      first.current = false;
      return;
    }
    version.current += 1;
    setState("pending");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => run().catch(() => undefined), delay);
  }, [value, delay, run]);

  // Retry while offline or after an error.
  useEffect(() => {
    if (state !== "offline" && state !== "error") return;
    const retry = () => run().catch(() => undefined);
    const id = setInterval(retry, 4000);
    window.addEventListener("online", retry);
    return () => {
      clearInterval(id);
      window.removeEventListener("online", retry);
    };
  }, [state, run]);

  // Warn before closing the tab with unsaved work.
  useEffect(() => {
    const fn = (e: BeforeUnloadEvent) => {
      if (version.current !== savedVersion.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", fn);
    return () => window.removeEventListener("beforeunload", fn);
  }, []);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (version.current !== savedVersion.current) await run();
    else if (inflight.current) await inflight.current;
  }, [run]);

  return { state, lastError, flush, dirty: () => version.current !== savedVersion.current };
}
