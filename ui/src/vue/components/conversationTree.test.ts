import {
  ancestorChain,
  anyDescendantWorking,
  childrenByParent,
  costReadout,
  subagentBadge,
  stripRows,
  workingDescendants,
  type ListedConversation,
} from "./conversationTree";

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`\u2713 ${name}`);
  } catch (err) {
    console.error(`\u2717 ${name}`);
    throw err;
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

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

run("childrenByParent groups children under their parent", () => {
  const top = conv("top", null);
  const a = conv("a", "top");
  const b = conv("b", "top");
  const tree = childrenByParent([top, a, b]);
  assertEqual(
    [...(tree.get("top") ?? [])].map((c) => c.conversation_id),
    ["a", "b"],
    "children of top",
  );
  assertEqual(tree.get("a") ?? null, null, "childless entries are not keys");
});

run("childrenByParent orders siblings by created_at, then id for ties", () => {
  const top = conv("top", null);
  const late = conv("late", "top", { created_at: iso(30) });
  const early = conv("early", "top", { created_at: iso(10) });
  const tieB = conv("tie-b", "top", { created_at: iso(20) });
  const tieA = conv("tie-a", "top", { created_at: iso(20) });
  const tree = childrenByParent([top, late, early, tieB, tieA]);
  assertEqual(
    [...(tree.get("top") ?? [])].map((c) => c.conversation_id),
    ["early", "tie-a", "tie-b", "late"],
    "sibling order",
  );
});

// The six badge cases from the PRD's badge table, data-driven. Expected
// values are written out longhand so the suffix rule is pinned, not computed.
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
  run(`badge: ${c.name}`, () => {
    const of = c.list.find((x) => x.conversation_id === c.of)!;
    assertEqual(subagentBadge(of, c.list), c.expected, c.name);
  });
}

run("badge: the N/M pair hides when N = 0, even while a deeper descendant runs", () => {
  const list = [
    conv("top", null),
    conv("c1", "top"),
    conv("gc1", "c1", { working: true }),
  ];
  const top = list[0];
  // The ring carries the deeper activity; the pair stays hidden.
  assertEqual(subagentBadge(top, list), {
    running: 0,
    launched: 1,
    descendants: 2,
    showRunningPair: false,
    showDescendantSuffix: true,
  }, "pair hidden while deeper descendant works");
});

run("badge: Z counts descendants at every depth (depth-agnostic)", () => {
  // The server caps nesting at 2, but the module is deliberately recursive.
  const list = [
    conv("top", null),
    conv("c1", "top"),
    conv("gc1", "c1"),
    conv("ggc1", "gc1"),
  ];
  assertEqual(subagentBadge(list[0], list).descendants, 3, "z across three levels");
  assertEqual(subagentBadge(list[0], list).showDescendantSuffix, true, "suffix");
});

run("badge: M falls back to the server's direct-children count", () => {
  const list = [conv("top", null, { subagent_count: 2 })];
  assertEqual(subagentBadge(list[0], list), {
    running: 0,
    launched: 2,
    descendants: 0,
    showRunningPair: false,
    showDescendantSuffix: false,
  }, "server fallback, no suffix (0 descendants > 2 launched is false)");
});

run("badge: in-memory children beat the server's count for M", () => {
  const list = [
    conv("top", null, { subagent_count: 3 }),
    conv("c1", "top", { working: true }),
  ];
  const badge = subagentBadge(list[0], list);
  assertEqual(badge.launched, 1, "in-memory first");
  assertEqual(badge.showRunningPair, true, "pair shows");
});

run("ring: idle conversation with no descendants → no badge ring", () => {
  const list = [conv("top", null)];
  assertEqual(anyDescendantWorking(list[0], list), false, "idle alone");
});

run("ring: any direct child working lights the badge ring", () => {
  const list = [conv("top", null), conv("c1", "top", { working: true })];
  assertEqual(anyDescendantWorking(list[0], list), true, "direct child working");
});

run("ring: a working descendant at any depth lights the badge ring", () => {
  const list = [
    conv("top", null),
    conv("c1", "top"),
    conv("gc1", "c1", { working: true }),
  ];
  assertEqual(anyDescendantWorking(list[0], list), true, "grandchild working");
  assertEqual(anyDescendantWorking(list[1], list), true, "child of the worker");
});

run("ring: own-turn-open does not light the badge ring", () => {
  // Row rings do not propagate activity up the chain — the row's own ring
  // means "this agent's turn is open"; the badge ring means "a descendant
  // works". A working conversation with a quiet subtree stays unlit.
  const list = [conv("top", null, { working: true })];
  assertEqual(anyDescendantWorking(list[0], list), false, "own turn open only");
});

run("ring: own turn open AND a descendant working — both at once", () => {
  const list = [
    conv("top", null, { working: true }),
    conv("c1", "top", { working: true }),
  ];
  assertEqual(anyDescendantWorking(list[0], list), true, "both rings");
});

run("cost: a childless conversation reads its own spend, no children flag", () => {
  const list = [conv("top", null, { cost_usd: 0.42, total_cost_usd: 0.42 })];
  assertEqual(costReadout(list[0], list), {
    ownCost: 0.42,
    totalCost: 0.42,
    hasChildren: false,
  }, "childless readout");
});

run("cost: a conversation with in-memory children carries the children flag", () => {
  const list = [
    conv("top", null, { cost_usd: 0.42, total_cost_usd: 1.47 }),
    conv("c1", "top", { cost_usd: 0.31, total_cost_usd: 0.68 }),
  ];
  // total is the server's recursive figure (own + all descendants' spend);
  // the module hands it through, the `total > own` display guard stays UI-side.
  assertEqual(costReadout(list[0], list), {
    ownCost: 0.42,
    totalCost: 1.47,
    hasChildren: true,
  }, "spawning readout");
});

run("cost: the server's subagent count counts as children", () => {
  const list = [conv("top", null, { subagent_count: 2 })];
  assertEqual(costReadout(list[0], list).hasChildren, true, "server fallback flag");
});

run("cost: absent cost fields read as zero", () => {
  const list = [conv("top", null)];
  assertEqual(costReadout(list[0], list), { ownCost: 0, totalCost: 0, hasChildren: false }, "zeros");
});

run("chain: a top-level conversation is its own (one-link) chain", () => {
  const list = [conv("top", null)];
  assertEqual(ids(ancestorChain(list[0], list)), ["top"], "self only");
});

run("chain: the full chain from a conversation up to its top-level root", () => {
  const list = [
    conv("top", null),
    conv("c1", "top"),
    conv("gc1", "c1"),
  ];
  assertEqual(ids(ancestorChain(list[2], list)), ["gc1", "c1", "top"], "grandchild chain");
  assertEqual(ids(ancestorChain(list[1], list)), ["c1", "top"], "child chain");
});

run("chain: a parent missing from the list ends the walk", () => {
  // e.g. the parent fell outside the list window; the chain returns what
  // exists rather than inventing links.
  const list = [conv("gc1", "c1")];
  assertEqual(ids(ancestorChain(list[0], list)), ["gc1"], "stopped at the gap");
});

// Readable id projections for asserting chains and row order.
function ids(convs: readonly ListedConversation[]): string[] {
  return convs.map((c) => c.conversation_id);
}

run("stop list: a conversation with no working descendants stops nothing", () => {
  const list = [conv("top", null), conv("c1", "top")];
  assertEqual(ids(workingDescendants(list[0], list)), [], "empty");
});

run("stop list: every working descendant at any depth, in tree order", () => {
  const list = [
    conv("top", null),
    conv("c1", "top", { working: true }),           // working direct child
    conv("c2", "top"),                              // idle direct child
    conv("gc1", "c1", { working: true }),           // working grandchild
    conv("gc2", "c2", { working: true }),           // working grandchild of an idle parent
    conv("top2", null, { working: true }),          // unrelated working conversation
  ];
  // The conversation itself never appears; idle descendants don't either.
  assertEqual(ids(workingDescendants(list[0], list)), ["c1", "gc1", "gc2"], "tree order");
});

run("strip: every working descendant at any depth, as its own row in tree order", () => {
  const list = [
    conv("top", null),
    conv("c1", "top", { working: true }),
    conv("c2", "top"),
    conv("gc1", "c1", { working: true }),
    conv("c3", "top", { working: true }),
  ];
  // The open conversation ("top") is not a row of its own strip. Depth is
  // relative to it: direct children at 0, grandchildren at 1.
  assertEqual(
    stripRows("top", list, new Set()).map((r) => [ids([r.conversation])[0], r.state, r.depth]),
    [
      ["c1", "running", 0],
      ["gc1", "running", 1],
      ["c3", "running", 0],
    ],
    "working rows in tree order",
  );
});

run("strip: an idle ancestor of a working descendant renders as a Waiting row", () => {
  const list = [
    conv("top", null),
    conv("c1", "top"), // idle — its turn ended; blocked on gc1's report-back
    conv("gc1", "c1", { working: true }),
  ];
  assertEqual(
    stripRows("top", list, new Set()).map((r) => [ids([r.conversation])[0], r.state, r.depth]),
    [
      ["c1", "waiting", 0],
      ["gc1", "running", 1],
    ],
    "scaffold under the worker",
  );
});

run("strip: scaffolding reaches every idle link in the chain", () => {
  const list = [
    conv("top", null),
    conv("c1", "top"),
    conv("gc1", "c1"),
    conv("ggc1", "gc1", { working: true }),
  ];
  assertEqual(
    stripRows("top", list, new Set()).map((r) => [ids([r.conversation])[0], r.state, r.depth]),
    [
      ["c1", "waiting", 0],
      ["gc1", "waiting", 1],
      ["ggc1", "running", 2],
    ],
    "full scaffold chain",
  );
});

run("strip: a working ancestor of a working descendant reads Running, not Waiting", () => {
  const list = [
    conv("top", null),
    conv("c1", "top", { working: true }),
    conv("gc1", "c1", { working: true }),
  ];
  assertEqual(
    stripRows("top", list, new Set()).map((r) => [ids([r.conversation])[0], r.state, r.depth]),
    [
      ["c1", "running", 0],
      ["gc1", "running", 1],
    ],
    "both running",
  );
});

run("strip: retained finished rows stay visible at any depth", () => {
  const list = [
    conv("top", null),
    conv("c1", "top"), // finished, retained
    conv("gc1", "c1"), // finished, retained — c1 keeps its Finished row too
  ];
  assertEqual(
    stripRows("top", list, new Set(["c1", "gc1"])).map(
      (r) => [ids([r.conversation])[0], r.state, r.depth],
    ),
    [
      ["c1", "finished", 0],
      ["gc1", "finished", 1],
    ],
    "retained subtree, all finished",
  );
});

run("strip: a retained idle ancestor of a still-running descendant reads Waiting", () => {
  const list = [
    conv("top", null),
    conv("c1", "top"),
    conv("gc1", "c1", { working: true }),
  ];
  assertEqual(
    stripRows("top", list, new Set(["c1"])).map((r) => [ids([r.conversation])[0], r.state]),
    [
      ["c1", "waiting"],
      ["gc1", "running"],
    ],
    "waiting wins over retained",
  );
});

run("strip: idle, unretained conversations with nothing running below get no row", () => {
  const list = [
    conv("top", null),
    conv("c1", "top"),
    conv("c2", "top"),
  ];
  assertEqual(stripRows("top", list, new Set(["c2"])).map((r) => ids([r.conversation])[0]), ["c2"], "only retained");
});

run("strip: retained ids outside the open conversation's tree are ignored", () => {
  const list = [
    conv("top", null),
    conv("other", null),
    conv("otherkid", "other", { working: true }),
    conv("c1", "top", { working: true }),
  ];
  assertEqual(
    stripRows("top", list, new Set(["otherkid", "ghost-id"])).map((r) => ids([r.conversation])[0]),
    ["c1"],
    "foreign and unknown retained ids dropped",
  );
});

run("strip: tree order with created_at ordering within siblings", () => {
  const list = [
    conv("top", null),
    conv("late", "top", { created_at: iso(30), working: true }),
    conv("gc-late", "late", { working: true }),
    conv("early", "top", { created_at: iso(10), working: true }),
  ];
  // early sorts before late despite arriving later in the list, and the
  // grandchild sits directly beneath its parent.
  assertEqual(
    stripRows("top", list, new Set()).map((r) => ids([r.conversation])[0]),
    ["early", "late", "gc-late"],
    "pre-order, siblings by created_at",
  );
});

run("quirk: archived descendants are invisible to Z and to the strip's rows", () => {
  // The list only ever carries unarchived conversations, so the module sees
  // no archived rows at all — Z and the row sets undercount when a
  // descendant is archived. Accepted quirk, consistent with how the drawer
  // already treats archived children; pinned here so it stays deliberate.
  const beforeArchive = [
    conv("top", null, { subagent_count: 2 }), // server still counts both
    conv("c1", "top", { working: true }),
    conv("c2", "top", { working: true }),
  ];
  assertEqual(subagentBadge(beforeArchive[0], beforeArchive).descendants, 2, "both present");
  assertEqual(ids(workingDescendants(beforeArchive[0], beforeArchive)), ["c1", "c2"], "stop list sees both");

  const afterArchive = beforeArchive.filter((c) => c.conversation_id !== "c2");
  assertEqual(subagentBadge(afterArchive[0], afterArchive).descendants, 1, "Z undercounts");
  assertEqual(ids(workingDescendants(afterArchive[0], afterArchive)), ["c1"], "stop list undercounts");
  assertEqual(
    stripRows("top", afterArchive, new Set()).map((r) => ids([r.conversation])[0]),
    ["c1"],
    "rows undercount",
  );
});

// --- Deterministic ordering (review fix 1) ---

run("sibling ids tie-break by codepoint, not host-locale collation", () => {
  const top = conv("top", null);
  const lower = conv("abc", "top", { created_at: iso(20) });
  const upper = conv("BCD", "top", { created_at: iso(20) });
  // Under en-US collation "abc".localeCompare("BCD") is -1 (lowercase first);
  // codepoint order puts "B" (0x42) before "a" (0x61). The tree order must
  // not depend on the host's locale.
  const tree = childrenByParent([top, lower, upper]);
  assertEqual(ids(tree.get("top") ?? []), ["BCD", "abc"], "codepoint tie-break");
});

run("created_at orders by instant, not string shape", () => {
  const top = conv("top", null);
  const offset = conv("off", "top", { created_at: "2026-01-01T13:00:20+01:00" }); // = 12:00:20Z
  const zulu = conv("zulu", "top", { created_at: iso(20) }); // 12:00:20Z, same instant
  const tree = childrenByParent([top, offset, zulu]);
  assertEqual(ids(tree.get("top") ?? []), ["off", "zulu"], "same instant → id tie-break");
});

run("an unparseable created_at crashes loudly rather than mis-ordering", () => {
  const list = [conv("top", null), conv("bad", "top", { created_at: "not-a-date" })];
  let message = "";
  try {
    childrenByParent(list);
  } catch (err) {
    message = (err as Error).message;
  }
  assert(message.includes("invalid created_at"), `expected a throw, got: ${message}`);
});

// --- Duplicate-id contract (review fix 3) ---

run("duplicate ids resolve last-wins, subtree attributed once", () => {
  const p1 = conv("p1", null);
  const c = conv("c", "p1");
  const underP1 = conv("dup", "p1"); // earlier copy — dropped
  const underC = conv("dup", "c"); // later copy — wins, like ancestorChain's id map
  const kid = conv("kid", "dup");
  const list = [p1, c, underP1, underC, kid];
  const tree = childrenByParent(list);
  assertEqual(ids(tree.get("p1") ?? []), ["c"], "earlier duplicate dropped from p1");
  assertEqual(ids(tree.get("c") ?? []), ["dup"], "later duplicate wins");
  assertEqual(subagentBadge(p1, list).descendants, 3, "subtree counted once, not twice");
});

// --- Cycle guards (review fix 2) ---

run("cycle: a self-parented conversation terminates every walker", () => {
  const list = [conv("x", "x", { working: true })];
  assertEqual(subagentBadge(list[0], list).descendants, 0, "badge z terminates");
  assertEqual(ids(workingDescendants(list[0], list)), [], "stop list terminates");
  assertEqual(
    stripRows("x", list, new Set()).map((r) => ids([r.conversation])[0]),
    ["x"],
    "strip terminates",
  );
});

run("cycle: a two-entry parent loop terminates every walker", () => {
  const list = [
    conv("a", "b", { working: true }),
    conv("b", "a", { working: true }),
  ];
  assertEqual(subagentBadge(list[0], list).descendants, 1, "badge z terminates");
  assertEqual(ids(workingDescendants(list[0], list)), ["b"], "stop list terminates");
  assertEqual(
    stripRows("a", list, new Set()).map((r) => ids([r.conversation])[0]),
    ["b", "a"],
    "strip terminates",
  );
});

run("cycle: ancestorChain terminates on a looping parent chain", () => {
  const list = [conv("c1", "gc1"), conv("gc1", "c1")];
  const chain = ancestorChain(list[0], list);
  assert(chain.length <= 2, `chain must terminate, got ${chain.length} links`);
});

// --- Descendant background jobs (phase 4) ---

run("strip: an idle descendant holding a running command gets a Waiting row to anchor it", () => {
  // The agent's turn is over (it backgrounded the command), nothing below
  // it runs — without a row its command would have nothing to indent under.
  const list = [conv("top", null), conv("c1", "top")];
  assertEqual(
    stripRows("top", list, new Set(), new Set(["c1"])).map(
      (r) => [ids([r.conversation])[0], r.state, r.depth],
    ),
    [["c1", "waiting", 0]],
    "job owner anchors its command row",
  );
});

run("strip: a working agent that also holds commands still reads Running", () => {
  const list = [conv("top", null), conv("c1", "top", { working: true })];
  assertEqual(
    stripRows("top", list, new Set(), new Set(["c1"])).map((r) => [ids([r.conversation])[0], r.state]),
    [["c1", "running"]],
    "running wins over waiting",
  );
});

run("strip: command activity holds a retained ancestor open as Waiting", () => {
  // A retained row only reads Finished once nothing below it runs — a
  // descendant's running command counts as running.
  const list = [
    conv("top", null),
    conv("c1", "top"), // retained, idle
    conv("gc1", "c1"), // idle, holds the running command
  ];
  assertEqual(
    stripRows("top", list, new Set(["c1"]), new Set(["gc1"])).map(
      (r) => [ids([r.conversation])[0], r.state, r.depth],
    ),
    [
      ["c1", "waiting", 0],
      ["gc1", "waiting", 1],
    ],
    "the scaffold chain stays Waiting while the command runs",
  );
});

run("strip: command-owner rows join the retained set's finished state when the command ends", () => {
  // Once the command's conversation stops being an owner, a shown row falls
  // back to today's states — the caller's retention keeps it as Finished.
  const list = [conv("top", null), conv("c1", "top")];
  assertEqual(
    stripRows("top", list, new Set(["c1"]), new Set()).map((r) => [ids([r.conversation])[0], r.state]),
    [["c1", "finished"]],
    "finished once retention holds it and nothing runs",
  );
});

run("strip: owners outside the open conversation's tree are ignored", () => {
  const list = [
    conv("top", null),
    conv("other", null),
    conv("otherkid", "other"),
  ];
  assertEqual(
    stripRows("top", list, new Set(), new Set(["otherkid", "top", "ghost"])).map(
      (r) => ids([r.conversation])[0],
    ),
    [],
    "foreign owners produce no rows",
  );
});
