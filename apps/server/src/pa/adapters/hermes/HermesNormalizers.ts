// @effect-diagnostics nodeBuiltinImport:off -- opaque reference keys never retain transcript paths.
import * as NodeCrypto from "node:crypto";
import type {
  PaAttachment,
  PaBotConfig,
  PaConfigSection,
  PaContextUsage,
  PaMessage,
  PaModelCatalog,
  PaModelOption,
  PaModelProvider,
  PaPendingRequest,
  PaQueuedItem,
  PaReasoningLevel,
  PaSchedule,
  PaSlashCommand,
  PaTodoItem,
  PaTodoState,
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
  readonly submission_id?: string;
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
  /** `session.transcript` compaction rows: how many messages the handoff summarized. */
  readonly compacted_messages?: number | null;
  /** `session.transcript`: a row too large for a page keeps only the head of its text. */
  readonly truncated?: boolean | null;
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
          readonly label?: string | null;
          readonly reasoning_levels?: ReadonlyArray<string> | null;
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

/** Only levels `select` can write back survive, kept in Hermes' ascending order. */
function normalizeModelReasoningLevels(
  raw: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<PaReasoningLevel> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = new Set(raw.map(normalizeHermesReasoningEffort));
  return HERMES_REASONING_LEVELS.filter((level) => ids.has(level.id));
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

function refName(ref: string) {
  return ref.split(/[\\/]/).at(-1)?.trim().slice(0, 255).trimEnd() || "attachment";
}

// Ingress moves an image into a digest directory but preserves its random staging basename.
export function hermesAttachmentKey(type: PaAttachment["type"], ref: string) {
  const value = type === "image" ? refName(ref) : ref;
  return (
    "external-" +
    NodeCrypto.createHash("sha256")
      .update(type + "\0" + value)
      .digest("hex")
  );
}

const mediaReference =
  /^[ \t]*(?:@(image|file):(?:`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|([^\s]+))|\[Image attached at: ([^\n\]]+)\]|\[(?:image|screenshot)\])[ \t]*$/gim;

function transcriptMedia(text: string, rowId: string, content?: unknown) {
  const attachments: PaAttachment[] = [];
  const named = new Set<string>();
  let placeholders = 0;
  const withoutVisionNotes = text
    .replace(/(?:@image:)?data:image\/[\w.+-]+;base64,[a-z0-9+/=]+/gi, "[image]")
    .replace(
      /\[The user (?:sent|attached) an image[\s\S]*?image_url: ([^\n]+?)(?: ~)?\](?=\s|$)/g,
      (_note, ref: string) => "[Image attached at: " + ref + "]",
    );
  let projected = withoutVisionNotes;
  if (/^@file:/im.test(projected)) {
    const boundary = projected.search(/\n\n--- (?:Attached Context|Context Warnings) ---\n/);
    if (boundary !== -1) {
      // Native-image routing appends its image hints after expanding the file references.
      const hints =
        projected
          .slice(boundary)
          .match(
            /(?:\n(?:\[Image attached at: [^\n\]]+\]|@image:[^\n]+))+(?:\n\[(?:image|screenshot)\])*\s*$/i,
          )?.[0] ?? "";
      projected = projected.slice(0, boundary) + hints;
    }
  }
  const clean = projected.replace(
    mediaReference,
    (
      _match,
      kind: string | undefined,
      backtick: string | undefined,
      double: string | undefined,
      single: string | undefined,
      bare: string | undefined,
      hint: string | undefined,
    ) => {
      const ref = backtick ?? double ?? single ?? bare ?? hint;
      if (!ref) {
        placeholders++;
        return "";
      }
      const type = kind?.toLowerCase() === "file" ? "file" : "image";
      const id = hermesAttachmentKey(type, ref);
      if (!named.has(id)) {
        named.add(id);
        attachments.push({
          id,
          type,
          name: refName(ref),
          mimeType: type === "image" ? "image/*" : "application/octet-stream",
          sizeBytes: 0,
          unavailable: true,
        });
      }
      return "";
    },
  );
  const blocks = Array.isArray(content) ? content : [content];
  const images = blocks.filter(
    (part) =>
      part && typeof part === "object" && ["image", "image_url", "input_image"].includes(part.type),
  ).length;
  const namedImages = attachments.filter((item) => item.type === "image").length;
  for (let i = namedImages; i < Math.max(placeholders, images); i++) {
    attachments.push({
      id: rowId + "-image-" + i,
      type: "image",
      name: "Image",
      mimeType: "image/*",
      sizeBytes: 0,
      unavailable: true,
    });
  }
  return { text: attachments.length ? clean.trim() : text, attachments };
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

/** FNV-1a: a short, stable digest for a row Hermes gave no `row_id`. */
function contentDigest(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * A timestamp can repeat across pages. Scope anonymous rows to the page that supplied them.
 */
function transcriptRowId(
  row: HermesTranscriptRow,
  role: string,
  text: string,
  seen: Map<string, number>,
  cursor: string,
  submissionId: string | undefined,
): string {
  if (typeof row.row_id === "number" && Number.isFinite(row.row_id)) return `row-${row.row_id}`;
  const base = `h-${contentDigest(
    JSON.stringify([
      role,
      submissionId ?? cursor,
      row.timestamp ?? null,
      row.tool_call_id ?? null,
      row.name ?? null,
      text,
    ]),
  )}`;
  const occurrence = seen.get(base) ?? 0;
  seen.set(base, occurrence + 1);
  return occurrence === 0 ? base : `${base}-${occurrence}`;
}

export function normalizeTranscriptRows(
  rows: ReadonlyArray<HermesTranscriptRow>,
  cursor = "",
): PaMessage[] {
  const result: PaMessage[] = [];
  const seenDigests = new Map<string, number>();
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
    const submissionId =
      nonEmptyString(row.submission_id) ?? nonEmptyString(row.display_metadata?.submission_id);
    const id = transcriptRowId(row, rawRole, text, seenDigests, cursor, submissionId);
    const media = role === "user" ? transcriptMedia(text, id, row.content) : undefined;
    const timestamp = normalizeHermesTimestamp(row.timestamp);
    const rowId =
      typeof row.row_id === "number" && Number.isFinite(row.row_id) ? row.row_id : undefined;
    const isCompaction = row.row_kind === "compaction";
    const compactedMessages =
      isCompaction && typeof row.compacted_messages === "number" && row.compacted_messages > 0
        ? row.compacted_messages
        : undefined;

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
          ...(rowId !== undefined ? { rowId } : {}),
        });
        pendingReasoning = undefined;
      }
    }

    if (
      !text &&
      !media?.attachments.length &&
      !(role === "user" && submissionId) &&
      !pendingReasoning &&
      !toolName &&
      !toolContext &&
      !isCompaction
    ) {
      continue;
    }
    const toolArgs =
      row.args && typeof row.args === "object" && !Array.isArray(row.args) ? row.args : undefined;
    result.push({
      id,
      role,
      text: media?.text ?? text,
      ...(role === "user" && submissionId ? { submissionId } : {}),
      ...(media?.attachments.length ? { attachments: media.attachments } : {}),
      ...(pendingReasoning ? { reasoning: pendingReasoning } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolName ? { toolName, toolCategory: classifyHermesTool(toolName) } : {}),
      ...(toolContext ? { toolContext } : {}),
      ...(toolArgs ? { toolArgs } : {}),
      ...(toolFailed ? { toolFailed } : {}),
      timestamp,
      rowKind: isCompaction ? "compaction" : "message",
      ...(rowId !== undefined ? { rowId } : {}),
      ...(row.truncated === true ? { truncated: true } : {}),
      ...(compactedMessages !== undefined ? { compactedMessages } : {}),
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
  /** The Hermes request method (`sudo`, `vault.save_login`, ...), which decides the answer's shape. */
  readonly method: string;
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
    method,
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
  const secret = channel === "server_request" ? secretPrompt(method, params) : null;
  if (secret) {
    return { ...routing, request: { requestId, ...scope, kind: "secret", ...secret } };
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

/** The field a one-value credential prompt answers with; `vault.save_login` has two. */
export const HERMES_SECRET_FIELD = {
  password: "password",
  value: "value",
  code: "code",
  identifier: "identifier",
} as const;

type SecretPromptShape = Pick<
  PaPendingRequest,
  "title" | "detail" | "command" | "fields" | "sideEffectNotice"
>;

/**
 * Hermes's masked one-string prompts (`tui_gateway/contracts/server_requests.py`), answered
 * `{value}` where `""` declines. Other server requests (`theme.*`, `preview.*`, `window.read`,
 * `tour`, `setup_beat`, ...) belong to Hermes Desktop: they stay unanswered here, because the
 * first viewer to answer settles them for every viewer.
 */
function secretPrompt(
  method: string,
  params: Record<string, unknown> | undefined,
): SecretPromptShape | null {
  switch (method) {
    case "sudo": {
      const command = nonEmptyString(params?.command);
      return {
        title: "Administrator password needed",
        detail: "The agent needs your sudo password to run this command.",
        ...(command ? { command } : {}),
        fields: [
          {
            id: HERMES_SECRET_FIELD.password,
            label: "Sudo password",
            secret: true,
            required: true,
          },
        ],
      };
    }
    case "secret": {
      const envVar = nonEmptyString(params?.env_var)?.trim();
      return {
        title: envVar ? `${envVar} needed` : "Secret needed",
        detail:
          nonEmptyString(params?.prompt) ?? "The agent needs a secret value to finish setting up.",
        fields: [
          {
            id: HERMES_SECRET_FIELD.value,
            label: envVar ?? "Secret",
            secret: true,
            required: true,
          },
        ],
        sideEffectNotice: envVar
          ? `Saved as ${envVar} in this agent's environment file (.env). The model never sees it.`
          : "Saved in this agent's environment file (.env). The model never sees it.",
      };
    }
    case "vault.unlock_prompt": {
      const name =
        nonEmptyString(params?.display_name)?.trim() ?? nonEmptyString(params?.backend)?.trim();
      return {
        title: name ? `Unlock ${name}` : "Unlock password manager",
        detail:
          "The agent needs your master password to use this password manager in this session.",
        fields: [
          {
            id: HERMES_SECRET_FIELD.password,
            label: "Master password",
            secret: true,
            required: true,
          },
        ],
        sideEffectNotice: "It stays unlocked until this session closes.",
      };
    }
    case "vault.code": {
      const site = nonEmptyString(params?.site)?.trim();
      const hint = nonEmptyString(params?.hint)?.trim();
      return {
        title: site ? `Verification code for ${site}` : "Verification code needed",
        detail: hint ?? "Enter the one-time code sent to your device.",
        fields: [
          {
            id: HERMES_SECRET_FIELD.code,
            label: "Code",
            required: true,
          },
        ],
      };
    }
    case "vault.save_login": {
      const site =
        nonEmptyString(params?.site)?.trim() ?? nonEmptyString(params?.origin)?.trim() ?? null;
      const origin = nonEmptyString(params?.origin)?.trim();
      return {
        title: site ? `Save a login for ${site}` : "Save a login",
        detail:
          origin && origin !== site
            ? `The agent is about to sign in to ${origin}.`
            : "The agent is about to sign in to this site.",
        fields: [
          {
            id: HERMES_SECRET_FIELD.identifier,
            label: "Username or email",
            required: true,
          },
          {
            id: HERMES_SECRET_FIELD.password,
            label: "Password",
            secret: true,
            required: true,
          },
        ],
        sideEffectNotice: "Saved to your password manager.",
      };
    }
    default:
      return null;
  }
}

function sessionRowId(row: HermesSessionRow): string {
  return String(row.session_id ?? row.id ?? "");
}

function withoutNullish<T extends object>(row: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== null && value !== undefined),
  ) as Partial<T>;
}

/** `session.list` filters only stored rows by `query`; live rows get the same title-or-id test. */
export function sessionRowMatches(row: HermesSessionRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [sessionRowId(row), row.title ?? ""].some((field) => field.toLowerCase().includes(needle));
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
        const label = nonEmptyString(cap?.label);
        const reasoningLevels = normalizeModelReasoningLevels(cap?.reasoning_levels);
        return {
          id,
          ...(label ? { label } : {}),
          ...(typeof cap?.reasoning === "boolean" ? { reasoning: cap.reasoning } : {}),
          ...(typeof cap?.can_disable_reasoning === "boolean"
            ? { canDisableReasoning: cap.can_disable_reasoning }
            : {}),
          ...(reasoningLevels ? { reasoningLevels } : {}),
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

/** `session_contract.py::PendingAdmission`, as `session.resume.pending` and `session.info.pending` list it. */
export interface HermesPendingAdmission {
  readonly admission_id?: string;
  readonly input_id?: string;
  readonly status?: string;
  readonly execution_generation?: number | null;
  readonly text?: string;
  readonly controls?: ReadonlyArray<string> | null;
  /** Handed to the running turn (`prompt.steer_queued`): listed `started` until that turn settles it. */
  readonly steering?: boolean | null;
}

/**
 * The messages still waiting, oldest first. The `started` row is the running turn itself and is
 * not listed; `steering` and `unknown` rows stay so a viewer never loses one that may come back.
 */
export function normalizeHermesQueue(pending: unknown): PaQueuedItem[] {
  if (!Array.isArray(pending)) return [];
  const items: PaQueuedItem[] = [];
  for (const raw of pending as ReadonlyArray<HermesPendingAdmission>) {
    if (!raw || typeof raw !== "object") continue;
    const id = nonEmptyString(raw.admission_id);
    if (!id) continue;
    const inputId = nonEmptyString(raw.input_id);
    const identity = inputId ? { id, inputId } : { id };
    const media = transcriptMedia(typeof raw.text === "string" ? raw.text : "", id);
    const text = media.text;
    const count = media.attachments.length;
    const controls = Array.isArray(raw.controls) ? raw.controls : [];
    if (raw.steering === true) {
      items.push({
        ...identity,
        text,
        status: "steering",
        canSteer: false,
        ...(count ? { attachmentCount: count } : {}),
      });
    } else if (raw.status === "queued") {
      items.push({
        ...identity,
        text,
        status: "queued",
        canSteer: count === 0 && controls.includes("steer"),
        ...(count ? { attachmentCount: count } : {}),
        ...(controls.includes("replace") ? { canReplace: true } : {}),
      });
    } else if (raw.status === "unknown") {
      items.push({
        ...identity,
        text,
        status: "unknown",
        canSteer: false,
        ...(count ? { attachmentCount: count } : {}),
      });
    }
  }
  return items;
}

/** The admission the running turn executes, from the same pending list. */
export function hermesRunningAdmissionId(pending: unknown): string | null {
  if (!Array.isArray(pending)) return null;
  for (const raw of pending as ReadonlyArray<HermesPendingAdmission>) {
    if (raw && raw.status === "started" && raw.steering !== true) {
      return nonEmptyString(raw.admission_id) ?? null;
    }
  }
  return null;
}

const finiteCount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * Hermes reports usage two ways: `common.py::Usage` (`context_used`/`context_max`, the status
 * bar) nested as `usage` or bare, and `session.usage`'s flat counters (`context_tokens`/
 * `context_length`). Occupancy comes only from the context figures: `total`/`total_tokens` are
 * the session's cumulative spend, which a window percentage must never be computed from.
 */
export function normalizeHermesUsage(raw: unknown): PaContextUsage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)) {
    const nested = normalizeHermesUsage(record.usage);
    if (nested !== null) return nested;
  }
  const tuiShape =
    "context_used" in record || "context_max" in record || "input" in record || "total" in record;
  const used = finiteCount(tuiShape ? record.context_used : record.context_tokens);
  const maxRaw = finiteCount(tuiShape ? record.context_max : record.context_length);
  const max = maxRaw !== undefined && maxRaw > 0 ? maxRaw : null;
  const inputTokens = finiteCount(tuiShape ? record.input : record.input_tokens);
  const outputTokens = finiteCount(tuiShape ? record.output : record.output_tokens);
  const totalTokens = finiteCount(tuiShape ? record.total : record.total_tokens);
  const cacheReadTokens = finiteCount(tuiShape ? record.cache_read : record.cache_read_tokens);
  const compressionCount = finiteCount(tuiShape ? record.compressions : record.compression_count);
  if (used === undefined && inputTokens === undefined && totalTokens === undefined) return null;
  const contextUsed = used ?? 0;
  const reported = finiteCount(record.context_percent);
  const contextPercent =
    max === null
      ? null
      : reported !== undefined && tuiShape
        ? Math.min(100, reported)
        : Math.max(0, Math.min(100, Math.round((contextUsed / max) * 100)));
  return {
    contextUsed,
    contextMax: max,
    contextPercent,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(compressionCount !== undefined ? { compressionCount } : {}),
  };
}

const TODO_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

/**
 * `tool_progress._normalize_todo_state`: `{todos: [{id, content, status, parent?}], revision}`.
 * Revision 0 with no items is Hermes's "no plan yet" and reads as none; an empty list at a later
 * revision is a real clear.
 */
export function normalizeHermesTodoState(raw: unknown): PaTodoState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.todos)) return null;
  const revisionRaw = Number(record.revision ?? 0);
  const revision = Number.isFinite(revisionRaw) ? Math.max(0, Math.trunc(revisionRaw)) : 0;
  const items: PaTodoItem[] = [];
  for (const [index, entry] of record.todos.entries()) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const text =
      nonEmptyString(item.content) ?? nonEmptyString(item.text) ?? nonEmptyString(item.title);
    if (!text) continue;
    const status = String(item.status ?? "pending")
      .trim()
      .toLowerCase();
    items.push({
      id: nonEmptyString(typeof item.id === "number" ? String(item.id) : item.id) ?? `#${index}`,
      text,
      status: (TODO_STATUSES.has(status) ? status : "pending") as PaTodoItem["status"],
    });
  }
  if (items.length === 0 && revision === 0) return null;
  return { revision, items };
}
