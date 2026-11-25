import { MOD_LABEL, useHotkeys } from "../hooks/useHotkeys";
import { useShortcuts, type ShortcutGroup } from "../state";
import { Dialog } from "./Dialog";

const GLOBAL: ShortcutGroup = {
  title: "Anywhere",
  keys: [
    ["?", "Show this list"],
    ["Shift+D", "Toggle dark theme"],
    ["Esc", "Close dialog or clear selection"],
  ],
};

export function ShortcutsOverlay() {
  const { open, setOpen, extra } = useShortcuts();
  useHotkeys({ "?": () => setOpen(!open) });
  if (!open) return null;
  const groups = [...extra, GLOBAL];
  return (
    <Dialog title="Keyboard shortcuts" onClose={() => setOpen(false)} wide>
      <div className="shortcut-grid">
        {groups.map((g) => (
          <Group key={g.title} g={g} />
        ))}
      </div>
    </Dialog>
  );
}

function Group({ g }: { g: ShortcutGroup }) {
  return (
    <>
      <h3>{g.title}</h3>
      {g.keys.map(([k, d]) => (
        <div className="shortcut-row" key={k + d}>
          <span>{d}</span>
          <span className="row" style={{ gap: 4 }}>
            {k.split(" or ").map((alt, i) => (
              <span key={i} className="row" style={{ gap: 2 }}>
                {i > 0 && <span className="faint">or</span>}
                {alt.split("+").map((p, j) => (
                  <kbd key={j}>{p === "Mod" ? MOD_LABEL : p}</kbd>
                ))}
              </span>
            ))}
          </span>
        </div>
      ))}
    </>
  );
}
