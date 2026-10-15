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
      // Two tasks start expanded without a click.
      const items = strip.getByTestId("running-work-items");
      await expect(items).toBeVisible();
      const jobs = items.getByTestId("background-job");
      await expect(jobs).toHaveCount(2);
      await expect(jobs.filter({ hasText: "echo ready" })).toBeVisible();
      await expect(jobs.filter({ hasText: "sleep 601" })).toBeVisible();
      expect(
        await strip.evaluate((element) =>
          element.nextElementSibling?.classList.contains("messages-bottom-sentinel"),
        ),
      ).toBe(true);

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

      // The user can still collapse and re-expand; the reading position holds.
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
      await row.click();
      await expect(page).toHaveURL(/\/c\/statushelper/, { timeout: 10000 });
    } finally {
      await stopWork(request, [conversationId]);
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

      await toggle.click();
      const items = strip.getByTestId("running-work-items");
      await expect(items).toBeVisible();
      await expect(items.getByTestId("background-job")).toHaveCount(5);
    } finally {
      await stopWork(request, [conversationId]);
    }
  });

  test("retains finished subagent rows while others run and hides when none run", async ({
    page,
    request,
  }) => {
    const { conversationId, slug } = await createConversationViaAPIWithDetails(
      request,
      "hello there",
    );
    try {
      // Two subagents: two rows start expanded behind the compact header.
      for (const name of ["firsthelper", "secondhelper"]) {
        expect(
          (
            await request.post(`/api/conversation/${conversationId}/chat`, {
              data: { message: `subagent: ${name} bash: sleep 120`, model: "predictable" },
            })
          ).ok(),
        ).toBe(true);
      }

      await page.goto(`/c/${slug}`);
      const strip = page.getByLabel("Running work", { exact: true });
      const toggle = strip.getByTestId("running-work-toggle");
      await expect(toggle).toContainText("2 subagents", { timeout: 30000 });
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      const rows = strip.locator(".running-work-agent");
      await expect(rows).toHaveCount(2);

      const subagents = await (
        await request.get(`/api/conversation/${conversationId}/subagents`)
      ).json();
      const first = subagents.find((sub: { slug?: string }) => sub.slug === "firsthelper");
      expect((await request.post(`/api/conversation/${first.conversation_id}/cancel`)).ok()).toBe(
        true,
      );
      // The finished row stays while the other still runs.
      await expect(
        rows.filter({ hasText: "firsthelper" }).locator(".running-work-agent-time"),
      ).toHaveText("Finished", { timeout: 15000 });
      await expect(
        rows.filter({ hasText: "secondhelper" }).locator(".running-work-agent-time"),
      ).toContainText("Running");

      // When nothing runs any more the strip hides itself.
      for (const sub of subagents) {
        await request.post(`/api/conversation/${sub.conversation_id}/cancel`);
      }
      await expect(strip).toHaveCount(0, { timeout: 15000 });
    } finally {
      await stopWork(request, [conversationId]);
    }
  });
});
