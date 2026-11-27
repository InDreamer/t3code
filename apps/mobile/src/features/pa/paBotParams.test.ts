import { describe, expect, it } from "vite-plus/test";

import { paBotKey, selectedPaBotKey } from "./paBotParams";

const route = (name: string, params?: object) => ({ key: name, name, params });

describe("selectedPaBotKey", () => {
  it("selects the Bot shown above Home, through sheets opened over it", () => {
    expect(
      selectedPaBotKey({
        index: 2,
        routes: [
          route("Home"),
          route("PaBot", { environmentId: "env", botId: "bot" }),
          route("PaSessions", { environmentId: "env", botId: "bot" }),
        ],
      }),
    ).toBe(paBotKey("env", "bot"));
  });

  it("selects nothing when Home is on top or another detail is shown", () => {
    expect(selectedPaBotKey({ index: 0, routes: [route("Home")] })).toBeNull();
    expect(
      selectedPaBotKey({
        index: 1,
        routes: [route("PaBot", { environmentId: "env", botId: "bot" }), route("Home")],
      }),
    ).toBeNull();
  });

  it("keys the same Bot id on two environments apart", () => {
    expect(paBotKey("a", "bot")).not.toBe(paBotKey("b", "bot"));
  });
});
