import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { effectScope, nextTick, shallowRef } from "vue";
import type { ConversationWithState } from "../../types";
import { useBackgroundJobs } from "./backgroundJobs";

// The composable polls the open conversation's tree: its own commands plus
// every descendant's that reports running background jobs, each lifecycle
// ending when that conversation's running count drops to zero. These tests
// stub fetch (the api client's only egress), drive the polled list like
// App's patch stream does — replacing the array — and use mock timers for
// the 3s reschedule.

let seq = 0;
function conv(id: string, parent: string | null, running = 0): ConversationWithState {
  const now = new Date(Date.UTC(2026, 0, 1, 12, 0, seq++)).toISOString();
  return {
    conversation_id: id,
    slug: id,
    user_initiated: true,
    created_at: now,
    updated_at: now,
    cwd: null,
    archived: false,
    parent_conversation_id: parent,
    model: null,
    conversation_options: "{}",
    current_generation: 1,
    agent_working: false,
    tags: "",
    is_draft: false,
    draft: "",
    queued_messages: "",
    turn_interrupted: false,
    external_conversation_id: null,
    external_endpoint: null,
    working: false,
    subagent_count: 0,
    running_background_jobs: running,
    max_sequence_id: 0,
  };
}

function job(id: string) {
  return { job_id: id, command: `cmd ${id}`, tail: "", started_at: "2026-01-01T12:00:00Z" };
}

type Kill = { conversationId: string; jobId: string };
let jobsByConv: Map<string, ReturnType<typeof job>[]>;
let kills: Kill[];
let failKills: Kill[];
let gets: string[];

// Drain Vue's scheduler and the in-flight fetch chains (setImmediate is a
// real macrotask — every pending microtask runs first).
async function drain() {
  await nextTick();
  await new Promise((resolve) => setImmediate(resolve));
}

function stubFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const get = url.match(/\/api\/conversation\/([^/]+)\/background-jobs$/);
    if (get) {
      gets.push(decodeURIComponent(get[1]));
      return Response.json(jobsByConv.get(decodeURIComponent(get[1])) ?? []);
    }
    const kill = url.match(/\/api\/conversation\/([^/]+)\/background-jobs\/([^/]+)\/kill$/);
    if (kill) {
      const target = {
        conversationId: decodeURIComponent(kill[1]),
        jobId: decodeURIComponent(kill[2]),
      };
      kills.push(target);
      if (failKills.some((k) => k.conversationId === target.conversationId && k.jobId === target.jobId)) {
        return new Response("lost race", { status: 500 });
      }
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof globalThis.fetch;
}

function harness(t: TestContext, initial: ConversationWithState[]) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  stubFetch();
  const scope = effectScope();
  const conversationId = shallowRef<string | null>(initial[0]?.conversation_id ?? null);
  const conversations = shallowRef<ConversationWithState[]>(initial);
  const composable = scope.run(() => useBackgroundJobs(conversationId, conversations))!;
  t.after(() => scope.stop());
  return { conversationId, conversations, ...composable };
}

test("polls the open conversation and its job-holding descendants, grouped per conversation", async (t) => {
  jobsByConv = new Map([
    ["root", [job("jr")]],
    ["mid", [job("jm1"), job("jm2")]],
    ["other", [job("jo")]],
  ]);
  kills = [];
  failKills = [];
  gets = [];
  const h = harness(t, [
    conv("root", null, 1),
    conv("mid", "root", 2),
    conv("leaf", "mid", 0), // idle descendant: never polled
    conv("other", null, 1), // outside the open tree: never polled
  ]);
  await drain();

  assert.deepEqual(
    [...h.jobsByConversation.value.keys()].sort(),
    ["mid", "root"],
    "exactly the tree's job-holding conversations are polled",
  );
  assert.deepEqual(
    h.jobsByConversation.value.get("root")?.jobs?.map((j) => j.job_id),
    ["jr"],
  );
  assert.deepEqual(
    h.jobsByConversation.value.get("mid")?.jobs?.map((j) => j.job_id),
    ["jm1", "jm2"],
  );
  assert.equal(h.jobsByConversation.value.get("root")?.error, "", "no error on success");
  assert.deepEqual(
    h.jobs.value.map((j) => j.job_id).sort(),
    ["jm1", "jm2", "jr"],
    "flat view unions every polled group",
  );
  assert.deepEqual(gets.sort(), ["mid", "root"], "idle and foreign conversations are never fetched");
});

test("a descendant's poll stops and its group drops when its running count hits zero", async (t) => {
  jobsByConv = new Map([
    ["root", [job("jr")]],
    ["mid", [job("jm1")]],
  ]);
  kills = [];
  failKills = [];
  gets = [];
  const h = harness(t, [conv("root", null, 1), conv("mid", "root", 1)]);
  await drain();
  assert.deepEqual([...h.jobsByConversation.value.keys()].sort(), ["mid", "root"]);

  // The middle's command finishes: its list row reports zero, the composable
  // drops its group and stops re-fetching it, while the root keeps polling.
  h.conversations.value = [conv("root", null, 1), conv("mid", "root", 0)];
  await drain();
  const mids = gets.filter((id) => id === "mid").length;
  t.mock.timers.tick(3000);
  await drain();
  t.mock.timers.tick(3000);
  await drain();
  assert.equal(
    gets.filter((id) => id === "mid").length,
    mids,
    "no further polls for the finished descendant",
  );
  assert.deepEqual([...h.jobsByConversation.value.keys()], ["root"], "its group dropped");
  assert.ok(gets.filter((id) => id === "root").length > 1, "the root's own poll continues");
});

test("nothing polls while no conversation in the tree reports running commands", async (t) => {
  jobsByConv = new Map();
  kills = [];
  failKills = [];
  gets = [];
  const h = harness(t, [conv("root", null, 0), conv("mid", "root", 0)]);
  await drain();
  assert.deepEqual(gets, [], "no fetches");
  assert.equal(h.jobsByConversation.value.size, 0, "no groups");
  assert.deepEqual(h.jobs.value, [], "flat view empty");
});

test("navigating to a conversation outside the tree stops every poll and clears the groups", async (t) => {
  jobsByConv = new Map([["root", [job("jr")]]]);
  kills = [];
  failKills = [];
  gets = [];
  const h = harness(t, [conv("root", null, 1), conv("mid", "root", 1)]);
  await drain();
  assert.ok(h.jobsByConversation.value.size > 0);

  h.conversationId.value = "elsewhere";
  h.conversations.value = [
    conv("root", null, 1),
    conv("mid", "root", 1),
    conv("elsewhere", null, 0),
  ];
  await drain();
  const roots = gets.filter((id) => id === "root").length;
  t.mock.timers.tick(3000);
  await drain();
  assert.equal(gets.filter((id) => id === "root").length, roots, "no further polls");
  assert.equal(h.jobsByConversation.value.size, 0, "groups cleared");

  // A root missing from the polled list goes quiet the same way.
  h.conversationId.value = "root";
  h.conversations.value = [];
  await drain();
  assert.equal(h.jobsByConversation.value.size, 0, "absent root polls nothing");
});

test("stop() kills through the owning conversation; a failure lands on that group alone", async (t) => {
  jobsByConv = new Map([
    ["root", [job("jr")]],
    ["mid", [job("jm1")]],
  ]);
  kills = [];
  failKills = [];
  gets = [];
  const h = harness(t, [conv("root", null, 1), conv("mid", "root", 1)]);
  await drain();

  await h.stop("mid", "jm1");
  assert.deepEqual(kills, [{ conversationId: "mid", jobId: "jm1" }], "kill hits the owning conversation");
  assert.equal(h.jobsByConversation.value.get("mid")?.error, "", "success keeps the group's error empty");

  failKills = [{ conversationId: "mid", jobId: "jm1" }];
  await h.stop("mid", "jm1");
  assert.ok(
    h.jobsByConversation.value.get("mid")!.error.includes("lost race"),
    "the failed kill records on its own group",
  );
  assert.equal(h.jobsByConversation.value.get("root")?.error, "", "the root's group untouched");
});

test("a running-count bump refetches the conversation's commands immediately", async (t) => {
  jobsByConv = new Map([
    ["root", [job("jr1")]],
    ["mid", [job("jm1")]],
  ]);
  kills = [];
  failKills = [];
  gets = [];
  const h = harness(t, [conv("root", null, 1), conv("mid", "root", 1)]);
  await drain();
  assert.deepEqual(
    h.jobsByConversation.value.get("mid")?.jobs?.map((j) => j.job_id),
    ["jm1"],
  );

  // Another command backgrounds: the count bumps and the group's list must
  // gain it within one round trip — the strip's stop-all has to cover
  // exactly what the header counts, not whatever the last 3s tick saw.
  jobsByConv.set("mid", [job("jm1"), job("jm2")]);
  h.conversations.value = [conv("root", null, 1), conv("mid", "root", 2)];
  await drain();
  assert.deepEqual(
    h.jobsByConversation.value.get("mid")?.jobs?.map((j) => j.job_id),
    ["jm1", "jm2"],
  );
  assert.deepEqual([...h.jobsByConversation.value.keys()].sort(), ["mid", "root"]);
});

test("stopping a command whose group already vanished is a quiet no-op", async (t) => {
  jobsByConv = new Map([["root", [job("jr")]]]);
  kills = [];
  failKills = [];
  gets = [];
  const h = harness(t, [conv("root", null, 1)]);
  await drain();
  await h.stop("ghost", "jg");
  assert.deepEqual(kills, [], "no endpoint hit");
  assert.equal(h.jobsByConversation.value.get("root")?.error, "", "no error recorded");
});