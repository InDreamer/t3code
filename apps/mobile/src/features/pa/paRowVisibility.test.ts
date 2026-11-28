import { expect, it, vi } from "vite-plus/test";
import { PaRowVisibility } from "./paRowVisibility";

it("wakes only a row crossing the viewport and drops the recycled key", () => {
  const rows = new PaRowVisibility();
  const first = vi.fn();
  const second = vi.fn();
  const release = rows.subscribe("a", first);
  rows.subscribe("b", second);
  expect(rows.has("a")).toBe(false);
  rows.update([{ key: "a", isViewable: true }]);
  rows.update([{ key: "a", isViewable: true }]);
  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
  rows.update([
    { key: "a", isViewable: false },
    { key: "b", isViewable: true },
  ]);
  expect(rows.has("a")).toBe(false);
  expect(rows.has("b")).toBe(true);
  release();
  rows.update([{ key: "a", isViewable: true }]);
  expect(first).toHaveBeenCalledTimes(2);
  expect(second).toHaveBeenCalledOnce();
});
