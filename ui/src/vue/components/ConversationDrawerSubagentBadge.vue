<!-- The "subagents" badge on a drawer row: the count pair (N direct children
     running / M direct children launched), the (ΣZ) suffix when the tree
     extends past the direct children, the working ring (lit while ANY
     descendant at any depth works — distinct from the row's own ring, which
     means "this agent's turn is open"), and the expand/collapse chevron.
     Renders nothing for entries without subagents. Numbers come from the
     conversationTree module; collapse semantics (whole subtree, per-entry
     persistence) live in the shared expanded set. Used by top-level rows
     and, recursively, by nested subagent rows. -->
<template>
  <button
    v-if="hasChildren"
    type="button"
    class="subagent-count-badge"
    v-tooltip.top="tooltip"
    :aria-label="isExpanded ? ctx.t('collapseSubagents') : ctx.t('expandSubagents')"
    @click="ctx.toggleSubagents($event, conversation.conversation_id)"
  >
    <span
      v-if="descendantWorking"
      class="working-indicator"
      data-testid="subagent-badge-running"
      aria-hidden="true"
    />
    <span class="drawer-subagent-count-badge-text">{{ label }}</span>
    <svg
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      :class="`drawer-subagent-chevron ${isExpanded ? 'drawer-subagent-chevron-expanded' : 'drawer-subagent-chevron-collapsed'}`"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        :stroke-width="2"
        d="M9 5l7 7-7 7"
      />
    </svg>
  </button>
</template>

<script setup lang="ts">
import { computed, inject } from "vue";
import type { ConversationWithState } from "../../types";
import { DrawerCtxKey } from "./conversationDrawerShared";
import { anyDescendantWorking, costReadout, subagentBadge } from "./conversationTree";

const props = defineProps<{
  conversation: ConversationWithState;
}>();

const ctx = inject(DrawerCtxKey)!;

const badge = computed(() => subagentBadge(props.conversation, ctx.treeConversations.value));
const hasChildren = computed(
  () => costReadout(props.conversation, ctx.treeConversations.value).hasChildren,
);

const descendantWorking = computed(() =>
  anyDescendantWorking(props.conversation, ctx.treeConversations.value),
);
const isExpanded = computed(() =>
  ctx.expandedSubagents.value.has(props.conversation.conversation_id),
);
// The N/M pair hides when N = 0 (even while a deeper descendant runs — the
// ring carries that signal); the (ΣZ) suffix renders only when Z > M.
const label = computed(() => {
  const b = badge.value;
  const pair = b.showRunningPair ? `${b.running}/` : "";
  const suffix = b.showDescendantSuffix ? ` (Σ${b.descendants})` : "";
  return `${pair}${b.launched}${suffix}`;
});
const tooltip = computed(() => {
  const action = isExpanded.value ? ctx.t("hideSubagents") : ctx.t("showSubagents");
  return badge.value.showRunningPair
    ? `${action} (${badge.value.running}/${badge.value.launched} ${ctx.t("running")})`
    : action;
});
</script>
