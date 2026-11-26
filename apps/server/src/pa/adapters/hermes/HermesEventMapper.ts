import type { PaAdapterEvent } from "../../types.ts";
import type { HermesRpcEventFrame } from "./HermesGatewayClient.ts";
import {
  classifyHermesTool,
  normalizePendingRequest,
  type HermesTrackedRequest,
} from "./HermesNormalizers.ts";

/** Hermes `seq` numbering within one replay epoch; a new epoch restarts it. */
export interface HermesSeqCursor {
  epoch: string | undefined;
  lastSeq: number;
}

/** Mutates `cursor`; false when `seq` was already delivered within the current replay epoch. */
export function acceptHermesSeq(
  cursor: HermesSeqCursor,
  seq: number | undefined,
  epoch: string | undefined,
): boolean {
  if (epoch !== undefined && epoch !== cursor.epoch) {
    cursor.epoch = epoch;
    cursor.lastSeq = seq ?? 0;
    return true;
  }
  if (seq === undefined || seq <= 0) return true;
  if (seq <= cursor.lastSeq) return false;
  cursor.lastSeq = seq;
  return true;
}

const MAX_TOOL_RESULT_CHARS = 16_000;

export interface HermesEventMapperHooks {
  readonly currentGeneration: () => number;
  readonly onGeneration: (generation: number) => void;
  readonly onRequestOpened: (tracked: HermesTrackedRequest) => void;
  readonly onRequestResolved: (requestId: string) => void;
}

const stringField = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Turns one Hermes session feed into neutral stream events. Hermes re-sends overlapping
 * `message.delta` ranges (`offset`) and reclassifies streamed text as commentary after the
 * fact (`message.interim` + `already_streamed`); both are resolved here, not in clients.
 */
export class HermesEventMapper {
  private readonly sessionId: string;
  private readonly hooks: HermesEventMapperHooks;
  private turnId: string | null = null;
  private turnSerial = 0;
  private segment = 0;
  private offset = 0;
  private segmentId: string | null = null;
  private segmentKey: string | null = null;
  private readonly commentarySegments = new Set<string>();
  private reasoningStreamed = false;
  private interimSerial = 0;

  constructor(sessionId: string, hooks: HermesEventMapperHooks) {
    this.sessionId = sessionId;
    this.hooks = hooks;
  }

  private startTurn(turnId: string | undefined): PaAdapterEvent {
    this.turnSerial += 1;
    this.turnId = turnId ?? null;
    this.segment = 0;
    this.offset = 0;
    this.segmentId = null;
    this.segmentKey = null;
    this.commentarySegments.clear();
    this.reasoningStreamed = false;
    return {
      type: "turn.started",
      sessionId: this.sessionId,
      ...(turnId ? { turnId } : {}),
    };
  }

  private answerSegmentId(base: string): string {
    let id = base;
    // Text after a commentary reclassification starts a new bubble, as Desktop renders it.
    for (let n = 1; this.commentarySegments.has(id); n += 1) id = `${base}~${n}`;
    return id;
  }

  map(frame: HermesRpcEventFrame): ReadonlyArray<PaAdapterEvent> {
    if (typeof frame.execution_generation === "number") {
      this.hooks.onGeneration(frame.execution_generation);
    }
    const p = frame.payload ?? {};
    const sessionId = this.sessionId;
    switch (frame.event) {
      case "message.start":
        return [this.startTurn(stringField(p.turn_id))];
      case "message.delta":
        return this.mapDelta(p);
      case "message.interim": {
        const text = typeof p.text === "string" ? p.text : "";
        if (!text.trim()) return [];
        if (p.already_streamed === true) {
          if (this.segmentId === null) return [];
          this.commentarySegments.add(this.segmentId);
          return [
            {
              type: "text.delta",
              sessionId,
              text: "",
              role: "commentary",
              segmentId: this.segmentId,
            },
          ];
        }
        this.interimSerial += 1;
        const segmentId = `interim-${this.turnSerial}-${this.interimSerial}`;
        this.commentarySegments.add(segmentId);
        this.segmentId = segmentId;
        this.segmentKey = null;
        return [{ type: "text.delta", sessionId, text, role: "commentary", segmentId }];
      }
      case "reasoning.delta": {
        const text = stringField(p.text) ?? stringField(p.delta);
        if (!text) return [];
        this.reasoningStreamed = true;
        return [{ type: "reasoning.delta", sessionId, text }];
      }
      case "reasoning.available": {
        // The full trace after the fact: only shown when nothing was streamed for this turn.
        const text = stringField(p.text) ?? stringField(p.delta);
        if (!text || this.reasoningStreamed) return [];
        this.reasoningStreamed = true;
        return [{ type: "reasoning.delta", sessionId, text }];
      }
      case "thinking.delta": {
        // Hermes `thinking_callback` emits transient spinner/wait notices ("" clears them), not CoT.
        if (typeof p.text !== "string" && typeof p.delta !== "string") return [];
        const text = (typeof p.text === "string" ? p.text : String(p.delta)).trim();
        return [{ type: "status.updated", sessionId, text: text.length > 0 ? text : null }];
      }
      case "tool.start":
      case "tool.started":
      case "tool.complete":
      case "tool.completed":
      case "tool.failed":
      case "tool.progress":
        return [this.mapTool(frame.event, p)];
      case "message.complete": {
        const text = typeof p.text === "string" ? p.text : "";
        const error = stringField(p.error);
        this.turnId = null;
        this.turnSerial += 1;
        this.segment = 0;
        this.offset = 0;
        this.segmentId = null;
        this.segmentKey = null;
        return [
          {
            type: "turn.completed",
            sessionId,
            status:
              p.status === "error"
                ? "error"
                : p.status === "interrupted"
                  ? "interrupted"
                  : "complete",
            ...(text ? { text } : {}),
            ...(error ? { error } : {}),
          },
        ];
      }
      case "approval.request":
      case "clarify.request": {
        const generation =
          typeof p.execution_generation === "number"
            ? p.execution_generation
            : this.hooks.currentGeneration();
        const tracked = normalizePendingRequest(
          String(p.prompt_id ?? p.id ?? ""),
          frame.event === "approval.request" ? "approval" : "clarify",
          p,
          "canonical",
          generation,
        );
        if (!tracked) return [];
        this.hooks.onRequestOpened(tracked);
        return [{ type: "request.opened", sessionId, request: tracked.request }];
      }
      case "approval.settled":
      case "clarify.settled":
      case "request.cancel":
      case "approval.cancelled": {
        const ids = Array.isArray(p.request_ids)
          ? p.request_ids.map((value) => String(value))
          : [String(p.prompt_id ?? p.id ?? p.request_id ?? "")];
        return ids
          .filter((id) => id.length > 0)
          .map((requestId) => {
            this.hooks.onRequestResolved(requestId);
            return { type: "request.resolved", sessionId, requestId } as const;
          });
      }
      case "session.title":
      case "session.updated": {
        const title = stringField(p.title);
        const model = stringField(p.model);
        if (!title && !model) return [];
        return [
          {
            type: "session.updated",
            sessionId,
            ...(title ? { title } : {}),
            ...(model ? { model } : {}),
          },
        ];
      }
      case "notice": {
        const message = String(p.message ?? p.text ?? "");
        return message ? [{ type: "notice", sessionId, message, persistent: true }] : [];
      }
      case "error":
        return [
          {
            type: "error",
            sessionId,
            message: String(p.message ?? p.error ?? "Session error"),
          },
        ];
      default:
        return [];
    }
  }

  private mapDelta(p: Record<string, unknown>): ReadonlyArray<PaAdapterEvent> {
    const text = typeof p.text === "string" ? p.text : "";
    if (!text) return [];
    const events: PaAdapterEvent[] = [];
    const turnId = stringField(p.turn_id);
    if (turnId !== undefined && this.turnId !== null && turnId !== this.turnId) {
      events.push(this.startTurn(turnId));
    } else if (turnId !== undefined && this.turnId === null) {
      this.turnId = turnId;
    }
    let chunk = text;
    if (typeof p.offset === "number") {
      const segment = typeof p.segment === "number" ? p.segment : 0;
      if (segment !== this.segment) {
        this.segment = segment;
        this.offset = p.offset + text.length;
      } else {
        const end = p.offset + text.length;
        if (end <= this.offset) return events;
        if (p.offset < this.offset) chunk = text.slice(this.offset - p.offset);
        this.offset = end;
      }
    } else {
      this.offset += text.length;
    }
    const key = `${this.turnId ?? `turn-${this.turnSerial}`}:${this.segment}`;
    if (
      this.segmentId === null ||
      this.segmentKey !== key ||
      this.commentarySegments.has(this.segmentId)
    ) {
      this.segmentKey = key;
      this.segmentId = this.answerSegmentId(key);
    }
    events.push({
      type: "text.delta",
      sessionId: this.sessionId,
      text: chunk,
      role: "answer",
      segmentId: this.segmentId,
    });
    return events;
  }

  private mapTool(event: string, p: Record<string, unknown>): PaAdapterEvent {
    const toolName = String(p.tool_name ?? p.name ?? "tool");
    const preview = stringField(p.context) ?? stringField(p.preview);
    const args =
      p.args && typeof p.args === "object" && !Array.isArray(p.args)
        ? (p.args as Record<string, unknown>)
        : undefined;
    const rawResult = stringField(p.result_text) ?? stringField(p.result);
    const result =
      rawResult !== undefined && rawResult.length > MAX_TOOL_RESULT_CHARS
        ? `${rawResult.slice(0, MAX_TOOL_RESULT_CHARS)}…`
        : rawResult;
    const durationMs =
      typeof p.duration_s === "number" && Number.isFinite(p.duration_s) && p.duration_s >= 0
        ? Math.round(p.duration_s * 1000)
        : undefined;
    return {
      type: "tool.updated",
      sessionId: this.sessionId,
      toolId: stringField(p.tool_call_id) ?? stringField(p.tool_id) ?? toolName,
      toolName,
      toolCategory: classifyHermesTool(toolName),
      status:
        event === "tool.start" || event === "tool.started"
          ? "started"
          : event === "tool.failed" || p.is_error === true
            ? "failed"
            : event === "tool.complete" || event === "tool.completed"
              ? "completed"
              : "progress",
      ...(preview ? { preview } : {}),
      ...(args ? { args } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }
}
