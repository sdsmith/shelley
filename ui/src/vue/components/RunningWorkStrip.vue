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
            v-if="jobCount > 0 && subagents.length > 0"
            class="running-work-separator"
            aria-hidden="true"
          />
          <span v-if="subagents.length > 0">
            {{ subagents.length }} subagent{{ subagents.length === 1 ? "" : "s" }}
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
          :disabled="subagents.length === 0 || stoppingSubagents"
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
        v-for="sub in seenSubagents"
        :key="sub.conversation_id"
        :conversation="sub"
        :finished="!runningSubagentIds.has(sub.conversation_id)"
      />
      <BackgroundJobsList v-if="jobCount > 0 || seenJobs.length > 0" :jobs="seenJobs" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, ref, shallowRef, watch } from "vue";
import type { ConversationWithState } from "../../types";
import type { BackgroundJob } from "../../services/api";
import { BackgroundJobsKey } from "../composables/backgroundJobs";
import { ConversationsListKey } from "../composables/subagentLive";
import BackgroundJobsList from "./BackgroundJobsList.vue";
import RunningWorkAgent from "./RunningWorkAgent.vue";
import ToolChevron from "./tools/ToolChevron.vue";
import { api } from "../../services/api";

const props = defineProps<{ conversationId: string }>();
const emit = defineEmits<{ toggle: [] }>();

const conversations = inject(ConversationsListKey);
if (!conversations) throw new Error("RunningWorkStrip requires ConversationsListKey");
const backgroundJobs = inject(BackgroundJobsKey);
if (!backgroundJobs) throw new Error("RunningWorkStrip requires BackgroundJobsKey");

const open = ref(false);
const seenSubagents = shallowRef<ConversationWithState[]>([]);
const seenJobs = shallowRef<BackgroundJob[]>([]);

const jobCount = computed(
  () =>
    conversations.value.find((c) => c.conversation_id === props.conversationId)
      ?.running_background_jobs ?? 0,
);
const subagents = computed(() =>
  conversations.value.filter((c) => c.parent_conversation_id === props.conversationId && c.working),
);
const runningSubagentIds = computed(
  () => new Set(subagents.value.map((sub) => sub.conversation_id)),
);

// Rows the strip can show: running background jobs plus running subagents.
const itemCount = computed(() => jobCount.value + subagents.value.length);

// A single row renders directly, without the toggle header.
const single = computed(() => itemCount.value === 1);

// Two to four rows start expanded; more than four start collapsed with the
// header showing the count instead. The user's own toggle always wins over
// the default once they have used it.
const userToggled = ref(false);
watch(
  () => itemCount.value > 0 && itemCount.value <= 4,
  (defaultOpen) => {
    if (userToggled.value || open.value === defaultOpen) return;
    open.value = defaultOpen;
    emit("toggle"); // the strip grew or shrank — follow it when pinned to bottom
  },
  { immediate: true },
);

const expanded = computed(() => single.value || open.value);

// Header actions: stop every live background command / cancel every running
// subagent. Each button greys out while its kind has nothing running; the
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
    for (const sub of [...subagents.value]) {
      try {
        await api.cancelConversation(sub.conversation_id);
      } catch {
        break; // lost a race with a finishing subagent; the rest still cancel
      }
    }
    stoppingSubagents.value = false;
  })();
}

function toggleWork() {
  userToggled.value = true;
  open.value = !open.value;
  emit("toggle");
}

function remember<T>(seen: T[], current: T[], key: (item: T) => string): T[] {
  const items = new Map<string, T>();
  for (const item of [...seen, ...current]) items.set(key(item), item);
  return [...items.values()];
}

// `immediate` matters: mounted mid-run (reload with work already going),
// `expanded` is true from the first evaluation and would otherwise never
// fire, leaving the header counting rows it never renders.
watch(
  [expanded, subagents, backgroundJobs.jobs],
  ([isExpanded, agents, jobs]) => {
    if (!isExpanded) {
      seenSubagents.value = [];
      seenJobs.value = [];
      return;
    }
    seenSubagents.value = remember(seenSubagents.value, agents, (sub) => sub.conversation_id).sort(
      (a, b) =>
        a.created_at.localeCompare(b.created_at) ||
        a.conversation_id.localeCompare(b.conversation_id),
    );
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
