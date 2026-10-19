<template>
  <section v-if="itemCount > 0 || open" class="running-work" aria-label="Running work">
    <!-- One row renders by itself; only two or more grow the header. -->
    <div v-if="!single" class="running-work-header">
      <button
        type="button"
        class="running-work-toggle"
        data-testid="running-work-toggle"
        :aria-expanded="open"
        :aria-controls="`running-work-${conversationId}`"
        @click="toggleWork"
      >
        <span v-if="itemCount > 0" class="running-work-dot" aria-hidden="true" />
        <span class="running-work-count">
          <span v-if="itemCount === 0">No running work</span>
          <span v-if="jobCount > 0">{{ jobCount }} task{{ jobCount === 1 ? "" : "s" }}</span>
          <span
            v-if="jobCount > 0 && runningSubagentCount > 0"
            class="running-work-separator"
            aria-hidden="true"
          />
          <span v-if="runningSubagentCount > 0">
            {{ runningSubagentCount }} subagent{{ runningSubagentCount === 1 ? "" : "s" }}
          </span>
        </span>
        <span class="running-work-view">
          {{ open ? "Hide work" : "View work" }}
          <ToolChevron :expanded="open" />
        </span>
      </button>
      <div v-if="itemCount > 0" class="running-work-header-actions">
        <span v-if="stopSubagentsError" class="running-work-stop-error" role="alert">{{
          stopSubagentsError
        }}</span>
        <button
          type="button"
          class="running-work-stop"
          data-testid="running-work-stop-jobs"
          aria-label="Stop all background commands"
          :disabled="jobCount === 0 || allJobsStopping"
          @click="stopAllJobs"
        >
          {{ allJobsStopping ? "Stopping…" : "Stop commands" }}
        </button>
        <button
          type="button"
          class="running-work-stop"
          data-testid="running-work-stop-subagents"
          aria-label="Stop all running subagents"
          :disabled="runningSubagentCount === 0 || stoppingSubagents"
          @click="stopAllSubagents"
        >
          {{ stoppingSubagents ? "Stopping…" : "Stop subagents" }}
        </button>
      </div>
    </div>
    <div
      v-if="expanded"
      :id="`running-work-${conversationId}`"
      class="running-work-items"
      data-testid="running-work-items"
      role="region"
      aria-label="Running work details"
    >
      <template v-for="row in rows" :key="row.conversation.conversation_id">
        <RunningWorkAgent
          :conversation="row.conversation"
          :state="row.state"
          :depth="row.depth"
        />
        <!-- A descendant's running commands render indented under their
             agent's row; the open conversation's own group sits at the
             bottom, unindented. -->
        <BackgroundJobsList
          v-if="groupVisible(row.conversation.conversation_id)"
          :conversation-id="row.conversation.conversation_id"
          :retained-jobs="seenJobs.get(row.conversation.conversation_id) ?? []"
          :depth="row.depth + 1"
        />
      </template>
      <BackgroundJobsList
        v-if="groupVisible(conversationId)"
        :conversation-id="conversationId"
        :retained-jobs="seenJobs.get(conversationId) ?? []"
        :depth="0"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, ref, shallowRef, watch } from "vue";
import type { BackgroundJob } from "../../services/api";
import { BackgroundJobsKey } from "../composables/backgroundJobs";
import { ConversationsListKey } from "../composables/subagentLive";
import BackgroundJobsList from "./BackgroundJobsList.vue";
import RunningWorkAgent from "./RunningWorkAgent.vue";
import ToolChevron from "./tools/ToolChevron.vue";
import { childrenByParent, dedupeConversations, descendantsOf, stripRows, workingDescendants } from "./conversationTree";
import { everyJobStopping } from "../composables/backgroundJobs";
import { api } from "../../services/api";
import { isBenignCancelFailure, stopFailureMessage } from "./stopSubagents";

const props = defineProps<{ conversationId: string }>();
const emit = defineEmits<{ toggle: [] }>();

const conversations = inject(ConversationsListKey);
if (!conversations) throw new Error("RunningWorkStrip requires ConversationsListKey");
const backgroundJobs = inject(BackgroundJobsKey);
if (!backgroundJobs) throw new Error("RunningWorkStrip requires BackgroundJobsKey");
const { stop: stopJob, jobsByConversation } = backgroundJobs;

const open = ref(false);
// Commands seen while expanded, per conversation — finished command rows
// stay visible until collapse (the agent rows' retention rule, per group).
const seenJobs = shallowRef(new Map<string, BackgroundJob[]>());

// The flat list, deduplicated last-wins by conversation_id (the module's
// dedupe rule). The drawer's dayFilteredConversations applies the same rule
// to its pool, minus the day filter: the strip shows running work
// regardless of the panel's selected day. Pre-deduping keeps the root
// lookup on the same canonical copy every walk sees.
const dedupedConversations = computed(() => dedupeConversations(conversations.value));

// One childrenByParent derivation per list version, shared by this
// component's tree reads (the module calls that take the raw list rebuild
// the map internally; the walks added for descendant jobs reuse this one
// rather than stacking another rebuild on every patch).
const byParent = computed(() => childrenByParent(dedupedConversations.value));

// The open conversation's record in the deduped list. Every tree read keys
// off it, so when it is absent from the list (a transient gap while the
// polled list catches up) the rows and the stop list go quiet together —
// "No running work" — instead of rendering a subtree the stop list cannot
// see.
const rootConversation = computed(() =>
  dedupedConversations.value.find((c) => c.conversation_id === props.conversationId),
);

// Header task count: the open conversation's own running commands plus its
// descendants' — running commands at any depth count as running work,
// whoever owns them.
const jobCount = computed(() => {
  const root = rootConversation.value;
  if (!root) return 0;
  return [root, ...descendantsOf(root.conversation_id, byParent.value)].reduce(
    (total, c) => total + c.running_background_jobs,
    0,
  );
});

// Stop list: every working descendant of the open conversation at any
// depth. The header's subagent count and "Stop subagents" both read it.
// Reuses the shared byParent instead of rebuilding per patch.
const stopList = computed(() =>
  rootConversation.value
    ? workingDescendants(rootConversation.value, dedupedConversations.value, byParent.value)
    : [],
);
const runningSubagentCount = computed(() => stopList.value.length);

// The conversations the composable is polling — the open conversation plus
// every descendant holding running commands. A descendant owner becomes a
// strip row even when its turn is over, so its commands indent beneath it.
const conversationIdsWithJobs = computed(() => new Set(jobsByConversation.value.keys()));

// Retention while expanded: every row the strip has shown — including the
// Waiting scaffolding rows — stays until collapse, so finished work at any
// depth doesn't vanish mid-review. Cleared on collapse.
const retainedIds = ref(new Set<string>());
const rows = computed(() =>
  rootConversation.value
    ? stripRows(props.conversationId, dedupedConversations.value, {
        retained: retainedIds.value,
        withJobs: conversationIdsWithJobs.value,
        byParent: byParent.value,
      })
    : [],
);

// Header count and headerless threshold: running background jobs plus
// running subagents.
const itemCount = computed(() => jobCount.value + runningSubagentCount.value);

// A single row renders directly, without the toggle header; anything more
// starts collapsed behind the header's count (the user's toggle opens it).
// Waiting scaffolding and retained finished rows never count toward this —
// only running work does. Known gap, pending a product decision: a lone
// running subagent gets no stop control in this state (the stop-all buttons
// live in the header, and only background commands carry a per-row stop).
const single = computed(() => itemCount.value === 1);

const expanded = computed(() => single.value || open.value);

// A command group renders while its conversation is polled (loading or
// live) and, after polling stops, while the strip retains commands it
// showed — finished rows stay until collapse.
function groupVisible(id: string): boolean {
  return jobsByConversation.value.has(id) || (seenJobs.value.get(id)?.length ?? 0) > 0;
}

// Header actions: stop every live background command — the open
// conversation's and its descendants' — / cancel every working descendant.
// Each button greys out while its kind has nothing running; the commands
// button also reads "Stopping…" while every live command sits in its
// group's killing set (pruned as the jobs leave the polled lists); a group
// whose list has not been fetched yet holds the state off — its commands
// are unseen, so nothing can be stopping them.
const allJobsStopping = computed(() => everyJobStopping([...jobsByConversation.value.values()]));

function stopAllJobs() {
  // Snapshot: a group dropped or a job finished mid-loop is caught on the
  // next click. Repeat kills are harmless no-ops: stop() returns early for
  // a command that already has a stop in flight.
  for (const [id, group] of [...jobsByConversation.value]) {
    for (const job of group.jobs ?? []) void stopJob({ conversationId: id, jobId: job.job_id });
  }
}

// The strip-level stop failure line: the summary of a sweep whose cancels
// failed (isBenignCancelFailure's benign 404s excepted), held together with
// the ids it names. Self-clearing — rendered only while a failed sweep
// still has a subject on the stop list — so a stale failure cannot resurface
// with the header after its subjects are gone.
const stopSubagentsFailure = ref<{ ids: readonly string[]; message: string } | null>(null);
const stopSubagentsError = computed(() =>
  stopSubagentsFailure.value?.ids.some((id) =>
    stopList.value.some((sub) => sub.conversation_id === id),
  )
    ? stopSubagentsFailure.value.message
    : "",
);

const stoppingSubagents = ref(false);
function stopAllSubagents() {
  if (stoppingSubagents.value) return;
  stoppingSubagents.value = true;
  stopSubagentsFailure.value = null;
  void (async () => {
    const swept = [...stopList.value];
    const failedIds: string[] = [];
    for (const sub of swept) {
      try {
        await api.cancelConversation(sub.conversation_id);
      } catch (e) {
        // Benign cancels must not stop the loop: a subagent that merely
        // finished never lands in this catch at all — its row persists, so
        // the endpoint answers 200 with `no_active_conversation`
        // (server/handlers.go) — and a 404 names a row that is deleted or
        // unknown, with nothing left to cancel (isBenignCancelFailure).
        // Any other failure also must not stop the rest, but is surfaced:
        // the rows would keep reading "running" with no signal that a
        // cancel was attempted and dropped.
        if (isBenignCancelFailure(e)) continue;
        const reason = `${sub.conversation_id}: ${e instanceof Error ? e.message : e}`;
        console.warn(`Cancel failed for ${reason}`);
        failedIds.push(sub.conversation_id);
      }
    }
    stoppingSubagents.value = false;
    if (failedIds.length > 0)
      stopSubagentsFailure.value = {
        ids: failedIds,
        message: stopFailureMessage(failedIds, swept.length),
      };
  })();
}

function toggleWork() {
  open.value = !open.value;
  emit("toggle");
}

function remember<T>(seen: readonly T[], current: readonly T[], key: (item: T) => string): T[] {
  const items = new Map<string, T>();
  for (const item of [...seen, ...current]) items.set(key(item), item);
  return [...items.values()];
}

// Retention update: while expanded, every shown row id joins the retained
// set, and every polled group's live commands merge into that
// conversation's seen list; collapsing clears both. The retained-set size
// comparison is load-bearing: nextIds is always a SUPERSET of the current
// set (rows only ever add ids here, never remove), so equal size means
// equal content and the write is skipped. Skipping it is what stops the
// rows↔retention render loop — rows read the retained set this watcher
// writes, so a fresh set identity on every fire would re-render rows,
// refire the watcher, and loop forever. A future change that removes ids
// from the set breaks the superset property (equal size would no longer
// imply equal content) and silently drops rows; compare contents instead.
// The seenJobs write takes a fresh map every fire and is safe from the loop
// for the same reason from the other side: rows does not read seenJobs.
// `immediate` matters: mounted mid-run (reload with work already going),
// `expanded` is true from the first evaluation and would otherwise never
// fire, leaving the header counting rows it never renders.
watch(
  [expanded, rows, jobsByConversation],
  ([isExpanded, currentRows, liveGroups]) => {
    if (!isExpanded) {
      if (retainedIds.value.size > 0) retainedIds.value = new Set();
      if (seenJobs.value.size > 0) seenJobs.value = new Map();
      return;
    }
    const nextIds = new Set(retainedIds.value);
    for (const row of currentRows) nextIds.add(row.conversation.conversation_id);
    if (nextIds.size !== retainedIds.value.size) retainedIds.value = nextIds;
    // Per conversation: a group still loading contributes nothing yet, and
    // a group that stopped polling keeps its seen commands — they render
    // Finished until collapse.
    const nextJobs = new Map(seenJobs.value);
    for (const [id, group] of liveGroups) {
      if (group.jobs === null) continue;
      nextJobs.set(id, remember(nextJobs.get(id) ?? [], group.jobs, (job) => job.job_id));
    }
    seenJobs.value = nextJobs;
  },
  { immediate: true },
);
</script>

<style scoped>
.running-work {
  flex: 0 0 auto;
  margin: 12px 0 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-secondary);
  font-size: var(--font-size-13);
}

.running-work-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}

.running-work-toggle {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: 1;
  min-width: 0;
  /* A thin strip: the rows below are the content, the header just counts. */
  padding: 6px 14px;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.running-work-toggle:hover {
  background: var(--bg-tertiary);
}

.running-work-dot {
  width: 7px;
  height: 7px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--primary);
}

.running-work-separator {
  width: 3px;
  height: 3px;
  flex-shrink: 0;
  border-radius: 50%;
  background: currentColor;
}

.running-work-count {
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 500;
}

.running-work-view {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  color: var(--text-secondary);
  font-size: var(--font-size-12);
}

.running-work-header-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 0 8px 0 4px;
}

.running-work-stop {
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-12);
  white-space: nowrap;
  cursor: pointer;
}

.running-work-stop:hover:not(:disabled) {
  background: var(--bg-tertiary);
}

.running-work-stop:disabled {
  opacity: 0.45;
  cursor: default;
}

.running-work-stop-error {
  flex-basis: 100%;
  padding: 0 12px 6px;
  color: var(--error-text);
  font-size: var(--font-size-12);
}

.running-work-items {
  background: var(--bg-base);
}

.running-work-header + .running-work-items {
  border-top: 1px solid var(--border);
}
</style>
