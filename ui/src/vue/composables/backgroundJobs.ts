import { computed, onScopeDispose, shallowRef, watch, type ComputedRef, type InjectionKey, type Ref } from "vue";
import { api, type BackgroundJob } from "../../services/api";
import type { ConversationWithState } from "../../types";
import { childrenByParent, dedupeConversations, descendantsOf } from "../components/conversationTree";

export const BackgroundJobsKey: InjectionKey<ReturnType<typeof useBackgroundJobs>> =
  Symbol("shelley-background-jobs");

// One polled conversation's live state: its commands (null while the first
// fetch is in flight), the last fetch error, and the commands a stop call
// is still in flight for. Readonly by contract: state is replaced per
// update, never edited in place — a mutated handle would neither trigger
// reactivity (the map's identity is what changes) nor survive the next
// setGroup.
export interface BackgroundJobsGroup {
  readonly jobs: readonly BackgroundJob[] | null;
  readonly error: string;
  readonly killing: ReadonlySet<string>;
}

// What useBackgroundJobs hands its consumers. jobsByConversation is
// Readonly by contract — state is replaced per update, never edited in
// place — so the type forbids the one usage that would silently break
// reactivity (the map's identity is what changes per update).
export interface BackgroundJobs {
  jobsByConversation: Readonly<Ref<ReadonlyMap<string, BackgroundJobsGroup>>>;
  // Flat view of every polled group's commands — the "is this command still
  // running" checks (a bash card's running state) key off it.
  jobs: ComputedRef<BackgroundJob[]>;
  // Stop one polled command. Returns false when the owning conversation's
  // group is already gone — a quiet no-op: the stop button only renders for
  // a polled command, so a false return means the command finished inside
  // the click's race window (the command is done either way). Returns true
  // once the stop was (or already had been) sent: a command with a stop in
  // flight returns true without re-sending the kill, and a group that
  // vanishes before the response lands still counts as stopped. An API
  // failure surfaces on the group's error.
  stop: (command: { conversationId: string; jobId: string }) => Promise<boolean>;
}

const POLL_MS = 3000;

// True when every fetched command across every group has a stop call in
// flight — the strip header's "Stopping…" state. A group whose list has
// not been fetched yet blocks the state (its commands are unseen, so
// nothing can be stopping them); a fetched-but-empty list passes vacuously
// — there is genuinely nothing to stop for that conversation.
export function everyJobStopping(groups: readonly BackgroundJobsGroup[]): boolean {
  const live = groups.flatMap((group) => group.jobs ?? []);
  return (
    live.length > 0 &&
    groups.every(
      (group) => group.jobs !== null && group.jobs.every((job) => group.killing.has(job.job_id)),
    )
  );
}

// The conversations whose running commands belong to the open
// conversation's strip: itself plus every descendant reporting running
// background jobs, mapped to their running counts. The list read is deduped
// last-wins by id (the strip's rule); a root missing from the list polls
// nothing, so the strip goes quiet together. Each of these conversations
// polls until its own running count drops to zero.
function pollTargets(
  conversationId: string | null,
  conversations: readonly ConversationWithState[],
): Map<string, number> {
  if (!conversationId) return new Map();
  const deduped = dedupeConversations(conversations);
  const root = deduped.find((c) => c.conversation_id === conversationId);
  if (!root) return new Map();
  const byParent = childrenByParent(deduped);
  return new Map(
    [root, ...descendantsOf(root.conversation_id, byParent)]
      .filter((c) => c.running_background_jobs > 0)
      .map((c) => [c.conversation_id, c.running_background_jobs]),
  );
}

export function useBackgroundJobs(
  conversationId: Ref<string | null>,
  // The conversation list, as App provides it. Contract: the ref's array
  // must be REPLACED per update, never mutated in place (push/splice) —
  // the watcher diffs per list version, so an in-place mutation silently
  // freezes the poll set.
  conversations: Ref<readonly ConversationWithState[]>,
): BackgroundJobs {
  // Live commands grouped per polled conversation. Replaced immutably on
  // every change so readers key off one identity per list version. Exposed
  // through the Readonly BackgroundJobs view; internal code keeps the
  // mutable map.
  const jobsByConversation = shallowRef(new Map<string, BackgroundJobsGroup>());
  const pollers = new Map<string, () => void>();

  function setGroup(id: string, group: BackgroundJobsGroup) {
    const next = new Map(jobsByConversation.value);
    next.set(id, group);
    jobsByConversation.value = next;
  }

  function dropGroup(id: string) {
    if (!jobsByConversation.value.has(id)) return;
    const next = new Map(jobsByConversation.value);
    next.delete(id);
    jobsByConversation.value = next;
  }

  // One conversation's poll loop: fetch, publish, reschedule — until
  // stopped. A failed fetch surfaces on the conversation's own group and
  // the loop continues (the polled list keeps the strip truthful). Bare
  // setTimeout/clearTimeout, not window.*: node's test runner mocks the
  // global timer (and window does not exist there).
  function startPoller(id: string): () => void {
    let disposed = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      disposed = true;
      clearTimeout(poll);
    };
    async function refresh() {
      try {
        const list = await api.getBackgroundJobs(id);
        if (disposed) return;
        const current = jobsByConversation.value.get(id);
        setGroup(id, {
          jobs: list,
          error: "",
          // A stop call for a command that has left the polled list is done
          // either way; the rest keep their in-flight marker.
          killing: new Set(
            [...(current?.killing ?? [])].filter((jobId) =>
              list.some((job) => job.job_id === jobId),
            ),
          ),
        });
      } catch (e) {
        if (!disposed) {
          const message = e instanceof Error ? e.message : String(e);
          const current = jobsByConversation.value.get(id);
          if (current) setGroup(id, { ...current, error: message });
          else setGroup(id, { jobs: null, error: message, killing: new Set() });
        }
      } finally {
        if (!disposed) poll = setTimeout(() => void refresh(), POLL_MS);
      }
    }
    void refresh();
    return stop;
  }

  // Diff the desired poll set against the active pollers: start the newly
  // wanted, stop (and drop the groups of) the rest. Every conversation's
  // lifecycle is its own — polling stops when its running count drops to
  // zero, independently of its neighbours. A count CHANGE restarts the
  // conversation's poller: a fresh poller fetches immediately, so the
  // group's command list tracks the header's count within one round trip
  // (the strip's stop-all must cover exactly what the header counts)
  // instead of at the next poll tick.
  // lastCounts mirrors the count each active poller was started for: an id
  // is in pollers iff it is in lastCounts, holding the count that poller
  // fetches — the invariant both loops above maintain.
  const lastCounts = new Map<string, number>();
  watch(
    [conversationId, conversations],
    ([id, convs]) => {
      const want = pollTargets(id, convs);
      for (const [polled, stopPoller] of [...pollers]) {
        if (want.get(polled) === lastCounts.get(polled)) continue;
        stopPoller();
        pollers.delete(polled);
        if (!want.has(polled)) {
          dropGroup(polled);
          lastCounts.delete(polled);
        }
      }
      for (const [polled, count] of want) {
        if (pollers.has(polled)) continue;
        lastCounts.set(polled, count);
        pollers.set(polled, startPoller(polled));
      }
    },
    { immediate: true },
  );
  onScopeDispose(() => {
    for (const stopPoller of pollers.values()) stopPoller();
    pollers.clear();
  });

  // Flat view of every polled group's commands — the "is this command still
  // running" checks (a bash card's running state) key off it.
  const jobs = computed(() =>
    [...jobsByConversation.value.values()].flatMap((group) => group.jobs ?? []),
  );

  async function stop({
    conversationId: ownerId,
    jobId,
  }: {
    conversationId: string;
    jobId: string;
  }): Promise<boolean> {
    const group = jobsByConversation.value.get(ownerId);
    if (!group) return false;
    // One stop per command: a stop already in flight returns success
    // without re-sending the kill (the kill endpoint is not idempotent, and
    // a double-send would surface a spurious failure on the group's error).
    if (group.killing.has(jobId)) return true;
    setGroup(ownerId, { ...group, killing: new Set(group.killing).add(jobId) });
    try {
      await api.killBackgroundJob(ownerId, jobId);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const current = jobsByConversation.value.get(ownerId);
      if (!current) return true;
      const next = new Set(current.killing);
      next.delete(jobId);
      setGroup(ownerId, { ...current, error: message, killing: next });
    }
    return true;
  }

  return { jobsByConversation, jobs, stop };
}
