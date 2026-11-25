// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";

import {
  HermesConnectionPool,
  type HermesRpcConnection,
  type HermesRpcEventFrame,
  type HermesServerRequestFrame,
} from "./HermesGatewayClient.ts";
import { defaultVisualForBot, type PaStore } from "./PaStore.ts";
import {
  isValidPaProfile,
  isValidPaSessionId,
  makePaBotId,
  type PaAdapter,
  type PaAdapterCapabilities,
  type PaAdapterStatus,
  type PaBotDetail,
  type PaBotSummary,
  type PaCreateBotInput,
  type PaCronJob,
  type PaCronMutationInput,
  type PaMessage,
  type PaModelProviderOption,
  type PaPendingRequest,
  type PaRespondRequestInput,
  type PaSendResult,
  type PaSessionSummary,
  type PaSkillEntry,
  type PaSlashCommand,
  type PaStreamEvent,
  type PaUpdateBotInput,
} from "./types.ts";

function nowMs(): number {
  // @effect-diagnostics globalDate:off
  return Date.now();
}

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

interface HermesProfileRow {
  readonly name: string;
  readonly is_default?: boolean;
  readonly model?: string | null;
  readonly provider?: string | null;
  readonly description?: string;
  readonly display_name?: string;
  readonly skill_count?: number;
  readonly last_session?: {
    readonly id?: string;
    readonly title?: string;
    readonly preview?: string;
    readonly started_at?: number | null;
    readonly last_active?: number | null;
    readonly message_count?: number;
  } | null;
  readonly canonical_session?: {
    readonly id?: string;
    readonly title?: string;
    readonly preview?: string;
    readonly last_active?: number | null;
  } | null;
}

interface HermesSessionRow {
  readonly session_id?: string;
  readonly id?: string;
  readonly title?: string | null;
  readonly preview?: string | null;
  readonly source?: string | null;
  readonly model?: string | null;
  readonly message_count?: number | null;
  readonly running?: boolean | null;
  readonly started_at?: number | null;
  readonly last_active?: number | null;
}

interface HermesTranscriptRow {
  readonly role?: string;
  readonly text?: string | null;
  readonly content?: unknown;
  readonly timestamp?: number | null;
  readonly row_id?: number | null;
  readonly name?: string | null;
  readonly args?: Record<string, unknown> | null;
  readonly reasoning?: string | null;
  readonly reasoning_content?: string | null;
  readonly row_kind?: string | null;
}

interface TrackedSessionState {
  executionGeneration: number;
  replayEpoch: string | null;
  subscriptionId: string | null;
  subscribers: number;
  readonly requests: Map<
    string,
    {
      readonly channel: "canonical" | "server_request";
      readonly kind: "approval" | "clarify";
      readonly executionGeneration?: number | undefined;
    }
  >;
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

export function normalizeTranscriptRows(rows: ReadonlyArray<HermesTranscriptRow>): PaMessage[] {
  const result: PaMessage[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const rawRole = String(row.role ?? "assistant").toLowerCase();
    const role: PaMessage["role"] =
      rawRole === "user"
        ? "user"
        : rawRole === "system"
          ? "system"
          : rawRole === "tool"
            ? "tool"
            : "assistant";
    const text = extractTranscriptText(row);
    const reasoning =
      typeof row.reasoning === "string" && row.reasoning.trim().length > 0
        ? row.reasoning
        : typeof row.reasoning_content === "string" && row.reasoning_content.trim().length > 0
          ? row.reasoning_content
          : undefined;
    if (!text && !reasoning && !row.name && row.row_kind !== "compaction") continue;
    result.push({
      id: row.row_id !== null && row.row_id !== undefined ? `row-${row.row_id}` : `idx-${index}`,
      role,
      text,
      reasoning,
      toolName: typeof row.name === "string" && row.name ? row.name : undefined,
      toolArgs: row.args && typeof row.args === "object" ? row.args : undefined,
      timestamp: normalizeHermesTimestamp(row.timestamp),
      rowKind: row.row_kind === "compaction" ? "compaction" : "message",
    });
  }
  return result;
}

export function normalizeSlashCatalog(raw: Record<string, unknown>): PaSlashCommand[] {
  const seen = new Map<string, PaSlashCommand>();
  const nameToCategory = new Map<string, string>();

  // Hermes `commands.catalog.categories` is an array of `{ name, pairs: [cmd, desc][] }`
  // (also support `{ id | name, commands: string[] }` shapes defensively).
  if (Array.isArray(raw.categories)) {
    for (const cat of raw.categories) {
      if (!cat || typeof cat !== "object") continue;
      const record = cat as { name?: unknown; id?: unknown; pairs?: unknown; commands?: unknown };
      const categoryName =
        typeof record.name === "string" && record.name
          ? record.name
          : typeof record.id === "string" && record.id
            ? record.id
            : "command";
      if (Array.isArray(record.pairs)) {
        for (const pair of record.pairs) {
          if (!Array.isArray(pair) || typeof pair[0] !== "string") continue;
          const cmd = pair[0].startsWith("/") ? pair[0] : `/${pair[0]}`;
          nameToCategory.set(cmd, categoryName);
          if (!seen.has(cmd)) {
            seen.set(cmd, {
              name: cmd,
              description: typeof pair[1] === "string" ? pair[1] : "",
              category: categoryName,
            });
          }
        }
      }
      if (Array.isArray(record.commands)) {
        for (const item of record.commands) {
          const key = typeof item === "string" ? item : (item as { name?: string })?.name;
          if (typeof key === "string" && key) {
            nameToCategory.set(key.startsWith("/") ? key : `/${key}`, categoryName);
          }
        }
      }
    }
  } else if (raw.categories && typeof raw.categories === "object") {
    for (const [category, entries] of Object.entries(raw.categories as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      for (const item of entries) {
        const key = typeof item === "string" ? item : (item as { name?: string })?.name;
        if (typeof key === "string" && key) {
          nameToCategory.set(key.startsWith("/") ? key : `/${key}`, category);
        }
      }
    }
  }

  const pairs = Array.isArray(raw.pairs) ? raw.pairs : [];
  for (const entry of pairs) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    const name = entry[0].startsWith("/") ? entry[0] : `/${entry[0]}`;
    const description = typeof entry[1] === "string" ? entry[1] : "";
    if (!seen.has(name)) {
      seen.set(name, {
        name,
        description,
        category: nameToCategory.get(name) ?? "command",
      });
    }
  }

  if (raw.skills && typeof raw.skills === "object" && !Array.isArray(raw.skills)) {
    for (const [skillName, meta] of Object.entries(raw.skills as Record<string, unknown>)) {
      const cmd = skillName.startsWith("/") ? skillName : `/${skillName}`;
      if (seen.has(cmd)) continue;
      const desc =
        typeof meta === "string"
          ? meta
          : meta &&
              typeof meta === "object" &&
              typeof (meta as { description?: unknown }).description === "string"
            ? (meta as { description: string }).description
            : "Hermes skill";
      seen.set(cmd, { name: cmd, description: desc, category: "skill" });
    }
  }

  return Array.from(seen.values());
}

function normalizeCronJobs(raw: Record<string, unknown>): PaCronJob[] {
  const jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
  return jobs
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((job, idx) => ({
      id: String(job.id ?? job.job_id ?? job.name ?? `job-${idx}`),
      name: String(job.name ?? job.id ?? `Job ${idx + 1}`),
      schedule: String(job.schedule ?? job.schedule_display ?? ""),
      prompt: String(job.prompt ?? ""),
      enabled: job.enabled !== false && job.paused !== true && job.status !== "paused",
      deliver: typeof job.deliver === "string" ? job.deliver : undefined,
      nextRunAt: typeof job.next_run_at === "string" ? job.next_run_at : undefined,
      lastRunAt: typeof job.last_run_at === "string" ? job.last_run_at : undefined,
      lastStatus: typeof job.last_status === "string" ? job.last_status : undefined,
    }));
}

function buildApprovalOptions(
  params: Record<string, unknown> | undefined,
): ReadonlyArray<{ readonly id: string; readonly label: string }> {
  if (Array.isArray(params?.choices) && params.choices.length > 0) {
    return params.choices
      .map((item) => {
        if (typeof item === "string") {
          return { id: item, label: item };
        }
        if (item && typeof item === "object") {
          const rec = item as { id?: unknown; value?: unknown; label?: unknown };
          const id = String(rec.id ?? rec.value ?? "");
          if (!id) return null;
          return { id, label: typeof rec.label === "string" ? rec.label : id };
        }
        return null;
      })
      .filter((x): x is { readonly id: string; readonly label: string } => x !== null);
  }
  const options: Array<{ readonly id: string; readonly label: string }> = [
    { id: "once", label: "Allow once" },
  ];
  if (params?.allow_session !== false) {
    options.push({ id: "session", label: "Allow session" });
  }
  if (params?.allow_permanent === true) {
    options.push({ id: "always", label: "Allow always" });
  }
  options.push({ id: "deny", label: "Deny" });
  return options;
}

function normalizePendingRequest(
  requestId: string,
  method: string,
  params: Record<string, unknown> | undefined,
  channel: "canonical" | "server_request",
  executionGeneration?: number,
): PaPendingRequest | null {
  if (!requestId) return null;
  if (method === "approval") {
    const command = typeof params?.command === "string" ? params.command : undefined;
    const description =
      typeof params?.description === "string"
        ? params.description
        : (command ?? "Hermes is asking permission to run a command.");
    return {
      requestId,
      kind: "approval",
      channel,
      executionGeneration,
      title: "Approval requested",
      detail: description,
      command,
      options: buildApprovalOptions(params),
    };
  }
  if (method === "clarify") {
    const rawQuestions = Array.isArray(params?.questions) ? params.questions : [];
    const questions = rawQuestions
      .filter((q): q is Record<string, unknown> => Boolean(q && typeof q === "object"))
      .map((q, idx) => ({
        id: String(q.qid ?? q.id ?? `q-${idx}`),
        prompt: String(q.question ?? q.prompt ?? ""),
        options: Array.isArray(q.choices)
          ? q.choices.map((c) => String(c))
          : Array.isArray(q.options)
            ? q.options.map((c) => String(c))
            : undefined,
      }));
    return {
      requestId,
      kind: "clarify",
      channel,
      executionGeneration,
      title: "Clarification requested",
      detail:
        typeof params?.question === "string"
          ? params.question
          : (questions[0]?.prompt ?? "Hermes needs your input to continue."),
      questions: questions.length > 0 ? questions : undefined,
    };
  }
  return null;
}

const HERMES_CAPABILITIES: PaAdapterCapabilities = {
  create: true,
  cron: true,
  slash: true,
  skills: true,
  toolsets: true,
};

export class HermesPaAdapter implements PaAdapter {
  readonly kind = "hermes" as const;
  readonly label = "Hermes";
  readonly capabilities = HERMES_CAPABILITIES;

  private readonly pool: HermesConnectionPool;
  private readonly store: PaStore;
  private readonly sessionStates = new Map<string, TrackedSessionState>();
  private versionCache: string | null = null;

  constructor(store: PaStore, pool = new HermesConnectionPool()) {
    this.store = store;
    this.pool = pool;
  }

  dispose(): void {
    this.sessionStates.clear();
    this.pool.closeAll();
  }

  private sessionKey(profile: string, sessionId: string): string {
    return `${profile}::${sessionId}`;
  }

  private getOrCreateSessionState(profile: string, sessionId: string): TrackedSessionState {
    const key = this.sessionKey(profile, sessionId);
    let state = this.sessionStates.get(key);
    if (!state) {
      state = {
        executionGeneration: 0,
        replayEpoch: null,
        subscriptionId: null,
        subscribers: 0,
        requests: new Map(),
      };
      this.sessionStates.set(key, state);
    }
    return state;
  }

  private async getVersion(): Promise<string | null> {
    if (this.versionCache !== null) return this.versionCache;
    try {
      const { stdout } = await execFileAsync("hermes", ["--version"], { timeout: 4_000 });
      const firstLine = stdout.trim().split("\n")[0]?.trim() ?? null;
      this.versionCache = firstLine;
      return firstLine;
    } catch {
      return null;
    }
  }

  async getStatus(): Promise<PaAdapterStatus> {
    try {
      const [conn, version] = await Promise.all([
        this.pool.getConnection("default"),
        this.getVersion(),
      ]);
      const res = await conn.call<{ profiles?: ReadonlyArray<HermesProfileRow> }>(
        "profiles.list",
        {},
      );
      return {
        kind: this.kind,
        label: this.label,
        available: true,
        online: true,
        version,
        botCount: res.profiles?.length ?? 0,
        error: null,
        capabilities: this.capabilities,
      };
    } catch (err) {
      return {
        kind: this.kind,
        label: this.label,
        available: true,
        online: false,
        version: await this.getVersion(),
        botCount: 0,
        error: err instanceof Error ? err.message : String(err),
        capabilities: this.capabilities,
      };
    }
  }

  private buildSummary(
    row: HermesProfileRow,
    options?: {
      readonly online?: boolean;
      readonly fallbackModel?: string | null;
      readonly fallbackProvider?: string | null;
      readonly fallbackPreview?: string | null;
      readonly fallbackActivityAt?: number | null;
      readonly running?: boolean;
    },
  ): PaBotSummary {
    const botId = makePaBotId("hermes", row.name);
    const meta = this.store.getBotMeta(botId);
    const isDefault = row.is_default === true || row.name === "default";
    const visual = defaultVisualForBot(botId, isDefault);
    const displayName =
      meta.displayName?.trim() || row.display_name?.trim() || (isDefault ? "Hermes" : row.name);

    const lastActivityAt =
      options?.fallbackActivityAt ??
      normalizeHermesTimestamp(
        row.last_session?.last_active ??
          row.canonical_session?.last_active ??
          row.last_session?.started_at,
      );

    const previewCandidate =
      options?.fallbackPreview?.trim() ||
      row.last_session?.preview?.trim() ||
      row.last_session?.title?.trim() ||
      row.canonical_session?.preview?.trim() ||
      row.canonical_session?.title?.trim() ||
      row.description?.trim() ||
      null;

    const unread =
      lastActivityAt !== null && meta.lastReadAt !== undefined && lastActivityAt > meta.lastReadAt;

    return {
      id: botId,
      adapter: "hermes",
      profile: row.name,
      name: displayName,
      description: row.description ?? "",
      avatarColor: meta.avatarColor ?? visual.avatarColor,
      avatarShape: meta.avatarShape ?? visual.avatarShape,
      pinned: meta.pinned ?? isDefault,
      isDefault,
      model: row.model || options?.fallbackModel || null,
      provider: row.provider || options?.fallbackProvider || null,
      skillCount: row.skill_count ?? 0,
      online: options?.online ?? true,
      running: options?.running === true,
      unread,
      lastMessagePreview: previewCandidate,
      lastActivityAt,
      primarySessionId: meta.primarySessionId ?? null,
    };
  }

  async listBots(): Promise<ReadonlyArray<PaBotSummary>> {
    const defaultConn = await this.pool.getConnection("default");
    const listRes = await defaultConn.call<{ profiles?: ReadonlyArray<HermesProfileRow> }>(
      "profiles.list",
      { include_sessions: true },
    );
    const profiles = listRes.profiles ?? [];

    // Avoid N+1 subprocess spawns on every roster refresh: use `profiles.list` + lightweight
    // `profiles.describe` over the already-open default socket only when a secondary profile
    // omitted its model metadata.
    const enriched = await Promise.all(
      profiles.map(async (row) => {
        if (row.model) {
          return this.buildSummary(row, { online: true });
        }
        try {
          const desc = await defaultConn.call<{
            model?: { default?: string; provider?: string };
            description?: string;
          }>("profiles.describe", { name: row.name });
          return this.buildSummary(row, {
            online: true,
            fallbackModel: desc.model?.default ?? null,
            fallbackProvider: desc.model?.provider ?? null,
            fallbackPreview: desc.description || null,
          });
        } catch {
          return this.buildSummary(row, { online: false });
        }
      }),
    );

    return enriched.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
    });
  }

  async getBotDetail(profile: string): Promise<PaBotDetail> {
    if (!isValidPaProfile(profile)) {
      throw new Error(`Invalid profile "${profile}"`);
    }
    const [defaultConn, profileConn] = await Promise.all([
      this.pool.getConnection("default"),
      this.pool.getConnection(profile),
    ]);

    // `model.options` must run on the profile's own connection to avoid `profile_mismatch`.
    const [listRes, descRes, modelRes, cronRes, skillsCatalogRes] = await Promise.all([
      defaultConn.call<{ profiles?: ReadonlyArray<HermesProfileRow> }>("profiles.list", {
        include_sessions: true,
      }),
      defaultConn.call<{
        name: string;
        description?: string;
        soul?: string;
        model?: { provider?: string; default?: string };
        skills?: ReadonlyArray<{ name: string; enabled?: boolean }>;
        toolsets?: ReadonlyArray<{
          name: string;
          enabled?: boolean;
          label?: string;
          description?: string;
        }>;
        mcp_servers?: ReadonlyArray<{ name: string; enabled?: boolean }>;
      }>("profiles.describe", { name: profile }),
      profileConn
        .call<{
          providers?: ReadonlyArray<{
            slug: string;
            name: string;
            is_current?: boolean;
            models?: ReadonlyArray<string>;
          }>;
        }>("model.options", {})
        .catch(() => ({ providers: [] })),
      defaultConn
        .call<Record<string, unknown>>("cron.manage", {
          action: "list",
          profile,
          include_disabled: true,
        })
        .catch(() => ({ jobs: [] })),
      defaultConn
        .call<{ skills?: Record<string, ReadonlyArray<string>> }>("skills.manage", {
          action: "list",
          profile,
        })
        .catch(() => ({ skills: {} })),
    ]);

    const profileRow: HermesProfileRow = listRes.profiles?.find((p) => p.name === profile) ?? {
      name: profile,
      is_default: profile === "default",
      model: descRes.model?.default ?? null,
      provider: descRes.model?.provider ?? null,
      description: descRes.description ?? "",
    };

    const summary = this.buildSummary(profileRow, {
      online: true,
      fallbackModel: descRes.model?.default ?? null,
      fallbackProvider: descRes.model?.provider ?? null,
    });

    const categoryBySkill = new Map<string, string>();
    const grouped = skillsCatalogRes.skills ?? {};
    for (const [category, names] of Object.entries(grouped)) {
      if (!Array.isArray(names)) continue;
      for (const name of names) {
        categoryBySkill.set(name, category);
      }
    }

    const describedSkills = descRes.skills ?? [];
    const skills: PaSkillEntry[] =
      describedSkills.length > 0
        ? describedSkills.map((item) => ({
            name: item.name,
            category: categoryBySkill.get(item.name),
            enabled: item.enabled !== false,
          }))
        : Array.from(categoryBySkill.entries()).map(([name, category]) => ({
            name,
            category,
            enabled: true,
          }));

    const modelOptions: PaModelProviderOption[] = (modelRes.providers ?? []).map((p) => ({
      slug: p.slug,
      name: p.name,
      isCurrent: p.is_current === true,
      models: p.models ?? [],
    }));

    return {
      ...summary,
      soul: descRes.soul ?? "",
      skills,
      toolsets: (descRes.toolsets ?? []).map((t) => ({
        name: t.name,
        label: t.label,
        description: t.description,
        enabled: t.enabled !== false,
      })),
      mcpServers: (descRes.mcp_servers ?? []).map((m) => ({
        name: m.name,
        enabled: m.enabled !== false,
      })),
      cronJobs: normalizeCronJobs(cronRes),
      modelOptions,
    };
  }

  async createBot(input: PaCreateBotInput): Promise<PaBotSummary> {
    const profileSlug = input.profile
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "");
    if (!isValidPaProfile(profileSlug)) {
      throw new Error("Profile slug must start with a letter or digit and use only [a-z0-9_-]");
    }

    const defaultConn = await this.pool.getConnection("default");
    await defaultConn.call("profiles.create", {
      name: profileSlug,
      description: input.description ?? "",
      soul: input.soul || undefined,
      model: input.model || undefined,
      provider: input.provider || undefined,
      mirror_credentials: true,
    });

    const botId = makePaBotId("hermes", profileSlug);
    this.store.updateBotMeta(botId, {
      displayName: input.name?.trim() || profileSlug,
      avatarColor: input.avatarColor,
      avatarShape: input.avatarShape,
      pinned: input.pinned ?? false,
      lastReadAt: nowMs(),
    });

    const bots = await this.listBots();
    const created = bots.find((b) => b.profile === profileSlug);
    if (!created) {
      throw new Error(`Profile "${profileSlug}" was created but not returned by profiles.list`);
    }
    return created;
  }

  async updateBot(profile: string, patch: PaUpdateBotInput): Promise<PaBotDetail> {
    if (!isValidPaProfile(profile)) {
      throw new Error(`Invalid profile "${profile}"`);
    }
    const botId = makePaBotId("hermes", profile);

    if (
      patch.name !== undefined ||
      patch.avatarColor !== undefined ||
      patch.avatarShape !== undefined ||
      patch.pinned !== undefined ||
      patch.markRead === true
    ) {
      this.store.updateBotMeta(botId, {
        ...(patch.name !== undefined ? { displayName: patch.name.trim() } : {}),
        ...(patch.avatarColor !== undefined ? { avatarColor: patch.avatarColor } : {}),
        ...(patch.avatarShape !== undefined ? { avatarShape: patch.avatarShape } : {}),
        ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
        ...(patch.markRead === true ? { lastReadAt: nowMs() } : {}),
      });
    }

    const hasHermesConfigPatch =
      patch.soul !== undefined ||
      patch.description !== undefined ||
      patch.model !== undefined ||
      patch.provider !== undefined ||
      patch.disabledSkills !== undefined ||
      patch.enabledToolsets !== undefined ||
      patch.enabledMcpServers !== undefined;

    let confirmRequired: { readonly message: string } | undefined;

    if (hasHermesConfigPatch) {
      const defaultConn = await this.pool.getConnection("default");
      const configureRes = await defaultConn.call<{
        ok?: boolean;
        confirm_required?: boolean | null;
        confirm_message?: string | null;
        error?: string | null;
      }>("profiles.configure", {
        name: profile,
        ...(patch.soul !== undefined ? { soul: patch.soul } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
        ...(patch.confirmExpensiveModel !== undefined
          ? { confirm_expensive_model: patch.confirmExpensiveModel }
          : {}),
        ...(patch.disabledSkills !== undefined
          ? { disabled_skills: [...patch.disabledSkills] }
          : {}),
        ...(patch.enabledToolsets !== undefined
          ? { enabled_toolsets: [...patch.enabledToolsets] }
          : {}),
        ...(patch.enabledMcpServers !== undefined
          ? { enabled_mcp_servers: [...patch.enabledMcpServers] }
          : {}),
      });

      if (configureRes.confirm_required) {
        confirmRequired = {
          message:
            configureRes.confirm_message ??
            "Hermes requires confirmation before pinning this model.",
        };
      } else if (configureRes.ok === false) {
        throw new Error(configureRes.error || "Hermes rejected profile configuration");
      }
    }

    const detail = await this.getBotDetail(profile);
    return confirmRequired ? { ...detail, confirmRequired } : detail;
  }

  async manageCron(profile: string, input: PaCronMutationInput): Promise<ReadonlyArray<PaCronJob>> {
    if (!isValidPaProfile(profile)) {
      throw new Error(`Invalid profile "${profile}"`);
    }
    const defaultConn = await this.pool.getConnection("default");
    const targetNameOrId = input.jobId ?? input.name;
    const mutationRes = await defaultConn.call<Record<string, unknown>>("cron.manage", {
      action: input.action,
      profile,
      ...(targetNameOrId !== undefined ? { name: targetNameOrId } : {}),
      ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.deliver !== undefined ? { deliver: input.deliver } : {}),
    });

    if (mutationRes.success === false || typeof mutationRes.error === "string") {
      throw new Error(
        typeof mutationRes.error === "string" ? mutationRes.error : "Cron job mutation failed",
      );
    }

    const listRes = await defaultConn.call<Record<string, unknown>>("cron.manage", {
      action: "list",
      profile,
      include_disabled: true,
    });
    return normalizeCronJobs(listRes);
  }

  async listSlashCommands(profile: string): Promise<ReadonlyArray<PaSlashCommand>> {
    if (!isValidPaProfile(profile)) {
      throw new Error(`Invalid profile "${profile}"`);
    }
    const conn = await this.pool.getConnection(profile);
    const raw = await conn.call<Record<string, unknown>>("commands.catalog", { profile });
    return normalizeSlashCatalog(raw);
  }

  async listSessions(profile: string): Promise<{
    readonly primarySessionId: string | null;
    readonly sessions: ReadonlyArray<PaSessionSummary>;
  }> {
    if (!isValidPaProfile(profile)) {
      throw new Error(`Invalid profile "${profile}"`);
    }
    const conn = await this.pool.getConnection(profile);
    const botId = makePaBotId("hermes", profile);
    const meta = this.store.getBotMeta(botId);

    const res = await conn.call<{ sessions?: ReadonlyArray<HermesSessionRow> }>("session.list", {
      scope: "stored",
      limit: 30,
    });
    const rows = res.sessions ?? [];
    const sessions: PaSessionSummary[] = rows
      .map((row) => {
        const sessionId = String(row.session_id ?? row.id ?? "");
        if (!sessionId) return null;
        return {
          sessionId,
          title: row.title?.trim() || "Untitled conversation",
          source: row.source ?? "local",
          model: row.model ?? null,
          messageCount: row.message_count ?? 0,
          running: row.running === true,
          startedAt: normalizeHermesTimestamp(row.started_at),
          lastActivityAt: normalizeHermesTimestamp(row.last_active ?? row.started_at),
          isPrimaryWeb: meta.primarySessionId === sessionId,
        };
      })
      .filter((item): item is PaSessionSummary => item !== null);

    const primarySessionId = meta.primarySessionId ?? null;
    if (primarySessionId && !sessions.some((s) => s.sessionId === primarySessionId)) {
      sessions.unshift({
        sessionId: primarySessionId,
        title: "T3 Web Chat",
        source: "gui",
        model: null,
        messageCount: 0,
        running: false,
        startedAt: nowMs(),
        lastActivityAt: nowMs(),
        isPrimaryWeb: true,
      });
    }

    return { primarySessionId, sessions };
  }

  async createSession(
    profile: string,
    options?: { readonly setPrimary?: boolean },
  ): Promise<PaSessionSummary> {
    if (!isValidPaProfile(profile)) {
      throw new Error(`Invalid profile "${profile}"`);
    }
    const conn = await this.pool.getConnection(profile);
    const created = await conn.call<{
      session_id: string;
      stored_session_id?: string;
      execution_generation?: number;
      replay_epoch?: string;
      subscription_id?: string;
    }>("session.create", { source: "gui" });
    const sessionId = created.session_id;
    const state = this.getOrCreateSessionState(profile, sessionId);
    if (typeof created.execution_generation === "number") {
      state.executionGeneration = created.execution_generation;
    }
    if (typeof created.replay_epoch === "string") {
      state.replayEpoch = created.replay_epoch;
    }
    if (typeof created.subscription_id === "string") {
      state.subscriptionId = created.subscription_id;
    }

    const setPrimary = options?.setPrimary !== false;
    if (setPrimary) {
      this.store.updateBotMeta(makePaBotId("hermes", profile), {
        primarySessionId: sessionId,
        lastReadAt: nowMs(),
      });
    }
    return {
      sessionId,
      title: "T3 Web Chat",
      source: "gui",
      model: null,
      messageCount: 0,
      running: false,
      startedAt: nowMs(),
      lastActivityAt: nowMs(),
      isPrimaryWeb: setPrimary,
    };
  }

  async getMessages(
    profile: string,
    sessionId: string,
    limit = 120,
  ): Promise<ReadonlyArray<PaMessage>> {
    if (!isValidPaProfile(profile) || !isValidPaSessionId(sessionId)) {
      throw new Error("Invalid profile or session id");
    }
    const conn = await this.pool.getConnection(profile);
    try {
      const res = await conn.call<{ rows?: ReadonlyArray<HermesTranscriptRow> }>(
        "session.transcript",
        {
          session_id: sessionId,
          limit,
          order: "latest",
        },
      );
      // Keep GET strictly read-only (client calls markRead explicitly via POST /update).
      return normalizeTranscriptRows(res.rows ?? []);
    } catch (err) {
      if (err instanceof Error && /not_found/i.test(err.message)) {
        return [];
      }
      throw err;
    }
  }

  private async ensureSessionAttached(
    profile: string,
    conn: HermesRpcConnection,
    sessionId: string,
  ): Promise<TrackedSessionState> {
    const state = this.getOrCreateSessionState(profile, sessionId);
    if (state.subscriptionId !== null) return state;

    const snap = await conn.call<{
      execution_generation?: number;
      replay_epoch?: string;
      subscription_id?: string;
    }>("session.resume", {
      session_id: sessionId,
      omit_messages: true,
      defer_history: true,
    });
    if (typeof snap.execution_generation === "number") {
      state.executionGeneration = snap.execution_generation;
    }
    if (typeof snap.replay_epoch === "string") {
      state.replayEpoch = snap.replay_epoch;
    }
    if (typeof snap.subscription_id === "string") {
      state.subscriptionId = snap.subscription_id;
    }
    return state;
  }

  async sendMessage(
    profile: string,
    sessionId: string,
    text: string,
    options?: { readonly inputId?: string | undefined },
  ): Promise<PaSendResult> {
    if (!isValidPaProfile(profile) || !isValidPaSessionId(sessionId)) {
      throw new Error("Invalid profile or session id");
    }
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Message cannot be empty");
    }
    const conn = await this.pool.getConnection(profile);
    await this.ensureSessionAttached(profile, conn, sessionId);
    const inputId = options?.inputId?.trim() || NodeCrypto.randomUUID();

    if (trimmed.startsWith("/")) {
      const execRes = await conn.call<{
        output?: string | null;
        warning?: string | null;
        type?: string | null;
        message?: string | null;
        notice?: string | null;
        display?: string | null;
      }>("slash.exec", {
        session_id: sessionId,
        command: trimmed,
        profile,
      });

      if (
        (execRes.type === "send" || execRes.type === "skill") &&
        typeof execRes.message === "string" &&
        execRes.message.trim().length > 0
      ) {
        const submit = await conn.call<{ admission_id?: string; submission_id?: string }>(
          "prompt.submit",
          {
            session_id: sessionId,
            text: execRes.message,
            input_id: inputId,
          },
        );
        return {
          kind: "turn",
          sessionId,
          submissionId: submit.admission_id ?? submit.submission_id ?? inputId,
          notice: execRes.notice ?? execRes.display ?? undefined,
          directiveType: execRes.type,
        };
      }

      const output = [execRes.output, execRes.warning, execRes.notice, execRes.display]
        .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
        .join("\n\n");

      return {
        kind: "slash",
        sessionId,
        output: output || "Command executed.",
        notice: execRes.notice ?? undefined,
        directiveType: execRes.type ?? "exec",
      };
    }

    // Hermes canonical `prompt.submit` strictly requires `input_id` or `submission_id`.
    const submit = await conn.call<{ admission_id?: string; submission_id?: string }>(
      "prompt.submit",
      {
        session_id: sessionId,
        text: trimmed,
        input_id: inputId,
      },
    );
    return {
      kind: "turn",
      sessionId,
      submissionId: submit.admission_id ?? submit.submission_id ?? inputId,
    };
  }

  async interruptSession(profile: string, sessionId: string): Promise<void> {
    if (!isValidPaProfile(profile) || !isValidPaSessionId(sessionId)) {
      throw new Error("Invalid profile or session id");
    }
    const conn = await this.pool.getConnection(profile);
    const state = await this.ensureSessionAttached(profile, conn, sessionId);
    // Hermes canonical `session.interrupt` strictly requires `execution_generation`.
    await conn.call("session.interrupt", {
      session_id: sessionId,
      execution_generation: state.executionGeneration,
    });
  }

  async respondRequest(
    profile: string,
    sessionId: string,
    input: PaRespondRequestInput,
  ): Promise<void> {
    if (!isValidPaProfile(profile) || !isValidPaSessionId(sessionId)) {
      throw new Error("Invalid profile or session id");
    }
    const conn = await this.pool.getConnection(profile);
    const state = this.getOrCreateSessionState(profile, sessionId);
    const tracked = state.requests.get(input.requestId);
    const channel = input.channel ?? tracked?.channel ?? "server_request";
    const executionGeneration =
      input.executionGeneration ?? tracked?.executionGeneration ?? state.executionGeneration;

    if (channel === "server_request") {
      if (input.kind === "approval") {
        conn.respondServerRequest(input.requestId, { choice: input.decision ?? "deny" });
      } else {
        const answers =
          input.answers && Object.keys(input.answers).length > 0
            ? input.answers
            : { "q-0": input.answer ?? "" };
        conn.respondServerRequest(input.requestId, { answers });
      }
      state.requests.delete(input.requestId);
      return;
    }

    // Canonical session authority prompts require exact `{ session_id, execution_generation, prompt_id, choice|answer }`.
    if (input.kind === "approval") {
      await conn.call("approval.respond", {
        session_id: sessionId,
        execution_generation: executionGeneration,
        prompt_id: input.requestId,
        choice: input.decision ?? "deny",
      });
    } else {
      const answerText =
        input.answer ?? (input.answers ? Object.values(input.answers).join("\n") : "");
      await conn.call("clarify.respond", {
        session_id: sessionId,
        execution_generation: executionGeneration,
        prompt_id: input.requestId,
        answer: answerText,
      });
    }
    state.requests.delete(input.requestId);
  }

  async subscribeSession(
    profile: string,
    sessionId: string,
    options: {
      readonly sinceSeq?: number | undefined;
      readonly replayEpoch?: string | undefined;
      readonly onEvent: (event: PaStreamEvent) => void;
      readonly onClose?: ((reason?: string) => void) | undefined;
    },
  ): Promise<() => void> {
    if (!isValidPaProfile(profile) || !isValidPaSessionId(sessionId)) {
      throw new Error("Invalid profile or session id");
    }
    const conn = await this.pool.getConnection(profile);
    const state = this.getOrCreateSessionState(profile, sessionId);
    state.subscribers += 1;

    const mapGatewayEvent = (frame: HermesRpcEventFrame): PaStreamEvent | null => {
      if (frame.session_id && frame.session_id !== sessionId) return null;
      if (typeof frame.execution_generation === "number") {
        state.executionGeneration = frame.execution_generation;
      }
      if (typeof frame.replay_epoch === "string") {
        state.replayEpoch = frame.replay_epoch;
      }
      const p = frame.payload ?? {};

      switch (frame.event) {
        case "message.start":
          return {
            type: "message.start",
            sessionId,
            turnId: typeof p.turn_id === "string" ? p.turn_id : undefined,
            seq: frame.seq,
          };
        case "message.delta":
          if (typeof p.text !== "string" || p.text.length === 0) return null;
          return {
            type: "message.delta",
            sessionId,
            text: p.text,
            turnId: typeof p.turn_id === "string" ? p.turn_id : undefined,
            segment: typeof p.segment === "number" ? p.segment : undefined,
            offset: typeof p.offset === "number" ? p.offset : undefined,
            seq: frame.seq,
          };
        case "message.interim":
          if (typeof p.text !== "string" || p.text.length === 0) return null;
          return {
            type: "message.interim",
            sessionId,
            text: p.text,
            alreadyStreamed: p.already_streamed === true,
            seq: frame.seq,
          };
        case "reasoning.delta":
        case "thinking.delta":
        case "reasoning.available":
          if (typeof p.text !== "string" && typeof p.delta !== "string") return null;
          return {
            type: "reasoning.delta",
            sessionId,
            text: typeof p.text === "string" ? p.text : String(p.delta ?? ""),
            seq: frame.seq,
          };
        case "tool.start":
        case "tool.started":
        case "tool.complete":
        case "tool.completed":
        case "tool.failed":
        case "tool.progress":
          return {
            type: "tool.progress",
            sessionId,
            toolName: String(p.tool_name ?? p.name ?? "tool"),
            status:
              frame.event === "tool.start" || frame.event === "tool.started"
                ? "started"
                : frame.event === "tool.failed" || p.is_error === true
                  ? "failed"
                  : frame.event === "tool.complete" || frame.event === "tool.completed"
                    ? "completed"
                    : "progress",
            preview: typeof p.preview === "string" ? p.preview : undefined,
            seq: frame.seq,
          };
        case "message.complete":
          return {
            type: "message.complete",
            sessionId,
            text: typeof p.text === "string" ? p.text : "",
            reasoning: typeof p.reasoning === "string" ? p.reasoning : undefined,
            status:
              p.status === "error"
                ? "error"
                : p.status === "interrupted"
                  ? "interrupted"
                  : "complete",
            error: typeof p.error === "string" ? p.error : undefined,
            seq: frame.seq,
          };
        case "approval.request":
        case "clarify.request": {
          const promptId = String(p.prompt_id ?? p.id ?? "");
          const kind = frame.event === "approval.request" ? "approval" : "clarify";
          const gen =
            typeof p.execution_generation === "number"
              ? p.execution_generation
              : state.executionGeneration;
          const mapped = normalizePendingRequest(promptId, kind, p, "canonical", gen);
          if (!mapped) return null;
          state.requests.set(promptId, { channel: "canonical", kind, executionGeneration: gen });
          return { type: "request.open", sessionId, request: mapped };
        }
        case "approval.settled":
        case "clarify.settled": {
          const promptId = String(p.prompt_id ?? p.id ?? "");
          if (!promptId) return null;
          state.requests.delete(promptId);
          return { type: "request.cancel", sessionId, requestId: promptId };
        }
        case "request.cancel": {
          const cancelId = String(p.id ?? p.request_id ?? "");
          if (!cancelId) return null;
          state.requests.delete(cancelId);
          return { type: "request.cancel", sessionId, requestId: cancelId };
        }
        case "approval.cancelled": {
          const ids = Array.isArray(p.request_ids)
            ? p.request_ids.map((v) => String(v)).filter(Boolean)
            : [String(p.id ?? p.request_id ?? "")].filter(Boolean);
          for (const id of ids) {
            state.requests.delete(id);
            options.onEvent({ type: "request.cancel", sessionId, requestId: id });
          }
          return null;
        }
        case "session.replay_gap":
          return {
            type: "snapshot",
            sessionId,
            running: true,
            lastSeq: typeof p.latest_seq === "number" ? p.latest_seq : 0,
            replayEpoch: typeof p.replay_epoch === "string" ? p.replay_epoch : undefined,
            snapshotRequired: true,
            openRequests: [],
          };
        case "notice":
          return {
            type: "notice",
            sessionId,
            message: String(p.message ?? p.text ?? ""),
          };
        case "error":
          return {
            type: "error",
            sessionId,
            message: String(p.message ?? p.error ?? "Hermes session error"),
          };
        default:
          return null;
      }
    };

    // Buffer live frames while resume/replay completes so events aren't delivered out of order.
    let bootstrapping = true;
    const bufferedLive: HermesRpcEventFrame[] = [];

    const unsubEvent = conn.onEvent((frame) => {
      if (bootstrapping) {
        bufferedLive.push(frame);
        return;
      }
      const mapped = mapGatewayEvent(frame);
      if (mapped) options.onEvent(mapped);
    });

    const unsubReq = conn.onServerRequest((req: HermesServerRequestFrame) => {
      // Strictly match session_id to prevent leaking approvals across sessions of the same profile!
      if (!req.session_id || req.session_id !== sessionId) return false;
      const mapped = normalizePendingRequest(
        req.request_id,
        req.method,
        req.params,
        "server_request",
        state.executionGeneration,
      );
      if (!mapped) return false;
      state.requests.set(req.request_id, {
        channel: "server_request",
        kind: mapped.kind,
        executionGeneration: state.executionGeneration,
      });
      options.onEvent({
        type: "request.open",
        sessionId,
        request: mapped,
      });
      return true;
    });

    const unsubClose = conn.onClose(() => {
      state.subscriptionId = null;
      options.onClose?.("Hermes gateway connection closed");
    });

    const snapshot = await conn
      .call<{
        running?: boolean;
        last_sequence?: number;
        replay_epoch?: string;
        execution_generation?: number;
        subscription_id?: string;
        prompts?: ReadonlyArray<{
          prompt_id?: string;
          id?: string;
          kind?: string;
          execution_generation?: number;
          payload?: Record<string, unknown>;
          params?: Record<string, unknown>;
        }>;
        open_requests?: ReadonlyArray<{
          id?: string;
          request_id?: string;
          method: string;
          params?: Record<string, unknown>;
        }>;
      }>("session.resume", {
        session_id: sessionId,
        omit_messages: true,
        defer_history: true,
      })
      .catch(() => ({
        running: false,
        last_sequence: 0,
        replay_epoch: undefined,
        execution_generation: state.executionGeneration,
        subscription_id: state.subscriptionId ?? undefined,
        prompts: [],
        open_requests: [],
      }));

    if (typeof snapshot.execution_generation === "number") {
      state.executionGeneration = snapshot.execution_generation;
    }
    if (typeof snapshot.replay_epoch === "string") {
      state.replayEpoch = snapshot.replay_epoch;
    }
    if (typeof snapshot.subscription_id === "string") {
      state.subscriptionId = snapshot.subscription_id;
    }

    const openRequests: PaPendingRequest[] = [];
    for (const entry of snapshot.open_requests ?? []) {
      const reqId = entry.id ?? entry.request_id ?? "";
      const mapped = normalizePendingRequest(
        reqId,
        entry.method,
        entry.params,
        "server_request",
        state.executionGeneration,
      );
      if (mapped) {
        state.requests.set(mapped.requestId, {
          channel: "server_request",
          kind: mapped.kind,
          executionGeneration: state.executionGeneration,
        });
        openRequests.push(mapped);
      }
    }
    for (const prompt of snapshot.prompts ?? []) {
      const promptId = prompt.prompt_id ?? prompt.id ?? "";
      const kind = prompt.kind === "clarify" ? "clarify" : "approval";
      const gen =
        typeof prompt.execution_generation === "number"
          ? prompt.execution_generation
          : state.executionGeneration;
      const mapped = normalizePendingRequest(
        promptId,
        kind,
        prompt.payload ?? prompt.params ?? (prompt as unknown as Record<string, unknown>),
        "canonical",
        gen,
      );
      if (mapped && !openRequests.some((r) => r.requestId === mapped.requestId)) {
        state.requests.set(mapped.requestId, {
          channel: "canonical",
          kind,
          executionGeneration: gen,
        });
        openRequests.push(mapped);
      }
    }

    let snapshotRequired = false;
    const replayFrames: HermesRpcEventFrame[] = [];
    if (options.sinceSeq !== undefined && options.sinceSeq > 0) {
      const targetEpoch = options.replayEpoch ?? state.replayEpoch;
      if (!targetEpoch) {
        snapshotRequired = true;
      } else {
        const replay = await conn
          .call<{
            events?: ReadonlyArray<{
              type: string;
              session_id?: string;
              seq?: number;
              replay_epoch?: string;
              execution_generation?: number;
              payload?: Record<string, unknown>;
            }>;
            truncated?: boolean;
            snapshot_required?: boolean;
          }>("session.events.since", {
            session_id: sessionId,
            last_sequence: options.sinceSeq,
            replay_epoch: targetEpoch,
          })
          .catch(() => ({ events: [], snapshot_required: true, truncated: true }));

        if (replay.snapshot_required || replay.truncated) {
          snapshotRequired = true;
        } else {
          for (const ev of replay.events ?? []) {
            replayFrames.push({
              event: ev.type,
              session_id: ev.session_id ?? sessionId,
              seq: ev.seq,
              replay_epoch: ev.replay_epoch,
              execution_generation: ev.execution_generation,
              payload: ev.payload,
            });
          }
        }
      }
    }

    options.onEvent({
      type: "snapshot",
      sessionId,
      running: snapshot.running === true,
      lastSeq: snapshot.last_sequence ?? 0,
      replayEpoch: state.replayEpoch ?? undefined,
      snapshotRequired,
      openRequests,
    });

    const deliveredSeqs = new Set<number>();
    for (const frame of replayFrames) {
      if (typeof frame.seq === "number") deliveredSeqs.add(frame.seq);
      const mapped = mapGatewayEvent(frame);
      if (mapped) options.onEvent(mapped);
    }

    bootstrapping = false;
    for (const frame of bufferedLive) {
      if (typeof frame.seq === "number" && deliveredSeqs.has(frame.seq)) continue;
      const mapped = mapGatewayEvent(frame);
      if (mapped) options.onEvent(mapped);
    }

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      unsubEvent();
      unsubReq();
      unsubClose();
      state.subscribers = Math.max(0, state.subscribers - 1);
      if (state.subscribers === 0 && state.subscriptionId && conn.isOpen()) {
        const subId = state.subscriptionId;
        state.subscriptionId = null;
        void conn
          .call("session.detach", { session_id: sessionId, subscription_id: subId }, 4_000)
          .catch(() => undefined);
      }
    };
  }
}
