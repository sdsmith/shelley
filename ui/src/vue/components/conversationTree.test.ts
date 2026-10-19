import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ancestorChain,
  anyDescendantWorking,
  childrenByParent,
  subagentBadge,
  stripRows,
  workingDescendants,
  type ListedConversation,
} from "./conversationTree";

// Fixture builders in the conversationSort.test.ts style: conversations as
// they arrive in the flat list, with just the fields the tree math reads.
// Every conversation gets a distinct created_at (monotonic per file) unless
// one is passed explicitly.
let tick = 0;
// Seconds offset from a fixed instant — Date rolls it into minutes/days, so
// any tick count stays a valid, monotonically increasing timestamp.
const iso = (n: number): string => new Date(Date.UTC(2026, 0, 1, 12, 0, n)).toISOString();
const conv = (
  id: string,
  parent: string | null,
  over: Partial<ListedConversation> = {},
): ListedConversation => ({
  conversation_id: id,
  parent_conversation_id: parent,
  working: false,
  created_at: over.created_at ?? iso(tick++),
  subagent_count: 0,
  ...over,
});

test("childrenByParent groups children under their parent", () => {
  const top = conv("top", null);
  const a = conv("a", "top");
  const b = conv("b", "top");
  const tree = childrenByParent([top, a, b]);
  assert.deepStrictEqual(
    [...(tree.get("top") ?? [])].map((c) => c.conversation_id),
    ["a", "b"],
    "children of top",
  );
  assert.deepStrictEqual(tree.get("a") ?? null, null, "childless entries are not keys");
});

test("childrenByParent orders siblings by created_at, then id for ties", () => {
  const top = conv("top", null);
  const late = conv("late", "top", { created_at: iso(30) });
  const early = conv("early", "top", { created_at: iso(10) });
  const tieB = conv("tie-b", "top", { created_at: iso(20) });
  const tieA = conv("tie-a", "top", { created_at: iso(20) });
  const tree = childrenByParent([top, late, early, tieB, tieA]);
  assert.deepStrictEqual(
    [...(tree.get("top") ?? [])].map((c) => c.conversation_id),
    ["early", "tie-a", "tie-b", "late"],
    "sibling order",
  );
});

// The badge's six cases, data-driven: N=0 hidden; N/M running pair; N/M
// with no deeper tree; N/M (ΣZ) when the tree extends past the direct
// children; idle M; idle M (ΣZ). Expected values are written out longhand
// so the suffix rule is pinned, not computed.
type BadgeFixture = { name: string; list: ListedConversation[]; of: string; expected: object };
const badgeCases: BadgeFixture[] = [
  {
    name: "no subagents launched → no badge",
    list: [conv("top", null)],
    of: "top",
    expected: {
      running: 0,
      launched: 0,
      descendants: 0,
      showRunningPair: false,
      showDescendantSuffix: false,
    },
  },
  {
    name: "1/1 with no deeper tree",
    list: [conv("top", null), conv("c1", "top", { working: true })],
    of: "top",
    expected: {
      running: 1,
      launched: 1,
      descendants: 1,
      showRunningPair: true,
      showDescendantSuffix: false,
    },
  },
  {
    name: "N/M with no deeper tree",
    list: [
      conv("top", null),
      conv("c1", "top", { working: true }),
      conv("c2", "top", { working: true }),
      conv("c3", "top"),
    ],
    of: "top",
    expected: {
      running: 2,
      launched: 3,
      descendants: 3,
      showRunningPair: true,
      showDescendantSuffix: false,
    },
  },
  {
    name: "N/M (ΣZ) with a deeper tree",
    list: [
      conv("top", null),
      conv("c1", "top", { working: true }),
      conv("c2", "top"),
      conv("gc1", "c2"),
    ],
    of: "top",
    expected: {
      running: 1,
      launched: 2,
      descendants: 3,
      showRunningPair: true,
      showDescendantSuffix: true,
    },
  },
  {
    name: "idle M with no deeper tree",
    list: [conv("top", null), conv("c1", "top"), conv("c2", "top")],
    of: "top",
    expected: {
      running: 0,
      launched: 2,
      descendants: 2,
      showRunningPair: false,
      showDescendantSuffix: false,
    },
  },
  {
    name: "idle M (ΣZ) with a deeper tree",
    list: [
      conv("top", null),
      conv("c1", "top"),
      conv("gc1", "c1"),
      conv("gc2", "c1"),
    ],
    of: "top",
    expected: {
      running: 0,
      launched: 1,
      descendants: 3,
      showRunningPair: false,
      showDescendantSuffix: true,
    },
  },
];
for (const c of badgeCases) {
  test(`badge: ${c.name}`, () => {
    const of = c.list.find((x) => x.conversation_id === c.of)!;
    assert.deepStrictEqual(subagentBadge(of, c.list), c.expected, c.name);
  });
}

test("badge: the N/M pair hides when N = 0, even while a deeper descendant runs", () => {
  const list = [
    conv("top", null),
    conv("c1", "top"),
    conv("gc1", "c1", { working: true }),
  ];
  const top = list[0];
  // The ring carries the deeper activity; the pair stays hidden.
  assert.deepStrictEqual(subagentBadge(top, list), {
    running: 0,
    launched: 1,
    descendants: 2,
    showRunningPair: false,
    showDescendantSuffix: true,
  }, "pair hidden while deeper descendant works");
});

test("badge: Z counts descendants at every depth (depth-agnostic)", () => {
  // The server caps nesting at 2, but the module is deliberately recursive.
  const list = [
    conv("top", null),
    conv("c1", "top"),
    conv("gc1", "c1"),
    conv("ggc1", "gc1"),
  ];
  assert.deepStrictEqual(subagentBadge(list[0], list).descendants, 3, "z across three levels");
  assert.deepStrictEqual(subagentBadge(list[0], list).showDescendantSuffix, true, "suffix");
});

test("badge: M falls back to the server's direct-children count", () => {
  const list = [conv("top", null, { subagent_count: 2 })];
  assert.deepStrictEqual(subagentBadge(list[0], list), {
    running: 0,
    launched: 2,
    descendants: 0,
    showRunningPair: false,
    showDescendantSuffix: false,
  }, "server fallback, no suffix (0 descendants > 2 launched is false)");
});

test("badge: in-memory children beat the server's count for M", () => {
  const list = [
    conv("top", null, { subagent_count: 3 }),
    conv("c1", "top", { working: true }),
  ];
  const badge = subagentBadge(list[0], list);
  assert.deepStrictEqual(badge.launched, 1, "in-memory first");
  assert.deepStrictEqual(badge.showRunningPair, true, "pair shows");
});

test("ring: idle conversation with no descendants → no badge ring", () => {
  const list = [conv("top", null)];
  assert.deepStrictEqual(anyDescendantWorking(list[0], list), false, "idle alone");
});

test("ring: any direct child working lights the badge ring", () => {
  const list = [conv("top", null), conv("c1", "top", { working: true })];
  assert.deepStrictEqual(anyDescendantWorking(list[0], list), true, "direct child working");
});

test("ring: a working descendant at any depth lights the badge ring", () => {
  const list = [
    conv("top", null),
    conv("c1", "top"),
    conv("gc1", "c1", { working: true }),
  ];
  assert.deepStrictEqual(anyDescendantWorking(list[0], list), true, "grandchild working");
  assert.deepStrictEqual(anyDescendantWorking(list[1], list), true, "child of the worker");
});

test("ring: own-turn-open does not light the badge ring", () => {
  // Row rings do not propagate activity up the chain — the row's own ring
  // means "this agent's turn is open"; the badge ring means "a descendant
  // works". A working conversation with a quiet subtree stays unlit.
  const list = [conv("top", null, { working: true })];
  assert.deepStrictEqual(anyDescendantWorking(list[0], list), false, "own turn open only");
});

test("ring: own turn open AND a descendant working — both at once", () => {
  const list = [
    conv("top", null, { working: true }),
    conv("c1", "top", { working: true }),
  ];
  assert.deepStrictEqual(anyDescendantWorking(list[0], list), true, "both rings");
});

test("chain: a top-level conversation is its own (one-link) chain", () => {
  const list = [conv("top", null)];
  assert.deepStrictEqual(ids(ancestorChain(list[0], list)), ["top"], "self only");
});

test("chain: the full chain from a conversation up to its top-level root", () => {
  const list = [
    conv("top", null),
    conv("c1", "top"),
    conv("gc1", "c1"),
  ];
  assert.deepStrictEqual(ids(ancestorChain(list[2], list)), ["gc1", "c1", "top"], "grandchild chain");
  assert.deepStrictEqual(ids(ancestorChain(list[1], list)), ["c1", "top"], "child chain");
});

test("chain: a parent missing from the list ends the walk", () => {
  // e.g. the parent fell outside the list window; the chain returns what
  // exists rather than inventing links.
  const list = [conv("gc1", "c1")];
  assert.deepStrictEqual(ids(ancestorChain(list[0], list)), ["gc1"], "stopped at the gap");
});

// Readable id projections for asserting chains and row order.
function ids(convs: readonly ListedConversation[]): string[] {
  return convs.map((c) => c.conversation_id);
}

test("stop list: a conversation with no working descendants stops nothing", () => {
  const list = [conv("top", null), conv("c1", "top")];
  assert.deepStrictEqual(ids(workingDescendants(list[0], list)), [], "empty");
});

test("stop list: every working descendant at any depth, in tree order", () => {
  const list = [
    conv("top", null),
    conv("c1", "top", { working: true }),           // working direct child
    conv("c2", "top"),                              // idle direct child
    conv("gc1", "c1", { working: true }),           // working grandchild
    conv("gc2", "c2", { working: true }),           // working grandchild of an idle parent
    conv("top2", null, { working: true }),          // unrelated working conversation
  ];
  // The conversation itself never appears; idle descendants don't either.
  assert.deepStrictEqual(ids(workingDescendants(list[0], list)), ["c1", "gc1", "gc2"], "tree order");
});

test("strip: every working descendant at any depth, as its own row in tree order", () => {
  const list = [
    conv("top", null),
    conv("c1", "top", { working: true }),
    conv("c2", "top"),
    conv("gc1", "c1", { working: true }),
    conv("c3", "top", { working: true }),
  ];
  // The open conversation ("top") is not a row of its own strip. Depth is
  // relative to it: direct children at 0, grandchildren at 1.
  assert.deepStrictEqual(
    stripRows("top", list, {}).map((r) => [ids([r.conversation])[0], r.state, r.depth]),
    [
      ["c1", "running", 0],
      ["gc1", "running", 1],
      ["c3", "running", 0],
    ],
    "working rows in tree order",
  );
});

test("strip: an idle ancestor of a working descendant renders as a Waiting row", () => {
  const list = [
    conv("top", null),
    conv("c1", "top"), // idle — its turn ended; blocked on gc1's report-back
    conv("gc1", "c1", { working: true }),
  ];
  assert.deepStrictEqual(
    stripRows("top", list, {}).map((r) => [ids([r.conversation])[0], r.state, r.depth]),
    [
      ["c1", "waiting", 0],
      ["gc1", "running", 1],
    ],
    "scaffold under the worker",
  );
});

test("strip: scaffolding reaches every idle link in the chain", () => {
  const list = [
    conv("top", null),
    conv("c1", "top"),
    conv("gc1", "c1"),
    conv("ggc1", "gc1", { working: true }),
  ];
  assert.deepStrictEqual(
    stripRows("top", list, {}).map((r) => [ids([r.conversation])[0], r.state, r.depth]),
    [
      ["c1", "waiting", 0],
      ["gc1", "waiting", 1],
      ["ggc1", "running", 2],
    ],
    "full scaffold chain",
  );
});

test("strip: a working ancestor of a working descendant reads Running, not Waiting", () => {
  const list = [
    conv("top", null),
    conv("c1", "top", { working: true }),
    conv("gc1", "c1", { working: true }),
  ];
  assert.deepStrictEqual(
    stripRows("top", list, {}).map((r) => [ids([r.conversation])[0], r.state, r.depth]),
    [
      ["c1", "running", 0],
      ["gc1", "running", 1],
    ],
    "both running",
  );
});

test("strip: retained finished rows stay visible at any depth", () => {
  const list = [
    conv("top", null),
    conv("c1", "top"), // finished, retained
    conv("gc1", "c1"), // finished, retained — c1 keeps its Finished row too
  ];
  assert.deepStrictEqual(
    stripRows("top", list, { retained: new Set(["c1", "gc1"]) }).map(
      (r) => [ids([r.conversation])[0], r.state, r.depth],
    ),
    [
      ["c1", "finished", 0],
      ["gc1", "finished", 1],
    ],
    "retained subtree, all finished",
  );
});

test("strip: a retained idle ancestor of a still-running descendant reads Waiting", () => {
  const list = [
    conv("top", null),
    conv("c1", "top"),
    conv("gc1", "c1", { working: true }),
  ];
  assert.deepStrictEqual(
    stripRows("top", list, { retained: new Set(["c1"]) }).map((r) => [ids([r.conversation])[0], r.state]),
    [
      ["c1", "waiting"],
      ["gc1", "running"],
    ],
    "waiting wins over retained",
  );
});

test("strip: idle, unretained conversations with nothing running below get no row", () => {
  const list = [
    conv("top", null),
    conv("c1", "top"),
    conv("c2", "top"),
  ];
  assert.deepStrictEqual(stripRows("top", list, { retained: new Set(["c2"]) }).map((r) => ids([r.conversation])[0]), ["c2"], "only retained");
});

test("strip: retained ids outside the open conversation's tree are ignored", () => {
  const list = [
    conv("top", null),
    conv("other", null),
    conv("otherkid", "other", { working: true }),
    conv("c1", "top", { working: true }),
  ];
  assert.deepStrictEqual(
    stripRows("top", list, { withJobs: new Set(["otherkid", "ghost-id"]) }).map((r) => ids([r.conversation])[0]),
    ["c1"],
    "foreign and unknown retained ids dropped",
  );
});

test("strip: tree order with created_at ordering within siblings", () => {
  const list = [
    conv("top", null),
    conv("late", "top", { created_at: iso(30), working: true }),
    conv("gc-late", "late", { working: true }),
    conv("early", "top", { created_at: iso(10), working: true }),
  ];
  // early sorts before late despite arriving later in the list, and the
  // grandchild sits directly beneath its parent.
  assert.deepStrictEqual(
    stripRows("top", list, {}).map((r) => ids([r.conversation])[0]),
    ["early", "late", "gc-late"],
    "pre-order, siblings by created_at",
  );
});

test("quirk: archived descendants are invisible to Z and to the strip's rows", () => {
  // The list only ever carries unarchived conversations, so the module sees
  // no archived rows at all — Z and the row sets undercount when a
  // descendant is archived. Accepted quirk, consistent with how the drawer
  // already treats archived children; pinned here so it stays deliberate.
  const beforeArchive = [
    conv("top", null, { subagent_count: 2 }), // server still counts both
    conv("c1", "top", { working: true }),
    conv("c2", "top", { working: true }),
  ];
  assert.deepStrictEqual(subagentBadge(beforeArchive[0], beforeArchive).descendants, 2, "both present");
  assert.deepStrictEqual(ids(workingDescendants(beforeArchive[0], beforeArchive)), ["c1", "c2"], "stop list sees both");

  const afterArchive = beforeArchive.filter((c) => c.conversation_id !== "c2");
  assert.deepStrictEqual(subagentBadge(afterArchive[0], afterArchive).descendants, 1, "Z undercounts");
  assert.deepStrictEqual(ids(workingDescendants(afterArchive[0], afterArchive)), ["c1"], "stop list undercounts");
  assert.deepStrictEqual(
    stripRows("top", afterArchive, {}).map((r) => ids([r.conversation])[0]),
    ["c1"],
    "rows undercount",
  );
});

// --- Deterministic ordering: locale-independent sibling keys ---

test("sibling ids tie-break by codepoint, not host-locale collation", () => {
  const top = conv("top", null);
  const lower = conv("abc", "top", { created_at: iso(20) });
  const upper = conv("BCD", "top", { created_at: iso(20) });
  // Under en-US collation "abc".localeCompare("BCD") is -1 (lowercase first);
  // codepoint order puts "B" (0x42) before "a" (0x61). The tree order must
  // not depend on the host's locale.
  const tree = childrenByParent([top, lower, upper]);
  assert.deepStrictEqual(ids(tree.get("top") ?? []), ["BCD", "abc"], "codepoint tie-break");
});

test("created_at orders by instant, not string shape", () => {
  const top = conv("top", null);
  const offset = conv("off", "top", { created_at: "2026-01-01T13:00:20+01:00" }); // = 12:00:20Z
  const zulu = conv("zulu", "top", { created_at: iso(20) }); // 12:00:20Z, same instant
  const tree = childrenByParent([top, offset, zulu]);
  assert.deepStrictEqual(ids(tree.get("top") ?? []), ["off", "zulu"], "same instant → id tie-break");
});

test("an unparseable created_at crashes loudly rather than mis-ordering", () => {
  const list = [conv("top", null), conv("bad", "top", { created_at: "not-a-date" })];
  let message = "";
  try {
    childrenByParent(list);
  } catch (err) {
    message = (err as Error).message;
  }
  assert(message.includes("invalid created_at"), `expected a throw, got: ${message}`);
});

// --- Duplicate-id contract: last-wins, subtree attributed once ---

test("duplicate ids resolve last-wins, subtree attributed once", () => {
  const p1 = conv("p1", null);
  const c = conv("c", "p1");
  const underP1 = conv("dup", "p1"); // earlier copy — dropped
  const underC = conv("dup", "c"); // later copy — wins, like ancestorChain's id map
  const kid = conv("kid", "dup");
  const list = [p1, c, underP1, underC, kid];
  const tree = childrenByParent(list);
  assert.deepStrictEqual(ids(tree.get("p1") ?? []), ["c"], "earlier duplicate dropped from p1");
  assert.deepStrictEqual(ids(tree.get("c") ?? []), ["dup"], "later duplicate wins");
  assert.deepStrictEqual(subagentBadge(p1, list).descendants, 3, "subtree counted once, not twice");
});

// --- Cycle guards: corrupt parent chains terminate every walker ---

test("cycle: a self-parented conversation terminates every walker", () => {
  const list = [conv("x", "x", { working: true })];
  assert.deepStrictEqual(subagentBadge(list[0], list).descendants, 0, "badge z terminates");
  assert.deepStrictEqual(ids(workingDescendants(list[0], list)), [], "stop list terminates");
  assert.deepStrictEqual(
    stripRows("x", list, {}).map((r) => ids([r.conversation])[0]),
    ["x"],
    "strip terminates",
  );
});

test("cycle: a two-entry parent loop terminates every walker", () => {
  const list = [
    conv("a", "b", { working: true }),
    conv("b", "a", { working: true }),
  ];
  assert.deepStrictEqual(subagentBadge(list[0], list).descendants, 1, "badge z terminates");
  assert.deepStrictEqual(ids(workingDescendants(list[0], list)), ["b"], "stop list terminates");
  assert.deepStrictEqual(
    stripRows("a", list, {}).map((r) => ids([r.conversation])[0]),
    ["b", "a"],
    "strip terminates",
  );
});

test("cycle: ancestorChain terminates on a looping parent chain", () => {
  const list = [conv("c1", "gc1"), conv("gc1", "c1")];
  const chain = ancestorChain(list[0], list);
  assert(chain.length <= 2, `chain must terminate, got ${chain.length} links`);
});

// --- Descendant background commands: job owners anchor strip rows ---

test("strip: an idle descendant holding a running command gets a Waiting row to anchor it", () => {
  // The agent's turn is over (it backgrounded the command), nothing below
  // it runs — without a row its command would have nothing to indent under.
  const list = [conv("top", null), conv("c1", "top")];
  assert.deepStrictEqual(
    stripRows("top", list, { withJobs: new Set(["c1"]) }).map(
      (r) => [ids([r.conversation])[0], r.state, r.depth],
    ),
    [["c1", "waiting", 0]],
    "job owner anchors its command row",
  );
});

test("strip: a working agent that also holds commands still reads Running", () => {
  const list = [conv("top", null), conv("c1", "top", { working: true })];
  assert.deepStrictEqual(
    stripRows("top", list, { withJobs: new Set(["c1"]) }).map((r) => [ids([r.conversation])[0], r.state]),
    [["c1", "running"]],
    "running wins over waiting",
  );
});

test("strip: command activity holds a retained ancestor open as Waiting", () => {
  // A retained row only reads Finished once nothing below it runs — a
  // descendant's running command counts as running.
  const list = [
    conv("top", null),
    conv("c1", "top"), // retained, idle
    conv("gc1", "c1"), // idle, holds the running command
  ];
  assert.deepStrictEqual(
    stripRows("top", list, { retained: new Set(["c1"]), withJobs: new Set(["gc1"]) }).map(
      (r) => [ids([r.conversation])[0], r.state, r.depth],
    ),
    [
      ["c1", "waiting", 0],
      ["gc1", "waiting", 1],
    ],
    "the scaffold chain stays Waiting while the command runs",
  );
});

test("strip: command-owner rows join the retained set's finished state when the command ends", () => {
  // Once the command's conversation stops being an owner, the normal state
  // rules apply — retention holds the row as Finished once nothing runs
  // below it.
  const list = [conv("top", null), conv("c1", "top")];
  assert.deepStrictEqual(
    stripRows("top", list, { retained: new Set(["c1"]) }).map((r) => [ids([r.conversation])[0], r.state]),
    [["c1", "finished"]],
    "finished once retention holds it and nothing runs",
  );
});

test("strip: owners outside the open conversation's tree are ignored", () => {
  const list = [
    conv("top", null),
    conv("other", null),
    conv("otherkid", "other"),
  ];
  assert.deepStrictEqual(
    stripRows("top", list, { withJobs: new Set(["otherkid", "top", "ghost"]) }).map(
      (r) => ids([r.conversation])[0],
    ),
    [],
    "foreign owners produce no rows",
  );
});
