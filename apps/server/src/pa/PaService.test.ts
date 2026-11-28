// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  PaError,
  type PaCapabilities,
  type PaAttachment,
  type PaMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeModule from "node:module";

import { makePaService } from "./PaService.ts";
import { PaStore } from "./PaStore.ts";
import { PaAttachmentStore } from "./PaAttachmentStore.ts";
import {
  createPendingAttachmentId,
  resolveAttachmentPathById,
  sweepStalePendingAttachments,
} from "../attachmentStore.ts";
import type { PaAgentRow, PaEngineInstance, PaSessionSubscriber } from "./types.ts";

const fs: typeof NodeFS = NodeModule.createRequire(import.meta.url)("node:fs");
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const CORE_ONLY: PaCapabilities = {
  sessions: { create: true, rename: false },
  execution: { interrupt: false, approvals: false, clarify: false },
  models: { supported: false, scope: "agent", allowCustom: false },
  commands: { supported: false },
  config: { supported: false },
  schedules: { supported: false },
  lifecycle: { create: false, delete: false },
};

const row = (agentRef: string, patch: Partial<PaAgentRow> = {}): PaAgentRow => ({
  agentRef,
  name: null,
  description: "",
  isDefault: false,
  model: null,
  provider: null,
  running: false,
  lastActivityAt: null,
  lastMessagePreview: null,
  ...patch,
});

function makeEngine(overrides: Partial<PaEngineInstance> = {}) {
  const feeds: PaSessionSubscriber[] = [];
  const sent: string[] = [];
  const engine: PaEngineInstance = {
    instanceId: "fake",
    driver: "fake",
    label: "Fake",
    capabilities: CORE_ONLY,
    isValidAgentRef: (ref) => /^[a-z]+$/.test(ref),
    listAgents: async () => [
      row("main", { isDefault: true, lastActivityAt: 10 }),
      row("helper", { name: "Helper", lastActivityAt: 50, lastReplyAt: 45 }),
    ],
    listSessions: async () => ({ sessions: [], nextCursor: null }),
    createSession: async () => ({
      sessionId: "s-new",
      title: "New conversation",
      source: "gui",
      model: null,
      messageCount: 0,
      running: false,
      startedAt: 1,
      lastActivityAt: 1,
    }),
    getMessages: async () => ({ messages: [], nextCursor: null, reset: false }),
    sendMessage: async (_ref, sessionId, text) => {
      sent.push(text);
      return text.startsWith("/")
        ? { kind: "output", sessionId, output: `ran ${text}` }
        : { kind: "turn", sessionId, submissionId: "sub-1" };
    },
    subscribeSession: async (_ref, sessionId, subscriber) => {
      feeds.push(subscriber);
      subscriber.onEvent({
        type: "snapshot",
        sessionId,
        running: false,
        openRequests: [],
        snapshotRequired: false,
      });
      return () => undefined;
    },
    ...overrides,
  };
  return { engine, feeds, sent };
}

function makeService(engines: ReadonlyArray<PaEngineInstance>) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pa-service-"));
  tempDirs.push(dir);
  const store = new PaStore(dir);
  return { store, service: makePaService({ store, instances: engines }) };
}

describe("PaService", () => {
  it("retains historical assets and limits cleanup to the requested owner", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pa-retention-"));
    tempDirs.push(dir);
    const store = new PaAttachmentStore(dir, dir);
    const id = createPendingAttachmentId(".svg");
    NodeFS.writeFileSync(NodePath.join(dir, id + ".svg"), "svg");
    const item: PaAttachment = {
      type: "file",
      id,
      name: "a".repeat(255),
      mimeType: "image/svg+xml",
      sizeBytes: 3,
    };
    const caps = { files: true, images: true };
    const [first] = await store.claim("bot", "s", "0", "", [item], caps);
    expect(first!.metadata.name).toBe("a".repeat(251) + ".svg");
    for (let i = 1; i <= 256; i++) await store.claim("bot", "s", String(i), "", [item], caps);
    expect(NodeFS.readFileSync(first!.path, "utf8")).toBe("svg");
    expect(new PaAttachmentStore(dir, dir).find("bot", "s", "0")).toBeDefined();
    const [other] = await store.claim("bot", "other", "another", "", [item], caps);
    store.bindSession("bot", "s", "owner");
    expect(store.find("bot", "owner", "0")).toBeDefined();
    store.forget("bot", "s");
    expect(NodeFS.existsSync(first!.path)).toBe(false);
    expect(NodeFS.existsSync(other!.path)).toBe(true);
    await store.claim("bot", "s", "new", "", [item], caps);
    expect(store.find("bot", "owner", "new")).toBeUndefined();
    store.forget("bot");
    expect(NodeFS.existsSync(other!.path)).toBe(false);
  });

  it.each(["[", "{}", "[null]"])("backs up a corrupt attachment journal (%s)", async (raw) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pa-corrupt-"));
    tempDirs.push(dir);
    const store = new PaAttachmentStore(dir, dir);
    await store.claim("bot", "s", "i", "", [], { files: true, images: true });
    const journals = NodePath.join(dir, "pa-attachments");
    const folder = NodePath.join(journals, NodeFS.readdirSync(journals)[0]!);
    const file = NodeFS.readdirSync(folder)[0]!;
    NodeFS.writeFileSync(NodePath.join(folder, file), raw);
    expect(new PaAttachmentStore(dir, dir).find("bot", "s", "i")).toBeUndefined();
    const backup = NodeFS.readdirSync(folder).find(
      (name) => name.includes(".corrupt-") && name.endsWith(".bak"),
    );
    expect(NodeFS.readFileSync(NodePath.join(folder, backup!), "utf8")).toBe(raw);
  });

  it("keeps a large attachment journal cached across text completions, queue snapshots and history", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pa-large-"));
    tempDirs.push(dir);
    const store = new PaAttachmentStore(dir, dir);
    const id = createPendingAttachmentId(".pdf");
    NodeFS.writeFileSync(NodePath.join(dir, id + ".pdf"), "pdf");
    const pdf: PaAttachment = {
      id,
      name: "doc.pdf",
      mimeType: "application/pdf",
      type: "file",
      sizeBytes: 3,
    };
    for (let index = 0; index < 257; index++)
      await store.claim("bot", "s", String(index), "hello", [pdf], { images: true, files: true });
    const cold = new PaAttachmentStore(dir, dir);
    using mocks = new DisposableStack();
    mocks.defer(NodeModule.syncBuiltinESMExports);
    const reads = mocks.use(vi.spyOn(fs, "readFileSync"));
    NodeModule.syncBuiltinESMExports();

    for (let index = 0; index < 5; index++) {
      cold.record("bot", "s", "plain-text", { rowId: 100 });
      cold.queue("bot", "s", [{ id: "q", status: "queued", text: "", canSteer: true }]);
      cold.hydrate("bot", "s", [
        { id: "r", rowKind: "message", role: "user", text: "hello", timestamp: null },
      ]);
    }
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("refuses subsequent writes when a corrupt journal cannot be backed up", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pa-backup-"));
    tempDirs.push(dir);
    const caps = { images: true, files: true };
    await new PaAttachmentStore(dir, dir).claim("bot", "s", "old", "", [], caps);
    const base = NodePath.join(dir, "pa-attachments");
    const folder = NodePath.join(base, NodeFS.readdirSync(base)[0]!);
    const file = NodePath.join(folder, NodeFS.readdirSync(folder)[0]!);
    NodeFS.writeFileSync(file, "[broken");
    const store = new PaAttachmentStore(dir, dir);
    const rename = fs.renameSync;
    using mocks = new DisposableStack();
    mocks.defer(NodeModule.syncBuiltinESMExports);
    mocks.use(
      vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (String(to).endsWith(".bak")) throw new Error("backup failed");
        rename(from, to);
      }),
    );
    NodeModule.syncBuiltinESMExports();
    expect(() => store.find("bot", "s", "old")).toThrow("backup failed");
    await expect(store.claim("bot", "s", "new", "", [], caps)).rejects.toThrow("backup failed");
    expect(NodeFS.readFileSync(file, "utf8")).toBe("[broken");
  });

  it.effect("preserves old and negotiated streams when attachment queue enrichment fails", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pa-stream-"));
      tempDirs.push(dir);
      const storage = new PaAttachmentStore(dir, dir);
      storage.record = () => {
        throw new Error("receipt write failed");
      };
      storage.queue = () => {
        throw new Error("journal unavailable");
      };
      let emit: () => void = () => {
        throw new Error("Feed not attached");
      };
      const { engine } = makeEngine({
        subscribeSession: async (_agent, sessionId, sub) => {
          const secret = { requestId: "key", kind: "secret" as const, title: "Key", detail: "" };
          const items = [{ id: "q", status: "queued" as const, text: "wait", canSteer: true }];
          sub.onEvent({
            type: "snapshot",
            sessionId,
            running: true,
            openRequests: [secret],
            queuedItems: items,
            snapshotRequired: false,
          });
          emit = () => {
            sub.onEvent({
              type: "usage.updated",
              sessionId,
              usage: { contextUsed: 5, contextMax: null, contextPercent: null },
            });
            sub.onEvent({ type: "queue.updated", sessionId, items });
            sub.onEvent({ type: "todos.updated", sessionId, todos: { revision: 1, items: [] } });
            sub.onEvent({ type: "request.opened", sessionId, request: secret });
            sub.onUserRowPersisted?.("input", 7);
            sub.onEvent({ type: "turn.completed", sessionId, status: "complete" });
          };
          return () => undefined;
        },
      });
      for (const protocolVersion of [undefined, 2]) {
        const service = makePaService({
          instances: [engine],
          store: new PaStore(dir),
          attachmentStore: storage,
        });
        const events = Array.from(
          yield* service
            .subscribeSession({
              botId: "fake:main",
              sessionId: "s",
              ...(protocolVersion ? { protocolVersion } : {}),
            })
            .pipe(
              Stream.tap((event) =>
                Effect.sync(() => {
                  if (event.type === "snapshot") emit();
                }),
              ),
              Stream.takeUntil((event) => event.type === "turn.completed"),
              Stream.runCollect,
            ),
        );
        expect(events.map((event) => event.type)).toEqual(
          protocolVersion
            ? [
                "snapshot",
                "usage.updated",
                "queue.updated",
                "todos.updated",
                "request.opened",
                "turn.completed",
              ]
            : ["snapshot", "turn.completed"],
        );
        expect(events[0]).toMatchObject({
          openRequests: protocolVersion ? [expect.objectContaining({ kind: "secret" })] : [],
        });
        if (protocolVersion) expect(events[0]).toHaveProperty("queuedItems.0.id", "q");
        else expect(events[0]).not.toHaveProperty("queuedItems");
        service.dispose();
      }
    }),
  );

  it.effect("rolls back definite refusals and rejects steering a journaled PDF", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pa-refusal-"));
      tempDirs.push(dir);
      const id = createPendingAttachmentId(".pdf");
      NodeFS.writeFileSync(NodePath.join(dir, id + ".pdf"), "pdf");
      const attachmentStore = new PaAttachmentStore(dir, dir);
      const { engine } = makeEngine({
        capabilities: {
          ...CORE_ONLY,
          attachments: { images: true, files: true },
          execution: { ...CORE_ONLY.execution, steer: true, queue: true },
        },
        sendMessage: async (_ref, sessionId, text) => {
          if (text === "missing") throw new PaError({ reason: "NotFound", message: "missing" });
          if (text === "voice") return { kind: "output", sessionId, output: "Voice stopped" };
          return {
            kind: "turn",
            sessionId,
            submissionId: "pdf-submission",
            admissionId: "pdf-admission",
          };
        },
        manageQueuedItem: async () => {
          throw new Error("unexpected steer");
        },
      });
      const service = makePaService({
        instances: [engine],
        store: new PaStore(dir),
        attachmentStore,
      });
      const session = { botId: "fake:main", sessionId: "s" };
      const input = {
        ...session,
        inputId: "retry",
        attachments: [
          { id, type: "file" as const, name: "doc.pdf", mimeType: "application/pdf", sizeBytes: 3 },
        ],
      };
      expect(yield* Effect.flip(service.sendMessage({ ...input, text: "missing" }))).toMatchObject({
        reason: "NotFound",
      });
      yield* service.sendMessage({ ...input, text: "voice" });
      expect(attachmentStore.find(session.botId, "s", "retry")).toBeUndefined();
      expect(NodeFS.readdirSync(dir).filter((name) => name.startsWith("_pa-"))).toEqual([]);
      const accepted = yield* service.sendMessage({ ...input, text: "read" });
      const withoutMarker: PaMessage = {
        role: "user",
        rowId: 12,
        id: "row-12",
        rowKind: "message",
        text: "read",
        timestamp: null,
        submissionId: "pdf-submission",
      };
      expect(attachmentStore.hydrate(session.botId, "s", [withoutMarker])[0]?.attachments).toEqual(
        accepted.attachments,
      );
      expect(new PaAttachmentStore(dir, dir).find(session.botId, "s", "pdf-admission")?.rowId).toBe(
        12,
      );
      expect(
        yield* Effect.flip(
          service.manageQueuedItem({ ...session, itemId: "pdf-admission", action: "steer" }),
        ),
      ).toMatchObject({ reason: "Unsupported" });
    }),
  );

  it("rolls back partial claims and refuses a linked file outside the upload store", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pa-claim-"));
    tempDirs.push(root);
    const dir = NodePath.join(root, "uploads");
    NodeFS.mkdirSync(dir);
    const good = createPendingAttachmentId(".pdf");
    const link = createPendingAttachmentId(".pdf");
    NodeFS.writeFileSync(NodePath.join(dir, good + ".pdf"), "pdf");
    NodeFS.writeFileSync(NodePath.join(root, "outside"), "pdf");
    NodeFS.symlinkSync(NodePath.join(root, "outside"), NodePath.join(dir, link + ".pdf"));
    const store = new PaAttachmentStore(root, dir);
    const file = (id: string): PaAttachment => ({
      type: "file",
      id,
      name: "file.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
    });
    const caps = { images: true, files: true, maxImages: 10 };
    await expect(
      store.claim("fake:main", "session", "input", "", [file(good), file(link)], caps),
    ).rejects.toThrow(PaError);
    expect(NodeFS.readdirSync(dir).filter((item) => item.startsWith("_pa-"))).toEqual([]);
    const tooMany = Array.from({ length: 11 }, (): PaAttachment => ({
      type: "image",
      id: createPendingAttachmentId(),
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 1,
    }));
    await expect(store.claim("fake:main", "session", "input", "", tooMany, caps)).rejects.toThrow(
      "Too many images",
    );
  });
  it.effect(
    "claims an original PDF once, survives pending cleanup and reload, and binds history by receipt",
    () =>
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pa-assets-"));
        tempDirs.push(dir);
        const id = createPendingAttachmentId(".pdf");
        const bytes = Buffer.from("%PDF-1.4\noriginal");
        NodeFS.writeFileSync(NodePath.join(dir, id + ".pdf"), bytes);
        const pdf: PaAttachment = {
          type: "file",
          id,
          name: "paper.pdf",
          mimeType: "application/pdf",
          sizeBytes: bytes.length,
        };
        const session = { botId: "fake:main", sessionId: "session" };
        const placeholder = { ...pdf, id: "external-file", unavailable: true };
        const row: PaMessage = {
          id: "row-5",
          rowId: 5,
          role: "user",
          text: "",
          timestamp: null,
          rowKind: "message",
          attachments: [placeholder],
        };
        const { engine } = makeEngine({
          capabilities: { ...CORE_ONLY, attachments: { images: true, files: true, maxImages: 10 } },
          sendMessage: async (_agent, sessionId, _text, options) => {
            expect(NodeFS.readFileSync(options.attachments![0]!.path)).toEqual(bytes);
            options.onStaged?.([{ key: "external-file", fileRef: "@file:paper.pdf" }]);
            return { kind: "turn", sessionId, submissionId: "receipt" };
          },
          getMessages: async () => ({ messages: [row], nextCursor: null, reset: false }),
        });
        const store = new PaAttachmentStore(dir, dir);
        const make = (attachmentStore: PaAttachmentStore) =>
          makePaService({ instances: [engine], store: new PaStore(dir), attachmentStore });
        const service = make(store);
        const input = { ...session, text: "", inputId: "one", attachments: [pdf] };
        const result = yield* service.sendMessage(input);
        expect(result.attachments?.[0]?.id).toMatch(/^_pa-/);
        expect(
          store.queue(session.botId, session.sessionId, [
            { id: "before-receipt", inputId: "one", text: "", status: "queued", canSteer: true },
          ])[0],
        ).toMatchObject({ attachmentCount: 1, canSteer: false });
        const copied = { ...row, id: "row-200", rowId: 200 };
        const augmented = { ...row, attachments: [placeholder, { ...placeholder, id: "extra" }] };
        expect(store.hydrate(session.botId, session.sessionId, [row, copied])).toEqual([
          row,
          copied,
        ]);
        expect(store.hydrate(session.botId, session.sessionId, [augmented])).toEqual([augmented]);
        expect(
          (yield* service.getMessages({ ...session, cursor: "older" })).messages[0]?.attachments,
        ).toEqual(result.attachments);
        expect(
          new PaAttachmentStore(dir, dir).find(session.botId, session.sessionId, "one")?.rowId,
        ).toBeUndefined();
        expect(store.hydrate(session.botId, session.sessionId, [copied])[0]?.attachments).toEqual(
          result.attachments,
        );
        const real = { ...row, id: "row-100", rowId: 100, submissionId: "receipt" };
        expect(store.hydrate(session.botId, session.sessionId, [real])[0]?.attachments).toEqual(
          result.attachments,
        );
        expect(
          new PaAttachmentStore(dir, dir).find(session.botId, session.sessionId, "one")?.rowId,
        ).toBe(100);
        expect(store.hydrate(session.botId, session.sessionId, [copied])).toEqual([copied]);
        store.record(session.botId, session.sessionId, "receipt", { rowId: 9 });
        expect(store.find(session.botId, session.sessionId, "one")?.rowId).toBe(9);
        store.record(session.botId, session.sessionId, "one", { rowId: 5 });
        sweepStalePendingAttachments({ attachmentsDir: dir, nowMs: Number.MAX_SAFE_INTEGER });
        expect(resolveAttachmentPathById({ attachmentsDir: dir, attachmentId: id })).toBeNull();
        expect((yield* service.sendMessage(input)).attachments).toEqual(result.attachments);
        const reloaded = make(new PaAttachmentStore(dir, dir));
        expect((yield* reloaded.getMessages(session)).messages[0]).toEqual({
          ...row,
          attachments: result.attachments,
        });
        expect(
          (yield* reloaded.getMessages({ ...session, sessionId: "other" })).messages[0],
        ).toEqual(row);
        expect(
          store.hydrate(session.botId, session.sessionId, [{ ...row, id: "row-6", rowId: 6 }])[0]
            ?.attachments,
        ).toEqual([placeholder]);
        expect(
          yield* Effect.flip(
            service.sendMessage({
              ...input,
              attachments: [{ ...pdf, id: createPendingAttachmentId(".pdf") }],
            }),
          ),
        ).toMatchObject({ reason: "Conflict" });
        expect(yield* Effect.flip(service.sendMessage({ ...session, text: "   " }))).toMatchObject({
          reason: "Invalid",
        });
        expect(
          yield* Effect.flip(
            service.sendMessage({ ...input, inputId: "another", attachments: result.attachments! }),
          ),
        ).toMatchObject({ reason: "Invalid" });
      }),
  );
  it.effect("lists every engine's agents with local metadata, pinned first then most recent", () =>
    Effect.gen(function* () {
      const { engine } = makeEngine();
      const { service, store } = makeService([engine]);
      store.updateBotMeta("fake:helper", { displayName: "Renamed", lastReadAt: 40 });

      const result = yield* service.listBots();
      expect(result.instances).toEqual([
        expect.objectContaining({ instanceId: "fake", online: true, botCount: 2, error: null }),
      ]);
      expect(result.bots.map((b) => [b.botId, b.name, b.pinned, b.unread])).toEqual([
        ["fake:main", "Fake", true, false],
        ["fake:helper", "Renamed", false, true],
      ]);
      expect(result.bots[0]).toMatchObject({
        engineLabel: "Fake",
        driver: "fake",
        agentRef: "main",
      });
    }),
  );

  it.effect(
    "coalesces roster reads, keeps offline bots and disposes their feeds only on a confirmed removal",
    () =>
      Effect.gen(function* () {
        const gate = Promise.withResolvers<ReadonlyArray<PaAgentRow>>();
        const started = Promise.withResolvers<void>();
        const listAgents = vi.fn(() => {
          started.resolve();
          return gate.promise;
        });
        const released = vi.fn();
        const { engine } = makeEngine({
          listAgents,
          subscribeSession: async () => released,
          config: {
            get: async () => ({ sections: [] }),
            patch: async () => ({
              sections: [
                {
                  id: "profile",
                  label: "Profile",
                  kind: "options",
                  fields: [
                    {
                      id: "description",
                      label: "Description",
                      kind: "text",
                      value: "Saved description",
                    },
                  ],
                },
              ],
            }),
          },
          models: {
            getCatalog: async () => {
              throw new Error("unused");
            },
            select: async () => ({
              status: "applied",
              current: { model: "saved-model", provider: "p" },
            }),
          },
        });
        const { service } = makeService([engine]);
        const first = yield* service.listBots().pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => started.promise);
        const second = yield* service.listBots().pipe(Effect.forkChild({ startImmediately: true }));
        gate.resolve([row("main")]);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(listAgents).toHaveBeenCalledTimes(1);
        yield* service
          .subscribeSession({ botId: "fake:main", sessionId: "s" })
          .pipe(Stream.take(1), Stream.runDrain);
        yield* service.updateBotMeta({ botId: "fake:main", name: "Saved", avatarColor: "#223344" });
        yield* service.selectBotModel({ botId: "fake:main", model: "saved-model", provider: "p" });
        yield* service.patchBotConfig({
          botId: "fake:main",
          sectionId: "profile",
          value: { kind: "options", values: { description: "Saved description" } },
        });
        listAgents.mockRejectedValueOnce(new Error("temporarily offline"));
        expect((yield* service.listBots()).bots).toMatchObject([
          {
            botId: "fake:main",
            online: false,
            name: "Saved",
            description: "Saved description",
            avatarColor: "#223344",
            model: "saved-model",
            provider: "p",
          },
        ]);
        expect(released).not.toHaveBeenCalled();
        listAgents.mockResolvedValueOnce([]);
        expect((yield* service.listBots()).bots).toEqual([]);
        expect(released).toHaveBeenCalledOnce();
        service.dispose();
      }),
  );

  it.effect(
    "settles every alias of a request and reclaims unknown or authoritatively idle detached turns",
    () =>
      Effect.gen(function* () {
        const pending = new Set<() => void>();
        const releases = vi.fn();
        const { engine } = makeEngine({
          sendMessage: async (_ref, sessionId, text) => ({
            kind: "turn",
            sessionId,
            unknown: text === "lost",
          }),
          requests: { respond: async () => {} },
          listAgents: async () => [
            row("main", { activeSessions: new Map([["canonical", "idle"]]) }),
          ],
          subscribeSession: async (_ref, sessionId, subscriber) => {
            subscriber.onCanonicalSession?.("canonical");
            subscriber.onEvent({
              type: "snapshot",
              snapshotRequired: false,
              sessionId,
              running: false,
              openRequests: [
                { requestId: "r", title: "Answer", detail: "", kind: "approval", scope: "session" },
              ],
            });
            return releases;
          },
        });
        const { store } = makeService([]);
        const service = makePaService({
          store,
          instances: [engine],
          hub: {
            capacity: 4,
            lingerMs: 1,
            reconnectDelaysMs: [],
            timers: {
              set: (fn) => {
                pending.add(fn);
                return fn;
              },
              clear: (fn) => pending.delete(fn as () => void),
            },
          },
        });
        const botId = "fake:main";
        for (const sessionId of ["root", "canonical"])
          yield* service
            .subscribeSession({ botId, sessionId })
            .pipe(Stream.take(1), Stream.runDrain);
        const bot = () => service.listBots().pipe(Effect.map((result) => result.bots[0]));
        expect(yield* bot()).toMatchObject({ awaiting: true });
        yield* service.respondRequest({
          botId,
          sessionId: "root",
          requestId: "r",
          decision: "once",
        });
        expect(yield* bot()).toMatchObject({ awaiting: false });
        expect(pending.size).toBe(2);
        yield* service.sendMessage({ botId, sessionId: "root", text: "lost" });
        expect(pending.size).toBe(2);
        yield* service.sendMessage({ botId, sessionId: "canonical", text: "go" });
        expect(pending.size).toBe(1);
        expect(yield* bot()).toMatchObject({ running: false });
        expect(pending.size).toBe(2);
        for (const dispose of pending) dispose();
        expect(releases).toHaveBeenCalledTimes(2);
        service.dispose();
      }),
  );

  it.effect("reports an engine that does not answer as offline without failing the roster", () =>
    Effect.gen(function* () {
      const { engine: healthy } = makeEngine();
      const { engine: broken } = makeEngine({
        instanceId: "down",
        listAgents: async () => {
          throw new PaError({ reason: "Unavailable", message: "engine not installed" });
        },
      });
      const { service } = makeService([healthy, broken]);
      const result = yield* service.listBots();
      expect(result.instances.map((i) => [i.instanceId, i.online, i.error])).toEqual([
        ["fake", true, null],
        ["down", false, "engine not installed"],
      ]);
      expect(result.bots.every((b) => b.instanceId === "fake")).toBe(true);
    }),
  );

  it.effect("rejects malformed ids, unknown engines and absent facets with neutral reasons", () =>
    Effect.gen(function* () {
      const { engine } = makeEngine();
      const { service } = makeService([engine]);
      expect(
        (yield* Effect.flip(service.getMessages({ botId: "nope", sessionId: "s" }))).reason,
      ).toBe("Invalid");
      expect((yield* Effect.flip(service.listSessions({ botId: "other:main" }))).reason).toBe(
        "NotFound",
      );
      expect((yield* Effect.flip(service.listSessions({ botId: "fake:BAD" }))).reason).toBe(
        "Invalid",
      );
      expect(
        (yield* Effect.flip(
          service.mutateSession({
            botId: "fake:main",
            sessionId: "s",
            action: "rename",
            requestId: "r",
            title: "T",
          }),
        )).reason,
      ).toBe("Unsupported");
      expect((yield* Effect.flip(service.getBotModels({ botId: "fake:main" }))).reason).toBe(
        "Unsupported",
      );
      expect(
        (yield* Effect.flip(service.interruptSession({ botId: "fake:main", sessionId: "s" })))
          .reason,
      ).toBe("Unsupported");
      expect(
        (yield* Effect.flip(service.createBot({ instanceId: "fake", agentRef: "new" }))).reason,
      ).toBe("Unsupported");
    }),
  );

  it.effect("keeps the primary session and read marker locally", () =>
    Effect.gen(function* () {
      const { engine } = makeEngine();
      const { service, store } = makeService([engine]);
      const created = yield* service.createSession({ botId: "fake:main" });
      expect(created).toMatchObject({ sessionId: "s-new", isPrimary: true });
      const listed = yield* service.listSessions({ botId: "fake:main" });
      expect(listed.primarySessionId).toBe("s-new");
      expect(listed.sessions).toEqual([
        expect.objectContaining({ sessionId: "s-new", isPrimary: true, messageCount: 0 }),
      ]);
      yield* service.updateBotMeta({ botId: "fake:main", markRead: true, pinned: false });
      expect(store.getBotMeta("fake:main")).toMatchObject({ pinned: false });
      expect(store.getBotMeta("fake:main").lastReadAt).toBeTypeOf("number");
    }),
  );

  it.effect("treats any command as manage when the engine declares no command policy", () =>
    Effect.gen(function* () {
      const { engine } = makeEngine();
      const { engine: withPolicy } = makeEngine({
        instanceId: "policy",
        commands: { list: async () => [], requiredScope: () => "operate" },
      });
      const { service } = makeService([engine, withPolicy]);
      expect(yield* service.requiredScopeForMessage("fake:main", "hello")).toBe("operate");
      expect(yield* service.requiredScopeForMessage("fake:main", "  /status")).toBe("manage");
      expect(yield* service.requiredScopeForMessage("policy:main", "/status")).toBe("operate");
    }),
  );

  it.effect("streams a session with resume tokens and fans command output out as a notice", () =>
    Effect.gen(function* () {
      const { engine, feeds } = makeEngine();
      const { service } = makeService([engine]);
      // The listener is registered by the time its snapshot is read, so driving the feed there is safe.
      const events = yield* service.subscribeSession({ botId: "fake:main", sessionId: "s-1" }).pipe(
        Stream.tap((event) =>
          event.type !== "snapshot"
            ? Effect.void
            : Effect.sync(() =>
                feeds[0]!.onEvent({
                  type: "text.delta",
                  sessionId: "s-1",
                  text: "Hi",
                  role: "answer",
                }),
              ).pipe(
                Effect.andThen(
                  service.sendMessage({
                    botId: "fake:main",
                    sessionId: "s-1",
                    text: "/status",
                    inputId: "i-1",
                  }),
                ),
                Effect.tap((result) =>
                  Effect.sync(() =>
                    expect(result).toEqual({
                      kind: "output",
                      sessionId: "s-1",
                      output: "ran /status",
                    }),
                  ),
                ),
              ),
        ),
        Stream.take(3),
        Stream.runCollect,
      );
      expect(Array.from(events)).toEqual([
        expect.objectContaining({ type: "snapshot", snapshotRequired: false }),
        expect.objectContaining({ type: "text.delta", text: "Hi" }),
        expect.objectContaining({
          type: "notice",
          message: "ran /status",
          persistent: true,
          inputId: "i-1",
        }),
      ]);
      expect(Array.from(events, (e) => Number(e.resumeToken.split(":")[1]))).toEqual([0, 1, 2]);
    }),
  );

  it.effect("cuts off a reader that falls behind instead of dropping events silently", () =>
    Effect.gen(function* () {
      const { engine, feeds } = makeEngine();
      const { service } = makeService([engine]);
      const result = yield* Effect.exit(
        service.subscribeSession({ botId: "fake:main", sessionId: "s-1" }).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (event.type !== "snapshot") return;
              // The reader stalls on its first event while the engine keeps producing.
              for (let i = 0; i < 3_000; i += 1) {
                feeds[0]!.onEvent({ type: "reasoning.delta", sessionId: "s-1", text: "x" });
              }
            }),
          ),
          Stream.runDrain,
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(Exit.isFailure(result) && JSON.stringify(result.cause)).toContain("fell behind");
    }),
  );

  it.effect(
    "serves a legitimate catch-up longer than 1,024 events without cutting the reader",
    () =>
      Effect.gen(function* () {
        const { engine, feeds } = makeEngine();
        const { service } = makeService([engine]);
        const input = { botId: "fake:main", sessionId: "s-1" };
        const [snapshot] = Array.from(
          yield* service.subscribeSession(input).pipe(Stream.take(1), Stream.runCollect),
        );
        for (let i = 0; i < 1_200; i += 1) {
          feeds[0]!.onEvent({ type: "reasoning.delta", sessionId: "s-1", text: "x" });
        }
        const resumed = Array.from(
          yield* service
            .subscribeSession({ ...input, resumeToken: snapshot!.resumeToken })
            .pipe(Stream.take(1_201), Stream.runCollect),
        );
        service.dispose();
        expect(resumed[0]).toMatchObject({ type: "snapshot", snapshotRequired: false });
        expect(resumed).toHaveLength(1_201);
        expect(resumed.at(-1)).toMatchObject({ type: "reasoning.delta" });
      }),
  );

  it.effect(
    "keeps detached turns and requests in the roster and marks only completions unread",
    () =>
      Effect.gen(function* () {
        const { engine, feeds } = makeEngine();
        const { service, store } = makeService([engine]);
        const botId = "fake:main";
        const summary = () =>
          service
            .listBots()
            .pipe(Effect.map((result) => result.bots.find((bot) => bot.botId === botId)));
        store.updateBotMeta(botId, { lastReadAt: 1 });
        for (const sessionId of ["s1", "s2"]) {
          yield* service
            .subscribeSession({ botId, sessionId })
            .pipe(Stream.take(1), Stream.runDrain);
        }
        expect(yield* summary()).toMatchObject({ running: false, awaiting: false, unread: false });
        yield* service.sendMessage({ botId, sessionId: "s1", text: "start" });
        expect(yield* summary()).toMatchObject({ running: true, unread: false });
        feeds[0]!.onEvent({
          type: "text.delta",
          role: "commentary",
          text: "thinking",
          sessionId: "s1",
        });
        feeds[1]!.onEvent({ type: "turn.started", sessionId: "s2" });
        for (const kind of ["approval", "clarify", "secret"] as const) {
          feeds[0]!.onEvent({
            type: "request.opened",
            sessionId: "s1",
            request: { requestId: "r", kind, title: "Input", detail: "" },
          });
          expect(yield* summary()).toMatchObject({ running: true, awaiting: true, unread: false });
          feeds[0]!.onEvent({ type: "request.resolved", requestId: "r", sessionId: "s1" });
        }
        feeds[0]!.onEvent({
          type: "turn.completed",
          status: "complete",
          sessionId: "s1",
          replyId: "s1-turn",
        });
        expect(yield* summary()).toMatchObject({ running: true, awaiting: false, unread: false });
        feeds[1]!.onEvent({
          type: "turn.completed",
          status: "complete",
          sessionId: "s2",
          replyId: "s2-turn",
        });
        expect(yield* summary()).toMatchObject({ running: false, awaiting: false, unread: true });
        yield* service.updateBotMeta({ botId, markRead: true });
        expect(yield* summary()).toMatchObject({ unread: false });
        service.dispose();
      }),
  );

  it.effect(
    "uses transcript identities for a legacy feed that replays unaddressed completions",
    () =>
      Effect.gen(function* () {
        let rowId = 1;
        const { engine, feeds } = makeEngine({
          getMessages: async () => ({
            messages: [
              {
                id: "row-" + rowId,
                role: "assistant",
                text: "Done",
                timestamp: rowId * 1_000,
                rowKind: "message",
              },
            ],
            nextCursor: null,
            reset: false,
          }),
        });
        const { service } = makeService([engine]);
        const input = { botId: "fake:main", sessionId: "s1" };
        const unread = () =>
          service.listBots().pipe(Effect.map((result) => result.bots[0]?.unread));
        yield* service.subscribeSession(input).pipe(Stream.take(1), Stream.runDrain);
        yield* service.getMessages(input);
        expect(yield* unread()).toBe(true);
        yield* service.updateBotMeta({
          botId: input.botId,
          markRead: true,
          seenReply: { sessionId: input.sessionId, id: "row-1" },
        });
        const complete = () =>
          feeds[0]!.onEvent({
            type: "turn.completed",
            sessionId: input.sessionId,
            status: "complete",
            text: "Done",
          });
        complete();
        expect(yield* unread()).toBe(false);
        rowId = 2;
        complete();
        expect(yield* unread()).toBe(true);
        service.dispose();
      }),
  );

  it.effect("drops an answered request from the shared feed before the engine settles it", () =>
    Effect.gen(function* () {
      const answered: string[] = [];
      const { engine, feeds } = makeEngine({
        requests: {
          respond: async (_ref, _sessionId, answer) => {
            answered.push(answer.requestId);
          },
        },
      });
      const { service } = makeService([engine]);
      const input = { botId: "fake:main", sessionId: "s-1" };
      yield* service.subscribeSession(input).pipe(Stream.take(1), Stream.runDrain);
      feeds[0]!.onEvent({ type: "turn.started", sessionId: "s-1" });
      for (const requestId of ["r1", "r2"]) {
        feeds[0]!.onEvent({
          type: "request.opened",
          sessionId: "s-1",
          request: { requestId, kind: "approval", title: "Run?", detail: "" },
        });
      }

      yield* service.respondRequest({ ...input, requestId: "r1", decision: "once" });
      const [afterAnswer] = Array.from(
        yield* service.subscribeSession(input).pipe(Stream.take(1), Stream.runCollect),
      );
      expect(answered).toEqual(["r1"]);
      expect(afterAnswer).toMatchObject({
        type: "snapshot",
        openRequests: [expect.objectContaining({ requestId: "r2" })],
      });

      feeds[0]!.onEvent({ type: "turn.completed", sessionId: "s-1", status: "complete" });
      const [afterTurn] = Array.from(
        yield* service.subscribeSession(input).pipe(Stream.take(1), Stream.runCollect),
      );
      service.dispose();
      expect(afterTurn).toMatchObject({ type: "snapshot", running: false, openRequests: [] });
    }),
  );
  it.effect(
    "pages sessions and messages, listing a fresh primary only on the unfiltered first page",
    () =>
      Effect.gen(function* () {
        const sessionCalls: unknown[] = [];
        const messageCalls: unknown[] = [];
        const { engine } = makeEngine({
          listSessions: async (_ref, options) => {
            sessionCalls.push(options);
            return { sessions: [], nextCursor: options.cursor ? null : "c-2" };
          },
          getMessages: async (_ref, _sessionId, options) => {
            messageCalls.push(options);
            return {
              messages: [
                {
                  id: "row-1",
                  role: "user",
                  text: "hi",
                  timestamp: 1,
                  rowKind: "message",
                  rowId: 1,
                },
              ],
              nextCursor: null,
              reset: options.cursor !== undefined,
            };
          },
        });
        const { service } = makeService([engine]);
        yield* service.createSession({ botId: "fake:main", requestId: "create-1" });

        const first = yield* service.listSessions({ botId: "fake:main" });
        expect(first.nextCursor).toBe("c-2");
        expect(first.sessions.map((s) => s.sessionId)).toEqual(["s-new"]);
        const searched = yield* service.listSessions({ botId: "fake:main", query: "  plan " });
        expect(searched.sessions).toEqual([]);
        const next = yield* service.listSessions({ botId: "fake:main", cursor: "c-2", limit: 5 });
        expect(next).toMatchObject({ sessions: [], nextCursor: null });
        expect(sessionCalls).toEqual([
          { query: undefined, cursor: undefined, limit: 30 },
          { query: "plan", cursor: undefined, limit: 30 },
          { query: undefined, cursor: "c-2", limit: 5 },
        ]);

        const latest = yield* service.getMessages({ botId: "fake:main", sessionId: "s-new" });
        expect(latest).toEqual({
          messages: [expect.objectContaining({ id: "row-1", rowId: 1 })],
          nextCursor: null,
        });
        const older = yield* service.getMessages({
          botId: "fake:main",
          sessionId: "s-new",
          cursor: "m-1",
        });
        expect(older.reset).toBe(true);
        expect(messageCalls).toEqual([
          { limit: 120, cursor: undefined },
          { limit: 120, cursor: "m-1" },
        ]);
      }),
  );

  it.effect("passes a create's idempotency key through and fans a rename out to viewers", () =>
    Effect.gen(function* () {
      const creates: unknown[] = [];
      const renames: unknown[] = [];
      const { engine } = makeEngine({
        capabilities: { ...CORE_ONLY, sessions: { create: true, rename: true } },
        createSession: async (_ref, options) => {
          creates.push(options);
          return {
            sessionId: "s-new",
            title: "New conversation",
            source: "gui",
            model: null,
            messageCount: 0,
            running: false,
            startedAt: 1,
            lastActivityAt: 1,
          };
        },
        renameSession: async (_ref, sessionId, input) => {
          renames.push({ sessionId, ...input });
          return { title: input.title };
        },
      });
      const { service } = makeService([engine]);
      yield* service.createSession({ botId: "fake:main", requestId: "create-1", title: "Plan" });
      expect(creates).toEqual([{ title: "Plan", requestId: "create-1" }]);

      const input = { botId: "fake:main", sessionId: "s-1" };
      const [attached] = Array.from(
        yield* service.subscribeSession(input).pipe(Stream.take(1), Stream.runCollect),
      );
      const renamed = yield* service.mutateSession({
        ...input,
        action: "rename",
        requestId: "rename-1",
        title: "  Trip plan  ",
      });
      expect(renamed).toEqual({ sessionId: "s-1", title: "Trip plan" });
      expect(renames).toEqual([{ sessionId: "s-1", title: "Trip plan", requestId: "rename-1" }]);
      const blank = yield* Effect.flip(
        service.mutateSession({ ...input, action: "rename", requestId: "rename-2", title: "  " }),
      );
      expect(blank.reason).toBe("Invalid");

      const resumed = Array.from(
        yield* service
          .subscribeSession({ ...input, resumeToken: attached!.resumeToken })
          .pipe(Stream.take(2), Stream.runCollect),
      );
      service.dispose();
      expect(resumed).toEqual([
        expect.objectContaining({ type: "snapshot", snapshotRequired: false }),
        expect.objectContaining({ type: "session.updated", title: "Trip plan" }),
      ]);
    }),
  );

  it.effect("needs manage only to answer a credential prompt, judged by the engine's record", () =>
    Effect.gen(function* () {
      const kinds: Record<string, "approval" | "clarify" | "secret"> = {
        r1: "approval",
        r2: "secret",
      };
      const { engine } = makeEngine({
        requests: {
          kindOf: (_ref, _sessionId, requestId) => kinds[requestId] ?? null,
          respond: async () => undefined,
        },
      });
      const { engine: withoutKinds, feeds: otherFeeds } = makeEngine({
        instanceId: "plain",
        requests: { respond: async () => undefined },
      });
      const { service } = makeService([engine, withoutKinds]);
      const scope = (botId: string, requestId: string) =>
        service.requiredScopeForRequest({ botId, sessionId: "s-1", requestId });
      expect(yield* scope("fake:main", "r1")).toBe("operate");
      expect(yield* scope("fake:main", "r2")).toBe("manage");
      expect(yield* scope("fake:main", "unknown")).toBe("operate");

      // An engine without its own record falls back to what the shared feed opened.
      const input = { botId: "plain:main", sessionId: "s-1" };
      yield* service.subscribeSession(input).pipe(Stream.take(1), Stream.runDrain);
      otherFeeds[0]!.onEvent({
        type: "request.opened",
        sessionId: "s-1",
        request: { requestId: "r9", kind: "secret", title: "Key", detail: "", fields: [] },
      });
      expect(yield* scope("plain:main", "r9")).toBe("manage");
      service.dispose();
    }),
  );

  it.effect("steers and manages the queue only where the engine declares them", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const facets = {
        steerSession: async (_ref: string, _sessionId: string, text: string) => {
          calls.push(`steer:${text}`);
          return { status: "notDelivered" } as const;
        },
        manageQueuedItem: async (
          _ref: string,
          _sessionId: string,
          input: { readonly itemId: string; readonly action: string },
        ) => {
          calls.push(`${input.action}:${input.itemId}`);
        },
      };
      const { engine: bare } = makeEngine(facets);
      const { engine: queueOnly } = makeEngine({
        ...facets,
        instanceId: "queue",
        capabilities: { ...CORE_ONLY, execution: { ...CORE_ONLY.execution, queue: true } },
      });
      const { engine: full } = makeEngine({
        ...facets,
        instanceId: "full",
        capabilities: {
          ...CORE_ONLY,
          execution: { ...CORE_ONLY.execution, queue: true, steer: true },
        },
      });
      const { service } = makeService([bare, queueOnly, full]);
      const session = (botId: string) => ({ botId, sessionId: "s-1" });

      expect(
        (yield* Effect.flip(service.steerSession({ ...session("fake:main"), text: "hi" }))).reason,
      ).toBe("Unsupported");
      expect(
        (yield* Effect.flip(
          service.manageQueuedItem({ ...session("fake:main"), itemId: "q", action: "cancel" }),
        )).reason,
      ).toBe("Unsupported");
      yield* service.manageQueuedItem({ ...session("queue:main"), itemId: "q1", action: "cancel" });
      expect(
        (yield* Effect.flip(
          service.manageQueuedItem({ ...session("queue:main"), itemId: "q1", action: "steer" }),
        )).reason,
      ).toBe("Unsupported");
      expect(yield* service.steerSession({ ...session("full:main"), text: "nudge" })).toEqual({
        status: "notDelivered",
      });
      yield* service.manageQueuedItem({ ...session("full:main"), itemId: "q2", action: "steer" });
      expect(calls).toEqual(["cancel:q1", "steer:nudge", "steer:q2"]);
    }),
  );
});
