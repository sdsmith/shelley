<template>
  <button
    type="button"
    class="running-work-agent"
    :style="{ '--strip-depth': depth }"
    title="Open subagent conversation"
    @click="openAgent"
  >
    <span class="running-work-agent-description">
      <strong>{{ conversation.slug }}</strong>
      <span
        >Agent<template v-if="state === 'running'"> · {{ activity || "Working…" }}</template></span
      >
      <span v-if="loadError" role="alert">{{ loadError }}</span>
    </span>
    <RunningToolTime
      v-if="state === 'running' && startedAt"
      v-slot="{ elapsed }"
      class="running-work-agent-time"
      :start-time="startedAt"
    >
      Running · {{ elapsed }}
    </RunningToolTime>
    <span v-else-if="state === 'running'" class="running-work-agent-time">Running</span>
    <span v-else-if="state === 'waiting'" class="running-work-agent-time">Waiting</span>
    <span v-else class="running-work-agent-time">Finished</span>
    <span class="running-work-agent-open" aria-hidden="true">↗</span>
  </button>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { ConversationWithState } from "../../types";
import type { StripRowState } from "./conversationTree";
import { navigateToConversationSlug, useSubagentLive } from "../composables/subagentLive";
import { api } from "../../services/api";
import { messageStore } from "../../services/messageStore";
import RunningToolTime from "./tools/RunningToolTime.vue";

// One row of the running-work strip. State is the strip row's three states:
// running (the agent's turn is open), finished, or waiting — an idle
// ancestor of a working descendant, its own turn over, blocked on a
// child's report-back. Depth is the row's depth under the strip's root
// conversation; each level indents one step.
const props = defineProps<{
  conversation: ConversationWithState;
  state: StripRowState;
  depth: number;
}>();

const { activity, startedAt } = useSubagentLive(
  computed(() => props.conversation.slug ?? ""),
  computed(() => props.conversation.conversation_id),
);
const loadError = ref("");
onMounted(async () => {
  const id = props.conversation.conversation_id;
  try {
    await messageStore.hydrate(id);
    const cached = messageStore.peek(id);
    if (messageStore.needsBackfill(id)) {
      const response = await api.getConversationWithProgress(id);
      messageStore.applyFullHistory(id, response);
    } else if (
      cached &&
      (cached.needsRefresh || cached.maxSequenceIdKnown > cached.maxSequenceId)
    ) {
      const fromSeq = cached.maxSequenceId;
      const response = await api.getConversationSince(id, fromSeq);
      messageStore.applyIncrementalTail(id, response, fromSeq);
    }
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  }
});

function openAgent() {
  navigateToConversationSlug(props.conversation.slug ?? props.conversation.conversation_id);
}
</script>

<style scoped>
.running-work-agent {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px 14px;
  /* Tree depth indent: one 1.5rem step per level under the strip's root
     (the same unit the drawer's nested rows use). */
  padding-left: calc(14px + var(--strip-depth, 0) * 24px);
  border: 0;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-13);
  text-align: left;
  cursor: pointer;
}

.running-work-agent:hover {
  background: var(--bg-secondary);
}

.running-work-agent-description {
  flex: 1;
  min-width: 0;
  /* One line: slug, then the live command/activity beside it. */
  display: flex;
  align-items: baseline;
  gap: 6px;
  overflow: hidden;
  white-space: nowrap;
}

.running-work-agent-description strong {
  flex-shrink: 0;
  font-weight: 500;
}

.running-work-agent-description > span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-secondary);
  font-size: var(--font-size-12);
}

.running-work-agent-open,
.running-work-agent-time {
  color: var(--text-secondary);
  font-size: var(--font-size-12);
  white-space: nowrap;
}
</style>
