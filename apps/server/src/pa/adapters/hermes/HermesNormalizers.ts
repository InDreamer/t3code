import type {
  PaBotConfig,
  PaConfigSection,
  PaMessage,
  PaModelCatalog,
  PaModelOption,
  PaModelProvider,
  PaPendingRequest,
  PaReasoningLevel,
  PaSchedule,
  PaSlashCommand,
  PaToolCategory,
} from "@t3tools/contracts";

import type { PaAdapterSession, PaAgentRow, PaCommandScope } from "../../types.ts";

export interface HermesProfileRow {
  readonly name: string;
  readonly is_default?: boolean;
  readonly model?: string | null;
  readonly provider?: string | null;
  readonly description?: string;
  readonly display_name?: string;
  readonly running?: boolean;
  readonly last_session?: {
    readonly id?: string;
    readonly title?: string;
    readonly preview?: string;
    readonly started_at?: number | null;
    readonly last_active?: number | null;
    readonly running?: boolean;
  } | null;
  readonly canonical_session?: {
    readonly id?: string;
    readonly title?: string;
    readonly preview?: string;
    readonly last_active?: number | null;
  } | null;
}

export interface HermesSessionRow {
  readonly session_id?: string;
  readonly id?: string;
  readonly title?: string | null;
  readonly preview?: string | null;
  readonly source?: string | null;
  readonly model?: string | null;
  readonly message_count?: number | null;
  readonly running?: boolean | null;
  readonly started_at?: number | null;
  readonly last_active_at?: number | null;
  readonly last_active?: number | null;
  readonly updated_at?: number | null;
}

export interface HermesTranscriptRow {
  readonly role?: string;
  readonly text?: string | null;
  readonly content?: unknown;
  readonly timestamp?: number | null;
  readonly row_id?: number | null;
  readonly name?: string | null;
  readonly context?: string | null;
  readonly tool_call_id?: string | null;
  readonly args?: Record<string, unknown> | null;
  readonly is_error?: boolean | null;
  readonly display_metadata?: Record<string, unknown> | null;
  readonly reasoning?: string | null;
  readonly reasoning_content?: string | null;
  readonly row_kind?: string | null;
  readonly display_kind?: string | null;
  /** `agent/history_commentary.py` projection: public commentary bubbles, sanitized answer and reasoning. */
  readonly display_commentary?: ReadonlyArray<unknown> | null;
  readonly display_content?: string | null;
  readonly display_reasoning?: string | null;
}

export interface HermesProfileDescription {
  readonly name?: string;
  readonly description?: string;
  readonly soul?: string;
  readonly model?: { readonly provider?: string; readonly default?: string };
  readonly skills?: ReadonlyArray<{ readonly name: string; readonly enabled?: boolean }>;
  readonly toolsets?: ReadonlyArray<{
    readonly name: string;
    readonly enabled?: boolean;
    readonly label?: string;
    readonly description?: string;
  }>;
  readonly mcp_servers?: ReadonlyArray<{ readonly name: string; readonly enabled?: boolean }>;
}

export interface HermesModelOptionsResult {
  readonly providers?: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
    readonly is_current?: boolean;
    readonly is_user_defined?: boolean;
    readonly source?: string;
    readonly models?: ReadonlyArray<string>;
    readonly capabilities?: Readonly<
      Record<
        string,
        {
          readonly reasoning?: boolean;
          readonly can_disable_reasoning?: boolean | null;
        }
      >
    >;
  }>;
}

export interface HermesReasoningConfigResult {
  readonly value?: string | boolean | null;
}

const HERMES_REASONING_LEVELS: ReadonlyArray<PaReasoningLevel> = [
  { id: "none", label: "Off" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
  { id: "ultra", label: "Ultra" },
];

const HERMES_REASONING_EFFORT_SET: ReadonlySet<string> = new Set(
  HERMES_REASONING_LEVELS.map((level) => level.id),
);

export function normalizeHermesReasoningEffort(value: unknown): string | undefined {
  if (value === false) return "none";
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "false" || normalized === "disabled" || normalized === "off") return "none";
  return HERMES_REASONING_EFFORT_SET.has(normalized) ? normalized : undefined;
}

export function normalizeHermesTimestamp(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num < 1e12 ? Math.round(num * 1000) : Math.round(num);
}

export function extractTranscriptText(row: HermesTranscriptRow): string {
  if (typeof row.text === "string" && row.text.length > 0) return row.text;
  if (typeof row.content === "string") return row.content;
  if (Array.isArray(row.content)) {
    return row.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          if (typeof record.text === "string") return record.text;
          if (typeof record.content === "string") return record.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Maps Hermes tool names onto the shared categories clients pick icons and verbs from. */
export function classifyHermesTool(toolName: string): PaToolCategory {
  const lower = toolName.toLowerCase();
  if (lower === "skill_manage" || lower.includes("skill")) return "skill";
  if (lower.includes("memory") || lower === "session_search") return "memory";
  if (lower === "web_search") return "web-search";
  if (lower === "execute_code" || lower.includes("python") || lower.includes("repl")) return "code";
  if (
    lower === "terminal" ||
    lower === "bash" ||
    lower === "shell" ||
    lower === "process" ||
    lower.includes("command") ||
    lower.includes("exec") ||
    lower.includes("shell")
  ) {
    return "terminal";
  }
  if (
    lower === "list_dir" ||
    lower === "ls" ||
    lower === "glob" ||
    lower.startsWith("read_") ||
    lower.startsWith("view_")
  ) {
    return "file-read";
  }
  if (
    lower === "patch" ||
    lower === "apply_patch" ||
    lower.startsWith("write_") ||
    lower.startsWith("edit_")
  ) {
    return "file-edit";
  }
  if (
    lower.includes("web_") ||
    lower.includes("browser") ||
    lower.includes("fetch") ||
    lower.includes("url") ||
    lower.includes("http")
  ) {
    return "web-fetch";
  }
  if (lower.includes("search") || lower.includes("grep") || lower.includes("find")) return "search";
  if (lower.includes("delegate") || lower.includes("subagent") || lower.includes("agent")) {
    return "agent";
  }
  if (lower.includes("todo") || lower.includes("plan")) return "todo";
  if (lower.includes("cron") || lower.includes("schedule")) return "schedule";
  if (lower.includes("code")) return "code";
  if (lower.includes("vision") || lower.includes("image") || lower.includes("screenshot")) {
    return "vision";
  }
  if (
    lower.includes("clarify") ||
    lower.includes("message") ||
    lower.includes("notify") ||
    lower.includes("send_")
  ) {
    return "message";
  }
  return "other";
}

const collapseWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function normalizeTranscriptRows(rows: ReadonlyArray<HermesTranscriptRow>): PaMessage[] {
  const result: PaMessage[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.display_kind === "hidden") continue;
    const rawRole = String(row.role ?? "assistant").toLowerCase();
    const role: PaMessage["role"] =
      rawRole === "user"
        ? "user"
        : rawRole === "system"
          ? "system"
          : rawRole === "tool"
            ? "tool"
            : "assistant";
    // Hermes Desktop hydration order: a projected `display_content` / `display_reasoning` wins,
    // even when empty (the projection stripped commentary that was flattened into it).
    const text =
      role === "assistant" && typeof row.display_content === "string"
        ? row.display_content
        : extractTranscriptText(row);
    const reasoning =
      role === "assistant" && typeof row.display_reasoning === "string"
        ? nonEmptyString(row.display_reasoning)
        : (nonEmptyString(row.reasoning) ?? nonEmptyString(row.reasoning_content));
    const toolContext = nonEmptyString(row.context)?.trim();
    const toolCallId = nonEmptyString(row.tool_call_id);
    const toolName = nonEmptyString(row.name);
    const toolFailed = row.is_error === true || row.display_metadata?.is_error === true;
    const id =
      row.row_id !== null && row.row_id !== undefined ? `row-${row.row_id}` : `idx-${index}`;
    const timestamp = normalizeHermesTimestamp(row.timestamp);

    const commentary =
      role === "assistant" && Array.isArray(row.display_commentary)
        ? row.display_commentary.filter(
            (part): part is string => typeof part === "string" && part.trim().length > 0,
          )
        : [];
    // Some providers also persist the joined commentary as the canonical answer: keep it once, as the answer.
    const commentaryIsReply =
      commentary.length > 0 &&
      text.trim().length > 0 &&
      collapseWhitespace(commentary.join("\n\n")) === collapseWhitespace(text);
    let pendingReasoning = reasoning;
    if (!commentaryIsReply) {
      for (const [partIndex, part] of commentary.entries()) {
        result.push({
          id: `${id}-commentary-${partIndex}`,
          role: "assistant",
          text: part,
          ...(pendingReasoning ? { reasoning: pendingReasoning } : {}),
          timestamp,
          rowKind: "message",
          commentary: true,
        });
        pendingReasoning = undefined;
      }
    }

    if (!text && !pendingReasoning && !toolName && !toolContext && row.row_kind !== "compaction") {
      continue;
    }
    const toolArgs =
      row.args && typeof row.args === "object" && !Array.isArray(row.args) ? row.args : undefined;
    result.push({
      id,
      role,
      text,
      ...(pendingReasoning ? { reasoning: pendingReasoning } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolName ? { toolName, toolCategory: classifyHermesTool(toolName) } : {}),
      ...(toolContext ? { toolContext } : {}),
      ...(toolArgs ? { toolArgs } : {}),
      ...(toolFailed ? { toolFailed } : {}),
      timestamp,
      rowKind: row.row_kind === "compaction" ? "compaction" : "message",
    });
  }
  return result;
}

const withSlash = (name: string) => (name.startsWith("/") ? name : `/${name}`);

/** Commands `slash.exec` refuses because a client owns them; Desktop and the TUI map them too. */
const CLIENT_HANDLED_COMMANDS: ReadonlyMap<
  string,
  { readonly handling: PaSlashCommand["handling"]; readonly description: string }
> = new Map([
  ["/new", { handling: "client:new-session", description: "Start a new session" }],
  ["/reset", { handling: "client:new-session", description: "Start a new session" }],
  ["/clear", { handling: "client:new-session", description: "Start a new session" }],
  ["/stop", { handling: "client:interrupt", description: "Stop the running turn" }],
  ["/model", { handling: "client:model-picker", description: "Switch the model" }],
]);

/**
 * Built-in commands runnable from a web chat session: the `gateway/session_commands.py`
 * allowlist without terminal/TTS-only commands (`/footer`, `/voice`, `/login`) and the
 * CLI/TUI commands `slash.exec` refuses with `unsupported_command`.
 */
const WEB_SUPPORTED_COMMANDS: ReadonlySet<string> = new Set([
  "/help",
  "/commands",
  "/status",
  "/context",
  "/version",
  "/whoami",
  "/usage",
  "/insights",
  "/profile",
  "/diff",
  "/memory",
  "/kanban",
  "/topup",
  "/suggestions",
  "/bundles",
  "/skills",
  "/toolsets",
  "/platforms",
  "/cron",
  "/title",
  "/goal",
  "/subgoal",
  "/loop",
  "/heartbeat",
  "/review",
  "/refine",
  "/debug",
  "/curator",
  "/autoprune",
  "/plan",
  "/learn",
  "/init",
  "/moa",
  "/blueprint",
  "/egress",
  "/reasoning",
  "/approvals",
  "/codex-runtime",
  "/busy",
  "/verbose",
  "/yolo",
  "/fast",
  "/personality",
  "/approve",
  "/deny",
]);

/** Everyday commands, in the order the "common" tab lists them. */
const FEATURED_COMMANDS: ReadonlyArray<string> = [
  "/new",
  "/model",
  "/status",
  "/context",
  "/memory",
  "/skills",
  "/usage",
  "/plan",
  "/review",
  "/cron",
  "/stop",
  "/help",
];
const FEATURED_RANK = new Map(FEATURED_COMMANDS.map((name, index) => [name, index]));

// Built-ins that are read-only or session-local. Hermes never expands profile `quick_commands`
// aliases or execs for a built-in name, so these cannot be shadowed by profile config.
const OPERATE_COMMANDS: ReadonlySet<string> = new Set([
  "help",
  "commands",
  "status",
  "context",
  "ctx",
  "whoami",
  "profile",
  "version",
  "v",
  "insights",
  "diff",
  "egress",
  "agents",
  "tasks",
  "history",
  "sessions",
  "resume",
  "new",
  "reset",
  "clear",
  "title",
  "compress",
  "compact",
  "retry",
  "undo",
  "branch",
  "fork",
  "stop",
  "discard",
  "queue",
  "q",
  "steer",
  "s",
  "btw",
  "bg",
  "plan",
  "review",
  "goal",
  "subgoal",
  "moa",
  "approve",
  "deny",
]);

// Python's `str.strip()` / `str.split(None, 1)` whitespace: ASCII FS..US and NEL on top of `\s`.
const PYTHON_EDGE_WS = /^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/g;
const PYTHON_WS = /[\s\x1c-\x1f\x85]+/;

/** Parses the command name the way Hermes does, so `//config` or `/CONFIG` cannot slip past. */
export function hermesRequiredScope(text: string): PaCommandScope {
  const trimmed = text.replace(PYTHON_EDGE_WS, "");
  if (!trimmed.startsWith("/")) return "operate";
  const stripped = trimmed.replace(/^\/+/, "");
  if (!stripped) return "manage";
  const name = stripped.split(PYTHON_WS, 1)[0]!.toLowerCase();
  return OPERATE_COMMANDS.has(name) ? "operate" : "manage";
}

function isDynamicCategory(category: string): boolean {
  const lower = category.toLowerCase();
  return lower === "skill" || lower.includes("plugin") || lower.includes("quick");
}

/**
 * Hermes `commands.catalog` (`tui_gateway/command_discovery.py`): `categories` lists registry,
 * quick and plugin commands; skills ride only in `pairs` + `skills`; `plugin_commands` also holds
 * plugin commands a display row hides; `commands[name].desktop` is the GUI disposition, where
 * `terminal` and `hidden` mean a GUI cannot run it.
 */
export function normalizeSlashCatalog(raw: Record<string, unknown>): PaSlashCommand[] {
  const seen = new Map<string, PaSlashCommand>();
  const nameToCategory = new Map<string, string>();
  const skillNames = new Set<string>();
  const pluginNames = new Set<string>();
  const recordOf = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const skills = recordOf(raw.skills);
  const plugins = recordOf(raw.plugin_commands);
  for (const key of Object.keys(skills ?? {})) skillNames.add(withSlash(key));
  for (const key of Object.keys(plugins ?? {})) pluginNames.add(withSlash(key));
  const meta = recordOf(raw.commands) ?? {};

  const add = (rawName: string, description: string, category: string) => {
    const name = withSlash(rawName);
    const key = name.toLowerCase();
    if (name === "/" || seen.has(key)) return;
    const group: PaSlashCommand["group"] =
      skillNames.has(name) || category.toLowerCase() === "skill"
        ? "skill"
        : pluginNames.has(name) || category.toLowerCase().includes("plugin")
          ? "plugin"
          : "command";
    const clientHandled = CLIENT_HANDLED_COMMANDS.get(key);
    if (clientHandled) {
      seen.set(key, {
        name,
        description: description || clientHandled.description,
        group: "command",
        handling: clientHandled.handling,
        requiredScope: "operate",
      });
      return;
    }
    if (group === "command" && !isDynamicCategory(category) && !WEB_SUPPORTED_COMMANDS.has(key)) {
      return;
    }
    const desktop = recordOf(meta[name])?.desktop;
    if (desktop === "terminal" || desktop === "hidden") return;
    seen.set(key, {
      name,
      description,
      group,
      handling: "engine",
      requiredScope: hermesRequiredScope(name),
    });
  };

  if (Array.isArray(raw.categories)) {
    for (const cat of raw.categories) {
      const record = recordOf(cat);
      if (!record) continue;
      const categoryName =
        nonEmptyString(record.name) ?? nonEmptyString(record.id) ?? ("command" as const);
      if (Array.isArray(record.pairs)) {
        for (const pair of record.pairs) {
          if (!Array.isArray(pair) || typeof pair[0] !== "string") continue;
          add(pair[0], typeof pair[1] === "string" ? pair[1] : "", categoryName);
        }
      }
      if (Array.isArray(record.commands)) {
        for (const item of record.commands) {
          const key = typeof item === "string" ? item : (item as { name?: string })?.name;
          if (typeof key === "string" && key) nameToCategory.set(withSlash(key), categoryName);
        }
      }
    }
  } else {
    for (const [category, entries] of Object.entries(recordOf(raw.categories) ?? {})) {
      if (!Array.isArray(entries)) continue;
      for (const item of entries) {
        const key = typeof item === "string" ? item : (item as { name?: string })?.name;
        if (typeof key === "string" && key) nameToCategory.set(withSlash(key), category);
      }
    }
  }

  for (const entry of Array.isArray(raw.pairs) ? raw.pairs : []) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    const name = withSlash(entry[0]);
    add(name, typeof entry[1] === "string" ? entry[1] : "", nameToCategory.get(name) ?? "command");
  }
  for (const [pluginName, description] of Object.entries(plugins ?? {})) {
    add(pluginName, typeof description === "string" ? description : "", "plugin");
  }
  for (const [skillName, skillMeta] of Object.entries(skills ?? {})) {
    const description =
      typeof skillMeta === "string"
        ? skillMeta
        : (nonEmptyString(recordOf(skillMeta)?.description) ?? "");
    add(skillName, description, "skill");
  }
  for (const [name, clientHandled] of CLIENT_HANDLED_COMMANDS) {
    if (seen.has(name) || name === "/reset" || name === "/clear") continue;
    seen.set(name, {
      name,
      description: clientHandled.description,
      group: "command",
      handling: clientHandled.handling,
      requiredScope: "operate",
    });
  }

  const commands = Array.from(seen.values()).map((command) =>
    FEATURED_RANK.has(command.name.toLowerCase()) ? { ...command, featured: true } : command,
  );
  const featured = commands
    .filter((command) => command.featured)
    .sort(
      (a, b) => FEATURED_RANK.get(a.name.toLowerCase())! - FEATURED_RANK.get(b.name.toLowerCase())!,
    );
  return [...featured, ...commands.filter((command) => !command.featured)];
}

export function normalizeCronJobs(raw: Record<string, unknown>): PaSchedule[] {
  const jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
  return jobs
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((job, idx) => {
      const optional = (key: string) =>
        typeof job[key] === "string" ? (job[key] as string) : undefined;
      const deliver = optional("deliver");
      const nextRunAt = optional("next_run_at");
      const lastRunAt = optional("last_run_at");
      const lastStatus = optional("last_status");
      return {
        id: String(job.id ?? job.job_id ?? job.name ?? `job-${idx}`),
        name: String(job.name ?? job.id ?? `Job ${idx + 1}`),
        schedule: String(job.schedule ?? job.schedule_display ?? ""),
        prompt: String(job.prompt_preview ?? job.prompt ?? ""),
        enabled: job.enabled !== false && job.paused !== true && job.status !== "paused",
        ...(deliver !== undefined ? { deliver } : {}),
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
        ...(lastRunAt !== undefined ? { lastRunAt } : {}),
        ...(lastStatus !== undefined ? { lastStatus } : {}),
      };
    });
}

/** A prompt this adapter has shown, with the Hermes routing it needs to answer it. */
export interface HermesTrackedRequest {
  readonly request: PaPendingRequest;
  /** `canonical` prompts answer over `*.respond` RPCs; `server_request` ones over the JSON-RPC reply. */
  readonly channel: "canonical" | "server_request";
  readonly executionGeneration?: number | undefined;
  /** Answers another viewer already locked on a resumed batch clarify (`params.answers`). */
  readonly lockedAnswers?: Readonly<Record<string, string>> | undefined;
}

const DENY_DECISIONS: ReadonlySet<string> = new Set(["deny", "reject", "cancel"]);

function buildApprovalOptions(
  params: Record<string, unknown> | undefined,
): NonNullable<PaPendingRequest["options"]> {
  const withIntent = (id: string, label: string) => ({
    id,
    label,
    intent: DENY_DECISIONS.has(id.toLowerCase()) ? ("deny" as const) : ("allow" as const),
  });
  if (Array.isArray(params?.choices) && params.choices.length > 0) {
    return params.choices.flatMap((item) => {
      if (typeof item === "string") return [withIntent(item, item)];
      if (item && typeof item === "object") {
        const rec = item as { id?: unknown; value?: unknown; label?: unknown };
        const id = String(rec.id ?? rec.value ?? "");
        if (!id) return [];
        return [withIntent(id, typeof rec.label === "string" ? rec.label : id)];
      }
      return [];
    });
  }
  const options = [withIntent("once", "Allow once")];
  if (params?.allow_session !== false) options.push(withIntent("session", "Allow this session"));
  if (params?.allow_permanent === true) options.push(withIntent("always", "Always allow"));
  options.push(withIntent("deny", "Deny"));
  return options;
}

function extractLockedAnswers(
  params: Record<string, unknown> | undefined,
): Readonly<Record<string, string>> | undefined {
  const raw = params?.answers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function normalizePendingRequest(
  requestId: string,
  method: string,
  params: Record<string, unknown> | undefined,
  channel: HermesTrackedRequest["channel"],
  executionGeneration?: number,
): HermesTrackedRequest | null {
  if (!requestId) return null;
  const routing = {
    channel,
    executionGeneration,
    ...(channel === "server_request" ? { lockedAnswers: extractLockedAnswers(params) } : {}),
  };
  const scope = channel === "server_request" ? { scope: "session" as const } : {};
  if (method === "approval") {
    const command = nonEmptyString(params?.command);
    return {
      ...routing,
      request: {
        requestId,
        ...scope,
        kind: "approval",
        title: "Approval requested",
        detail:
          nonEmptyString(params?.description) ??
          command ??
          "The agent is asking permission to run a command.",
        ...(command ? { command } : {}),
        options: buildApprovalOptions(params),
      },
    };
  }
  if (method !== "clarify") return null;
  // Server requests carry `questions: [{qid, question, choices, multi_select}]`; canonical
  // `clarify.request` prompts carry one top-level `question`/`choices`/`multi_select`.
  const rawQuestions = Array.isArray(params?.questions)
    ? params.questions
    : typeof params?.question === "string"
      ? [params]
      : [];
  const questions = rawQuestions
    .filter((q): q is Record<string, unknown> => Boolean(q && typeof q === "object"))
    .map((q, idx) => {
      const choices = Array.isArray(q.choices)
        ? q.choices
        : Array.isArray(q.options)
          ? q.options
          : [];
      const options = choices.map((choice) => String(choice));
      return {
        id: String(q.qid ?? q.id ?? `q${idx}`),
        prompt: String(q.question ?? q.prompt ?? ""),
        ...(options.length > 0 ? { options } : {}),
        ...(q.multi_select === true && options.length > 0 ? { multiSelect: true } : {}),
      };
    });
  const detail =
    nonEmptyString(params?.question) ??
    questions[0]?.prompt ??
    "The agent needs your input to continue.";
  return {
    ...routing,
    request: {
      requestId,
      ...scope,
      kind: "clarify",
      title: "Clarification requested",
      detail,
      // A free-form prompt still answers as one question, so every client renders one shape.
      questions: questions.length > 0 ? questions : [{ id: "q0", prompt: detail }],
    },
  };
}

function sessionRowId(row: HermesSessionRow): string {
  return String(row.session_id ?? row.id ?? "");
}

function withoutNullish<T extends object>(row: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== null && value !== undefined),
  ) as Partial<T>;
}

export function mergeSessionRows(
  liveRows: ReadonlyArray<HermesSessionRow>,
  storedRows: ReadonlyArray<HermesSessionRow>,
): PaAdapterSession[] {
  const byId = new Map<string, HermesSessionRow>();
  for (const row of storedRows) {
    const id = sessionRowId(row);
    if (id) byId.set(id, row);
  }
  for (const row of liveRows) {
    const id = sessionRowId(row);
    if (!id) continue;
    const stored = byId.get(id);
    // Live rows win (running state, current model); stored picker fields fill their gaps.
    byId.set(id, stored ? { ...stored, ...withoutNullish(row) } : row);
  }
  return Array.from(byId.entries())
    .map(([sessionId, row]) => ({
      sessionId,
      title: row.title?.trim() || "Untitled conversation",
      source: row.source ?? "local",
      model: row.model ?? null,
      messageCount: row.message_count ?? 0,
      running: row.running === true,
      startedAt: normalizeHermesTimestamp(row.started_at),
      lastActivityAt: normalizeHermesTimestamp(
        row.last_active_at ?? row.last_active ?? row.updated_at ?? row.started_at,
      ),
    }))
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
}

export function normalizeProfileRow(row: HermesProfileRow): PaAgentRow {
  const isDefault = row.is_default === true || row.name === "default";
  return {
    agentRef: row.name,
    name: nonEmptyString(row.display_name)?.trim() ?? (isDefault ? null : row.name),
    description: row.description ?? "",
    isDefault,
    model: nonEmptyString(row.model) ?? null,
    provider: nonEmptyString(row.provider) ?? null,
    running: row.running === true || row.last_session?.running === true,
    lastActivityAt: normalizeHermesTimestamp(
      row.last_session?.last_active ??
        row.canonical_session?.last_active ??
        row.last_session?.started_at,
    ),
    lastMessagePreview:
      nonEmptyString(row.last_session?.preview)?.trim() ??
      nonEmptyString(row.last_session?.title)?.trim() ??
      nonEmptyString(row.canonical_session?.preview)?.trim() ??
      nonEmptyString(row.canonical_session?.title)?.trim() ??
      nonEmptyString(row.description)?.trim() ??
      null,
  };
}

/** `hermes` and `virtual` providers are ones Hermes found on the host rather than ones configured. */
const isAutoDetectedSource = (source: string | undefined) =>
  source === "hermes" || source === "virtual";

export function normalizeModelCatalog(
  options: HermesModelOptionsResult,
  description: HermesProfileDescription,
  reasoning?: HermesReasoningConfigResult,
): PaModelCatalog {
  const rows = options.providers ?? [];
  const isPrimary = (row: (typeof rows)[number]) =>
    row.is_current === true || row.is_user_defined === true || !isAutoDetectedSource(row.source);
  // With nothing configured, everything Hermes detected is all there is to pick from.
  const anyPrimary = rows.some(isPrimary);
  const providers = rows.map((row): PaModelProvider & { readonly rank: number } => {
    const tier = !anyPrimary || isPrimary(row) ? "primary" : "detected";
    const badge =
      row.is_current === true
        ? "current"
        : row.is_user_defined === true
          ? "custom"
          : isAutoDetectedSource(row.source)
            ? "detected"
            : undefined;
    const capabilities = row.capabilities;
    return {
      id: row.slug,
      label: row.name,
      tier,
      ...(badge ? { badge } : {}),
      isCurrent: row.is_current === true,
      models: (row.models ?? []).map((id): PaModelOption => {
        const cap = capabilities?.[id];
        return {
          id,
          ...(typeof cap?.reasoning === "boolean" ? { reasoning: cap.reasoning } : {}),
          ...(typeof cap?.can_disable_reasoning === "boolean"
            ? { canDisableReasoning: cap.can_disable_reasoning }
            : {}),
        };
      }),
      rank: row.is_current ? 0 : row.is_user_defined ? 1 : tier === "primary" ? 2 : 3,
    };
  });
  const currentProvider =
    nonEmptyString(description.model?.provider) ?? rows.find((row) => row.is_current)?.slug ?? null;
  const currentModel = nonEmptyString(description.model?.default);
  const reasoningEffort = reasoning ? normalizeHermesReasoningEffort(reasoning.value) : undefined;
  return {
    scope: "agent",
    allowCustom: true,
    current: currentModel
      ? {
          provider: currentProvider,
          model: currentModel,
          ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        }
      : null,
    providers: providers
      .sort((a, b) => a.rank - b.rank)
      .map(({ rank: _rank, ...provider }) => provider),
    reasoningLevels: HERMES_REASONING_LEVELS,
  };
}

export const HERMES_SECTION = {
  profile: "profile",
  persona: "persona",
  skills: "skills",
  toolsets: "toolsets",
  mcpServers: "mcpServers",
} as const;

export function normalizeProfileConfig(
  description: HermesProfileDescription,
  skillCategories: Readonly<Record<string, ReadonlyArray<string>>>,
): PaBotConfig {
  const categoryBySkill = new Map<string, string>();
  for (const [category, names] of Object.entries(skillCategories)) {
    if (!Array.isArray(names)) continue;
    for (const name of names) categoryBySkill.set(name, category);
  }
  const describedSkills = description.skills ?? [];
  const skillItems =
    describedSkills.length > 0
      ? describedSkills.map((item) => ({ name: item.name, enabled: item.enabled !== false }))
      : Array.from(categoryBySkill.keys(), (name) => ({ name, enabled: true }));
  const sections: PaConfigSection[] = [
    {
      kind: "options",
      id: HERMES_SECTION.profile,
      label: "Profile",
      fields: [
        {
          kind: "text",
          id: "description",
          label: "Description",
          value: description.description ?? "",
        },
      ],
    },
    {
      kind: "document",
      id: HERMES_SECTION.persona,
      label: "Persona",
      description: "SOUL.md",
      text: description.soul ?? "",
    },
  ];
  if (skillItems.length > 0) {
    sections.push({
      kind: "toggleList",
      id: HERMES_SECTION.skills,
      label: "Skills",
      items: skillItems.map((item) => {
        const group = categoryBySkill.get(item.name);
        return {
          id: item.name,
          label: item.name,
          ...(group ? { group } : {}),
          enabled: item.enabled,
        };
      }),
    });
  }
  const toolsets = description.toolsets ?? [];
  if (toolsets.length > 0) {
    sections.push({
      kind: "toggleList",
      id: HERMES_SECTION.toolsets,
      label: "Toolsets",
      // Hermes reads an empty pin as "clear the pin", silently re-enabling every default toolset.
      minEnabled: 1,
      items: toolsets.map((toolset) => ({
        id: toolset.name,
        label: toolset.label || toolset.name,
        ...(toolset.description ? { description: toolset.description } : {}),
        enabled: toolset.enabled !== false,
      })),
    });
  }
  const mcpServers = description.mcp_servers ?? [];
  if (mcpServers.length > 0) {
    sections.push({
      kind: "toggleList",
      id: HERMES_SECTION.mcpServers,
      label: "MCP servers",
      items: mcpServers.map((server) => ({
        id: server.name,
        label: server.name,
        enabled: server.enabled !== false,
      })),
    });
  }
  return { sections };
}
