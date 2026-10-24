import { expect, test } from "@playwright/test";

type PerformanceMemory = {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
};

declare global {
  interface Performance {
    memory?: PerformanceMemory;
  }
}

test.describe("confidential claim performance evidence", () => {
  test("records browser responsiveness and memory without triggering a financial transaction", async ({ page }, testInfo) => {
    const measurements = await page.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const resources = performance.getEntriesByType("resource");
      const longTasks: number[] = [];
      let observer: PerformanceObserver | undefined;

      if (typeof PerformanceObserver !== "undefined" &&
          PerformanceObserver.supportedEntryTypes.includes("longtask")) {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration);
        });
        observer.observe({ type: "longtask", buffered: true });
      }

      const memory = performance.memory;
      return {
        capturedAt: new Date().toISOString(),
        url: location.origin + location.pathname,
        navigation: navigation ? {
          domContentLoadedMs: navigation.domContentLoadedEventEnd,
          loadEventMs: navigation.loadEventEnd,
          responseMs: navigation.responseEnd,
          transferBytes: navigation.transferSize
        } : null,
        resourceCount: resources.length,
        resourceDurationMs: resources.reduce((total, entry) => total + entry.duration, 0),
        longTaskSupported: Boolean(observer),
        longTasksMs: longTasks,
        memory: memory ? {
          usedHeapBytes: memory.usedJSHeapSize,
          totalHeapBytes: memory.totalJSHeapSize,
          heapLimitBytes: memory.jsHeapSizeLimit
        } : null
      };
    });

    await page.waitForTimeout(1_000);
    const followup = await page.evaluate(() => {
      const memory = performance.memory;
      return memory ? {
        usedHeapBytes: memory.usedJSHeapSize,
        totalHeapBytes: memory.totalJSHeapSize,
        heapLimitBytes: memory.jsHeapSizeLimit
      } : null;
    });

    const artifact = {
      schemaVersion: 1,
      test: "confidential-claim-performance",
      environment: {
        browser: testInfo.project.name,
        baseURL: testInfo.project.use.baseURL ?? null,
        viewport: testInfo.project.use.viewport ?? null
      },
      note: "This artifact measures browser loading and idle memory only. It does not submit or sign a wallet transaction. Confidential proof duration is recorded by the claim flow when an eligible hosted test account is available.",
      ...measurements,
      memoryAfterOneSecond: followup,
      memoryAvailable: measurements.memory !== null && followup !== null
    };

    await testInfo.attach("confidential-claim-performance.json", {
      body: Buffer.from(JSON.stringify(artifact, null, 2)),
      contentType: "application/json"
    });

    expect(measurements.navigation, "Navigation timing should be available in a real browser").not.toBeNull();
    expect(measurements.resourceCount).toBeGreaterThan(0);
  });

  test("records actual confidential proof duration, interaction latency and heap deltas for an explicitly authorized Devnet settlement", async ({ browser }, testInfo) => {
    test.skip(
      process.env.PAYLORE_E2E_ENABLE_FINANCIAL_TRANSACTIONS !== "true" ||
      !process.env.PAYLORE_E2E_SETTLEMENT_URL || !process.env.PAYLORE_E2E_STORAGE_STATE,
      "Opt in only with an authenticated Devnet contributor, eligible finalized allocation, and explicit financial-test authorization."
    );
    test.setTimeout(180_000);
    const context = await browser.newContext({ storageState: process.env.PAYLORE_E2E_STORAGE_STATE });
    const page = await context.newPage();
    await page.addInitScript(() => {
      (window as Window & { __payloreLongTasks?: number[] }).__payloreLongTasks = [];
      if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes.includes("longtask")) return;
      new PerformanceObserver((list) => {
        const tasks = (window as Window & { __payloreLongTasks?: number[] }).__payloreLongTasks;
        for (const entry of list.getEntries()) tasks?.push(entry.duration);
      }).observe({ type: "longtask", buffered: true });
    });
    try {
      await page.goto(process.env.PAYLORE_E2E_SETTLEMENT_URL!);
      const button = page.getByRole("button", { name: "Claim & Cash Out" });
      await expect(button).toBeVisible();
      const before = await page.evaluate(() => ({ time: performance.now(), heap: performance.memory?.usedJSHeapSize ?? null }));
      const responses: Array<{ status: number; timing: string | null; elapsedMs: number }> = [];
      page.on("response", (response) => {
        if (!/\/allocations\/[^/]+\/claim$/.test(new URL(response.url()).pathname)) return;
        const timing = response.request().timing();
        // Performance artifacts must not retain private allocation amounts or transaction signatures.
        responses.push({
          status: response.status(),
          timing: response.headers()["server-timing"] ?? null,
          elapsedMs: timing.responseEnd - timing.startTime
        });
      });
      await button.click();
      await expect.poll(() => responses.length, { timeout: 150_000 }).toBeGreaterThan(0);
      const after = await page.evaluate(() => ({ time: performance.now(), heap: performance.memory?.usedJSHeapSize ?? null,
        longTasks: (window as Window & { __payloreLongTasks?: number[] }).__payloreLongTasks ?? [] }));
      const proofDurationMs = responses.flatMap((response) => {
        const match = response.timing?.match(/confidential-proof;dur=([0-9.]+)/);
        return match ? [Number(match[1])] : [];
      });
      await testInfo.attach("confidential-settlement-performance.json", { body: Buffer.from(JSON.stringify({
        schemaVersion: 1, capturedAt: new Date().toISOString(), url: process.env.PAYLORE_E2E_SETTLEMENT_URL,
        browserProject: testInfo.project.name, interactionDurationMs: after.time - before.time,
        heapBeforeBytes: before.heap, heapAfterBytes: after.heap,
        heapDeltaBytes: before.heap === null || after.heap === null ? null : after.heap - before.heap,
        proofDurationMs, longTasksMs: after.longTasks,
        longestLongTaskMs: Math.max(0, ...after.longTasks), responses
      }, null, 2)), contentType: "application/json" });
      expect(responses.some((response) => response.status === 200)).toBe(true);
      expect(proofDurationMs.length).toBeGreaterThan(0);
    } finally { await context.close(); }
  });

  test("records claim proof UI duration when the flow is present without clicking submit", async ({ page }, testInfo) => {
    const startedAt = Date.now();
    await page.goto("/");

    const proofState = page.getByText(/Preparing secure proof|Verifying proof context|Claim submitted|Waiting for final confirmation/i).first();
    const visible = await proofState.isVisible().catch(() => false);
    const result = {
      schemaVersion: 1,
      test: "confidential-claim-proof-ui-duration",
      capturedAt: new Date().toISOString(),
      route: "/",
      elapsedUntilObservationMs: Date.now() - startedAt,
      proofStateObserved: visible,
      observedState: visible ? (await proofState.textContent())?.trim() ?? null : null,
      submittedTransaction: false,
      note: "This check never clicks Claim or opens a wallet prompt. A real proof-duration measurement is only available while the proof UI is actively rendered."
    };

    await testInfo.attach("confidential-claim-proof-ui-duration.json", {
      body: Buffer.from(JSON.stringify(result, null, 2)),
      contentType: "application/json"
    });
  });
});
