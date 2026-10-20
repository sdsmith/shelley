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

// TestShippedDepthCapLetsDepthTwoSpawnButNotDepthThree covers the shipped
// MaxSubagentDepth end to end: a subagent's subagent (depth 2) is offered the
// subagent tool, and depth 3 is the first conversation without it.
func TestShippedDepthCapLetsDepthTwoSpawnButNotDepthThree(t *testing.T) {
	t.Parallel()
	server, database, ps := newTestServer(t)
	ctx := t.Context()

	top, err := database.CreateConversation(ctx, nil, true, nil, strPtr("predictable"), db.ConversationOptions{})
	if err != nil {
		t.Fatal(err)
	}
	chain := map[string]string{}
	parent := top.ConversationID
	for want := 1; want <= 3; want++ {
		conv, err := database.CreateSubagentConversation(ctx, fmt.Sprintf("depth-%d", want), parent, nil)
		if err != nil {
			t.Fatalf("create depth-%d: %v", want, err)
		}
		chain[fmt.Sprintf("echo: depth %d delegates", want)] = conv.ConversationID
		parent = conv.ConversationID
	}

	toolsOffered := func(prompt string) map[string]bool {
		runDelegatedTurn(t, server, database, chain[prompt], prompt)
		return requestTools(t, ps, prompt)
	}

	if !toolsOffered("echo: depth 2 delegates")["subagent"] {
		t.Error("depth-2 subagent was not offered the subagent tool")
	}
	depth3 := toolsOffered("echo: depth 3 delegates")
	if depth3["subagent"] {
		t.Error("depth-3 subagent was offered the subagent tool")
	}
	if !depth3["message_parent"] {
		t.Error("depth-3 subagent lacks the message_parent tool")
	}
}
