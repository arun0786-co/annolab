import { useCallback, useMemo, useReducer, useRef } from "react";
import * as H from "../lib/history";
import type { Ann, EditApi } from "./types";

type Action =
  | { type: "push"; next: Ann[] }
  | { type: "replace"; next: Ann[] }
  | { type: "begin" }
  | { type: "commit" }
  | { type: "cancel" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset"; next: Ann[] };

function reducer(h: H.History<Ann[]>, a: Action): H.History<Ann[]> {
  switch (a.type) {
    case "push":
      return h.anchor !== null ? H.replace(h, a.next) : H.push(h, a.next);
    case "replace":
      return H.replace(h, a.next);
    case "begin":
      return H.begin(h);
    case "commit":
      return H.commit(h);
    case "cancel":
      return H.cancel(h);
    case "undo":
      return H.undo(h);
    case "redo":
      return H.redo(h);
    case "reset":
      return H.reset(a.next);
  }
}

/** Annotation list with undo/redo. Every editor writes through the returned EditApi. */
export function useAnnStore(initial: Ann[] = []) {
  const [h, dispatch] = useReducer(reducer, initial, H.createHistory);
  const cur = useRef(h);
  cur.current = h;
  const setAll = useCallback((fn: (a: Ann[]) => Ann[]) => {
    const next = fn(cur.current.present);
    cur.current = reducer(cur.current, { type: "push", next });
    dispatch({ type: "push", next });
  }, []);
  const edit: EditApi = useMemo(
    () => ({
      add: (a) => setAll((xs) => [...xs, a]),
      patch: (cid, fn) => setAll((xs) => xs.map((x) => (x.cid === cid ? fn(x) : x))),
      remove: (cid) => setAll((xs) => xs.filter((x) => x.cid !== cid)),
      setAll,
      begin: () => {
        cur.current = H.begin(cur.current);
        dispatch({ type: "begin" });
      },
      commit: () => {
        cur.current = H.commit(cur.current);
        dispatch({ type: "commit" });
      },
      cancel: () => {
        cur.current = H.cancel(cur.current);
        dispatch({ type: "cancel" });
      },
    }),
    [setAll],
  );
  return {
    anns: h.present,
    edit,
    undo: useCallback(() => {
      cur.current = H.undo(cur.current);
      dispatch({ type: "undo" });
    }, []),
    redo: useCallback(() => {
      cur.current = H.redo(cur.current);
      dispatch({ type: "redo" });
    }, []),
    reset: useCallback((next: Ann[]) => {
      cur.current = H.reset(next);
      dispatch({ type: "reset", next });
    }, []),
    canUndo: h.past.length > 0 || h.anchor !== null,
    canRedo: h.future.length > 0,
  };
}
