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
      <RunningWorkAgent
        v-for="row in rows"
        :key="row.conversation.conversation_id"
        :conversation="row.conversation"
        :state="row.state"
        :depth="row.depth"
      />
      <BackgroundJobsList v-if="jobCount > 0 || seenJobs.length > 0" :jobs="seenJobs" />
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
import { stripRows, workingDescendants } from "./conversationTree";
import { api } from "../../services/api";

const props = defineProps<{ conversationId: string }>();
const emit = defineEmits<{ toggle: [] }>();

const conversations = inject(ConversationsListKey);
if (!conversations) throw new Error("RunningWorkStrip requires ConversationsListKey");
const backgroundJobs = inject(BackgroundJobsKey);
if (!backgroundJobs) throw new Error("RunningWorkStrip requires BackgroundJobsKey");

const open = ref(false);
const seenJobs = shallowRef<BackgroundJob[]>([]);

// The flat list, deduplicated last-wins by conversation_id — the module's
// contract, the same rule the drawer's dayFilteredConversations applies to
// its pool (minus the day filter: the strip shows running work regardless
// of the panel's selected day). Walking the raw list would double-count a
// duplicated conversation.
const dedupedConversations = computed(() => [
  ...new Map(conversations.value.map((c) => [c.conversation_id, c])).values(),
]);

// The open conversation's own running commands. Header tasks are running
// work only; descendants' commands join here in task 04.
const jobCount = computed(
  () =>
    conversations.value.find((c) => c.conversation_id === props.conversationId)
      ?.running_background_jobs ?? 0,
);

// Stop list: every working descendant of the open conversation at any
// depth. The header's subagent count and "Stop subagents" both read it.
const rootConversation = computed(() =>
  dedupedConversations.value.find((c) => c.conversation_id === props.conversationId),
);
const stopList = computed(() =>
  rootConversation.value
    ? workingDescendants(rootConversation.value, dedupedConversations.value)
    : [],
);
const runningSubagentCount = computed(() => stopList.value.length);

// Retention while expanded: every row the strip has shown — including the
// Waiting scaffolding rows — stays until collapse, so finished work at any
// depth doesn't vanish mid-review. Cleared on collapse.
const retainedIds = ref(new Set<string>());
const rows = computed(() =>
  stripRows(props.conversationId, dedupedConversations.value, retainedIds.value),
);

// Rows the strip can show: running background jobs plus running subagents.
const itemCount = computed(() => jobCount.value + runningSubagentCount.value);

// A single row renders directly, without the toggle header; anything more
// starts collapsed behind the header's count (the user's toggle opens it).
// Waiting scaffolding and retained finished rows never count toward this —
// only running work does.
const single = computed(() => itemCount.value === 1);

const expanded = computed(() => single.value || open.value);

// Header actions: stop every live background command / cancel every working
// descendant. Each button greys out while its kind has nothing running; the
// commands button also reads "Stopping…" while every live job sits in the
// composable's killing set (pruned as the jobs leave the polled list).
const liveJobs = computed(() => backgroundJobs.jobs.value ?? []);
const allJobsStopping = computed(() => {
  const jobs = liveJobs.value;
  const { killing } = backgroundJobs;
  return jobs.length > 0 && jobs.every((job) => killing.value.has(job.job_id));
});
const { stop: stopJob } = backgroundJobs;

function stopAllJobs() {
  for (const job of liveJobs.value) void stopJob(job.job_id);
}

const stoppingSubagents = ref(false);
function stopAllSubagents() {
  if (stoppingSubagents.value) return;
  stoppingSubagents.value = true;
  void (async () => {
    for (const sub of [...stopList.value]) {
      try {
        await api.cancelConversation(sub.conversation_id);
      } catch {
        // Lost a race with a finishing subagent; cancel the rest anyway.
      }
    }
    stoppingSubagents.value = false;
  })();
}

function toggleWork() {
  open.value = !open.value;
  emit("toggle");
}

function remember<T>(seen: T[], current: T[], key: (item: T) => string): T[] {
  const items = new Map<string, T>();
  for (const item of [...seen, ...current]) items.set(key(item), item);
  return [...items.values()];
}

// Retention update: while expanded, every shown row id joins the retained
// set (rows only ever grow while expanded, so a size change is the only
// case to catch); collapsing clears it. `immediate` matters: mounted
// mid-run (reload with work already going), `expanded` is true from the
// first evaluation and would otherwise never fire, leaving the header
// counting rows it never renders.
watch(
  [expanded, rows, backgroundJobs.jobs],
  ([isExpanded, currentRows, jobs]) => {
    if (!isExpanded) {
      if (retainedIds.value.size > 0) retainedIds.value = new Set();
      seenJobs.value = [];
      return;
    }
    const next = new Set(retainedIds.value);
    for (const row of currentRows) next.add(row.conversation.conversation_id);
    if (next.size !== retainedIds.value.size) retainedIds.value = next;
    if (jobs !== null) {
      seenJobs.value = remember(seenJobs.value, jobs, (job) => job.job_id);
    }
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

.running-work-items {
  background: var(--bg-base);
}

.running-work-header + .running-work-items {
  border-top: 1px solid var(--border);
}
</style>
