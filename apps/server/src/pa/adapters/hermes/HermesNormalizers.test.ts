import { describe, expect, it } from "vite-plus/test";

import {
  classifyHermesTool,
  extractTranscriptText,
  hermesRequiredScope,
  hermesRunningAdmissionId,
  mergeSessionRows,
  normalizeHermesQueue,
  normalizeHermesTimestamp,
  normalizeHermesTodoState,
  normalizeHermesUsage,
  normalizeModelCatalog,
  normalizePendingRequest,
  normalizeProfileConfig,
  normalizeProfileRow,
  normalizeSlashCatalog,
  normalizeTranscriptRows,
  sessionRowMatches,
} from "./HermesNormalizers.ts";

describe("Hermes transcripts", () => {
  it("preserves inline references as prose and distinguishes anonymous rows on different pages", () => {
    for (const text of ["Take a [screenshot] of the error", "Check @file:README.md"]) {
      expect(normalizeTranscriptRows([{ role: "user", text }])[0]).toMatchObject({ text });
      expect(
        normalizeHermesQueue([
          { admission_id: "q", status: "queued", text, controls: ["steer"] },
        ])[0],
      ).toMatchObject({ text, canSteer: true });
    }
    expect(
      normalizeTranscriptRows([{ role: "user", text: '@file:"dir/   "' }])[0]?.attachments?.[0]
        ?.name,
    ).toBe("attachment");
    const row = { role: "assistant", text: "OK" };
    expect(normalizeTranscriptRows([row], "older")[0]?.id).not.toBe(
      normalizeTranscriptRows([row])[0]?.id,
    );
  });

  it("retains user rows carrying a display metadata submission receipt without a media marker", () => {
    expect(
      normalizeTranscriptRows([
        { role: "user", row_id: 17, text: "", display_metadata: { submission_id: "received" } },
      ]),
    ).toMatchObject([{ role: "user", rowId: 17, submissionId: "received" }]);
  });

  it("keeps external references inert and preserves row ids across pagination", () => {
    const row = {
      role: "user",
      text: 'compare\n@file:"/host/private/one two.pdf"\n@image:/private/photo.png\n[image]',
      timestamp: 17,
    };
    const [message] = normalizeTranscriptRows([row]);
    expect(message?.text).toBe("compare");
    expect(
      message?.attachments?.map(({ type, name, unavailable }) => [type, name, unavailable]),
    ).toEqual([
      ["file", "one two.pdf", true],
      ["image", "photo.png", true],
    ]);
    expect(JSON.stringify(message)).not.toContain("/private/");
    expect(normalizeTranscriptRows([{ role: "assistant", text: "before" }, row])[1]).toEqual(
      message,
    );
    const [imageOnly] = normalizeTranscriptRows([
      {
        role: "user",
        row_id: 4,
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,private" } }],
      },
    ]);
    expect(imageOnly).toMatchObject({
      id: "row-4",
      text: "",
      attachments: [{ type: "image", unavailable: true }],
    });
    expect(JSON.stringify(imageOnly)).not.toContain("base64");
    const [mixed] = normalizeTranscriptRows([
      {
        role: "user",
        text: "compare\n@file:/private/q.pdf\n\n--- Attached Context ---\n\nexpanded\n\n[Image attached at: /private/photo.png]\n[image]",
      },
    ]);
    expect(mixed?.text).toBe("compare");
    expect(mixed?.attachments?.map((item) => item.name)).toEqual(["q.pdf", "photo.png"]);
    const [projected] = normalizeTranscriptRows([
      {
        role: "user",
        text: 'compare\n@file:/private/q.pdf\n\n--- Attached Context ---\n\nexpanded\n\n@image:"/private/photo.png"',
      },
    ]);
    expect(projected?.attachments).toEqual(mixed?.attachments);
    expect(
      normalizeHermesQueue([
        {
          admission_id: "q",
          input_id: "send",
          status: "queued",
          text: "@file:/private/q.pdf",
          controls: ["steer"],
        },
      ]),
    ).toEqual([
      { id: "q", inputId: "send", status: "queued", text: "", attachmentCount: 1, canSteer: false },
    ]);
  });
  it("normalizes timestamps, text parts, tool rows and reasoning", () => {
    expect(normalizeHermesTimestamp(1795613800.5)).toBe(1795613800500);
    expect(normalizeHermesTimestamp(1795613800500)).toBe(1795613800500);
    expect(normalizeHermesTimestamp(null)).toBeNull();
    expect(
      extractTranscriptText({ content: [{ type: "text", text: "Hello" }, { text: "world" }] }),
    ).toBe("Hello\nworld");

    const messages = normalizeTranscriptRows([
      { role: "user", text: "/status", row_id: 1, timestamp: 1700000000 },
      {
        role: "tool",
        name: "web_search",
        context: "Beijing weather",
        tool_call_id: "tc-9",
        args: { query: "Beijing weather" },
        content: "Sunny 24C",
        display_metadata: { is_error: true },
        row_id: 11,
      },
      { role: "assistant", text: "ok", reasoning_content: "Checked", row_id: 2 },
      { role: "assistant", text: "", row_id: 3 },
      { role: "system", text: "Compacted", row_kind: "compaction", row_id: 4 },
    ]);
    expect(messages.map((m) => m.rowKind)).toEqual(["message", "message", "message", "compaction"]);
    expect(messages[1]).toMatchObject({
      role: "tool",
      toolName: "web_search",
      toolCategory: "web-search",
      toolContext: "Beijing weather",
      toolCallId: "tc-9",
      toolArgs: { query: "Beijing weather" },
      toolFailed: true,
      text: "Sunny 24C",
    });
    expect(messages[2]?.reasoning).toBe("Checked");
  });

  it("projects display_commentary as commentary rows without losing the final answer", () => {
    const messages = normalizeTranscriptRows([
      { role: "user", text: "check the repo", row_id: 1 },
      {
        role: "assistant",
        text: "Let me look.\n\nThe repo is clean.",
        display_content: "The repo is clean.",
        display_commentary: ["Let me look."],
        display_reasoning: "",
        reasoning: "private Let me look.",
        row_id: 2,
        timestamp: 1700000000,
      },
      // Joined commentary persisted as the canonical answer stays a single (final) row.
      { role: "assistant", text: "Same text", display_commentary: ["Same text"], row_id: 3 },
      { role: "assistant", text: "scaffold", display_kind: "hidden", row_id: 4 },
    ]);
    expect(messages.map((m) => [m.id, m.text, m.commentary ?? false])).toEqual([
      ["row-1", "check the repo", false],
      ["row-2-commentary-0", "Let me look.", true],
      ["row-2", "The repo is clean.", false],
      ["row-3", "Same text", false],
    ]);
    expect(messages[1]?.reasoning).toBeUndefined();
    expect(messages[2]?.reasoning).toBeUndefined();
    expect(messages[1]?.timestamp).toBe(1700000000000);
  });

  it("keeps paged rows' ids stable without a row_id and carries compaction details", () => {
    const page = [
      { role: "user", text: "same", timestamp: 1700000000 },
      { role: "user", text: "same", timestamp: 1700000000 },
      { role: "assistant", text: "head", truncated: true },
      {
        role: "system",
        text: "Summary",
        row_kind: "compaction",
        compacted_messages: 12,
        row_id: 9,
      },
    ];
    const first = normalizeTranscriptRows(page);
    // The same rows read again (or on another page) get the same ids, and duplicates stay apart.
    expect(normalizeTranscriptRows(page).map((m) => m.id)).toEqual(first.map((m) => m.id));
    expect(new Set(first.map((m) => m.id)).size).toBe(4);
    expect(first.slice(0, 3).every((m) => m.id.startsWith("h-"))).toBe(true);
    expect(normalizeTranscriptRows(page.slice(2))[0]?.id).toBe(first[2]?.id);
    expect(first[2]).toMatchObject({ truncated: true });
    expect(first[2]?.rowId).toBeUndefined();
    expect(first[3]).toMatchObject({
      id: "row-9",
      rowId: 9,
      rowKind: "compaction",
      compactedMessages: 12,
    });
  });

  it("keeps timestamp twins on separate pages and stable submissions across pages", () => {
    const row = { role: "assistant", text: "OK", timestamp: 1700000000 };
    expect(normalizeTranscriptRows([row])[0]?.id).not.toBe(
      normalizeTranscriptRows([row], "older")[0]?.id,
    );
    const submitted = { ...row, role: "user", submission_id: "submit-1" };
    expect(normalizeTranscriptRows([submitted])[0]?.id).toBe(
      normalizeTranscriptRows([submitted], "older")[0]?.id,
    );
  });

  it("classifies tools into neutral categories", () => {
    expect(
      [
        "terminal",
        "read_file",
        "patch",
        "search_files",
        "web_search",
        "web_extract",
        "memory",
        "delegate_task",
        "todo",
        "cronjob",
        "skill_view",
        "execute_code",
        "vision_analyze",
        "send_message",
        "mystery",
      ].map(classifyHermesTool),
    ).toEqual([
      "terminal",
      "file-read",
      "file-edit",
      "search",
      "web-search",
      "web-fetch",
      "memory",
      "agent",
      "todo",
      "schedule",
      "skill",
      "code",
      "vision",
      "message",
      "other",
    ]);
  });
});

describe("Hermes slash catalog", () => {
  it("keeps web-runnable commands, skills, quick commands and plugins; drops CLI-only ones", () => {
    const commands = normalizeSlashCatalog({
      pairs: [
        ["/new", "Start a new session"],
        ["/model", "Switch model"],
        ["/status", "Show status"],
        ["/redraw", "Force terminal repaint"],
        ["/export", "Export profile archive"],
        ["/quit", "Exit CLI"],
        ["/daily-brief", "Compile morning digest"],
      ],
      commands: {
        "/model": { argument_mode: "mixed", desktop: "hidden" },
        "/redraw": { argument_mode: null, desktop: "terminal" },
        "/export": { argument_mode: "text", desktop: null },
      },
      categories: [
        {
          name: "Session",
          pairs: [
            ["/new", "Start a new session"],
            ["/redraw", "Force terminal repaint"],
            ["/export", "Export profile archive"],
          ],
        },
        { name: "Info", pairs: [["/status", "Show status"]] },
        { name: "Quick Commands", pairs: [["/morning", "Run morning check"]] },
      ],
      skills: { "/daily-brief": { usage: 3, origin: "local" } },
      plugin_commands: { logs: "Tail plugin logs" },
    });
    expect(commands).toEqual([
      {
        name: "/new",
        description: "Start a new session",
        group: "command",
        handling: "client:new-session",
        requiredScope: "operate",
        featured: true,
      },
      {
        name: "/model",
        description: "Switch model",
        group: "command",
        handling: "client:model-picker",
        requiredScope: "operate",
        featured: true,
      },
      {
        name: "/status",
        description: "Show status",
        group: "command",
        handling: "engine",
        requiredScope: "operate",
        featured: true,
      },
      expect.objectContaining({ name: "/stop", handling: "client:interrupt", featured: true }),
      {
        name: "/morning",
        description: "Run morning check",
        group: "command",
        handling: "engine",
        requiredScope: "manage",
      },
      expect.objectContaining({ name: "/daily-brief", group: "skill", handling: "engine" }),
      expect.objectContaining({ name: "/logs", group: "plugin", requiredScope: "manage" }),
    ]);
  });

  it("parses command names the way Hermes does before deciding the required grant", () => {
    expect(hermesRequiredScope("hello /config")).toBe("operate");
    expect(hermesRequiredScope("/status")).toBe("operate");
    expect(hermesRequiredScope("  /STATUS  extra")).toBe("operate");
    expect(hermesRequiredScope("//status")).toBe("operate");
    expect(hermesRequiredScope("/model gpt")).toBe("manage");
    expect(hermesRequiredScope("/config set x")).toBe("manage");
    expect(hermesRequiredScope("//config")).toBe("manage");
    expect(hermesRequiredScope("/status\x1cconfig")).toBe("operate");
    expect(hermesRequiredScope("/my-quick-alias")).toBe("manage");
    expect(hermesRequiredScope("/")).toBe("manage");
  });
});

describe("Hermes sessions, profiles and models", () => {
  it("merges live + stored session rows, preferring live state and reading last_active_at", () => {
    const sessions = mergeSessionRows(
      [{ session_id: "s-live", title: "Live now", running: true, model: "flash", started_at: 100 }],
      [
        {
          session_id: "s-live",
          title: "Stored title",
          running: false,
          message_count: 9,
          last_active_at: 1700000500,
          started_at: 100,
        },
        { session_id: "s-old", title: "Old", last_active: 1700000100, started_at: 50 },
      ],
    );
    expect(sessions.map((s) => s.sessionId)).toEqual(["s-live", "s-old"]);
    expect(sessions[0]).toMatchObject({
      title: "Live now",
      running: true,
      model: "flash",
      messageCount: 9,
      lastActivityAt: 1700000500000,
    });
    expect(sessions[1]).toMatchObject({ lastActivityAt: 1700000100000 });
  });

  it("matches a live session by title or id, as the stored search does", () => {
    const row = { session_id: "20261127_abc", title: "Trip Plan" };
    expect(sessionRowMatches(row, "trip")).toBe(true);
    expect(sessionRowMatches(row, "ABC")).toBe(true);
    expect(sessionRowMatches(row, "groceries")).toBe(false);
    expect(sessionRowMatches({ id: "s-1", title: null }, "s-1")).toBe(true);
  });

  it("leaves the default profile unnamed so the engine label can stand in", () => {
    expect(normalizeProfileRow({ name: "default", is_default: true })).toMatchObject({
      agentRef: "default",
      name: null,
      isDefault: true,
    });
    expect(normalizeProfileRow({ name: "feedbot", display_name: "Feed" })).toMatchObject({
      agentRef: "feedbot",
      name: "Feed",
      isDefault: false,
    });
  });

  it("puts the current and custom providers first and folds auto-detected ones away", () => {
    const catalog = normalizeModelCatalog(
      {
        providers: [
          { slug: "anthropic", name: "Anthropic", source: "hermes", models: ["c"] },
          {
            slug: "pixel-openai",
            name: "Pixel OpenAI",
            is_user_defined: true,
            source: "user-config",
            models: ["g"],
          },
          { slug: "openrouter", name: "OpenRouter", is_current: true, models: ["m"] },
        ],
      },
      { model: { default: "m", provider: "openrouter" } },
    );
    expect(catalog.current).toEqual({ provider: "openrouter", model: "m" });
    expect(catalog.providers.map((p) => [p.id, p.tier, p.badge ?? null, p.isCurrent])).toEqual([
      ["openrouter", "primary", "current", true],
      ["pixel-openai", "primary", "custom", false],
      ["anthropic", "detected", "detected", false],
    ]);

    // With nothing configured, everything detected is all there is to pick from.
    const onlyDetected = normalizeModelCatalog(
      { providers: [{ slug: "anthropic", name: "Anthropic", source: "hermes", models: ["c"] }] },
      {},
    );
    expect(onlyDetected.providers[0]?.tier).toBe("primary");
    expect(onlyDetected.current).toBeNull();
  });

  it("carries per-model reasoning capabilities and active reasoning effort", () => {
    const catalog = normalizeModelCatalog(
      {
        providers: [
          {
            slug: "openai",
            name: "OpenAI",
            is_current: true,
            models: ["gpt-5.4", "gpt-4o-mini", "gpt-6-astra"],
            capabilities: {
              "gpt-5.4": { reasoning: true, can_disable_reasoning: true },
              "gpt-4o-mini": { reasoning: false },
              "gpt-6-astra": { reasoning: true, can_disable_reasoning: false },
            },
          },
        ],
      },
      { model: { default: "gpt-5.4", provider: "openai" } },
      { value: "HIGH" },
    );
    expect(catalog.current).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    expect(catalog.reasoningLevels?.map((level) => level.id)).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(catalog.providers[0]?.models).toEqual([
      { id: "gpt-5.4", reasoning: true, canDisableReasoning: true },
      { id: "gpt-4o-mini", reasoning: false },
      { id: "gpt-6-astra", reasoning: true, canDisableReasoning: false },
    ]);

    const disabled = normalizeModelCatalog(
      { providers: [] },
      { model: { default: "gpt-5.4", provider: "openai" } },
      { value: false },
    );
    expect(disabled.current?.reasoningEffort).toBe("none");
  });
});

describe("Hermes prompts and config", () => {
  it("normalizes approvals to native option ids with an intent", () => {
    const tracked = normalizePendingRequest(
      "srq-1",
      "approval",
      { command: "rm -rf build", allow_permanent: true },
      "server_request",
      4,
    );
    expect(tracked).toMatchObject({ channel: "server_request", executionGeneration: 4 });
    expect(tracked?.request).toMatchObject({
      requestId: "srq-1",
      kind: "approval",
      command: "rm -rf build",
      detail: "rm -rf build",
    });
    expect(tracked?.request.options?.map((o) => [o.id, o.intent])).toEqual([
      ["once", "allow"],
      ["session", "allow"],
      ["always", "allow"],
      ["deny", "deny"],
    ]);
  });

  it("gives every clarify prompt at least one question and keeps locked answers", () => {
    const free = normalizePendingRequest("c-1", "clarify", {}, "canonical");
    expect(free?.request.questions).toEqual([
      { id: "q0", prompt: "The agent needs your input to continue." },
    ]);
    const batch = normalizePendingRequest(
      "srq-b",
      "clarify",
      {
        questions: [
          { qid: "q0", question: "Env?", choices: ["prod", "staging"], multi_select: true },
          { qid: "q1", question: "Why?" },
        ],
        answers: { q0: "prod" },
      },
      "server_request",
    );
    expect(batch?.request.questions).toEqual([
      { id: "q0", prompt: "Env?", options: ["prod", "staging"], multiSelect: true },
      { id: "q1", prompt: "Why?" },
    ]);
    expect(batch?.lockedAnswers).toEqual({ q0: "prod" });
  });

  it("opens Hermes's masked prompts as secret requests and ignores Desktop-only ones", () => {
    const sudo = normalizePendingRequest(
      "srq-s",
      "sudo",
      { command: "apt install jq" },
      "server_request",
    );
    expect(sudo).toMatchObject({ method: "sudo", channel: "server_request" });
    expect(sudo?.request).toMatchObject({
      kind: "secret",
      scope: "session",
      command: "apt install jq",
      fields: [{ id: "password", secret: true, required: true }],
    });
    const secret = normalizePendingRequest(
      "srq-k",
      "secret",
      { env_var: "TAVILY_API_KEY", prompt: "Paste the key" },
      "server_request",
    );
    expect(secret?.request).toMatchObject({
      kind: "secret",
      title: "TAVILY_API_KEY needed",
      detail: "Paste the key",
      fields: [{ id: "value", label: "TAVILY_API_KEY", secret: true }],
      sideEffectNotice: expect.stringContaining(".env"),
    });
    const code = normalizePendingRequest("srq-c", "vault.code", {}, "server_request");
    expect(code?.request.fields).toEqual([{ id: "code", label: "Code", required: true }]);
    const login = normalizePendingRequest(
      "srq-l",
      "vault.save_login",
      { origin: "https://github.com", site: "github.com" },
      "server_request",
    );
    expect(login?.request.fields?.map((field) => [field.id, field.secret ?? false])).toEqual([
      ["identifier", false],
      ["password", true],
    ]);
    expect(
      normalizePendingRequest("srq-u", "vault.unlock_prompt", {}, "server_request")?.request.kind,
    ).toBe("secret");
    // Only the server-request channel carries these; Desktop's bridges stay unanswered here.
    expect(normalizePendingRequest("x", "sudo", {}, "canonical")).toBeNull();
    for (const method of ["theme.set", "preview.open", "window.read", "tour", "setup_beat"]) {
      expect(normalizePendingRequest("x", method, {}, "server_request")).toBeNull();
    }
  });

  it("describes a profile as generic config sections", () => {
    const config = normalizeProfileConfig(
      {
        description: "Daily news",
        soul: "You are terse.",
        skills: [
          { name: "digest", enabled: true },
          { name: "scrape", enabled: false },
        ],
        toolsets: [{ name: "web", label: "Web", enabled: true }],
      },
      { news: ["digest"] },
    );
    expect(config.sections.map((s) => [s.id, s.kind])).toEqual([
      ["profile", "options"],
      ["persona", "document"],
      ["skills", "toggleList"],
      ["toolsets", "toggleList"],
    ]);
    const skills = config.sections.find((s) => s.id === "skills");
    expect(skills?.kind === "toggleList" && skills.items).toEqual([
      { id: "digest", label: "digest", group: "news", enabled: true },
      { id: "scrape", label: "scrape", enabled: false },
    ]);
    const toolsets = config.sections.find((s) => s.id === "toolsets");
    expect(toolsets?.kind === "toggleList" && toolsets.minEnabled).toBe(1);
  });
});

describe("Hermes queue, usage and todos", () => {
  const pending = [
    { admission_id: "adm-run", status: "started", text: "first", controls: [] },
    { admission_id: "adm-steer", status: "started", steering: true, text: "nudge" },
    { admission_id: "adm-q1", status: "queued", text: "next", controls: ["steer", "replace"] },
    { admission_id: "adm-q2", status: "queued", text: "with file", controls: [] },
    { admission_id: "adm-lost", status: "unknown", text: "lost" },
    { admission_id: "adm-done", status: "terminal", text: "done" },
  ];

  it("lists what still waits, never the running admission, and only offers the verbs Hermes serves", () => {
    expect(normalizeHermesQueue(pending)).toEqual([
      { id: "adm-steer", text: "nudge", status: "steering", canSteer: false },
      { id: "adm-q1", text: "next", status: "queued", canSteer: true, canReplace: true },
      { id: "adm-q2", text: "with file", status: "queued", canSteer: false },
      { id: "adm-lost", text: "lost", status: "unknown", canSteer: false },
    ]);
    expect(hermesRunningAdmissionId(pending)).toBe("adm-run");
    expect(normalizeHermesQueue(undefined)).toEqual([]);
    expect(hermesRunningAdmissionId([{ admission_id: "a", status: "queued" }])).toBeNull();
  });

  it("reads context occupancy from the context figures, never from cumulative totals", () => {
    // `session_usage.py::tui_usage` shape, as `message.complete.usage` and `info.usage` carry it.
    expect(
      normalizeHermesUsage({
        input: 90_000,
        output: 4_000,
        total: 94_000,
        context_used: 12_000,
        context_max: 200_000,
        context_percent: 6,
        cache_read: 3_000,
        compressions: 1,
      }),
    ).toEqual({
      contextUsed: 12_000,
      contextMax: 200_000,
      contextPercent: 6,
      inputTokens: 90_000,
      outputTokens: 4_000,
      totalTokens: 94_000,
      cacheReadTokens: 3_000,
      compressionCount: 1,
    });
    // `session.usage` carries both views; the nested status-bar one wins.
    expect(
      normalizeHermesUsage({
        usage: { input: 10, total: 10, context_used: 5_000, context_max: 10_000 },
        context_tokens: 1,
        context_length: 2,
      }),
    ).toMatchObject({ contextUsed: 5_000, contextMax: 10_000, contextPercent: 50 });
    // Only the deprecated flat counters.
    expect(
      normalizeHermesUsage({
        input_tokens: 400_000,
        total_tokens: 420_000,
        context_tokens: 30_000,
        context_length: 120_000,
        compression_count: 2,
      }),
    ).toMatchObject({ contextUsed: 30_000, contextMax: 120_000, contextPercent: 25 });
    // No window known: no percentage, whatever the session has spent.
    expect(normalizeHermesUsage({ input: 50_000, total: 900_000 })).toMatchObject({
      contextUsed: 0,
      contextMax: null,
      contextPercent: null,
      totalTokens: 900_000,
    });
    expect(normalizeHermesUsage(null)).toBeNull();
    expect(normalizeHermesUsage({ model: "x" })).toBeNull();
  });

  it("normalizes todo snapshots and treats an unused revision-0 store as no plan", () => {
    expect(
      normalizeHermesTodoState({
        revision: 3,
        todos: [
          { id: "1", content: "Read the code", status: "completed" },
          { id: 2, content: "Write the fix", status: "IN_PROGRESS" },
          { id: "3", content: "Ship", status: "someday" },
          { id: "4", content: "" },
        ],
      }),
    ).toEqual({
      revision: 3,
      items: [
        { id: "1", text: "Read the code", status: "completed" },
        { id: "2", text: "Write the fix", status: "in_progress" },
        { id: "3", text: "Ship", status: "pending" },
      ],
    });
    expect(normalizeHermesTodoState({ revision: 0, todos: [] })).toBeNull();
    expect(normalizeHermesTodoState({ revision: 4, todos: [] })).toEqual({
      revision: 4,
      items: [],
    });
    expect(normalizeHermesTodoState({ todos: "nope" })).toBeNull();
  });
});
