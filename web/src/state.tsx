import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, hasToken, onUnauthorized, setToken } from "./api/client";
import type { User } from "./api/types";
import type { Theme } from "./lib/palette";

// ---------- theme ----------

export type ThemePref = "system" | "light" | "dark";
const THEME_KEY = "annolab.theme";

function systemTheme(): Theme {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

interface ThemeCtx {
  pref: ThemePref;
  theme: Theme;
  setPref: (p: ThemePref) => void;
  cycle: () => void;
}
const ThemeContext = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(() => {
    try {
      return (localStorage.getItem(THEME_KEY) as ThemePref) || "system";
    } catch {
      return "system";
    }
  });
  const [sys, setSys] = useState<Theme>(systemTheme);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const fn = () => setSys(mq.matches ? "dark" : "light");
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (pref === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", pref);
  }, [pref]);
  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p);
    try {
      localStorage.setItem(THEME_KEY, p);
    } catch {
      /* ignore */
    }
  }, []);
  const theme: Theme = pref === "system" ? sys : pref;
  const value = useMemo(
    () => ({ pref, theme, setPref, cycle: () => setPref(theme === "dark" ? "light" : "dark") }),
    [pref, theme, setPref],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const c = useContext(ThemeContext);
  if (!c) throw new Error("ThemeProvider missing");
  return c;
}

// ---------- session ----------

interface SessionCtx {
  user: User | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}
const SessionContext = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(!hasToken());
  useEffect(() => {
    if (!hasToken()) return;
    api
      .me()
      .then(setUser, () => setToken(null))
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    const off = onUnauthorized(() => setUser(null));
    return () => void off();
  }, []);
  const login = useCallback(async (email: string, password: string) => {
    const r = await api.login(email, password);
    setToken(r.token);
    setUser(r.user);
  }, []);
  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);
  const value = useMemo(() => ({ user, ready, login, logout }), [user, ready, login, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const c = useContext(SessionContext);
  if (!c) throw new Error("SessionProvider missing");
  return c;
}

// ---------- shortcuts overlay ----------

export interface ShortcutGroup {
  title: string;
  keys: [string, string][];
}

interface ShortcutsCtx {
  open: boolean;
  setOpen: (o: boolean) => void;
  extra: ShortcutGroup[];
  setExtra: (g: ShortcutGroup[]) => void;
}
const ShortcutsContext = createContext<ShortcutsCtx | null>(null);

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [extra, setExtra] = useState<ShortcutGroup[]>([]);
  const value = useMemo(() => ({ open, setOpen, extra, setExtra }), [open, extra]);
  return <ShortcutsContext.Provider value={value}>{children}</ShortcutsContext.Provider>;
}

export function useShortcuts() {
  const c = useContext(ShortcutsContext);
  if (!c) throw new Error("ShortcutsProvider missing");
  return c;
}

/** Register page-specific shortcut groups for the `?` overlay while a view is mounted. */
export function useShortcutGroups(groups: ShortcutGroup[]) {
  const { setExtra } = useShortcuts();
  const key = JSON.stringify(groups);
  useEffect(() => {
    setExtra(groups);
    return () => setExtra([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setExtra]);
}
