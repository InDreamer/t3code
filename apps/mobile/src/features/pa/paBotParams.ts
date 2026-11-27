import type { NavigationState } from "@react-navigation/native";

/** A Bot page's route params: the Bot, the environment that hosts it and the session shown. */
export type PaBotParams = {
  readonly environmentId: string;
  readonly botId: string;
  /** Absent: the Bot's primary conversation, or the first one it has. */
  readonly sessionId?: string;
};

/** Identifies a Bot across environments, for row selection and stores. */
export function paBotKey(environmentId: string, botId: string): string {
  return JSON.stringify([environmentId, botId]);
}

export function selectedPaBotKeyOf(params: object | undefined): string | null {
  const value = params as Partial<Record<keyof PaBotParams, unknown>> | undefined;
  return typeof value?.environmentId === "string" && typeof value.botId === "string"
    ? paBotKey(value.environmentId, value.botId)
    : null;
}

/** The Bot the root stack shows directly above Home, for the Android sidebar's selection. */
export function selectedPaBotKey(state: Pick<NavigationState, "routes" | "index">) {
  for (let index = state.index; index >= 0; index--) {
    const route = state.routes[index];
    if (!route || route.name === "Home") return null;
    if (route.name === "PaBot") return selectedPaBotKeyOf(route.params);
  }
  return null;
}
