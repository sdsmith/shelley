import { test, expect, type APIRequestContext } from "@playwright/test";
import { createConversationViaAPIWithDetails } from "./helpers";

// These jobs and subagents sleep for minutes; stop them so a failed run does
// not leave them on the shared server.
async function stopWork(request: APIRequestContext, conversationIds: string[]) {
  for (const id of conversationIds) {
    const subagents = await (await request.get(`/api/conversation/${id}/subagents`)).json();
    for (const { conversation_id } of subagents ?? []) {
      await request.post(`/api/conversation/${conversation_id}/cancel`);
    }
    const jobs = await (await request.get(`/api/conversation/${id}/background-jobs`)).json();
    for (const { job_id } of jobs ?? []) {
      await request.post(`/api/conversation/${id}/background-jobs/${job_id}/kill`);
    }
  }
}

async function waitForIdle(request: APIRequestContext, conversationId: string) {
  // Posts sent while a turn runs are queued and drain nondeterministically;
  // wait the current turn out before sending the next one.
  await expect
    .poll(async () => {
      const body = await (await request.get(`/api/conversation/${conversationId}`)).json();
      return body.conversation.agent_working;
    })
    .toBe(false);
}

// A two-level delegation tree driven through the predictable model: a
// middletask subagent whose own turn ends immediately, then two working
// leaf grandchildren spawned FROM that middle. `prefix` keeps each test's
// slugs unique on the shared test server (colliding slugs get renamed).
// Returns the middle row.
async function spawnDepth2Tree(request: APIRequestContext, conversationId: string, prefix: string) {
  await waitForIdle(request, conversationId);
  expect(
    (
      await request.post(`/api/conversation/${conversationId}/chat`, {
        data: { message: `subagent: ${prefix}middletask hello there`, model: "predictable" },
      })
    ).ok(),
  ).toBe(true);
  await waitForIdle(request, conversationId);
  const middles = await (
    await request.get(`/api/conversation/${conversationId}/subagents`)
  ).json();
  const middle = middles.find((s: { slug?: string }) => s.slug === `${prefix}middletask`);
  expect(middle).toBeTruthy();
  await waitForIdle(request, middle.conversation_id);
  for (const name of ["leafone", "leaftwo"]) {
    expect(
      (
        await request.post(`/api/conversation/${middle.conversation_id}/chat`, {
          data: { message: `subagent: ${prefix}${name} bash: sleep 120`, model: "predictable" },
        })
      ).ok(),
    ).toBe(true);
    await waitForIdle(request, middle.conversation_id);
  }
  return middle;
}

test.describe("running work", () => {
  test("keeps mobile work visible and retains finished jobs while others run", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 500 });
    const { conversationId, slug } = await createConversationViaAPIWithDetails(
      request,
      "bash-bg: echo ready; sleep 600",
    );
    try {
      expect(
        (
          await request.post(`/api/conversation/${conversationId}/chat`, {
            data: { message: "bash-bg: sleep 601", model: "predictable" },
          })
        ).ok(),
      ).toBe(true);
      await page.goto(`/c/${slug}`);
      await expect(page.getByTestId("message-input")).toBeVisible({ timeout: 30000 });

      const strip = page.getByLabel("Running work", { exact: true });
      const toggle = strip.getByTestId("running-work-toggle");
      await expect(toggle).toContainText("2 tasks", { timeout: 15000 });
      await expect(toggle).not.toContainText("Running:");
      await expect(strip.getByTestId("running-work-stop-jobs")).toBeEnabled();
      await expect(strip.getByTestId("running-work-stop-subagents")).toBeDisabled();
      // More than one task starts collapsed; the count waits in the header.
      const items = strip.getByTestId("running-work-items");
      await expect(items).toHaveCount(0);
      expect(
        await strip.evaluate((element) =>
          element.nextElementSibling?.classList.contains("messages-bottom-sentinel"),
        ),
      ).toBe(true);

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      const jobs = items.getByTestId("background-job");
      await expect(jobs).toHaveCount(2);
      await expect(jobs.filter({ hasText: "echo ready" })).toBeVisible();
      await expect(jobs.filter({ hasText: "sleep 601" })).toBeVisible();

      const scroller = page.locator(".messages-container");
      await scroller.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect
        .poll(() =>
          scroller.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(2);
      await expect
        .poll(() =>
          strip.evaluate((element) => {
            const container = element.closest(".messages-container")!.getBoundingClientRect();
            const panel = element.getBoundingClientRect();
            return panel.top >= container.top && panel.bottom <= container.bottom;
          }),
        )
        .toBe(true);

      // The user can collapse and re-expand; the reading position holds.
      await toggle.evaluate((element) => {
        element.dispatchEvent(new Event("touchstart", { bubbles: true }));
        (element as HTMLElement).click();
      });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await scroller.evaluate((element) => {
        element.dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true }));
        element.scrollTop -= 20;
      });
      const readingPosition = await scroller.evaluate((element) => element.scrollTop);
      await toggle.evaluate((element) => (element as HTMLElement).click());
      await expect(items).toBeVisible();
      await expect
        .poll(async () =>
          Math.abs((await scroller.evaluate((element) => element.scrollTop)) - readingPosition),
        )
        .toBeLessThanOrEqual(2);

      const echo = jobs.filter({ hasText: "echo ready" });
      await echo.locator("summary").click();
      await expect(echo.getByTestId("background-job-tail")).toContainText("ready");
      const liveJobs = await (
        await request.get(`/api/conversation/${conversationId}/background-jobs`)
      ).json();
      const job = liveJobs.find((job: { command: string }) => job.command.includes("echo ready"));
      expect(
        (
          await request.post(
            `/api/conversation/${conversationId}/background-jobs/${job.job_id}/kill`,
          )
        ).ok(),
      ).toBe(true);
      // One task left: the header drops away and the finished job stays
      // visible next to the running one.
      await expect(toggle).toHaveCount(0, { timeout: 15000 });
      await expect(echo.locator(".running-command-time")).toHaveText("Finished");
      await expect(echo.getByTestId("background-job-kill")).toHaveCount(0);
      await expect(echo.getByTestId("background-job-tail")).toContainText("ready");
      await expect(
        jobs.filter({ hasText: "sleep 601" }).locator(".running-command-time"),
      ).toContainText("Running");
      await scroller.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect
        .poll(() =>
          strip.evaluate((element) => {
            const container = element.closest(".messages-container")!.getBoundingClientRect();
            const panel = element.getBoundingClientRect();
            return panel.top >= container.top && panel.bottom <= container.bottom;
          }),
        )
        .toBe(true);
    } finally {
      await stopWork(request, [conversationId]);
    }
  });

  test("shows a single subagent row without the toggle and opens its conversation", async ({
    page,
    request,
  }) => {
    const { conversationId, slug } = await createConversationViaAPIWithDetails(
      request,
      "hello there",
    );
    try {
      await page.goto(`/c/${slug}`);
      const input = page.getByTestId("message-input");
      await expect(input).toBeVisible({ timeout: 30000 });

      await input.fill("subagent: statushelper bash: sleep 120");
      await page.getByTestId("send-button").click();

      const strip = page.getByLabel("Running work", { exact: true });
      await expect(strip.getByTestId("running-work-toggle")).toHaveCount(0, { timeout: 30000 });
      const row = strip.locator(".running-work-agent");
      await expect(row).toContainText("statushelper");
      await expect(row).toContainText("sleep", { timeout: 30000 });
      // The command sits beside the name on one line, not under it.
      await expect(row.locator(".running-work-agent-description")).toHaveCSS("display", "flex");
      await row.click();
      await expect(page).toHaveURL(/\/c\/statushelper/, { timeout: 10000 });
    } finally {
      await stopWork(request, [conversationId]);
    }
  });

  test("lists working descendants at any depth with Waiting scaffolding and counts running work only", async ({
    page,
    request,
  }) => {
    const { conversationId, slug } = await createConversationViaAPIWithDetails(
      request,
      "hello there",
    );
    let middleId = "";
    try {
      const middle = await spawnDepth2Tree(request, conversationId, "");
      middleId = middle.conversation_id;

      await page.goto(`/c/${slug}`);
      const strip = page.getByLabel("Running work", { exact: true });
      const toggle = strip.getByTestId("running-work-toggle");
      // The header counts running work only: the two working leaves — the
      // idle middle renders as Waiting scaffolding and is not counted.
      await expect(toggle).toContainText("2 subagents", { timeout: 30000 });
      await expect(toggle).not.toContainText("3 subagents");
      await expect(toggle).not.toContainText("task");
      await expect(strip.getByTestId("running-work-stop-jobs")).toBeDisabled();
      await expect(strip.getByTestId("running-work-stop-subagents")).toBeEnabled();

      await toggle.click();
      const rows = strip.locator(".running-work-agent");
      await expect(rows).toHaveCount(3);
      const middleRow = rows.filter({ hasText: "middletask" });
      const leafOne = rows.filter({ hasText: "leafone" });
      const leafTwo = rows.filter({ hasText: "leaftwo" });
      // The idle middle is a Waiting scaffolding row; the leaves run.
      await expect(middleRow.locator(".running-work-agent-time")).toHaveText("Waiting");
      await expect(leafOne.locator(".running-work-agent-time")).toContainText("Running");
      await expect(leafTwo.locator(".running-work-agent-time")).toContainText("Running");
      // Indentation: each leaf one step past the middle, matched.
      const xs = await Promise.all(
        [middleRow, leafOne, leafTwo].map(
          async (row) => (await row.locator("strong").boundingBox())!.x,
        ),
      );
      expect(xs[1] - xs[0]).toBeGreaterThanOrEqual(20);
      expect(xs[2] - xs[0]).toBeGreaterThanOrEqual(20);
      expect(Math.abs(xs[2] - xs[1])).toBeLessThan(2);

      // One click halts the whole delegation tree: the stop list is the
      // working descendants (the two leaves — the idle middle is not on
      // it), and the scaffolding row reads Finished once nothing below it
      // runs.
      await strip.getByTestId("running-work-stop-subagents").click();
      await expect(toggle).toContainText("No running work", { timeout: 15000 });
      await expect(leafOne.locator(".running-work-agent-time")).toHaveText("Finished", {
        timeout: 15000,
      });
      await expect(leafTwo.locator(".running-work-agent-time")).toHaveText("Finished");
      await expect(middleRow.locator(".running-work-agent-time")).toHaveText("Finished");
      // With nothing running, the stop actions drop out of the header.
      await expect(strip.getByTestId("running-work-stop-subagents")).toHaveCount(0);
    } finally {
      await stopWork(request, [conversationId, middleId].filter(Boolean));
    }
  });

  test("a subagent conversation's strip shows its own subtree", async ({ page, request }) => {
    const { conversationId } = await createConversationViaAPIWithDetails(request, "hello there");
    let middleId = "";
    try {
      const middle = await spawnDepth2Tree(request, conversationId, "sub-");
      middleId = middle.conversation_id;

      // The strip composes recursively: opening the middle conversation
      // shows ITS subtree — the two leaves — with no row for the middle
      // itself or its parent.
      await page.goto(`/c/${middle.slug}`);
      const strip = page.getByLabel("Running work", { exact: true });
      const toggle = strip.getByTestId("running-work-toggle");
      await expect(toggle).toContainText("2 subagents", { timeout: 30000 });
      await toggle.click();
      const rows = strip.locator(".running-work-agent");
      await expect(rows).toHaveCount(2);
      await expect(rows.filter({ hasText: "leafone" })).toBeVisible();
      await expect(rows.filter({ hasText: "leaftwo" })).toBeVisible();
      await expect(rows.filter({ hasText: "middletask" })).toHaveCount(0);

      // One leaf stops via the server: a single running item renders
      // headerless, and the finished leaf is retained beside it (the strip
      // was expanded).
      const leaves = await (await request.get(`/api/conversation/${middleId}/subagents`)).json();
      const leafTwo = leaves.find((s: { slug?: string }) => s.slug === "sub-leaftwo");
      expect(
        (await request.post(`/api/conversation/${leafTwo.conversation_id}/cancel`)).ok(),
      ).toBe(true);
      await expect(toggle).toHaveCount(0, { timeout: 15000 });
      await expect(rows).toHaveCount(2);
      await expect(
        rows.filter({ hasText: "leaftwo" }).locator(".running-work-agent-time"),
      ).toHaveText("Finished");
      await expect(
        rows.filter({ hasText: "leafone" }).locator(".running-work-agent-time"),
      ).toContainText("Running");
    } finally {
      await stopWork(request, [conversationId, middleId].filter(Boolean));
    }
  });

  test("starts collapsed with the count once there are more than four tasks", async ({
    page,
    request,
  }) => {
    const { conversationId, slug } = await createConversationViaAPIWithDetails(
      request,
      "hello there",
    );
    try {
      // One job per agent turn. Posts sent while a turn runs are queued and
      // drain nondeterministically, so wait each turn out before the next.
      for (const n of [1, 2, 3, 4, 5]) {
        expect(
          (
            await request.post(`/api/conversation/${conversationId}/chat`, {
              data: { message: `bash-bg: sleep ${600 + n}`, model: "predictable" },
            })
          ).ok(),
        ).toBe(true);
        await expect
          .poll(async () => {
            const body = await (await request.get(`/api/conversation/${conversationId}`)).json();
            return body.conversation.agent_working;
          })
          .toBe(false);
      }

      await page.goto(`/c/${slug}`);
      const strip = page.getByLabel("Running work", { exact: true });
      const toggle = strip.getByTestId("running-work-toggle");
      // More than four tasks: collapsed by default, count in the header.
      await expect(toggle).toContainText("5 tasks", { timeout: 30000 });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(strip.getByTestId("running-work-items")).toHaveCount(0);
      await expect(strip.getByTestId("running-work-stop-jobs")).toBeEnabled();
      await expect(strip.getByTestId("running-work-stop-subagents")).toBeDisabled();

      await toggle.click();
      const items = strip.getByTestId("running-work-items");
      await expect(items).toBeVisible();
      await expect(items.getByTestId("background-job")).toHaveCount(5);
    } finally {
      await stopWork(request, [conversationId]);
    }
  });

  test("a failed cancel doesn't abort the remaining stops", async ({ page, request }) => {
    const { conversationId, slug } = await createConversationViaAPIWithDetails(
      request,
      "hello there",
    );
    try {
      await waitForIdle(request, conversationId);
      for (const name of ["fourthhelper", "fifthhelper"]) {
        expect(
          (
            await request.post(`/api/conversation/${conversationId}/chat`, {
              data: { message: `subagent: ${name} bash: sleep 120`, model: "predictable" },
            })
          ).ok(),
        ).toBe(true);
        await waitForIdle(request, conversationId);
      }

      await page.goto(`/c/${slug}`);
      const strip = page.getByLabel("Running work", { exact: true });
      const toggle = strip.getByTestId("running-work-toggle");
      await expect(toggle).toContainText("2 subagents", { timeout: 30000 });
      await toggle.click();
      const rows = strip.locator(".running-work-agent");

      const subagents = await (
        await request.get(`/api/conversation/${conversationId}/subagents`)
      ).json();
      const first = subagents.find((s: { slug?: string }) => s.slug === "fourthhelper");
      // The first cancel fails (as if lost to a finishing subagent); the
      // loop must still reach the rest.
      await page.route(`**/api/conversation/${first.conversation_id}/cancel`, (route) =>
        route.fulfill({ status: 500, body: "lost race" }),
      );
      await strip.getByTestId("running-work-stop-subagents").click();
      await expect(
        rows.filter({ hasText: "fifthhelper" }).locator(".running-work-agent-time"),
      ).toHaveText("Finished", { timeout: 15000 });
      await expect(
        rows.filter({ hasText: "fourthhelper" }).locator(".running-work-agent-time"),
      ).toContainText("Running");
    } finally {
      await stopWork(request, [conversationId]);
    }
  });

  test("retains finished subagent rows while others run and stops them all from the header", async ({
    page,
    request,
  }) => {
    const { conversationId, slug } = await createConversationViaAPIWithDetails(
      request,
      "hello there",
    );
    try {
      await waitForIdle(request, conversationId);
      for (const name of ["firsthelper", "secondhelper", "thirdhelper"]) {
        expect(
          (
            await request.post(`/api/conversation/${conversationId}/chat`, {
              data: { message: `subagent: ${name} bash: sleep 120`, model: "predictable" },
            })
          ).ok(),
        ).toBe(true);
        await waitForIdle(request, conversationId);
      }

      await page.goto(`/c/${slug}`);
      const strip = page.getByLabel("Running work", { exact: true });
      const toggle = strip.getByTestId("running-work-toggle");
      await expect(toggle).toContainText("3 subagents", { timeout: 30000 });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      // No background commands are running, so that button is greyed out.
      await expect(strip.getByTestId("running-work-stop-jobs")).toBeDisabled();
      const stopSubagents = strip.getByTestId("running-work-stop-subagents");
      await expect(stopSubagents).toBeEnabled();

      await toggle.click();
      const rows = strip.locator(".running-work-agent");
      await expect(rows).toHaveCount(3);

      const subagents = await (
        await request.get(`/api/conversation/${conversationId}/subagents`)
      ).json();
      const first = subagents.find((sub: { slug?: string }) => sub.slug === "firsthelper");
      expect((await request.post(`/api/conversation/${first.conversation_id}/cancel`)).ok()).toBe(
        true,
      );
      // The finished row stays while the others still run.
      await expect(
        rows.filter({ hasText: "firsthelper" }).locator(".running-work-agent-time"),
      ).toHaveText("Finished", { timeout: 15000 });
      await expect(
        rows.filter({ hasText: "secondhelper" }).locator(".running-work-agent-time"),
      ).toContainText("Running");

      // One click stops the rest. The user expanded the strip earlier, so it
      // stays open showing "No running work" until they collapse it.
      await stopSubagents.click();
      await expect(toggle).toContainText("No running work", { timeout: 15000 });
      await toggle.click();
      await expect(strip).toHaveCount(0, { timeout: 15000 });
    } finally {
      await stopWork(request, [conversationId]);
    }
  });

  test("stops commands from the header without touching subagents", async ({ page, request }) => {
    const { conversationId, slug } = await createConversationViaAPIWithDetails(
      request,
      "bash-bg: echo ready; sleep 600",
    );
    try {
      await waitForIdle(request, conversationId);
      expect(
        (
          await request.post(`/api/conversation/${conversationId}/chat`, {
            data: { message: "subagent: mixedhelper bash: sleep 120", model: "predictable" },
          })
        ).ok(),
      ).toBe(true);
      await waitForIdle(request, conversationId);

      await page.goto(`/c/${slug}`);
      const strip = page.getByLabel("Running work", { exact: true });
      const toggle = strip.getByTestId("running-work-toggle");
      await expect(toggle).toContainText("1 task", { timeout: 30000 });
      await expect(toggle).toContainText("1 subagent");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(strip.getByTestId("running-work-stop-jobs")).toBeEnabled();
      await expect(strip.getByTestId("running-work-stop-subagents")).toBeEnabled();

      // Expand, then stop the commands: the job row flips to Finished and
      // stays, the subagent keeps running.
      await toggle.click();
      const jobRow = strip.getByTestId("background-job").filter({ hasText: "echo ready" });
      await expect(jobRow).toBeVisible();
      await strip.getByTestId("running-work-stop-jobs").click();
      await expect(jobRow.locator(".running-command-time")).toHaveText("Finished", {
        timeout: 15000,
      });
      await expect(
        strip.locator(".running-work-agent").locator(".running-work-agent-time"),
      ).toContainText("Running");

      // The lone subagent keeps the strip alive; cancelling it marks the row
      // Finished and the open strip persists until the user collapses it.
      const subagents = await (
        await request.get(`/api/conversation/${conversationId}/subagents`)
      ).json();
      for (const sub of subagents) {
        await request.post(`/api/conversation/${sub.conversation_id}/cancel`);
      }
      await expect(
        strip.locator(".running-work-agent").locator(".running-work-agent-time"),
      ).toHaveText("Finished", { timeout: 15000 });
      await expect(toggle).toContainText("No running work");
      await toggle.click();
      await expect(strip).toHaveCount(0, { timeout: 15000 });
    } finally {
      await stopWork(request, [conversationId]);
    }
  });
});
