import { describe, expect, it } from "vite-plus/test";

import {
  classifyHermesTool,
  extractTranscriptText,
  hermesRequiredScope,
  mergeSessionRows,
  normalizeHermesTimestamp,
  normalizeModelCatalog,
  normalizePendingRequest,
  normalizeProfileConfig,
  normalizeProfileRow,
  normalizeSlashCatalog,
  normalizeTranscriptRows,
} from "./HermesNormalizers.ts";

describe("Hermes transcripts", () => {
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
    expect(normalizePendingRequest("x", "sudo", {}, "server_request")).toBeNull();
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
