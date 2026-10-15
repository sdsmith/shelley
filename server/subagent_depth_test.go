package server

import (
	"fmt"
	"testing"

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
		parent = conv.ConversationID
	}
}
