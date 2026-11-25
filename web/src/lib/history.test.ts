import { describe, expect, it } from "vitest";
import { begin, cancel, commit, createHistory, HISTORY_LIMIT, push, redo, replace, undo } from "./history";

describe("history", () => {
  it("undoes and redoes in order", () => {
    let h = createHistory(0);
    h = push(h, 1);
    h = push(h, 2);
    h = undo(h);
    expect(h.present).toBe(1);
    h = undo(h);
    expect(h.present).toBe(0);
    h = undo(h);
    expect(h.present).toBe(0);
    h = redo(h);
    h = redo(h);
    expect(h.present).toBe(2);
    h = redo(h);
    expect(h.present).toBe(2);
  });
  it("drops redo after a new edit", () => {
    let h = push(push(createHistory("a"), "b"), "c");
    h = undo(h);
    h = push(h, "d");
    expect(h.future).toEqual([]);
    expect(redo(h).present).toBe("d");
    expect(undo(h).present).toBe("b");
  });
  it("folds a drag transaction into one step", () => {
    let h = createHistory({ x: 0 });
    h = begin(h);
    for (let i = 1; i <= 10; i++) h = replace(h, { x: i });
    h = commit(h);
    expect(h.past).toHaveLength(1);
    expect(undo(h).present).toEqual({ x: 0 });
  });
  it("cancels a transaction and ignores no-op commits", () => {
    let h = begin(createHistory(5));
    h = replace(h, 6);
    expect(cancel(h).present).toBe(5);
    expect(commit(begin(createHistory(5))).past).toHaveLength(0);
  });
  it("undo during an open transaction commits it first", () => {
    let h = begin(createHistory(1));
    h = replace(h, 2);
    h = undo(h);
    expect(h.present).toBe(1);
    expect(redo(h).present).toBe(2);
  });
  it("caps memory", () => {
    let h = createHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 50; i++) h = push(h, i);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
  });
});
