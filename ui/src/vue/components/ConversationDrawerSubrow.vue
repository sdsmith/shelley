<!-- Recursive row for a subagent conversation in the drawer's spawn tree.
     Renders the subagent markup (title, own working ring, preview, and a
     meta line: date, running-jobs gear, tree-aware subagent badge).
     An expanded entry renders its own nested list of these rows beneath it,
     so indent grows one level per depth with no hardcoded cap (the server
     caps nesting; the rendering is deliberately depth-agnostic). Each row
     carries `ancestorIds` — the ids above it — and a row whose own id is
     already among its ancestors renders nothing: a corrupt list that makes
     a conversation its own descendant must not recurse forever (matching
     conversationTree's cycle guards). Multiple
     root nodes so the row renders inline inside its parent's
     .subagent-list with no wrapper element — CONSEQUENCE: attribute
     fallthrough does not apply (Vue drops attrs on multi-root components),
     which is why the row declares its own data-conversation-id for stable
     per-row targeting from specs and styles; pass anything else the row
     needs as props. All state/handlers come from the DrawerCtx inject.
     Subrows are never drafts and never archived (both states are top-level
     only), so the draft/archived gates the top-level row carries do not
     apply here. -->
<template>
  <div
    v-if="!cycle"
    :class="`conversation-item subagent-item drawer-subagent-item-style ${isActive ? 'active' : ''}${isNew ? ' conversation-item-enter' : ''}`"
    :data-conversation-id="conversation.conversation_id"
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
  </div>

  <!-- Nested spawn tree: this entry's own subagents, recursively. -->
  <div
    v-if="!cycle && isExpanded && conversationSubagents.length > 0"
    class="subagent-list drawer-subagent-list"
  >
    <ConversationDrawerSubrow
      v-for="sub in conversationSubagents"
      :key="sub.conversation_id"
      :conversation="sub"
      :ancestor-ids="childAncestorIds"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, inject } from "vue";
import type { ConversationWithState } from "../../types";
import { DrawerCtxKey } from "./conversationDrawerShared";
import ConversationDrawerSubagentBadge from "./ConversationDrawerSubagentBadge.vue";
import GearIcon from "./GearIcon.vue";

const props = defineProps<{
  conversation: ConversationWithState;
  // The ids of the rows above this one (its parent chain up to the
  // top-level row). A row whose own id is already among its ancestors is
  // corrupt data (a parent cycle) and renders nothing instead of recursing
  // into itself forever — the render-side match of conversationTree's
  // cycle guards.
  ancestorIds: ReadonlySet<string>;
}>();

const ctx = inject(DrawerCtxKey)!;

// This row is its own ancestor: corrupt parent data, skip the whole row.
const cycle = computed(() => props.ancestorIds.has(props.conversation.conversation_id));
// The nested rows' ancestor set: everything above this row plus this row.
const childAncestorIds = computed(() => {
  const next = new Set(props.ancestorIds);
  next.add(props.conversation.conversation_id);
  return next;
});

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

function onSubClick(e: MouseEvent) {
  if (ctx.handleModifiedClick(e, props.conversation)) return;
  ctx.selectConversation(props.conversation);
}
function taskTooltip(count: number): string {
  return `${count} task${count === 1 ? "" : "s"} running`;
}
</script>

