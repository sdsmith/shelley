package server

import (
	"fmt"
	"slices"
	"strings"
	"testing"

	"shelley.exe.dev/claudetool"
	"shelley.exe.dev/db"
)

// TestSubagentDepthCountsParentHops covers the depth walk that feeds
// MaxSubagentDepth: a top-level row is 0 and each parent hop adds one, so a
// max above 1 caps nesting at that depth instead of only separating
// top-level conversations from their children.
func TestSubagentDepthCountsParentHops(t *testing.T) {
	server, database, _ := newTestServer(t)

	ctx := t.Context()

	top, err := database.CreateConversation(ctx, nil, true, nil, nil, db.ConversationOptions{})
	if err != nil {
		t.Fatalf("create top: %v", err)
	}
	if got, err := server.subagentDepth(ctx, top.ConversationID); err != nil || got != 0 {
		t.Fatalf("top depth = %d, %v; want 0", got, err)
	}

	parent := top.ConversationID
	for want := 1; want <= 3; want++ {
		conv, err := database.CreateSubagentConversation(ctx, fmt.Sprintf("depth-%d", want), parent, nil)
		if err != nil {
			t.Fatalf("create depth-%d: %v", want, err)
		}
		if got, err := server.subagentDepth(ctx, conv.ConversationID); err != nil || got != want {
			t.Fatalf("depth-%d row walks to %d, %v; want %d", want, got, err, want)
		}
		mgr, err := server.getOrCreateConversationManager(ctx, conv.ConversationID, "")
		if err != nil {
			t.Fatalf("manager for depth-%d: %v", want, err)
		}
		if mgr.toolSetConfig.SubagentDepth != want {
			t.Fatalf("manager for depth-%d carries depth %d; want %d", want, mgr.toolSetConfig.SubagentDepth, want)
		}
		// Pin the shipped nesting boundary: with MaxSubagentDepth=2, a
		// depth-1 subagent may spawn another level (its toolset offers the
		// subagent tool) and a depth-2 subagent may not.
		if want <= 2 {
			toolCfg := mgr.toolSetConfig
			toolCfg.ParentConversationID = conv.ConversationID
			toolSet := claudetool.NewToolSet(ctx, toolCfg)
			names := toolNames(toolSet)
			toolSet.Cleanup()
			hasSubagent := slices.Contains(names, "subagent")
			if want == 1 && !hasSubagent {
				t.Errorf("depth-1 toolset lacks the subagent tool; has %v", names)
			}
			if want == 2 && hasSubagent {
				t.Errorf("depth-2 toolset offers the subagent tool; has %v", names)
			}
		}
		parent = conv.ConversationID
	}
}

func toolNames(ts *claudetool.ToolSet) []string {
	names := make([]string, 0, len(ts.Tools()))
	for _, tool := range ts.Tools() {
		names = append(names, tool.Name)
	}
	return names
}

// TestSubagentDepthErrorPaths covers the walk's two documented failure modes:
// a missing row errors (the depth is never guessed, not even to 0), and a
// corrupt parent chain — a cycle — errors; manager creation propagates both
// instead of building a manager.
func TestSubagentDepthErrorPaths(t *testing.T) {
	server, database, _ := newTestServer(t)

	ctx := t.Context()

	if _, err := server.subagentDepth(ctx, "no-such-conversation"); err == nil {
		t.Fatal("unknown conversation: want an error, got nil")
	} else if got, want := err.Error(), "load conversation no-such-conversation for subagent depth"; !strings.Contains(got, want) {
		t.Fatalf("missing-row error %q does not name the wrap; want it to contain %q", got, want)
	}

	top, err := database.CreateConversation(ctx, nil, true, nil, nil, db.ConversationOptions{})
	if err != nil {
		t.Fatalf("create top: %v", err)
	}
	a, err := database.CreateSubagentConversation(ctx, "cycle-a", top.ConversationID, nil)
	if err != nil {
		t.Fatalf("create cycle-a: %v", err)
	}
	b, err := database.CreateSubagentConversation(ctx, "cycle-b", a.ConversationID, nil)
	if err != nil {
		t.Fatalf("create cycle-b: %v", err)
	}
	// Reparent a under its own child: the two form a parent cycle.
	if _, err := database.UpdateConversationParent(ctx, a.ConversationID, b.ConversationID); err != nil {
		t.Fatalf("reparent cycle-a: %v", err)
	}
	if _, err := server.subagentDepth(ctx, a.ConversationID); err == nil {
		t.Fatal("parent cycle: want an error, got nil")
	}
	if _, err := server.getOrCreateConversationManager(ctx, a.ConversationID, ""); err == nil {
		t.Fatal("manager creation on a parent cycle: want the walk's error, got nil")
	}
}
