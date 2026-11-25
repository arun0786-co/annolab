import { useEffect, useRef } from "react";

export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Normalise an event to a combo string like "mod+shift+z", "space", "[", "1", "delete". */
export function comboOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  let key = e.key.toLowerCase();
  if (key === " ") key = "space";
  if (key === "backspace") key = "delete";
  if (key === "esc") key = "escape";
  // Shift is implied by the character for symbols like "?"; only record it for letters and named keys.
  if (e.shiftKey && (key.length > 1 || /[a-z]/.test(key))) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

function isActivatable(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t?.closest?.("button, a[href], summary, [role=button], [role=option], [role=radio], [role=checkbox]");
}

/**
 * Bind keys on window. Handlers are read through a ref so callers can pass a fresh map every render.
 * Keys are skipped while typing in a form field, except "escape" and "mod+enter".
 */
export function useHotkeys(map: HotkeyMap, enabled = true) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const combo = comboOf(e);
      if (isTyping(e) && combo !== "escape" && combo !== "mod+enter") return;
      // Let Enter and Space activate a focused button or link as usual.
      if ((combo === "enter" || combo === "space") && isActivatable(e)) return;
      const fn = ref.current[combo];
      if (fn) {
        e.preventDefault();
        fn(e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

export const MOD_LABEL = isMac ? "Cmd" : "Ctrl";
