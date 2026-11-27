import { PaError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { HermesConnectionError, HermesRpcError } from "./HermesGatewayClient.ts";

/** Caller mistakes keep their own reason; only a gateway that is down or misbehaving is not. */
export const isPaError = Schema.is(PaError);

export function toPaError(cause: unknown): PaError {
  if (isPaError(cause)) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  if (cause instanceof HermesConnectionError) {
    return new PaError({ reason: "Unavailable", message });
  }
  if (cause instanceof HermesRpcError) {
    const detailed = [message, cause.detail].filter(Boolean).join(" ");
    if (message === "admission_conflict")
      return Object.assign(new PaError({ reason: "Conflict", message: detailed }), {
        inputRefused: true,
      });
    if (
      cause.code === 4062 ||
      /\b(stale_generation|revision_conflict|admission_started|session_idle|steer_unavailable)\b/i.test(
        message,
      )
    ) {
      return new PaError({ reason: "Conflict", message: detailed });
    }
    if (/\bnot[\s_]found\b/i.test(message)) {
      return new PaError({ reason: "NotFound", message: detailed });
    }
    if (/\b(invalid_params|invalid_selection)\b/i.test(message)) {
      return new PaError({ reason: "Invalid", message: detailed });
    }
    if (/\bpermission_denied\b/i.test(message)) {
      return new PaError({ reason: "Forbidden", message: detailed });
    }
    if (/\bunsupported_(command|control)\b/i.test(message)) {
      return new PaError({ reason: "Unsupported", message: detailed });
    }
    return new PaError({ reason: "Upstream", message: detailed });
  }
  return new PaError({ reason: "Upstream", message });
}

export function invalid(message: string): PaError {
  return new PaError({ reason: "Invalid", message });
}

export async function withPaErrors<A>(run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (cause) {
    throw toPaError(cause);
  }
}
