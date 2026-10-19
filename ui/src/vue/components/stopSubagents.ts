// Pure helpers behind the running-work strip's "Stop subagents" sweep: the
// cancel-failure classification (which failures are benign) and the summary
// line the header renders. Framework-free and side-effect-free so node:test
// can pin them; RunningWorkStrip wires them to the endpoint.

import { ApiError } from "../../services/api";

// True when a failed cancelConversation is benign and must not surface: the
// endpoint's 404 ("Conversation not found") names a row that is deleted or
// unknown, so there is nothing left to cancel. Note a subagent that merely
// finished never fails at all — its row persists, so the endpoint answers
// 200 with `no_active_conversation` (server/handlers.go) and the call
// succeeds. Every other failure — a non-404 ApiError, a network error,
// anything else — must surface: the strip's rows would otherwise keep
// reading "running" with no signal that a cancel was attempted and dropped.
export function isBenignCancelFailure(e: unknown): boolean {
  return e instanceof ApiError && e.status === 404;
}

// One line for a whole stop sweep: how many of the swept cancels failed,
// with the failed conversations' ids. Per-failure reasons land in the
// console (each failure is warned individually); the surfaced line names
// what failed and how broadly.
export function stopFailureMessage(failedIds: readonly string[], swept: number): string {
  return `Cancel failed for ${failedIds.length} of ${swept}: ${failedIds.join(", ")}`;
}
