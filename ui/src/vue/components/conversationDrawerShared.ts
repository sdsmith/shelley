// Shared types/helpers/injection key for ConversationDrawer.vue and its row
// children (ConversationDrawerRow.vue, ConversationDrawerSubrow.vue).
import type { ComputedRef, InjectionKey, Ref } from "vue";
import type { Conversation, ConversationWithState } from "../../types";
import type { TranslationKeys } from "../../i18n/types";
import type { OfferedTag } from "../../utils/tagFilter";
import { costReadout } from "./conversationTree";
import { formatUsd } from "../../utils/tokenCostGraph";

export type GroupBy = "none" | "daily" | "cwd" | "git_repo" | "tag" | "participants";

// The session-price readout on a drawer row, shared by top-level and nested
// rows so both encode one rule: hidden while there is no usage to price
// (total <= 0); a spawning entry (hasChildren) reads own/total when the
// recursive total exceeds the row's own spend, and the single total
// otherwise; a childless entry renders its own cost — which for a childless
// conversation is the recursive total the server reports (equal, or the
// total when the server reports spend with no listed children).
export interface CostParts {
  main: string;
  total: string | null;
}

export function costParts(
  conversation: ConversationWithState,
  conversations: readonly ConversationWithState[],
): CostParts | null {
  const { ownCost, totalCost, hasChildren } = costReadout(conversation, conversations);
  if (totalCost <= 0) return null;
  if (hasChildren && totalCost > ownCost)
    return { main: formatUsd(ownCost), total: formatUsd(totalCost) };
  return { main: formatUsd(totalCost), total: null };
}

// Parses the JSON-encoded tags field on a Conversation. Tolerates the empty
// string and malformed JSON (treated as no tags).
export function parseTags(conversation: Conversation): string[] {
  if (!conversation.tags) return [];
  try {
    const parsed = JSON.parse(conversation.tags);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

// SNIPPET_MARK_START / END match db.SnippetMarkStart / SnippetMarkEnd on the
// server. The server wraps every matched FTS term in these sentinel bytes.
export const SNIPPET_MARK_START = "\x02";
export const SNIPPET_MARK_END = "\x03";

export function stripSnippetMarks(snippet: string): string {
  return snippet.split(SNIPPET_MARK_START).join("").split(SNIPPET_MARK_END).join("");
}

export interface SnippetSegment {
  text: string;
  mark: boolean;
}

// Split a snippet into plain/marked runs so the row can render <mark> spans
// without v-html. Mirrors renderSnippet() in the React component.
export function renderSnippetSegments(snippet: string): SnippetSegment[] {
  const out: SnippetSegment[] = [];
  let i = 0;
  while (i < snippet.length) {
    const start = snippet.indexOf(SNIPPET_MARK_START, i);
    if (start === -1) {
      out.push({ text: snippet.slice(i), mark: false });
      break;
    }
    if (start > i) out.push({ text: snippet.slice(i, start), mark: false });
    const end = snippet.indexOf(SNIPPET_MARK_END, start + 1);
    if (end === -1) {
      out.push({ text: snippet.slice(start + 1), mark: false });
      break;
    }
    out.push({ text: snippet.slice(start + 1, end), mark: true });
    i = end + 1;
  }
  return out;
}

// The context shared from ConversationDrawer.vue down to its row children.
export interface DrawerCtx {
  t: (key: keyof TranslationKeys) => string;
  currentConversationId: ComputedRef<string | null>;
  searchText: ComputedRef<string>;
  showParticipantBadges: ComputedRef<boolean>;
  // Number of live terminals pinned to each conversation. Rows show a badge
  // when a conversation has more than one.
  terminalCounts: ComputedRef<Record<string, number>>;
  subagentsByParent: ComputedRef<Record<string, ConversationWithState[]>>;
  // The flat list the tree math reads: day-filtered and deduplicated
  // last-wins — the exact pool subagentsByParent buckets. Rows pass THIS
  // list to the conversationTree module, so badge numbers and rendered rows
  // agree; passing any other list (props.conversations, a locally filtered
  // one) can make numbers disagree with rows under the day filter.
  dayFilteredConversations: ComputedRef<ConversationWithState[]>;
  // Ids the conversation list gained since its previous state (null on the
  // first seed): rows carrying one of these animate in.
  enteringIds: Ref<Set<string> | null>;
  expandedSubagents: Ref<Set<string>>;
  copiedConvId: Ref<string | null>;
  pendingDeleteId: Ref<string | null>;
  pendingDeleteRef: Ref<HTMLElement | null>;
  editingId: Ref<string | null>;
  editingSlug: Ref<string>;
  renameInputRef: Ref<HTMLInputElement | null>;
  tagEditorId: Ref<string | null>;
  tagInput: Ref<string>;
  tagEditorRef: Ref<HTMLElement | null>;
  tagInputRef: Ref<HTMLInputElement | null>;
  draftLabels: ComputedRef<Record<string, string>>;
  groupBy: Ref<GroupBy>;
  // Tag filter: the selection is derived from the search query (`tag:foo`),
  // so toggling a chip edits that query.
  selectedTags: Ref<string[]>;
  selectedUsers: Ref<string[]>;
  toggleTagFilter: (tag: string) => void;
  formatDate: (timestamp: string) => string;
  formatCwdForDisplay: (p: string | null | undefined) => string | null;
  handleModifiedClick: (e: MouseEvent, conversation: Conversation) => boolean;
  handleAuxClick: (e: MouseEvent, conversation: Conversation) => void;
  selectConversation: (c: Conversation) => void;
  toggleSubagents: (e: MouseEvent, conversationId: string) => void;
  handleStartRename: (e: MouseEvent, conversation: Conversation) => void;
  handleRename: (conversationId: string) => void;
  handleRenameKeyDown: (e: KeyboardEvent, conversationId: string) => void;
  handleOpenTagEditor: (e: MouseEvent, conversationId: string) => void;
  handleAddTag: (conversation: Conversation, tag?: string) => Promise<void>;
  // Tag-editor dropdown: existing tags matching `typed` anywhere, best-first.
  matchTagOffers: (conversation: Conversation, typed: string) => OfferedTag[];
  handleRemoveTag: (conversation: Conversation, tag: string) => void;
  handleArchive: (e: MouseEvent, conversationId: string) => void;
  handleUnarchive: (e: MouseEvent, conversationId: string) => void;
  handleCopyGitHash: (e: MouseEvent, hash: string, convId: string) => void;
  handleDeleteClick: (e: MouseEvent, conversationId: string) => void;
  handleConfirmDelete: (e: MouseEvent, conversationId: string) => void;
  handleCancelDelete: (e: MouseEvent) => void;
}

export const DrawerCtxKey: InjectionKey<DrawerCtx> = Symbol("shelley-conversation-drawer");
