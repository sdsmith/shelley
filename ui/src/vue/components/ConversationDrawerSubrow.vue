<!-- Recursive row for a subagent conversation in the drawer's spawn tree.
     Renders the subagent markup (title, own working ring, preview, date,
     running-jobs gear, trailing cost) plus — when the entry has spawned
     subagents of its own — the tree-aware subagent badge and the own/total
     cost readout. An expanded entry renders its own nested list of these
     rows beneath it, so indent grows one level per depth with no hardcoded
     cap (the server caps nesting; the rendering is deliberately
     depth-agnostic). Multiple root nodes so it renders inline inside its
     parent's .subagent-list with no wrapper element. All state/handlers
     come from the DrawerCtx inject. -->
<template>
  <div
    :class="`conversation-item subagent-item drawer-subagent-item-style ${isActive ? 'active' : ''}${isNew ? ' conversation-item-enter' : ''}`"
    @click="onSubClick"
    @auxclick="ctx.handleAuxClick($event, conversation)"
  >
    <div class="drawer-conversation-item-flex-container">
      <div class="drawer-conversation-header-row">
        <div class="drawer-conversation-item-flex-container">
          <div class="conversation-title" :title="conversation.slug || undefined">
            <em v-if="!conversation.slug">untitled</em>
            <template v-else>{{ conversation.slug }}</template>
          </div>
        </div>
        <span
          v-if="conversation.working"
          class="working-indicator"
          :title="ctx.t('subagentIsWorking')"
        />
      </div>
      <div class="conversation-preview" :title="conversation.preview || undefined">
        {{ conversation.preview || "\u00a0" }}
      </div>
      <div class="conversation-meta">
        <span class="conversation-date drawer-subagent-date">{{
          ctx.formatDate(conversation.updated_at)
        }}</span>
        <span
          v-if="conversation.running_background_jobs > 0"
          class="conversation-running-work"
          data-testid="conversation-running-work"
          :aria-label="taskTooltip(conversation.running_background_jobs)"
          :title="taskTooltip(conversation.running_background_jobs)"
        >
          <GearIcon class="conversation-running-work-gear" />
          {{ conversation.running_background_jobs }}
        </span>
        <ConversationDrawerSubagentBadge :conversation="conversation" />
      </div>
    </div>
    <!-- Trailing cost, today's placement. Spawning entries read own/total
         (today's `total > own` guard); childless entries keep their own
         cost only. -->
    <span v-if="costParts" class="conversation-cost"
      >{{ costParts.main }}<span
        v-if="costParts.total"
        class="conversation-cost-slash"
        aria-hidden="true"
        >/</span
      >{{ costParts.total ?? "" }}</span
    >
  </div>

  <!-- Nested spawn tree: this entry's own subagents, recursively. -->
  <div
    v-if="isExpanded && conversationSubagents.length > 0"
    class="subagent-list drawer-subagent-list"
  >
    <ConversationDrawerSubrow
      v-for="sub in conversationSubagents"
      :key="sub.conversation_id"
      :conversation="sub"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, inject } from "vue";
import type { ConversationWithState } from "../../types";
import { DrawerCtxKey } from "./conversationDrawerShared";
import { costReadout } from "./conversationTree";
import ConversationDrawerSubagentBadge from "./ConversationDrawerSubagentBadge.vue";
import GearIcon from "./GearIcon.vue";
import { formatUsd } from "../../utils/tokenCostGraph";

const props = defineProps<{
  conversation: ConversationWithState;
}>();

const ctx = inject(DrawerCtxKey)!;

const isActive = computed(
  () => props.conversation.conversation_id === ctx.currentConversationId.value,
);
const isNew = computed(
  () =>
    ctx.enteringIds.value !== null &&
    ctx.enteringIds.value.has(props.conversation.conversation_id),
);
const conversationSubagents = computed(
  () => ctx.subagentsByParent.value[props.conversation.conversation_id] || [],
);
const isExpanded = computed(() =>
  ctx.expandedSubagents.value.has(props.conversation.conversation_id),
);
const readout = computed(() => costReadout(props.conversation, ctx.treeConversations.value));
const costParts = computed(() => {
  const { ownCost, totalCost, hasChildren } = readout.value;
  if (!hasChildren) return ownCost > 0 ? { main: formatUsd(ownCost), total: null } : null;
  if (totalCost <= 0) return null;
  if (totalCost > ownCost) return { main: formatUsd(ownCost), total: formatUsd(totalCost) };
  return { main: formatUsd(totalCost), total: null };
});

function onSubClick(e: MouseEvent) {
  if (ctx.handleModifiedClick(e, props.conversation)) return;
  ctx.selectConversation(props.conversation);
}
function taskTooltip(count: number): string {
  return `${count} task${count === 1 ? "" : "s"} running`;
}
</script>
