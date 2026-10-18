// Tree-derived spawn-tree semantics over the flat conversation list, in one
// pure, framework-free place. The list snapshot / patch stream already ships
// every conversation at every depth with its parent id, working flag, own
// cost, recursive total cost, and direct-children count — everything here is
// computed client-side from that list alone. No UI concerns (rendering,
// collapse state, i18n) live in this module.

// The conversation fields the tree math reads. ConversationWithState
// satisfies this structurally; keeping the surface structural keeps the
// module decoupled from generated types and trivial to fixture in tests.
export interface ListedConversation {
  conversation_id: string;
  parent_conversation_id: string | null;
  working: boolean;
  created_at: string;
  // The server's direct-children count. M falls back to it when the
  // in-memory list holds none of the conversation's children.
  subagent_count: number;
  cost_usd?: number | null;
  total_cost_usd?: number | null;
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

// Children grouped by parent id, each sibling list in tree order. The map
// holds only entries that have children in the given list. Duplicate ids in
// the list resolve last-wins — the same rule ancestorChain's id map applies
// — so a duplicated conversation is attributed to one parent only.
export function childrenByParent<T extends ListedConversation>(
  convs: readonly T[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  const seen = new Set<string>();
  for (let i = convs.length - 1; i >= 0; i--) {
    const c = convs[i];
    createdAtMs(c); // every listed conversation must carry a parseable created_at
    if (seen.has(c.conversation_id)) continue;
    seen.add(c.conversation_id);
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
// after its parent, created_at ordering within siblings). The seen set is a
// cycle guard (matching ancestorChain): a corrupt list that makes a
// conversation its own descendant terminates instead of overflowing.
function descendantsOf<T extends ListedConversation>(
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
//     the server's direct-children count as fallback (today's rule).
//   - `descendants` is Z: all descendants at any depth, walked client-side.
// Rendering rules carried alongside the numbers: the N/M pair hides when
// N = 0 (even while a deeper descendant runs — the badge ring carries that
// signal), and the (ΣZ) suffix renders only when Z > M.
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
): SubagentBadge {
  const byParent = childrenByParent(convs);
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
// two rings can light at once.
export function anyDescendantWorking<T extends ListedConversation>(
  conv: T,
  convs: readonly T[],
): boolean {
  return descendantsOf(conv.conversation_id, childrenByParent(convs)).some(
    (d) => d.working,
  );
}

// Per-entry cost-readout inputs: the row's own spend, the recursive total
// (own + all descendants' spend — the server already computes it per
// conversation), and whether the entry has spawned subagents (the badge
// and the `own/total` shape key off this). Formatting — the `total > own`
// guard, currency notation — stays UI-side.
export interface CostReadout {
  ownCost: number;
  totalCost: number;
  hasChildren: boolean;
}

export function costReadout<T extends ListedConversation>(
  conv: T,
  convs: readonly T[],
): CostReadout {
  const kids = childrenByParent(convs).get(conv.conversation_id) ?? [];
  return {
    ownCost: conv.cost_usd ?? 0,
    totalCost: conv.total_cost_usd ?? 0,
    hasChildren: kids.length > 0 || (conv.subagent_count ?? 0) > 0,
  };
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
// its own descendant.
export function workingDescendants<T extends ListedConversation>(
  conv: T,
  convs: readonly T[],
): T[] {
  return descendantsOf(conv.conversation_id, childrenByParent(convs)).filter(
    (d) => d.working,
  );
}

// The running-work strip's row set for the open conversation `rootId`:
//   - every working descendant at any depth (state "running"),
//   - retained finished rows — the ids the strip tracks while expanded
//     (state "finished"),
//   - "Waiting" scaffolding rows for idle ancestors of any shown row
//     (state "waiting"), so indentation always lands under a visible
//     parent.
// Rows come back in tree order (a child directly beneath its parent,
// created_at ordering within siblings); `depth` counts from the open
// conversation's direct children (0). Working wins over waiting, waiting
// over finished: an idle ancestor of an active descendant renders as
// "Waiting" even if it is itself retained, and a retained row only reads
// "Finished" once nothing below it runs.
export type StripRowState = "running" | "waiting" | "finished";

export interface StripRow<T extends ListedConversation = ListedConversation> {
  conversation: T;
  depth: number;
  state: StripRowState;
}

export function stripRows<T extends ListedConversation>(
  rootId: string,
  convs: readonly T[],
  retainedIds: ReadonlySet<string>,
): StripRow<T>[] {
  const byParent = childrenByParent(convs);
  const isShown = (c: T): boolean => c.working || retainedIds.has(c.conversation_id);

  // Post-order pass: which subtrees hold a shown row, and which hold a
  // working row (strictly below their root). Cycle-guarded like
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
      if (kid.working || below.working) working = true;
    }
    subtreeShown.set(id, shown);
    subtreeWorking.set(id, working);
    return { shown, working };
  };
  walk(rootId);

  // Pre-order pass: emit shown rows and scaffolding ancestors.
  const rows: StripRow<T>[] = [];
  const emitted = new Set<string>();
  const emit = (id: string, depth: number): void => {
    for (const kid of byParent.get(id) ?? []) {
      const kidId = kid.conversation_id;
      if (emitted.has(kidId)) continue;
      emitted.add(kidId);
      if (!isShown(kid) && !subtreeShown.get(kidId)) continue;
      const state: StripRowState = kid.working
        ? "running"
        : subtreeWorking.get(kidId) || !retainedIds.has(kidId)
          ? "waiting"
          : "finished";
      rows.push({ conversation: kid, depth, state });
      emit(kidId, depth + 1);
    }
  };
  emit(rootId, 0);
  return rows;
}
