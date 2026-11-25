import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/client";

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function SkeletonRows({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-label="Loading" className="stack" style={{ padding: 12 }}>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="row" style={{ gap: 12 }}>
          {Array.from({ length: cols }, (_, c) => (
            <div key={c} className="skeleton" style={{ height: 14, flex: c === 1 ? 3 : 1 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const status = error instanceof ApiError ? error.status : -1;
  const offline = status === 0;
  if (status === 404 || status === 403) {
    // Retrying cannot help here; send the person somewhere useful instead.
    const msg = error.message.charAt(0).toUpperCase() + error.message.slice(1);
    return (
      <div className="state state-error" role="alert">
        <h2>{status === 404 ? msg : "You do not have access to this"}</h2>
        <p>{status === 404 ? "It may have been deleted, or the link is wrong." : msg}</p>
        <Link className="btn" to="/">
          Back to projects
        </Link>
      </div>
    );
  }
  return (
    <div className="state state-error" role="alert">
      <h2>{offline ? "Cannot reach the server" : "Something went wrong"}</h2>
      <p>{offline ? "Check that the backend is running, then retry." : error.message}</p>
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
