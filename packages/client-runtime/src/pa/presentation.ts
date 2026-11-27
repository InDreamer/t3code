import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import {
  findActivePaToolAction,
  type PaLiveTurnState,
  type PaToolAction,
  type PaWorkGroupSummary,
} from "./timeline.ts";

/** The verb for what a tool step did, in the reader's language. */
export function formatPaToolVerb(action: PaToolAction, resolve: MFunctionType = mFallback): string {
  const pick = (failed: string, active: string, done: string) =>
    resolve(action.phase === "failed" ? failed : action.phase === "active" ? active : done);
  switch (action.category) {
    case "terminal":
      return pick(msg("Command failed"), msg("Running command"), msg("Ran command"));
    case "file-read":
      return pick(msg("Read failed"), msg("Reading file"), msg("Read file"));
    case "file-edit":
      return pick(msg("Edit failed"), msg("Editing file"), msg("Edited file"));
    case "web-search":
      return pick(msg("Search failed"), msg("Searching"), msg("Searched"));
    case "web-fetch":
      return pick(msg("Fetch failed"), msg("Reading web page"), msg("Read web page"));
    case "search":
      return pick(msg("Lookup failed"), msg("Looking up"), msg("Looked up"));
    case "memory":
      return pick(msg("Memory search failed"), msg("Searching memory"), msg("Searched memory"));
    case "agent":
      return pick(msg("Delegation failed"), msg("Delegating subtask"), msg("Delegated subtask"));
    case "todo":
      return pick(msg("Task update failed"), msg("Updating tasks"), msg("Updated tasks"));
    case "schedule":
      return pick(
        msg("Schedule operation failed"),
        msg("Managing scheduled tasks"),
        msg("Updated scheduled tasks"),
      );
    case "skill":
      return pick(msg("Skill failed"), msg("Using skill"), msg("Used skill"));
    case "code":
      return pick(msg("Code execution failed"), msg("Running code"), msg("Ran code"));
    case "vision":
      return pick(msg("Image analysis failed"), msg("Analyzing image"), msg("Analyzed image"));
    case "message":
      return pick(msg("Could not send message"), msg("Sending message"), msg("Sent message"));
    case "other":
      return action.phase === "failed"
        ? resolve(msg("{tool} failed", { tool: action.toolName }))
        : action.toolName;
  }
}

/** The folded label of a run of tool and reasoning steps. */
export function formatPaWorkGroupLabel(
  summary: PaWorkGroupSummary,
  resolve: MFunctionType = mFallback,
): string {
  switch (summary.kind) {
    case "reasoning":
      return resolve(msg("Reasoning details"));
    case "tool": {
      const verb = formatPaToolVerb(summary.action, resolve);
      const detail = summary.action.target ? `${verb} ${summary.action.target}` : verb;
      return summary.afterReasoning ? resolve(msg("Reasoned · {detail}", { detail })) : detail;
    }
    case "tools":
      return summary.afterReasoning
        ? resolve(msg("Reasoned and used {count} tools", { count: summary.count }))
        : resolve(msg("Used {count} tools", { count: summary.count }));
  }
}

/** Where a session started, as the engine names it (`gui`, `cron`, a chat platform...). */
export function formatPaSessionSource(source: string, resolve: MFunctionType = mFallback): string {
  switch (source.toLowerCase()) {
    case "gui":
      return resolve(msg("T3 Web"));
    case "feishu":
      return resolve(msg("Feishu"));
    case "telegram":
      return resolve(msg("Telegram"));
    case "cron":
      return resolve(msg("Scheduled task"));
    case "cli":
    case "tui":
      return resolve(msg("Terminal"));
    case "local":
      return resolve(msg("Local"));
    default:
      return source;
  }
}

/** One line on what a running turn is doing, for a reader scrolled away from its end. */
export function summarizePaLiveActivity(
  turn: PaLiveTurnState,
  resolve: MFunctionType = mFallback,
): string | null {
  if (turn.openRequests.length > 0) return resolve(msg("Waiting for your approval"));
  if (turn.phase !== "running") return null;
  const lastBlock = turn.blocks.at(-1);
  if (lastBlock?.kind === "text" && lastBlock.text.length > 0) return resolve(msg("Streaming"));
  if (lastBlock?.kind === "work-group") {
    const activeTool = findActivePaToolAction(turn);
    if (activeTool) return formatPaToolVerb(activeTool, resolve);
  }
  return turn.statusText || resolve(msg("Thinking"));
}
