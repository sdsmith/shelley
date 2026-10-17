package server

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"shelley.exe.dev/db"
	"shelley.exe.dev/llm"
	"shelley.exe.dev/llm/predictable"
)

// subagentDoneFixture sets up a parent conversation with an active manager and
// a child subagent conversation whose manager comes from
// getOrCreateConversationManager. It records a final assistant text
// message into the subagent's DB as the subagent's latest response.
type subagentDoneFixture struct {
	server   *Server
	database *db.DB
	llmSvc   *predictable.Service

	parentID    string
	parentMgr   *ConversationManager
	subagentID  string
	subagentMgr *ConversationManager
	subSlug     string
	subResponse string
}

func newSubagentDoneFixture(t *testing.T, subResponse string) *subagentDoneFixture {
	t.Helper()
	server, database, ps := newTestServer(t)

	ctx := t.Context()

	// Parent conversation.
	parentConv, err := database.CreateConversation(ctx, nil, true, nil, nil, db.ConversationOptions{})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}

	parentMgr, err := server.getOrCreateConversationManager(ctx, parentConv.ConversationID, "")
	if err != nil {
		t.Fatalf("get parent manager: %v", err)
	}

	// Subagent conversation, parented to the above. Use CreateSubagentConversation
	// so ParentConversationID is set.
	slug := "sub-test"
	subConv, err := database.CreateSubagentConversation(ctx, slug, parentConv.ConversationID, nil)
	if err != nil {
		t.Fatalf("create subagent conv: %v", err)
	}

	subagentMgr, err := server.getOrCreateConversationManager(ctx, subConv.ConversationID, "")
	if err != nil {
		t.Fatalf("get subagent manager: %v", err)
	}

	// Record a final assistant text message on the subagent so lastAssistantText
	// has something to read.
	assistantMsg := llm.Message{
		Role:      llm.MessageRoleAssistant,
		Content:   []llm.Content{{Type: llm.ContentTypeText, Text: subResponse}},
		EndOfTurn: true,
	}
	if err := server.recordMessage(ctx, subConv.ConversationID, assistantMsg, llm.Usage{}, nil); err != nil {
		t.Fatalf("record subagent assistant: %v", err)
	}

	return &subagentDoneFixture{
		server:      server,
		database:    database,
		llmSvc:      ps,
		parentID:    parentConv.ConversationID,
		parentMgr:   parentMgr,
		subagentID:  subConv.ConversationID,
		subagentMgr: subagentMgr,
		subSlug:     slug,
		subResponse: subResponse,
	}
}

// A delegated turn that ends with a plain reply — no message_parent — must
// still resolve the parent's wait: both the subagent tool's ack and the
// parent's own instructions say the subagent's messages will wake it, so
// Shelley forwards the terminal message, attributed to the subagent. Without
// the forward the parent waits forever (seen in the wild: a round-2 review
// summary agent wrote its report as its final text and stalled the whole
// review tree). A user-driven turn with no delegation pending still wakes
// nobody: only work the parent asked for reports back.
func TestUnreportedDelegatedTurnForwardsFinalMessage(t *testing.T) {
	server, database, held, parent := newBtwTest(t)
	ctx := t.Context()
	child, err := database.CreateSubagentConversation(ctx, "silent-worker", parent.ConversationID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewSubagentRunner(server).RunSubagent(ctx, child.ConversationID, "echo: delegated answer", "predictable", ""); err != nil {
		t.Fatal(err)
	}
	releaseAndWaitIdle(t, server, child.ConversationID, held.waitCall(t, "echo: delegated answer"))

	forward := `Subagent "silent-worker" ended its turn without sending a final message_parent report. Its final message is forwarded below.` +
		"\n\ndelegated answer"
	wrapped := `<subagent_message conversation_id="` + child.ConversationID + `" slug="silent-worker">` +
		"\n" + forward + "\n</subagent_message>"
	releaseAndWaitIdle(t, server, parent.ConversationID, held.waitCall(t, wrapped))

	// A user-driven turn with no delegation pending wakes nobody. The
	// explicit report below lands after any spurious forward would have, so
	// reading the parent's rows once it arrives settles the check.
	response := postBtwChat(t, server, child.ConversationID,
		ChatRequest{Message: "echo: manual child turn", Model: "predictable"})
	if response.Code != 202 {
		t.Fatalf("manual child turn status=%d body=%s", response.Code, response.Body.String())
	}
	releaseAndWaitIdle(t, server, child.ConversationID, held.waitCall(t, "echo: manual child turn"))
	if err := NewSubagentRunner(server).MessageParent(ctx, child.ConversationID, "explicit report", true); err != nil {
		t.Fatal(err)
	}
	wrapped = `<subagent_message conversation_id="` + child.ConversationID + `" slug="silent-worker">` +
		"\nexplicit report\n</subagent_message>"
	releaseAndWaitIdle(t, server, parent.ConversationID, held.waitCall(t, wrapped))

	want := []string{forward, "explicit report"}
	if got := senderReports(t, database, parent.ConversationID); !slices.Equal(got, want) {
		t.Fatalf("parent heard %q from the subagent, want %q", got, want)
	}
}

// A delegated turn that ends while its background bash job still runs must
// not report yet — that was the noise that removed unconditional turn-end
// notices. The job's exit opens another turn, and that turn's end is the one
// that forwards.
func TestTurnEndForwardWaitsForRunningBackgroundJob(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir()) // keep the job log out of /tmp
	server, database, _ := newTestServer(t)
	defer stopActiveConversationLoops(server)
	server.toolSetConfig.BashBackgroundAfter = 50 * time.Millisecond

	parent, err := database.CreateConversation(t.Context(), nil, true, nil, strPtr("predictable"), db.ConversationOptions{})
	if err != nil {
		t.Fatal(err)
	}
	child, err := database.CreateSubagentConversation(t.Context(), "job-worker", parent.ConversationID, nil)
	if err != nil {
		t.Fatal(err)
	}
	gate := filepath.Join(t.TempDir(), "gate")
	if err := syscall.Mkfifo(gate, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewSubagentRunner(server).RunSubagent(t.Context(), child.ConversationID,
		"bash: echo started; read -r _ < "+gate+"; echo finished", "predictable", ""); err != nil {
		t.Fatal(err)
	}
	waitForMessageContaining(t, database, child.ConversationID, "moved to background job", 10*time.Second)
	waitForIdle(t, server, child.ConversationID)

	if err := os.WriteFile(gate, []byte("go\n"), 0); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 15*time.Second, func() bool {
		return len(senderReports(t, database, parent.ConversationID)) == 1
	})
	// The forward carries the job-notice turn's reply, proving the first
	// turn's end stayed quiet while the job ran.
	if got := senderReports(t, database, parent.ConversationID)[0]; !strings.Contains(got, "job turn done") {
		t.Fatalf("forward = %q, want the job-notice turn's final message", got)
	}
}

// senderReports returns the texts of every message attributed to a subagent
// sender, in order.
func senderReports(t *testing.T, database *db.DB, conversationID string) []string {
	t.Helper()
	var out []string
	for _, m := range listMessages(t, database, conversationID) {
		if m.Type != string(db.MessageTypeUser) || m.UserData == nil {
			continue
		}
		data, ok, err := parseSenderMessageUserData([]byte(*m.UserData))
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			out = append(out, data.Text)
		}
	}
	return out
}

// Cleanup must never evict a conversation manager whose agent is mid-turn
// (agentWorking=true). Tool calls — e.g. a shell command that runs
// for many minutes — do not Touch the manager, so lastActivity goes
// stale even though the conversation is very much alive. Evicting it tears
// down the loop context mid-flight (cancelling in-flight tool calls and LLM
// requests) and orphans the turn.
func TestCleanupSkipsWorkingConversations(t *testing.T) {
	t.Parallel()
	server, database, _ := newTestServer(t)
	ctx := t.Context()

	mkStale := func(working bool) (string, *ConversationManager) {
		conv, err := database.CreateConversation(ctx, nil, true, nil, nil, db.ConversationOptions{})
		if err != nil {
			t.Fatalf("create conversation: %v", err)
		}
		mgr, err := server.getOrCreateConversationManager(ctx, conv.ConversationID, "")
		if err != nil {
			t.Fatalf("get manager: %v", err)
		}
		if working {
			mgr.SetAgentWorking(true)
		}
		mgr.mu.Lock()
		mgr.lastActivity = time.Now().Add(-time.Hour) // well past the 30-min cutoff
		mgr.mu.Unlock()
		return conv.ConversationID, mgr
	}

	workingID, _ := mkStale(true)
	idleID, _ := mkStale(false)

	server.Cleanup()

	server.mu.Lock()
	_, workingKept := server.activeConversations[workingID]
	_, idleKept := server.activeConversations[idleID]
	server.mu.Unlock()

	if !workingKept {
		t.Fatalf("Cleanup evicted a conversation whose agent is still working")
	}
	if idleKept {
		t.Fatalf("Cleanup kept a stale idle conversation; want evicted")
	}
}

// requestWithText returns the most recent request the predictable service
// received whose messages contain text.
func requestWithText(t *testing.T, ps *predictable.Service, text string) *llm.Request {
	t.Helper()
	requests := ps.GetRecentRequests()
	for i := len(requests) - 1; i >= 0; i-- {
		if requestHasText(requests[i], text) {
			return requests[i]
		}
	}
	t.Fatalf("no LLM request contained %q", text)
	return nil
}

// A subagent whose manager was first loaded by something other than the
// subagent tool (the user opening it, a background job notice, reload after
// eviction) is still a subagent: it cannot spawn subagents, and it can
// message its parent.
func TestSubagentLoadedOutsideSubagentToolKeepsItsRole(t *testing.T) {
	t.Parallel()
	server, database, ps := newTestServer(t)
	// Pin the one-level policy this test asserts; the server default may vary.
	server.toolSetConfig.MaxSubagentDepth = 1
	ctx := t.Context()
	parent, err := database.CreateConversation(ctx, nil, true, nil, strPtr("predictable"), db.ConversationOptions{})
	if err != nil {
		t.Fatal(err)
	}
	sub, err := database.CreateSubagentConversation(ctx, "worker", parent.ConversationID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.getOrCreateConversationManager(ctx, sub.ConversationID, ""); err != nil {
		t.Fatal(err)
	}

	if _, err := NewSubagentRunner(server).RunSubagent(ctx, sub.ConversationID, "echo: delegated work", "predictable", ""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 15*time.Second, func() bool {
		return countByType(listMessages(t, database, sub.ConversationID), db.MessageTypeAgent) == 1 && !server.IsAgentWorking(sub.ConversationID)
	})
	tools := map[string]bool{}
	for _, tool := range requestWithText(t, ps, "echo: delegated work").Tools {
		tools[tool.Name] = true
	}
	if tools["subagent"] {
		t.Error("subagent was offered the subagent tool")
	}
	if !tools["message_parent"] {
		t.Error("subagent lacks the message_parent tool")
	}
}

// Delegated subagents are told to report with message_parent; workers, which
// lack that tool, are not.
func TestSubagentSystemPromptAsksForMessageParent(t *testing.T) {
	t.Parallel()
	server, database, ps := newTestServer(t)
	ctx := t.Context()
	parent, err := database.CreateConversation(ctx, nil, true, nil, strPtr("predictable"), db.ConversationOptions{})
	if err != nil {
		t.Fatal(err)
	}
	sub, err := database.CreateSubagentConversation(ctx, "helper", parent.ConversationID, nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := database.CreateCommitTourWorker(ctx, parent.ConversationID, t.TempDir(), "predictable", commitTourWorkerOptions())
	if err != nil {
		t.Fatal(err)
	}
	defer stopActiveConversationLoops(server)

	const instruction = "message_parent(end_turn=true)"
	for _, tc := range []struct {
		id, prompt string
		want       bool
	}{
		{sub.ConversationID, "echo: subagent work", true},
		{worker.ConversationID, "echo: worker work", false},
	} {
		if _, err := NewSubagentRunner(server).RunSubagent(ctx, tc.id, tc.prompt, "predictable", ""); err != nil {
			t.Fatal(err)
		}
		waitFor(t, 15*time.Second, func() bool {
			return countByType(listMessages(t, database, tc.id), db.MessageTypeAgent) == 1 && !server.IsAgentWorking(tc.id)
		})
		var system strings.Builder
		for _, s := range requestWithText(t, ps, tc.prompt).System {
			system.WriteString(s.Text)
		}
		if got := strings.Contains(system.String(), instruction); got != tc.want {
			t.Errorf("%s: system prompt has %q = %v, want %v:\n%s", tc.prompt, instruction, got, tc.want, system.String())
		}
	}
}

func commitTourWorkerOptions() db.ConversationOptions {
	return db.ConversationOptions{
		Kind:       db.CommitTourKind,
		CommitTour: &db.CommitTourRequest{Commit: "0123456789abcdef", State: "building", RequestedAt: time.Now().UTC()},
	}
}
