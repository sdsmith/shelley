import { computed, onScopeDispose, shallowRef, watch, type InjectionKey, type Ref } from "vue";
import { api, type BackgroundJob } from "../../services/api";
import type { ConversationWithState } from "../../types";
import { childrenByParent, descendantsOf } from "../components/conversationTree";

export const BackgroundJobsKey: InjectionKey<ReturnType<typeof useBackgroundJobs>> =
  Symbol("shelley-background-jobs");

// One polled conversation's live state: its commands (null while the first
// fetch is in flight), the last fetch error, and the commands a stop call
// is still in flight for.
export interface BackgroundJobsGroup {
  jobs: BackgroundJob[] | null;
  error: string;
  killing: Set<string>;
}

const POLL_MS = 3000;

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
  const deduped = [...new Map(conversations.map((c) => [c.conversation_id, c])).values()];
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
  conversations: Ref<ConversationWithState[]>,
) {
  // Live commands grouped per polled conversation. Replaced immutably on
  // every change so readers key off one identity per list version.
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
  // the loop continues (the polled list keeps the strip truthful).
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
          const current = jobsByConversation.value.get(id);
          if (current) setGroup(id, { ...current, error: e instanceof Error ? e.message : String(e) });
          else setGroup(id, { jobs: null, error: e instanceof Error ? e.message : String(e), killing: new Set() });
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
  // instead of at the next 3s tick.
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

  async function stop(id: string, jobId: string) {
    const group = jobsByConversation.value.get(id);
    // The stop button only renders for a polled command, so the group is
    // virtually always there; if it vanished mid-click the command is done
    // either way.
    if (!group) return;
    setGroup(id, { ...group, killing: new Set(group.killing).add(jobId) });
    try {
      await api.killBackgroundJob(id, jobId);
    } catch (e) {
      const current = jobsByConversation.value.get(id);
      if (!current) return;
      const next = new Set(current.killing);
      next.delete(jobId);
      setGroup(id, {
        ...current,
        error: e instanceof Error ? e.message : String(e),
        killing: next,
      });
    }
  }

  return { jobsByConversation, jobs, stop };
}
