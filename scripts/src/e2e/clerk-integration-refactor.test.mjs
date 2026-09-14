/* global document */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { startStaticServer } from "./serve.mjs";
import { collectAxeResults } from "./accessibility.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const output = path.join(root, "tmp/clerk-integration-refactor");
const clientId = "22222222-2222-4222-8222-222222222222";
const identity = {
  userId: "00000000-0000-4000-8000-000000000001",
  firmId: "00000000-0000-4000-8000-000000000002",
  clientPartyId: clientId,
  buyerPartyId: null,
  email: "fixture@valo.example",
  fullName: "Local reviewer",
  workspaceName: "Local fixture firm",
  consentCaptured: true,
  features: ["clerk_ai"],
  releaseTag: "R4",
};
const summary = {
  clientPartyId: clientId,
  legalName: "Local fixture business",
  totalInvoices: 1,
  draftCount: 0,
  pendingCount: 0,
  stampedCount: 0,
  failedCount: 0,
  cancelledCount: 0,
  unsubmittedCount: 1,
  unsubmittedValue: "1000",
  stampedValue: "0",
  overdueCount: 1,
  atRiskCount: 0,
  upcomingDeadlineCount: 0,
  penaltyRisk: "low",
  recentActivity: [],
  failingInvoiceIds: [],
};
const fixtures = {
  "/api/healthz": { contractVersion: "0.104.0" },
  "/api/notifications": { items: [], unreadCount: 0, nextCursor: null },
  "/api/operations": { operations: [], nextCursor: null },
  "/api/firm-api-keys": [],
  "/api/firm-webhooks": [],
  [`/api/console/clients/${clientId}`]: {
    client: summary,
    invoices: [],
    deadlines: [],
  },
  "/api/dashboard/summary": summary,
  "/api/dashboard/receivables": { groups: [], debtors: [] },
  "/api/clerk/action-proposals": {
    actions: [
      {
        kind: "submit_overdue",
        title: "Review the overdue invoice",
        why: "One invoice is ready for review.",
        targetCount: 1,
        truncated: false,
        targets: [
          {
            invoiceId: "invoice-fixture",
            invoiceNumber: "INV-FIXTURE-001",
            issueDate: "2026-08-01",
            grandTotal: "1000",
            currency: "NGN",
          },
        ],
      },
    ],
    note: "Only approved actions run.",
  },
  "/api/clerk/action-decisions": { decisions: [] },
  "/api/clerk/action-policies": { enabled: true, policies: [] },
};

async function checkDialog(page, name) {
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    );
  });
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press("Tab");
    assert.ok(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
      "dialog must trap keyboard focus",
    );
  }
  const box = await dialog.boundingBox();
  assert.ok(
    box && box.x >= -1 && box.x + box.width <= page.viewportSize().width + 1,
    "dialog must fit the viewport",
  );
  const axe = await collectAxeResults(page);
  assert.deepEqual(
    axe.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target),
    })),
    [],
  );
  await page.screenshot({
    path: path.join(output, `${name}.png`),
    fullPage: false,
  });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
}

async function checkClerk(page, scenario, suffix) {
  await page.getByTestId("action-submit_overdue").waitFor();
  if (scenario.readOnly) {
    assert.equal(
      await page.getByTestId("button-approve-submit_overdue").count(),
      0,
    );
    assert.equal(
      await page.getByTestId("button-automate-submit_overdue").count(),
      0,
    );
    return;
  }
  await page.getByTestId("button-approve-submit_overdue").click();
  await checkDialog(page, `${scenario.name}-approval-${suffix}`);
  await page.getByTestId("button-automate-submit_overdue").click();
  await page.getByTestId("input-policy-cap").fill("0");
  assert.ok(await page.getByTestId("button-confirm-automate").isDisabled());
  await checkDialog(page, `${scenario.name}-automation-${suffix}`);
}

async function checkIntegrations(page, suffix) {
  await page.getByTestId("text-no-api-keys").waitFor();
  await page.getByTestId("text-no-webhooks").waitFor();
  await page.getByTestId("button-new-api-key").click();
  assert.ok(await page.getByTestId("button-create-api-key").isDisabled());
  await checkDialog(page, `api-key-${suffix}`);
  await page.getByTestId("button-new-webhook").click();
  await page.getByTestId("input-webhook-url").fill("ftp://example.invalid");
  await page.getByTestId("input-webhook-url").blur();
  await page.getByTestId("text-webhook-url-error").waitFor();
  assert.equal(
    await page.getByTestId("input-webhook-url").getAttribute("aria-invalid"),
    "true",
  );
  assert.ok(await page.getByTestId("button-create-webhook").isDisabled());
  await checkDialog(page, `webhook-${suffix}`);
}

test(
  "extracted Clerk dialogs and integration settings preserve browser semantics",
  { timeout: 180_000 },
  async (t) => {
    await mkdir(output, { recursive: true });
    const server = await startStaticServer({ port: 0, apiPort: 1 });
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    t.after(async () => {
      await browser?.close();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    });
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
    });
    const scenarios = [
      {
        name: "console-clerk",
        route: `/console/clients/${clientId}?view=clerk`,
        role: "firm_staff",
      },
      {
        name: "sme-clerk",
        route: "/app/dashboard?view=clerk",
        role: "client_user",
      },
      {
        name: "auditor-clerk",
        route: `/console/clients/${clientId}?view=clerk`,
        role: "auditor",
        readOnly: true,
      },
      {
        name: "integrations",
        route: "/console/api-access",
        role: "firm_admin",
      },
    ];
    for (const scenario of scenarios) {
      for (const [width, theme] of [
        [375, "light"],
        [1360, "dark"],
      ]) {
        await t.test(`${scenario.name} ${width}px ${theme}`, async () => {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            serviceWorkers: "block",
          });
          const writes = [];
          try {
            await context.route("**/*", async (route) => {
              const url = new URL(route.request().url());
              if (url.origin !== origin) return route.abort();
              if (!url.pathname.startsWith("/api/")) return route.continue();
              if (route.request().method() !== "GET") {
                writes.push(url.pathname);
                return route.abort();
              }
              const body =
                url.pathname === "/api/me"
                  ? {
                      ...identity,
                      role: scenario.role,
                      capabilities: [
                        "console.portfolio.read",
                        "invoice.read",
                        "clerk.ask",
                        ...(!scenario.readOnly ? ["invoice.submit"] : []),
                      ],
                    }
                  : fixtures[url.pathname];
              // Ancillary self-gating cards remain unavailable; every request is local and read-only.
              return route.fulfill({
                status: body ? 200 : 404,
                contentType: "application/json",
                body: JSON.stringify(body ?? { error: "FIXTURE_UNAVAILABLE" }),
              });
            });
            const page = await context.newPage();
            page.setDefaultTimeout(10_000);
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(origin + scenario.route);
            await page.evaluate(
              (mode) =>
                document.documentElement.classList.toggle(
                  "dark",
                  mode === "dark",
                ),
              theme,
            );
            const suffix = `${width}-${theme}`;
            if (scenario.name === "integrations")
              await checkIntegrations(page, suffix);
            else await checkClerk(page, scenario, suffix);
            assert.deepEqual(errors, []);
            assert.deepEqual(writes, []);
          } finally {
            await context.close();
          }
        });
      }
    }
  },
);
