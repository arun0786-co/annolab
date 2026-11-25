import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

/** Modal dialog: traps focus, closes on Escape and backdrop click, restores focus on close. */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    const first = el.querySelector<HTMLElement>("[autofocus], input, select, textarea, button:not([data-close])");
    (first ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key !== "Tab") return;
      const f = [...el.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(
        (n) => !n.hasAttribute("disabled"),
      );
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) {
        e.preventDefault();
        f[f.length - 1].focus();
      } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
        e.preventDefault();
        f[0].focus();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`dialog${wide ? " dialog-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
      >
        <div className="dialog-head">
          <h2 id={id}>{title}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close" data-close>
            <Icon name="x" />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
