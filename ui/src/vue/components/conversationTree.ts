// Tree-derived spawn-tree semantics over the flat conversation list, in one
// pure, framework-free place. The list snapshot / patch stream already ships
// every conversation at every depth with its parent id, working flag, and
// direct-children count — everything here is computed client-side from that
// list alone. No component code, no collapse state, no i18n lives here: the
// module computes the numbers and the show/hide decisions the UI reads.

// The conversation fields the tree math reads. ConversationWithState
// satisfies this structurally; keeping the surface structural keeps the
// module decoupled from generated types and trivial to fixture in tests.
export interface ListedConversation {
  conversation_id: string;
  parent_conversation_id: string | null;
  working: boolean;
  // Must be ISO-8601-parseable: an unparseable value makes every function
  // in this module throw rather than silently mis-order the tree. Validate
  // patch data before it reaches here — this module crashes on bad input
  // by design.
  created_at: string;
  // The server's direct-children count. M falls back to it when the
  // in-memory list holds none of the conversation's children.
  subagent_count: number;
}

// Sibling order everywhere in the tree: by created_at instant, then id for
// ties. Both keys compare deterministically across machines — epoch millis
// for timestamps, codepoint order for ids (localeCompare's collation is
// host-locale-dependent; ids are ULIDs, so codepoint order is creation
// order — the same approach as utils/conversationSort.ts).
function createdAtMs(c: ListedConversation): number {
  // created_at is ISO-8601 from the server; an unparseable value is a bug —
  // crash rather than silently mis-order the tree.
  const t = new Date(c.created_at).getTime();
  if (!Number.isFinite(t)) throw new Error(`invalid created_at: ${c.created_at}`);
  return t;
}

function byCreatedThenId<T extends ListedConversation>(a: T, b: T): number {
  const byTime = createdAtMs(a) - createdAtMs(b);
  if (byTime !== 0) return byTime;
  if (a.conversation_id === b.conversation_id) return 0;
  return a.conversation_id < b.conversation_id ? -1 : 1;
}

// Duplicate ids in a list resolve last-wins. The dedupe rule is this
// module's contract (every index it builds applies it), so callers dedupe
// through here instead of hand-rolling the same expression.
export function dedupeConversations<T extends ListedConversation>(
  convs: readonly T[],
): T[] {
  return [...new Map(convs.map((c) => [c.conversation_id, c])).values()];
}

// Children grouped by parent id, each sibling list in tree order. The map
// holds only entries that have children in the given list. Duplicate ids in
// the list resolve last-wins (dedupeConversations), so a duplicated
// conversation is attributed to one parent only. Throws on an unparseable
// created_at anywhere in `convs` (see ListedConversation.created_at).
export function childrenByParent<T extends ListedConversation>(
  convs: readonly T[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const c of dedupeConversations(convs)) {
    createdAtMs(c); // every listed conversation must carry a parseable created_at
    const parent = c.parent_conversation_id;
    if (!parent) continue;
    const kids = out.get(parent);
    if (kids) kids.push(c);
    else out.set(parent, [c]);
  }
  for (const kids of out.values()) kids.sort(byCreatedThenId);
  return out;
}

// Every descendant of `id` at any depth, in tree order (each child directly
// after its parent, created_at ordering within siblings), walked over a
// caller-built childrenByParent map. Exported so callers that already hold
// the map (the strip derives it once per list version and shares it across
// its computeds; the background-jobs composable does the same per patch)
// reuse one walk instead of rebuilding it. The seen set is a cycle guard
// (matching ancestorChain): a corrupt list that makes a conversation its
// own descendant terminates instead of overflowing.
export function descendantsOf<T extends ListedConversation>(
  id: string,
  byParent: Map<string, T[]>,
): T[] {
  const out: T[] = [];
  const seen = new Set<string>([id]);
  const walk = (parentId: string): void => {
    for (const kid of byParent.get(parentId) ?? []) {
      if (seen.has(kid.conversation_id)) continue;
      seen.add(kid.conversation_id);
      out.push(kid);
      walk(kid.conversation_id);
    }
  };
  walk(id);
  return out;
}

// Per-entry subagent badge numbers:
//   - `running` is N: direct children currently working.
//   - `launched` is M: direct children launched — the in-memory list first,
//     the server's direct-children count as fallback.
//   - `descendants` is Z: all descendants at any depth, walked client-side.
// Rendering rules carried alongside the numbers: the N/M pair hides when
// N = 0 (even while a deeper descendant runs — the badge ring carries that
// signal), and the (ΣZ) suffix renders only when Z > M.
// Throws on an unparseable created_at anywhere in `convs` (see
// ListedConversation.created_at). Callers reading several conversations per
// list version should pass one prebuilt `childrenByParent` map as `byParent`
// instead of letting each call rebuild it (the badge and its ring share one
// build this way).
export interface SubagentBadge {
  running: number;
  launched: number;
  descendants: number;
  showRunningPair: boolean;
  showDescendantSuffix: boolean;
}

export function subagentBadge<T extends ListedConversation>(
  conv: T,
  convs: readonly T[],
  byParent: Map<string, T[]> = childrenByParent(convs),
): SubagentBadge {
  const kids = byParent.get(conv.conversation_id) ?? [];
  const running = kids.filter((k) => k.working).length;
  const launched = kids.length || conv.subagent_count || 0;
  const descendants = descendantsOf(conv.conversation_id, byParent).length;
  return {
    running,
    launched,
    descendants,
    showRunningPair: running > 0,
    showDescendantSuffix: descendants > launched,
  };
}

// The badge ring condition: any descendant at any depth is working.
// Deliberately distinct from the row's own ring ("this agent's turn is
// open" — the conversation's own `working` flag): subagents run detached,
// so a parent's turn typically ends while its descendants work, and the
// two rings can light at once. Throws on an unparseable created_at in
// `convs`; takes a prebuilt map like subagentBadge does.
export function anyDescendantWorking<T extends ListedConversation>(
  conv: T,
  convs: readonly T[],
  byParent: Map<string, T[]> = childrenByParent(convs),
): boolean {
  return descendantsOf(conv.conversation_id, byParent).some((d) => d.working);
}

// The conversation's ancestor chain: itself first, then each parent, up to
// the top-level root. A parent missing from the list (outside the list
// window) ends the walk, and the seen set stops a corrupt parent cycle (a
// conversation its own ancestor) instead of spinning. Duplicate ids in the
// list resolve last-wins via the id map — matching childrenByParent's
// dedupe.
export function ancestorChain<T extends ListedConversation>(
  conv: T,
  convs: readonly T[],
): T[] {
  const byId = new Map(convs.map((c) => [c.conversation_id, c]));
  const chain: T[] = [];
  const seen = new Set<string>();
  let cur: T | undefined = conv;
  while (cur && !seen.has(cur.conversation_id)) {
    seen.add(cur.conversation_id);
    chain.push(cur);
    const parentId: string | null = cur.parent_conversation_id;
    cur = parentId ? byId.get(parentId) : undefined;
  }
  return chain;
}

// The stop list: every working descendant of the conversation at any depth
// ("Stop subagents" cancels each of these; the strip header's subagent
// count is this list's length). Tree order; the conversation itself is not
// its own descendant. Duplicate ids in the list resolve last-wins —
// childrenByParent's rule — so a duplicated conversation is attributed
// once. Throws on an unparseable created_at in `convs`; takes a prebuilt
// map like subagentBadge does.
export function workingDescendants<T extends ListedConversation>(
  conv: T,
  convs: readonly T[],
  byParent: Map<string, T[]> = childrenByParent(convs),
): T[] {
  return descendantsOf(conv.conversation_id, byParent).filter((d) => d.working);
}

// The running-work strip's row set for the open conversation `rootId`:
//   - every working descendant at any depth (state "running"),
//   - every descendant holding a running background command — listed in
//     `withJobs` — even when its own turn is over (state "waiting"), so its
//     commands have a row to render beneath,
//   - retained finished rows — the ids the strip tracks while expanded
//     (state "finished"),
//   - "Waiting" scaffolding rows for idle ancestors of any shown row
//     (state "waiting"), so indentation always lands under a visible
//     parent.
// `options.withJobs` is optional (empty by default): with no command owners
// the row set is the working/retained set alone.
// Rows come back in tree order (a child directly beneath its parent,
// created_at ordering within siblings); `depth` counts from the open
// conversation's direct children (0). Duplicate ids in the list resolve
// last-wins (childrenByParent's rule), so a duplicated conversation
// renders once. Working wins over waiting, waiting over finished: an idle
// ancestor of an active descendant renders as "Waiting" even if it is
// itself retained, and a retained row only reads "Finished" once nothing
// below it — including descendants' commands — runs. Throws on an
// unparseable created_at in `convs`.
export type StripRowState = "running" | "waiting" | "finished";

export interface StripRow<T extends ListedConversation = ListedConversation> {
  conversation: T;
  depth: number;
  state: StripRowState;
}

export function stripRows<T extends ListedConversation>(
  rootId: string,
  convs: readonly T[],
  options: { retained?: ReadonlySet<string>; withJobs?: ReadonlySet<string> } = {},
): StripRow<T>[] {
  const retainedIds = options.retained ?? new Set<string>();
  const conversationIdsWithJobs = options.withJobs ?? new Set<string>();
  const byParent = childrenByParent(convs);
  const isShown = (c: T): boolean =>
    c.working || retainedIds.has(c.conversation_id) || conversationIdsWithJobs.has(c.conversation_id);

  // Post-order pass: which subtrees hold a shown row, and which hold a
  // working row (strictly below their root) — a working agent or a
  // descendant holding a running command counts. Cycle-guarded like
  // descendantsOf — a corrupt list terminates the walk.
  const subtreeShown = new Map<string, boolean>();
  const subtreeWorking = new Map<string, boolean>();
  const walked = new Set<string>();
  const walk = (id: string): { shown: boolean; working: boolean } => {
    let shown = false;
    let working = false;
    for (const kid of byParent.get(id) ?? []) {
      if (walked.has(kid.conversation_id)) continue;
      walked.add(kid.conversation_id);
      const below = walk(kid.conversation_id);
      if (isShown(kid) || below.shown) shown = true;
      if (kid.working || conversationIdsWithJobs.has(kid.conversation_id) || below.working)
        working = true;
    }
    subtreeShown.set(id, shown);
    subtreeWorking.set(id, working);
    return { shown, working };
  };
  walk(rootId);

  // Pre-order pass: emit shown rows and scaffolding ancestors.
  const rows: StripRow<T>[] = [];
  const emitted = new Set<string>();
  // The strip's core state rule, one branch per rule in the order the doc
  // reads: working → running; a retained row with nothing running below it
  // — no working descendant, no commands — → finished; everything else
  // (scaffolding ancestors, command owners whose turn is over) → waiting.
  const rowState = (kid: T): StripRowState => {
    if (kid.working) return "running";
    const kidId = kid.conversation_id;
    if (
      !subtreeWorking.get(kidId) &&
      !conversationIdsWithJobs.has(kidId) &&
      retainedIds.has(kidId)
    )
      return "finished";
    return "waiting";
  };
  const emit = (id: string, depth: number): void => {
    for (const kid of byParent.get(id) ?? []) {
      const kidId = kid.conversation_id;
      if (emitted.has(kidId)) continue;
      emitted.add(kidId);
      if (!isShown(kid) && !subtreeShown.get(kidId)) continue;
      rows.push({ conversation: kid, depth, state: rowState(kid) });
      emit(kidId, depth + 1);
    }
  };
  emit(rootId, 0);
  return rows;
}
