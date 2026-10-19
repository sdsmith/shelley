import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../services/api";
import { isBenignCancelFailure, stopFailureMessage } from "./stopSubagents";

test("isBenignCancelFailure: only the cancel endpoint's 404 is benign", () => {
  assert.equal(
    isBenignCancelFailure(new ApiError("Conversation not found", 404)),
    true,
    "a deleted/unknown row has nothing left to cancel",
  );
  assert.equal(isBenignCancelFailure(new ApiError("Failed to cancel conversation", 500)), false);
  assert.equal(isBenignCancelFailure(new ApiError("gone", 410)), false);
  assert.equal(isBenignCancelFailure(new Error("network down")), false, "non-ApiError failures surface");
  assert.equal(isBenignCancelFailure("404"), false, "a 404 lookalike that is not an ApiError surfaces");
  assert.equal(isBenignCancelFailure(undefined), false);
});

test("stopFailureMessage aggregates a sweep: N of M with the failed ids", () => {
  assert.equal(stopFailureMessage(["sub-1"], 3), "Cancel failed for 1 of 3: sub-1");
  assert.equal(
    stopFailureMessage(["sub-1", "sub-2"], 3),
    "Cancel failed for 2 of 3: sub-1, sub-2",
    "multiple failures aggregate instead of last-failure-wins",
  );
  assert.equal(
    stopFailureMessage(["b", "a"], 2),
    "Cancel failed for 2 of 2: b, a",
    "ids keep their sweep order",
  );
});
