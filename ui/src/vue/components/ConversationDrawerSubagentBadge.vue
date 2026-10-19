<!-- The "subagents" badge on a drawer row: the count pair, the (ΣZ) suffix
     when the tree extends past the direct children, the working ring (lit
     while any descendant at any depth works — see anyDescendantWorking's doc
     for how that differs from the row's own ring), and the expand/collapse
     chevron. Numbers and rendering flags come from the conversationTree
     module's subagentBadge (its doc is the contract for what renders);
     collapse semantics (whole subtree, per-entry persistence) live in the
     shared expanded set. Self-guards: renders nothing for entries without
     subagents, and nothing for draft or archived entries (top-level-only
     states) even if a caller passes one. Used by top-level rows and,
     recursively, by nested subagent rows. -->
<template>
  <button
    v-if="renders"
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
import { anyDescendantWorking, childrenByParent, subagentBadge } from "./conversationTree";

const props = defineProps<{
  conversation: ConversationWithState;
}>();

const ctx = inject(DrawerCtxKey)!;

// One childrenByParent build per list version, shared by the badge numbers
// and the ring below (the module's helpers rebuild per call unless handed a
// prebuilt map).
const byParent = computed(() => childrenByParent(ctx.dayFilteredConversations.value));

const badge = computed(() =>
  subagentBadge(props.conversation, ctx.dayFilteredConversations.value, byParent.value),
);
const hasChildren = computed(() => badge.value.launched > 0);

const descendantWorking = computed(() =>
  anyDescendantWorking(props.conversation, ctx.dayFilteredConversations.value, byParent.value),
);
// Draft/archived entries carry no spawn tree (both states are top-level
// row concerns); the guard keeps a stray call site silent.
const renders = computed(
  () => hasChildren.value && !props.conversation.is_draft && !props.conversation.archived,
);
const isExpanded = computed(() =>
  ctx.expandedSubagents.value.has(props.conversation.conversation_id),
);
// Flags from subagentBadge drive the pair and the Σ suffix (its doc is the
// rendering contract).
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
