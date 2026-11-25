import { createFileRoute } from "@tanstack/react-router";

import { BotsPage, type BotsSearch } from "../components/pa/BotsPage";

export const Route = createFileRoute("/_chat/bots")({
  validateSearch: (raw: Record<string, unknown>): BotsSearch => ({
    ...(typeof raw.bot === "string" && raw.bot ? { bot: raw.bot.slice(0, 128) } : {}),
    ...(typeof raw.session === "string" && raw.session
      ? { session: raw.session.slice(0, 200) }
      : {}),
  }),
  component: BotsPage,
});
