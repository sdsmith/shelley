import { test, expect } from "@playwright/test";
import { testWorkingDirectory } from "./helpers";

// Cost-bearing model-list entries for the picker's pricing sub-label (see
// ModelPicker.vue and utils/costNotation); values mirror the PRD's notation
// examples. tiers is always present on the wire ([] when the model has none).
const PLAIN_COST = { input: 3, output: 15, cache_read: 0.3, cache_write: 0, tiers: [] };
const MARKED_COST = {
  input: 1,
  output: 3,
  cache_read: 2,
  cache_write: 0.125,
  tiers: [
    { input: 0.5, output: 2.5, cache_read: 0.05, cache_write: 0, threshold_tokens: 100000 },
  ],
};
// formatModelCost(MARKED_COST) — the surcharge and tier sections, verbatim.
const MARKED_TOOLTIP = [
  "* Surcharge:",
  "- cache writes $0.125/M",
  "** Tiered pricing (not reflected in conversation cumulative cost):",
  "- $0.50/$0.05/$2.50 @ above 100k input",
].join("\n");

// A model list where pricing is observable: every entry priced (the base
// model plain), one twin carrying markers, sourced twins (a second source,
// so a multi-source install is covered), and one entry the catalog cannot
// price.
async function mockPricedModelList(page: import("@playwright/test").Page) {
  await page.route("**/api/models", async (route) => {
    const models = await (await route.fetch()).json();
    await route.fulfill({
      json: [
        ...models.map((m) => ({ ...m, source: "$PREDICTABLE", cost: PLAIN_COST })),
        {
          ...models[0],
          id: "predictable-marked",
          display_name: "Marked Twin",
          source: "Twin A",
          cost: MARKED_COST,
          ready: true,
          tier: 1,
        },
        {
          ...models[0],
          id: "predictable-sourced",
          display_name: "Sourced Twin",
          source: "Twin B",
          cost: PLAIN_COST,
          ready: true,
          tier: 1,
        },
        {
          ...models[0],
          id: "predictable-unpriced",
          display_name: "Unpriced Twin",
          source: "Twin C",
          ready: true,
          tier: 1,
        },
      ],
    });
  });
}

// A single-source install where pricing is observable: every model from the
// same one source, every entry priced. The twin gives the picker a second
// row while every option still names the install's only source.
async function mockSingleSourcePricedModelList(page: import("@playwright/test").Page) {
  await page.route("**/api/models", async (route) => {
    const models = await (await route.fetch()).json();
    await route.fulfill({
      json: [
        ...models.map((m) => ({ ...m, source: "$PREDICTABLE", cost: PLAIN_COST })),
        {
          ...models[0],
          id: "predictable-twin",
          display_name: "Priced Twin",
          source: "$PREDICTABLE",
          cost: PLAIN_COST,
          ready: true,
          tier: 1,
        },
      ],
    });
  });
}

// The unified model + effort picker (ChatStatusContent -> ModelPicker.vue) is
// built on PrimeVue <Select>. It renders on the new-conversation screen. Here
// we exercise the PrimeVue-specific open/select behavior, the inline
// reasoning-effort pill row, the Model heading's "Manage…" action, and
// persistence of the chosen model + effort to localStorage.
test.describe("Model picker (PrimeVue)", () => {
  test("opens, lists models, selecting one persists, Manage… opens manage modal", async ({
    page,
  }) => {
    test.setTimeout(60000);

    // A single-source install: the one model comes from one source, which
    // the picker names under every option.
    await mockSingleSourcePricedModelList(page);
    await page.goto("/new");
    await page.waitForLoadState("domcontentloaded");

    const picker = page.locator(".model-picker.p-select");
    await expect(picker).toBeVisible({ timeout: 10000 });

    // Open the overlay.
    await picker.click();
    const panel = page.locator(".model-picker-panel");
    await expect(panel).toBeVisible();

    // At least one model is offered and the heading's actions are present.
    const options = panel.locator(".p-select-option");
    expect(await options.count()).toBeGreaterThanOrEqual(1);
    const manageBtn = panel.getByRole("button", { name: "Manage Models" });
    await expect(manageBtn).toBeVisible();
    await expect(panel.getByRole("button", { name: "Refresh" })).toBeVisible();

    // On a phone it is a sheet across the bottom of the screen.
    const viewport = page.viewportSize()!;
    if (viewport.width < 768) {
      const box = (await panel.boundingBox())!;
      expect(box.x).toBe(0);
      expect(box.width).toBe(viewport.width);
      expect(Math.round(box.y + box.height)).toBe(viewport.height);
    }

    // Even in a single-source install, every option names its source.
    await expect(
      panel.locator(".p-select-option:not(:has(.model-picker-option-source))"),
    ).toHaveCount(0);
    await expect(options.first().locator(".model-picker-option-source")).toHaveText("$PREDICTABLE");

    // Pick the first model -> its label shows in the trigger and the raw model
    // id (not the pretty label) persists to localStorage. The panel stays
    // open, as for every choice in it.
    const firstName = (await options
      .first()
      .locator(".model-picker-option-name")
      .textContent())!.trim();
    await options.first().click();
    await expect(picker.locator(".model-picker-value-name")).toHaveText(firstName);
    expect(await page.evaluate(() => localStorage.getItem("shelley_selected_model"))).toBe(
      "predictable",
    );
    await expect(panel).toBeVisible();
    // Close hands focus back to the trigger.
    await panel.getByRole("button", { name: "Close" }).click();
    await expect(panel).toBeHidden();
    await expect(picker.locator(".p-select-label")).toBeFocused();

    // Manage… opens the manage-models modal, closing the panel.
    await picker.click();
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Manage Models" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(panel).toBeHidden();
  });

  test("shows the cost breakdown as a priced option's sub-label", async ({ page }) => {
    await mockPricedModelList(page);
    await page.goto("/new");
    const picker = page.locator(".model-picker.p-select");
    await expect(picker).toBeVisible({ timeout: 10000 });
    await picker.click();
    const panel = page.locator(".model-picker-panel");

    // The plain priced option: just the triple. Not a Recent row — recents
    // also name "predictable" once the DB has history from other tests.
    const plainOption = panel
      .locator(".p-select-option:not(:has(.model-picker-option-effort))", {
        hasText: "predictable",
      })
      .first();
    await expect(plainOption.locator(".model-picker-option-cost")).toHaveText("$3/$0.30/$15");

    // The gate is gone: the dominant source renders under the plain option
    // too, and the cost-first ordering holds for it.
    await expect(plainOption.locator(".model-picker-option-sublabel")).toHaveText(
      "$3/$0.30/$15 · $PREDICTABLE",
    );

    // Cost and source share one grey line (cost first), so priced rows keep
    // the height of any other row with a sub-label — one name line plus at
    // most one grey line.
    const sourcedOption = panel.locator(".p-select-option", { hasText: "Sourced Twin" });
    await expect(sourcedOption.locator(".model-picker-option-sublabel")).toHaveCount(1);
    await expect(sourcedOption.locator(".model-picker-option-sublabel")).toHaveText(
      "$3/$0.30/$15 · Twin B",
    );
    const plainBox = (await plainOption.boundingBox())!;
    const sourcedBox = (await sourcedOption.boundingBox())!;
    expect(Math.abs(sourcedBox.height - plainBox.height)).toBeLessThan(1);

    // The unpriced twin: no cost anywhere — silence, not a zero.
    const unpricedOption = panel.locator(".p-select-option", { hasText: "Unpriced Twin" });
    await expect(unpricedOption.locator(".model-picker-option-cost")).toHaveCount(0);
    await expect(unpricedOption.locator(".model-picker-option-sublabel")).toHaveText("Twin C");
  });

  test("a single-source install names the source on every option, cost first", async ({
    page,
  }) => {
    await mockSingleSourcePricedModelList(page);
    await page.goto("/new");
    const picker = page.locator(".model-picker.p-select");
    await expect(picker).toBeVisible({ timeout: 10000 });
    await picker.click();
    const panel = page.locator(".model-picker-panel");

    // Every option carries the source sub-label even though the install has
    // just the one source, and the grey line keeps the cost-first ordering:
    // $cost · $source.
    await expect(
      panel.locator(".p-select-option:not(:has(.model-picker-option-source))"),
    ).toHaveCount(0);
    const modelRow = panel.locator(".p-select-option", { hasText: "Priced Twin" });
    await expect(modelRow.locator(".model-picker-option-sublabel")).toHaveText(
      "$3/$0.30/$15 · $PREDICTABLE",
    );
  });

  test("shows the pricing tooltip only on marked options", async ({ page }) => {
    await mockPricedModelList(page);
    await page.goto("/new");
    const picker = page.locator(".model-picker.p-select");
    await expect(picker).toBeVisible({ timeout: 10000 });
    await picker.click();
    const panel = page.locator(".model-picker-panel");

    // A marked option (surcharge + tier): hovering its cost span opens the
    // tooltip with the details, and the markers also get a spoken form.
    const markedOption = panel.locator(".p-select-option", { hasText: "Marked Twin" });
    const markedCost = markedOption.locator(".model-picker-option-cost");
    await expect(markedCost).toHaveText("**$1/$2*/$3");
    await markedCost.hover();
    const tooltipText = page.locator(".p-tooltip-text");
    await tooltipText.waitFor();
    // Raw equality: toHaveText normalizes whitespace, which would let a
    // lost pre-line rule (all four sections on one line) pass.
    expect(await tooltipText.innerText()).toBe(MARKED_TOOLTIP);
    await expect(markedOption.locator(".sr-only")).toHaveText(
      "cache-write surcharge; tiered pricing applies — listed rates are short-context base rates",
    );

    // A plain (unmarked) price: moving to its cost span — where v-tooltip
    // binds — takes the tooltip away again. No spoken form either.
    const plainOption = panel
      .locator(".p-select-option:not(:has(.model-picker-option-effort))", {
        hasText: "Sourced Twin",
      });
    await plainOption.locator(".model-picker-option-cost").hover();
    await expect(page.locator(".p-tooltip")).toHaveCount(0);
    await expect(plainOption.locator(".sr-only")).toHaveCount(0);
  });

  test("closed trigger keeps showing just the model name and effort", async ({ page }) => {
    // A single-source install, so the trigger is pinned against the source
    // sub-labels every option now carries: none of it reaches the trigger.
    await mockSingleSourcePricedModelList(page);
    // Store an effort so the trigger's suffix is present to assert; mark the
    // default profile applied, or the composer's first-load profile
    // application resets the level (see the recent-pricing test).
    await page.addInitScript(() => {
      localStorage.setItem("shelley.thinkingLevel.v2", "high");
      localStorage.setItem("shelley.profileApplied", "Default");
    });
    await page.goto("/new");
    const picker = page.locator(".model-picker.p-select");
    await expect(picker).toBeVisible({ timeout: 10000 });

    // Pick the priced, sourced model and close: the trigger names the model
    // and the effort — never the price or the source.
    await picker.click();
    const panel = page.locator(".model-picker-panel");
    await panel.locator(".p-select-option", { hasText: "Priced Twin" }).click();
    await expect(picker.locator(".model-picker-value-name")).toHaveText("Priced Twin");
    await expect(picker.locator(".model-picker-value-effort")).toHaveText("· high");
    await expect(picker.locator(".model-picker-value")).not.toContainText("$");
  });

  test("recent combinations carry the same pricing", async ({ page, request }) => {
    const response = await request.post("/api/conversations/new", {
      data: {
        message: "echo recent pricing",
        model: "predictable",
        cwd: testWorkingDirectory(),
        conversation_options: { thinking_level: "high" },
      },
    });
    expect(response.ok()).toBeTruthy();
    const { conversation_id: conversationId } = await response.json();

    // Keep this page's picker history scoped to the conversation we just
    // created (see the recent-combinations test below).
    await page.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options);
          this.addEventListener("message", (event) => {
            const data = JSON.parse(event.data) as { conversation_list_patch?: unknown };
            if (data.conversation_list_patch) event.stopImmediatePropagation();
          });
        }
      };
    });
    await page.route("**/api/conversations/snapshot", async (route) => {
      const snapshotResponse = await route.fetch();
      const snapshot = (await snapshotResponse.json()) as {
        conversations: Array<{ conversation_id: string }>;
        hash: string;
      };
      const seed = snapshot.conversations.find(
        (conversation) => conversation.conversation_id === conversationId,
      );
      if (!seed) throw new Error("recent pricing conversation missing from snapshot");
      await route.fulfill({
        response: snapshotResponse,
        json: { ...snapshot, conversations: [seed] },
      });
    });
    // "medium" is load-bearing: the conversation above was created with
    // "high", and the active combination is filtered out of recents —
    // storing the same level would leave the Recent group empty.
    await page.addInitScript(() => {
      localStorage.setItem("shelley.thinkingLevel.v2", "medium");
      localStorage.setItem("shelley.profileApplied", "Default");
    });

    await mockPricedModelList(page);
    // Recent combinations are taken as the panel opens, so wait for the
    // conversation snapshot before opening it.
    const snapshotLoaded = page.waitForResponse("**/api/conversations/snapshot");
    await page.goto("/new");
    await snapshotLoaded;
    const picker = page.locator(".model-picker.p-select");
    await expect(picker).toBeVisible({ timeout: 10000 });
    await picker.click();
    const panel = page.locator(".model-picker-panel");
    await expect(panel.locator(".model-picker-group-label")).toHaveText("Recent");
    const recentRow = panel.locator(".p-select-option:has(.model-picker-option-effort)");
    await expect(recentRow.locator(".model-picker-option-name")).toHaveText("predictable");
    // The recent row renders through the same option template, pricing
    // included — and its source, now that every option names one.
    await expect(recentRow.locator(".model-picker-option-cost")).toHaveText("$3/$0.30/$15");
    await expect(recentRow.locator(".model-picker-option-sublabel")).toHaveText(
      "$3/$0.30/$15 · $PREDICTABLE",
    );
  });

  test("keeps model and directory inline when they fit, then wraps when needed", async ({
    page,
  }) => {
    // Pin the directory so layout doesn't depend on the length of the
    // server's checkout path (which varies across CI agents and wraps the
    // Dir chip onto its own line when long).
    await page.addInitScript(() => localStorage.setItem("shelley_selected_cwd", "/tmp/e2e-dir"));
    await page.setViewportSize({ width: 412, height: 915 });
    await page.goto("/new");
    await expect(page.locator(".status-field-model")).toBeVisible();
    await expect(page.locator(".status-field-cwd")).toBeVisible();

    const fieldTops = () =>
      page.evaluate(() => ({
        model: document.querySelector(".status-field-model")!.getBoundingClientRect().top,
        cwd: document.querySelector(".status-field-cwd")!.getBoundingClientRect().top,
      }));

    let tops = await fieldTops();
    expect(Math.abs(tops.model - tops.cwd)).toBeLessThan(2);

    await page.setViewportSize({ width: 260, height: 700 });
    tops = await fieldTops();
    expect(Math.abs(tops.model - tops.cwd)).toBeGreaterThan(2);
  });

  test("does not focus model search when opened on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/new");

    const picker = page.locator(".model-picker.p-select");
    await expect(picker).toBeVisible({ timeout: 10000 });
    await picker.click();

    const searchbox = page.locator(".model-picker-panel").getByRole("searchbox");
    await expect(searchbox).toBeVisible();
    await expect(searchbox).not.toBeFocused();
  });

  test("keyboard focus follows a pick made with the pointer", async ({ page }) => {
    // A second model, so there is a row to pick other than the selected one.
    await page.route("**/api/models", async (route) => {
      const models = await (await route.fetch()).json();
      const twin = { ...models[0], id: "predictable-twin", display_name: "Predictable Twin" };
      await route.fulfill({ json: [...models, twin] });
    });
    // Desktop, where the search has focus from the start.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/new");
    const picker = page.locator(".model-picker.p-select");
    await picker.click();
    const panel = page.locator(".model-picker-panel");
    const twin = panel.locator(".p-select-option", { hasText: "Predictable Twin" });
    await expect(twin).toBeVisible();
    await expect(panel.getByRole("searchbox")).toBeFocused();

    // Keyboard on the selected row, then the pointer on the other: Enter
    // keeps the pointer's pick.
    await page.keyboard.press("ArrowDown");
    await expect(panel.locator(".p-select-option.p-focus")).not.toContainText("Twin");
    await twin.click();
    await expect(twin).toHaveClass(/p-focus/);
    await page.keyboard.press("Enter");
    await expect(panel).toBeHidden();
    await expect(picker.locator(".model-picker-value-name")).toHaveText("Predictable Twin");
  });

  test("effort pills select a level, persist it, and keep the popover open", async ({ page }) => {
    test.setTimeout(60000);

    await page.goto("/new");
    await page.waitForLoadState("domcontentloaded");

    // Reset persisted level so assertions are deterministic across workers.
    await page.evaluate(() => localStorage.removeItem("shelley.thinkingLevel.v2"));
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const picker = page.locator(".model-picker.p-select");
    await expect(picker).toBeVisible({ timeout: 10000 });
    await picker.click();
    const panel = page.locator(".model-picker-panel");
    await expect(panel).toBeVisible();

    // Models without explicit capability metadata use the standard levels
    // through xhigh; rare max support must be advertised by the model.
    const pills = panel.locator(".model-picker-effort-pill");
    expect(await pills.count()).toBeGreaterThanOrEqual(6);
    await expect(pills.filter({ hasText: /^max$/ })).toHaveCount(0);

    // Pick "high" -> persists, popover stays open, trigger shows the suffix.
    await pills.filter({ hasText: /^high$/ }).click();
    await expect(panel).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("shelley.thinkingLevel.v2"))).toBe(
      "high",
    );
    await expect(pills.filter({ hasText: /^high$/ })).toHaveAttribute("aria-checked", "true");

    // Close the popover; the trigger reflects the effort and keeps it after reload.
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(picker.locator(".model-picker-value-effort")).toHaveText("· high");
    await page.reload();
    await expect(picker.locator(".model-picker-value-effort")).toHaveText("· high");
  });

  test("shows recent combinations, hidden while searching", async ({ page, request }) => {
    test.setTimeout(60000);

    const response = await request.post("/api/conversations/new", {
      data: {
        message: "echo recent model picker",
        model: "predictable",
        cwd: testWorkingDirectory(),
        conversation_options: { thinking_level: "high" },
      },
    });
    expect(response.ok()).toBeTruthy();
    const { conversation_id: conversationId } = await response.json();

    // The suite shares a conversation DB across workers. Other tests can
    // contribute a more popular recent model/effort combination, so keep
    // this page's picker history scoped to the conversation we just created.
    // Keep the stream connected for the picker, but ignore list patches
    // that would reintroduce other tests' conversations after the snapshot.
    await page.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      window.EventSource = class extends NativeEventSource {
        constructor(url: string | URL, options?: EventSourceInit) {
          super(url, options);
          this.addEventListener("message", (event) => {
            const data = JSON.parse(event.data) as { conversation_list_patch?: unknown };
            if (data.conversation_list_patch) event.stopImmediatePropagation();
          });
        }
      };
    });
    await page.route("**/api/conversations/snapshot", async (route) => {
      const snapshotResponse = await route.fetch();
      const snapshot = (await snapshotResponse.json()) as {
        conversations: Array<{ conversation_id: string }>;
        hash: string;
      };
      const seed = snapshot.conversations.find(
        (conversation) => conversation.conversation_id === conversationId,
      );
      if (!seed) throw new Error("recent model picker conversation missing from snapshot");
      await route.fulfill({
        response: snapshotResponse,
        json: { ...snapshot, conversations: [seed] },
      });
    });

    // The composer has taken on the default profile already; its picks stand.
    await page.addInitScript(() => {
      localStorage.setItem("shelley.thinkingLevel.v2", "high");
      localStorage.setItem("shelley.profileApplied", "Default");
    });
    await page.goto("/new");
    const picker = page.locator(".model-picker.p-select");
    await expect(picker).toBeVisible({ timeout: 10000 });
    await picker.click();

    const panel = page.locator(".model-picker-panel");
    await expect(panel.locator(".model-picker-group-label")).toHaveCount(0);

    const recentRow = panel.locator(".p-select-option:has(.model-picker-option-effort)");
    const modelRow = panel.locator(".p-select-option:not(:has(.model-picker-option-effort))");
    await expect(modelRow.locator(".model-picker-option-name")).toHaveText("predictable");
    await expect(modelRow.locator(".model-picker-option-check")).toBeVisible();

    await panel.locator(".model-picker-effort-pill").filter({ hasText: /^low$/ }).click();

    // Recent combinations are taken as the panel opens.
    await expect(panel.locator(".model-picker-group-label")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await picker.click();
    await expect(panel.locator(".model-picker-group-label")).toHaveText("Recent");
    await expect(panel.locator(".model-picker-group-divider")).toBeVisible();
    await expect(recentRow.locator(".model-picker-option-name")).toHaveText("predictable");
    await expect(recentRow.locator(".model-picker-option-effort")).toHaveText("high");
    await expect(recentRow.locator(".model-picker-option-check")).toHaveCount(0);
    // A heading, not a highlight, sets them apart; the highlight is the
    // selected model's, where the keyboard starts.
    await expect(recentRow).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(modelRow).toHaveClass(/p-focus/);
    const nameBox = await recentRow.locator(".model-picker-option-name").boundingBox();
    const effortPill = recentRow.locator(".model-picker-option-effort");
    const effortBox = await effortPill.boundingBox();
    expect(effortBox!.x).toBeGreaterThan(nameBox!.x + nameBox!.width);
    await expect(effortPill).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

    await recentRow.hover();
    await expect(recentRow).not.toHaveClass(/p-focus/);

    await panel.getByRole("searchbox").fill("predictable");
    await expect(panel.locator(".model-picker-group-label")).toHaveCount(0);
    await expect(panel.locator(".p-select-option-group:visible")).toHaveCount(0);

    await panel.getByRole("searchbox").fill("");
    await expect(panel.locator(".model-picker-group-label")).toBeVisible();

    // Picking one keeps it where it is; the model's check and the reasoning
    // pill show the choice.
    await recentRow.click();
    await expect(picker.locator(".model-picker-value-effort")).toHaveText("· high");
    await expect(recentRow.locator(".model-picker-option-check")).toHaveCount(0);
    await expect(modelRow.locator(".model-picker-option-check")).toBeVisible();
    await expect(panel.getByRole("radio", { name: "high", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(panel).toBeVisible();
  });
});
