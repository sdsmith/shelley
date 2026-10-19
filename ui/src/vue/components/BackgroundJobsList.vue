<template>
  <div
    class="running-commands"
    role="group"
    aria-label="Commands"
    :data-conversation-id="conversationId"
    :style="{ '--strip-depth': depth }"
  >
    <div v-if="error" class="background-jobs-error" role="alert">{{ error }}</div>
    <!-- "Loading…" stays up beside the alert while a first fetch keeps
         failing: the poller genuinely is still retrying. -->
    <div v-if="loading" class="background-jobs-empty">Loading…</div>
    <div v-else-if="retainedJobs.length === 0" class="background-jobs-empty">No running jobs.</div>
    <details
      v-for="job in retainedJobs"
      :key="job.job_id"
      class="running-command"
      data-testid="background-job"
    >
      <summary>
        <span class="running-command-tool">bash</span>
        <span class="running-command-name" :title="job.command">{{ job.command }}</span>
        <RunningToolTime
          v-if="runningIds.has(job.job_id)"
          v-slot="{ elapsed }"
          class="running-command-time"
          :start-time="job.started_at"
        >
          Running · {{ elapsed }}
        </RunningToolTime>
        <span v-else class="running-command-time">Finished</span>
        <span class="running-command-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div class="running-command-body">
        <div class="running-command-output-heading">
          <span>Output</span>
          <button
            v-if="runningIds.has(job.job_id)"
            type="button"
            class="running-command-stop"
            data-testid="background-job-kill"
            :disabled="killing.has(job.job_id)"
            :aria-label="`Stop command: ${job.command}`"
            @click="stop({ conversationId, jobId: job.job_id })"
          >
            {{ killing.has(job.job_id) ? "Stopping…" : "Stop command" }}
          </button>
        </div>
        <pre class="running-command-output" data-testid="background-job-tail">{{
          job.tail || "No output yet."
        }}</pre>
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed, inject } from "vue";
import type { BackgroundJob } from "../../services/api";
import { BackgroundJobsKey } from "../composables/backgroundJobs";
import RunningToolTime from "./tools/RunningToolTime.vue";

// One conversation's command group of the running-work strip: the strip's
// retained commands for `conversationId`, live-checked against the
// composable's polled group — polled commands show elapsed time and a stop
// button, the rest read Finished. This must be the strip's RETENTION list
// (finished rows kept until collapse), never the polled group's live jobs —
// those arrive through the composable, keyed by conversationId, and the two
// channels disagree by design. `depth` indents the group one step under its
// owning agent's row (the open conversation's own group sits at 0); the
// strip always knows the row's depth.
const props = defineProps<{
  conversationId: string;
  retainedJobs: BackgroundJob[];
  depth: number;
}>();

const backgroundJobs = inject(BackgroundJobsKey);
if (!backgroundJobs) throw new Error("BackgroundJobsList requires BackgroundJobsKey");
const { stop } = backgroundJobs;
const group = computed(() => backgroundJobs.jobsByConversation.value.get(props.conversationId));
const loading = computed(() => group.value?.jobs === null);
const runningIds = computed(() => new Set((group.value?.jobs ?? []).map((job) => job.job_id)));
const error = computed(() => group.value?.error ?? "");
const killing = computed(() => group.value?.killing ?? new Set<string>());
</script>

<style scoped>
.running-commands {
  /* Tree depth indent: one 1.5rem step per level under the strip's root,
     matching the agent rows; the group's own 14px row padding aligns the
     commands with the agent row at the same depth. */
  padding-left: calc(var(--strip-depth, 0) * 1.5rem);
}

.running-command + .running-command {
  border-top: 1px solid var(--border);
}

.running-command > summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  list-style: none;
  cursor: pointer;
}

.running-command > summary::-webkit-details-marker {
  display: none;
}

.running-command-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}

.running-command-tool,
.running-command-time,
.running-command-chevron {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-12);
}

.running-command[open] .running-command-chevron {
  transform: rotate(180deg);
}

.running-command-body {
  padding: 0 14px 14px;
}

.running-command-output-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  color: var(--text-secondary);
  font-size: var(--font-size-12);
}

.running-command-stop {
  padding: 5px 9px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  cursor: pointer;
}

.running-command-stop:hover {
  background: var(--bg-secondary);
}

.running-command-stop:disabled {
  color: var(--text-secondary);
  cursor: default;
}

.running-command-output {
  margin: 0;
  padding: 12px;

  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: var(--font-size-12);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
