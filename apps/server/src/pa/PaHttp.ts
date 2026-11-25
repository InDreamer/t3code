import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { eventStreamResponse } from "../eventStreamResponse.ts";
import * as ServerHttp from "../http.ts";
import { requestUrl } from "../requestUrl.ts";
import { layerLive as layerPaServiceLive, PaService, type PaServiceShape } from "./PaService.ts";
import { isValidPaSessionId, parsePaBotId, type PaStreamEvent } from "./types.ts";

const PA_PREFIX = "/api/pa";

const HEX_COLOR_SCHEMA = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/));
const AVATAR_SHAPE_SCHEMA = Schema.Literals(["blob", "pumpkin", "cloud", "drop", "pill", "circle"]);
const ADAPTER_KIND_SCHEMA = Schema.Literals(["hermes", "openclaw"]);

const CreateBotBodySchema = Schema.Struct({
  adapter: ADAPTER_KIND_SCHEMA,
  profile: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  avatarColor: Schema.optional(HEX_COLOR_SCHEMA),
  avatarShape: Schema.optional(AVATAR_SHAPE_SCHEMA),
  pinned: Schema.optional(Schema.Boolean),
  soul: Schema.optional(Schema.String.check(Schema.isMaxLength(64_000))),
  model: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  provider: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
});

const UpdateBotBodySchema = Schema.Struct({
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  avatarColor: Schema.optional(HEX_COLOR_SCHEMA),
  avatarShape: Schema.optional(AVATAR_SHAPE_SCHEMA),
  pinned: Schema.optional(Schema.Boolean),
  soul: Schema.optional(Schema.String.check(Schema.isMaxLength(64_000))),
  model: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  provider: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
  confirmExpensiveModel: Schema.optional(Schema.Boolean),
  disabledSkills: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(160)))),
  enabledToolsets: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(160)))),
  enabledMcpServers: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(160)))),
  markRead: Schema.optional(Schema.Boolean),
});

const CronMutationBodySchema = Schema.Struct({
  action: Schema.Literals(["add", "remove", "pause", "resume"]),
  jobId: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  schedule: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  prompt: Schema.optional(Schema.String.check(Schema.isMaxLength(16_000))),
  deliver: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});

const CreateSessionBodySchema = Schema.Struct({
  setPrimary: Schema.optional(Schema.Boolean),
});

const SendMessageBodySchema = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64_000)),
  inputId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
});

const RespondRequestBodySchema = Schema.Struct({
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  kind: Schema.Literals(["approval", "clarify"]),
  channel: Schema.optional(Schema.Literals(["canonical", "server_request"])),
  executionGeneration: Schema.optional(Schema.Number),
  decision: Schema.optional(Schema.Literals(["once", "always", "deny", "session"])),
  answer: Schema.optional(Schema.String.check(Schema.isMaxLength(16_000))),
  answers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

class PaRouteError extends Schema.TaggedError<PaRouteError, { readonly brand: unique symbol }>()(
  "PaRouteError",
  {
    status: Schema.Number,
    message: Schema.String,
  },
) {}

const tryPa = <A>(thunk: () => Promise<A>) =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) =>
      new PaRouteError({
        status: 502,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

const authenticatePaRoute = Effect.fnUntraced(function* (scope: AuthEnvironmentScope) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(scope)) {
    return yield* failEnvironmentScopeRequired(scope);
  }
  return session;
});

const jsonResponse = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const errorResponse = (error: PaRouteError) => jsonResponse({ error: error.message }, error.status);

const decodeJsonBody = Effect.fn("decodeJsonBody")(function* <A, I>(schema: Schema.Codec<A, I>) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const raw = yield* request.json.pipe(
    Effect.mapError((err) => {
      const reason =
        err && typeof err === "object" && "reason" in err ? String(err.reason) : undefined;
      if (reason === "MaxBodySize") {
        return new PaRouteError({ status: 413, message: "Request body exceeds maximum size" });
      }
      return new PaRouteError({ status: 400, message: "Invalid JSON request body" });
    }),
  );
  return yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
    Effect.mapError(
      (err) =>
        new PaRouteError({ status: 400, message: `Invalid request payload: ${err.message}` }),
    ),
  );
});

const respondPaJson = <A>(
  thunk: () => Promise<A>,
  mapBody: (value: A) => unknown = (value) => value,
  status = 200,
) =>
  tryPa(thunk).pipe(
    Effect.map((data) => jsonResponse(mapBody(data), status)),
    Effect.catchTags({
      PaRouteError: (err) => Effect.succeed(errorResponse(err)),
    }),
  );

function decodePathSegments(pathname: string): ReadonlyArray<string> | null {
  const subPath = pathname.slice(PA_PREFIX.length).replace(/\/+$/, "") || "/";
  const parts = subPath.split("/").filter(Boolean);
  const decoded: string[] = [];
  for (const part of parts) {
    try {
      decoded.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }
  return decoded;
}

const makePaRequestHandler = Effect.fn("makePaRequestHandler")(
  function* (pa: PaServiceShape) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const urlOption = requestUrl(request);
    if (Option.isNone(urlOption)) {
      return jsonResponse({ error: "Bad request" }, 400);
    }
    const url = urlOption.value;
    const method = request.method.toUpperCase();
    const segments = decodePathSegments(url.pathname);
    if (segments === null) {
      return jsonResponse({ error: "Malformed URL encoding" }, 400);
    }

    // GET /api/pa/health
    if (method === "GET" && segments.length === 1 && segments[0] === "health") {
      yield* authenticatePaRoute(AuthOrchestrationReadScope);
      return yield* respondPaJson(() => pa.getHealth());
    }

    // GET /api/pa/bots
    if (method === "GET" && segments.length === 1 && segments[0] === "bots") {
      yield* authenticatePaRoute(AuthOrchestrationReadScope);
      return yield* respondPaJson(() => pa.listBots());
    }

    // POST /api/pa/bots (creating a profile mirrors host credentials -> requires providers:manage)
    if (method === "POST" && segments.length === 1 && segments[0] === "bots") {
      yield* authenticatePaRoute(AuthProvidersManageScope);
      return yield* decodeJsonBody(CreateBotBodySchema).pipe(
        Effect.flatMap((input) =>
          tryPa(() => pa.createBot(input)).pipe(Effect.map((bot) => jsonResponse({ bot }, 201))),
        ),
        Effect.catchTags({
          PaRouteError: (err) => Effect.succeed(errorResponse(err)),
        }),
      );
    }

    // Routes scoped to /api/pa/bots/:botId/...
    if (segments[0] === "bots" && segments.length >= 2) {
      const botId = segments[1]!;
      if (!parsePaBotId(botId)) {
        return jsonResponse({ error: `Invalid bot id "${botId}"` }, 400);
      }

      if (method === "GET" && segments.length === 2) {
        yield* authenticatePaRoute(AuthOrchestrationReadScope);
        return yield* respondPaJson(
          () => pa.getBotDetail(botId),
          (bot) => ({ bot }),
        );
      }

      // POST /api/pa/bots/:botId/update (CORS-safe on Electron & cross-origin web; PATCH not in httpCors)
      if (method === "POST" && segments.length === 3 && segments[2] === "update") {
        // Authenticate with orchestration:operate first; escalate to providers:manage if mutating profile config.
        const session = yield* authenticatePaRoute(AuthOrchestrationOperateScope);
        return yield* Effect.gen(function* () {
          const patch = yield* decodeJsonBody(UpdateBotBodySchema);
          const mutatesProviderConfig =
            patch.soul !== undefined ||
            patch.description !== undefined ||
            patch.model !== undefined ||
            patch.provider !== undefined ||
            patch.disabledSkills !== undefined ||
            patch.enabledToolsets !== undefined ||
            patch.enabledMcpServers !== undefined;
          if (mutatesProviderConfig && !session.scopes.includes(AuthProvidersManageScope)) {
            return yield* failEnvironmentScopeRequired(AuthProvidersManageScope);
          }
          const bot = yield* tryPa(() => pa.updateBot(botId, patch));
          return jsonResponse({ bot });
        }).pipe(
          Effect.catchTags({
            PaRouteError: (err) => Effect.succeed(errorResponse(err)),
          }),
        );
      }

      // POST /api/pa/bots/:botId/cron (manages persistent scheduled execution -> requires providers:manage)
      if (method === "POST" && segments.length === 3 && segments[2] === "cron") {
        yield* authenticatePaRoute(AuthProvidersManageScope);
        return yield* decodeJsonBody(CronMutationBodySchema).pipe(
          Effect.flatMap((input) =>
            tryPa(() => pa.manageCron(botId, input)).pipe(
              Effect.map((cronJobs) => jsonResponse({ cronJobs })),
            ),
          ),
          Effect.catchTags({
            PaRouteError: (err) => Effect.succeed(errorResponse(err)),
          }),
        );
      }

      if (method === "GET" && segments.length === 3 && segments[2] === "commands") {
        yield* authenticatePaRoute(AuthOrchestrationReadScope);
        return yield* respondPaJson(
          () => pa.listSlashCommands(botId),
          (commands) => ({ commands }),
        );
      }

      if (method === "GET" && segments.length === 3 && segments[2] === "sessions") {
        yield* authenticatePaRoute(AuthOrchestrationReadScope);
        return yield* respondPaJson(() => pa.listSessions(botId));
      }

      if (method === "POST" && segments.length === 3 && segments[2] === "sessions") {
        yield* authenticatePaRoute(AuthOrchestrationOperateScope);
        return yield* decodeJsonBody(CreateSessionBodySchema).pipe(
          Effect.flatMap((body) =>
            tryPa(() => pa.createSession(botId, { setPrimary: body.setPrimary !== false })).pipe(
              Effect.map((session) => jsonResponse({ session }, 201)),
            ),
          ),
          Effect.catchTags({
            PaRouteError: (err) => Effect.succeed(errorResponse(err)),
          }),
        );
      }

      // Routes scoped to /api/pa/bots/:botId/sessions/:sessionId/...
      if (segments.length === 5 && segments[2] === "sessions") {
        const sessionId = segments[3]!;
        const action = segments[4]!;
        if (!isValidPaSessionId(sessionId)) {
          return jsonResponse({ error: "Invalid session id" }, 400);
        }

        if (method === "GET" && action === "messages") {
          yield* authenticatePaRoute(AuthOrchestrationReadScope);
          const limitParam = Number(url.searchParams.get("limit") ?? "120");
          const limit =
            Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 120;
          return yield* respondPaJson(
            () => pa.getMessages(botId, sessionId, limit),
            (messages) => ({ messages }),
          );
        }

        if (method === "POST" && action === "send") {
          yield* authenticatePaRoute(AuthOrchestrationOperateScope);
          return yield* decodeJsonBody(SendMessageBodySchema).pipe(
            Effect.flatMap((body) =>
              tryPa(() =>
                pa.sendMessage(botId, sessionId, body.text, { inputId: body.inputId }),
              ).pipe(Effect.map((result) => jsonResponse(result))),
            ),
            Effect.catchTags({
              PaRouteError: (err) => Effect.succeed(errorResponse(err)),
            }),
          );
        }

        if (method === "POST" && action === "interrupt") {
          yield* authenticatePaRoute(AuthOrchestrationOperateScope);
          return yield* respondPaJson(
            () => pa.interruptSession(botId, sessionId),
            () => ({ ok: true }),
          );
        }

        if (method === "POST" && action === "respond") {
          yield* authenticatePaRoute(AuthOrchestrationOperateScope);
          return yield* decodeJsonBody(RespondRequestBodySchema).pipe(
            Effect.flatMap((input) =>
              tryPa(() => pa.respondRequest(botId, sessionId, input)).pipe(
                Effect.map(() => jsonResponse({ ok: true })),
              ),
            ),
            Effect.catchTags({
              PaRouteError: (err) => Effect.succeed(errorResponse(err)),
            }),
          );
        }

        if (method === "GET" && action === "events") {
          const authSession = yield* authenticatePaRoute(AuthOrchestrationReadScope);
          const sessionStore = yield* SessionStore.SessionStore;

          const sinceRaw = url.searchParams.get("sinceSeq");
          const sinceParsed = sinceRaw !== null ? Number(sinceRaw) : undefined;
          const sinceSeq =
            sinceParsed !== undefined && Number.isFinite(sinceParsed) && sinceParsed > 0
              ? sinceParsed
              : undefined;
          const replayEpoch = url.searchParams.get("replayEpoch") ?? undefined;

          const rawStream = Stream.callback<PaStreamEvent>(
            (queue) =>
              Effect.acquireRelease(
                tryPa(() =>
                  pa.subscribeSession(botId, sessionId, {
                    sinceSeq,
                    replayEpoch,
                    onEvent: (event) => {
                      Queue.offerUnsafe(queue, event);
                    },
                    onClose: (reason) => {
                      Queue.offerUnsafe(queue, {
                        type: "error",
                        sessionId,
                        message: reason ?? "Upstream PA stream disconnected",
                      });
                      Queue.endUnsafe(queue);
                    },
                  }),
                ).pipe(
                  Effect.catchTags({
                    PaRouteError: (err) => {
                      Queue.offerUnsafe(queue, {
                        type: "error",
                        sessionId,
                        message: err.message,
                      });
                      Queue.endUnsafe(queue);
                      return Effect.succeed(() => undefined);
                    },
                  }),
                ),
                (unsubscribe) => Effect.sync(() => unsubscribe()),
              ),
            { bufferSize: 256, strategy: "sliding" },
          );

          // Close SSE immediately if the authenticated T3 session/device is revoked.
          const eventStream =
            authSession.sessionId !== undefined
              ? rawStream.pipe(
                  Stream.interruptWhen(
                    sessionStore
                      .awaitInvalidation(authSession.sessionId, authSession.proofKeyThumbprint)
                      .pipe(Effect.orElseSucceed(() => undefined)),
                  ),
                )
              : rawStream;

          return eventStreamResponse(eventStream, (event) => Effect.succeed(JSON.stringify(event)));
        }
      }
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
  Effect.catchTags({
    EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
    EnvironmentInternalError: HttpServerRespondable.toResponse,
    EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
  }),
);

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const pa = yield* PaService;
    const handler = makePaRequestHandler(pa).pipe(
      Effect.provideService(
        HttpIncomingMessage.MaxBodySize,
        ByteSize.bytes(ServerHttp.API_MAX_BODY_BYTES),
      ),
    );
    return Layer.mergeAll(
      HttpRouter.add("GET", `${PA_PREFIX}/*`, handler),
      HttpRouter.add("POST", `${PA_PREFIX}/*`, handler),
    );
  }),
).pipe(Layer.provide(layerPaServiceLive));
