import { Link, NavLink, Outlet } from "react-router-dom";
import { useHotkeys } from "../hooks/useHotkeys";
import { useSession, useShortcuts, useTheme } from "../state";
import { Icon } from "./Icon";

export function Brand() {
  return (
    <Link to="/" className="brand" aria-label="annolab home">
      <span className="brand-mark" aria-hidden="true" />
      annolab
    </Link>
  );
}

export function ThemeButton() {
  const { theme, cycle } = useTheme();
  return (
    <button
      className="btn btn-ghost btn-icon"
      onClick={cycle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      title="Toggle theme (Shift+D)"
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} />
    </button>
  );
}

export function HelpButton() {
  const { setOpen } = useShortcuts();
  return (
    <button className="btn btn-ghost btn-icon" onClick={() => setOpen(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
      <Icon name="keyboard" />
    </button>
  );
}

export function AppShell() {
  const { user, logout } = useSession();
  const { cycle } = useTheme();
  useHotkeys({ "shift+d": cycle });
  return (
    <div className="app">
      <header className="topbar">
        <Brand />
        <nav className="crumbs" aria-label="Primary">
          <NavLink to="/" end>
            Projects
          </NavLink>
        </nav>
        <div className="topbar-right">
          <HelpButton />
          <ThemeButton />
          {user && (
            <span className="row muted" style={{ fontSize: "var(--fs-sm)" }}>
              <span>{user.name}</span>
              <span className="badge">{user.role}</span>
              <button className="btn btn-ghost btn-icon" onClick={logout} aria-label="Sign out" title="Sign out">
                <Icon name="logout" />
              </button>
            </span>
          )}
        </div>
      </header>
      <main className="main" id="main">
        <Outlet />
      </main>
    </div>
  );
}

export function Crumbs({ items }: { items: { label: string; to?: string }[] }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb" style={{ marginBottom: 8, fontSize: "var(--fs-sm)" }}>
      {items.map((c, i) => (
        <span key={i} className="row" style={{ gap: 8 }}>
          {i > 0 && <span className="sep">/</span>}
          {c.to ? <Link to={c.to}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}
        </span>
      ))}
    </nav>
  );
}
