// Undo/redo stack shared by every editor. Pure functions over an immutable state.

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** Snapshot taken at the start of a drag; committed as one undo step at the end. */
  anchor: T | null;
}

export const HISTORY_LIMIT = 200;

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], anchor: null };
}

/** Record `next` as a new undoable step. Clears redo. */
export function push<T>(h: History<T>, next: T): History<T> {
  if (Object.is(next, h.present)) return h;
  const past = [...h.past, h.present];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, present: next, future: [], anchor: null };
}

/** Change the present without recording a step (used while dragging inside a transaction). */
export function replace<T>(h: History<T>, next: T): History<T> {
  return { ...h, present: next };
}

/** Start a transaction: later `replace` calls fold into one step on `commit`. */
export function begin<T>(h: History<T>): History<T> {
  return { ...h, anchor: h.present };
}

export function commit<T>(h: History<T>): History<T> {
  if (h.anchor === null) return h;
  if (Object.is(h.anchor, h.present)) return { ...h, anchor: null };
  const past = [...h.past, h.anchor];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, present: h.present, future: [], anchor: null };
}

export function cancel<T>(h: History<T>): History<T> {
  if (h.anchor === null) return h;
  return { ...h, present: h.anchor, anchor: null };
}

export function undo<T>(h: History<T>): History<T> {
  const base = h.anchor !== null ? commit(h) : h;
  if (!base.past.length) return base;
  const prev = base.past[base.past.length - 1];
  return { past: base.past.slice(0, -1), present: prev, future: [base.present, ...base.future], anchor: null };
}

export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  const [next, ...rest] = h.future;
  return { past: [...h.past, h.present], present: next, future: rest, anchor: null };
}

/** Replace the whole history, e.g. after loading a new item. */
export function reset<T>(present: T): History<T> {
  return createHistory(present);
}
