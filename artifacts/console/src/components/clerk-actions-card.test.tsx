// @vitest-environment jsdom
// The console "Clerk suggests" card — the SME dashboard card's firm-side
// twin. The pins that matter:
//  - F1: the card (and its OPEN results dialog) must survive the proposals
//    query refetching to an empty list — after a full batch the refetched
//    list is [] and an early return would unmount the results mid-read.
//  - closeDialog is a no-op while the execute mutation is in flight: a batch
//    cannot be cancelled from here, so its result is always shown.
//  - The proposals/decisions invalidations are deferred to closeDialog and
//    fire only when a decision exists — never immediately on success, never
//    on a cancelled confirmation.
//  - Every contract outcome renders through the shared vocabulary in
//    @workspace/format (no raw enum string leaks into the dialog).
//  - Chaser drafts render subject/body and copy as "subject\n\nbody".
// Plus the console-only mount rule: past decisions keep the card visible
// even when a dark clerk_actions flag empties the proposals.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { operationSessionKey, readOperations } from "@workspace/web-ui";
import type {
  ActionProposal,
  ActionProposals,
  ActionTarget,
  ActionTargetOutcome,
  ClerkActionDecision,
  ExecuteActionResult,
  PaymentChaserDraft,
} from "@workspace/api-client-react";

// Controllable stand-ins for the generated hooks the card renders with. The
// rest of the module stays real — in particular the query-key builders, so
// the invalidation assertions compare against genuine keys.
const harness = vi.hoisted(() => ({
  me: {
    data: undefined as unknown,
  },
  proposals: {
    data: undefined as unknown,
    isSuccess: false,
  },
  decisions: {
    data: undefined as unknown,
  },
  policies: {
    data: undefined as unknown,
  },
  evidence: {
    data: undefined as unknown,
  },
  execute: {
    calls: [] as unknown[],
    pending: false,
    result: null as unknown,
    error: null as unknown,
  },
  policyCalls: {
    grant: [] as unknown[],
    pause: [] as unknown[],
    resume: [] as unknown[],
    revoke: [] as unknown[],
  },
  reset() {
    this.me.data = undefined;
    this.proposals.data = undefined;
    this.proposals.isSuccess = false;
    this.decisions.data = undefined;
    this.policies.data = undefined;
    this.evidence.data = undefined;
    this.execute.calls = [];
    this.execute.pending = false;
    this.execute.result = null;
    this.execute.error = null;
    this.policyCalls.grant = [];
    this.policyCalls.pause = [];
    this.policyCalls.resume = [];
    this.policyCalls.revoke = [];
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  // A policy mutation stand-in that resolves instantly and fires both the
  // hook-level onSuccess (the card's invalidation) and the per-call one
  // (dialog close), like a live mutation would.
  type MutationOpts = {
    mutation?: { onSuccess?: () => void; onError?: (e: unknown) => void };
  };
  const policyMutation =
    (name: keyof typeof harness.policyCalls) => (options?: MutationOpts) => ({
      isPending: false,
      mutate: (vars: unknown, callOpts?: { onSuccess?: () => void }) => {
        harness.policyCalls[name].push(vars);
        options?.mutation?.onSuccess?.();
        callOpts?.onSuccess?.();
      },
    });
  return {
    ...actual,
    useGetMe: () => ({ data: harness.me.data }),
    useGetActionProposals: () => ({
      data: harness.proposals.data,
      isSuccess: harness.proposals.isSuccess,
    }),
    useGetActionDecisions: () => ({
      data: harness.decisions.data,
    }),
    useGetActionPolicies: () => ({
      data: harness.policies.data,
    }),
    useGetClientAutomationEvidence: () => ({
      data: harness.evidence.data,
    }),
    useGrantActionPolicy: policyMutation("grant"),
    usePauseActionPolicy: policyMutation("pause"),
    useResumeActionPolicy: policyMutation("resume"),
    useRevokeActionPolicy: policyMutation("revoke"),
    useExecuteAction: () => ({
      // Getter so the object handed to the handlers always reflects the
      // in-flight state, exactly like a live mutation object would.
      get isPending() {
        return harness.execute.pending;
      },
      mutateAsync: (vars: unknown) => {
        harness.execute.calls.push(vars);
        if (harness.execute.error) return Promise.reject(harness.execute.error);
        return Promise.resolve(harness.execute.result);
      },
    }),
  };
});

// Import AFTER the mock so the component module binds the stand-ins.
import { ClerkActionsCard } from "./clerk-actions-card";
import {
  ActionTargetOutcomeOutcome,
  getGetActionDecisionsQueryKey,
  getGetActionPoliciesQueryKey,
  getGetActionProposalsQueryKey,
  getGetClientPortfolioQueryKey,
} from "@workspace/api-client-react";
import type {
  AutomationEvidence,
  AutomationEvidenceKind,
  ClerkActionPolicy,
} from "@workspace/api-client-react";
import {
  ACTION_OUTCOME_LABELS,
  policyEvidenceLine,
  policyGrantDescription,
} from "@/lib/format";

function target(invoiceId: string, invoiceNumber: string): ActionTarget {
  return {
    invoiceId,
    invoiceNumber,
    issueDate: "2026-06-01",
    daysOverdue: 30,
    grandTotal: "10000.00",
    currency: "NGN",
    note: null,
  };
}

function proposal(over: Partial<ActionProposal> = {}): ActionProposal {
  return {
    kind: "submit_overdue",
    title: "Submit 2 overdue invoices",
    why: "Two invoices are past the statutory window.",
    targets: [target("inv-1", "INV-001"), target("inv-2", "INV-002")],
    targetCount: 2,
    truncated: false,
    evidence: {},
    ...over,
  };
}

function proposals(actions: ActionProposal[]): ActionProposals {
  return { actions, note: "Nothing runs until a firm user approves." };
}

function decision(
  targets: ActionTargetOutcome[],
  over: Partial<ClerkActionDecision> = {},
): ClerkActionDecision {
  const executed = targets.filter(
    (t) => t.outcome === "submitted" || t.outcome === "drafted",
  ).length;
  const skipped = targets.filter(
    (t) => t.outcome === "skipped_not_eligible",
  ).length;
  return {
    id: "dec-1",
    firmId: "f-1",
    clientPartyId: "cp-1",
    kind: "submit_overdue",
    decidedBy: "u-1",
    policyId: null,
    evidence: {},
    targets,
    requestedCount: targets.length,
    executedCount: executed,
    skippedCount: skipped,
    failedCount: targets.length - executed - skipped,
    createdAt: "2026-07-29T10:00:00Z",
    ...over,
  };
}

function policy(over: Partial<ClerkActionPolicy> = {}): ClerkActionPolicy {
  return {
    id: "pol-1",
    firmId: "f-1",
    clientPartyId: "cp-1",
    kind: "submit_overdue",
    maxTargetsPerRun: 50,
    grantedBy: "u-1",
    grantedByRole: "firm_admin",
    pausedAt: null,
    pausedReason: null,
    pausedBy: null,
    revokedAt: null,
    revokedBy: null,
    lastRunAt: null,
    lastRunDay: null,
    createdAt: "2026-07-28T09:00:00Z",
    ...over,
  };
}

function evidenceKind(
  over: Partial<AutomationEvidenceKind> = {},
): AutomationEvidenceKind {
  return {
    kind: "retry_failed",
    sample: 5,
    agreed: 3,
    disagreed: 1,
    pending: 1,
    agreementRate: 0.6,
    medianLeadDays: 2,
    exposureFloorNgn: null,
    note: "Backtested against the client's own submissions.",
    ...over,
  };
}

function evidence(kinds: AutomationEvidenceKind[]): AutomationEvidence {
  return { windowMonths: 6, asOf: "2026-08-06", kinds };
}

function chaserDraft(): PaymentChaserDraft {
  return {
    invoiceId: "inv-1",
    invoiceNumber: "INV-001",
    buyerName: "Zenith Retail",
    subject: "Payment reminder for INV-001",
    body: "Good day,\n\nINV-001 is now due. Kindly arrange payment.",
    source: "template",
    stage: 1,
    previousReminders: { count: 0, lastAt: null },
  };
}

// The card reads the query client from context; the spy records every
// invalidation's key so the deferred-refetch contract can be asserted.
function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(qc, "invalidateQueries").mockResolvedValue(undefined);
  const ui = () => (
    <QueryClientProvider client={qc}>
      <ClerkActionsCard clientPartyId="cp-1" />
    </QueryClientProvider>
  );
  const view = render(ui());
  return {
    invalidatedKeys: () =>
      spy.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey),
    rerenderCard: () => view.rerender(ui()),
  };
}

// Clicks run async handlers (the execute mutation resolves in a microtask);
// act(async …) flushes them before assertions.
const click = (el: Element) =>
  act(async () => {
    fireEvent.click(el);
  });

// Drive the card from proposal to the results view: approve → confirm, with
// the mutation resolving to `result`.
async function openResults(
  result: ExecuteActionResult,
  kind = "submit_overdue",
) {
  harness.execute.result = result;
  await click(screen.getByTestId(`button-approve-${kind}`));
  await click(screen.getByTestId("button-confirm-action"));
  expect(screen.getByText("Batch result")).toBeTruthy();
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
beforeEach(() => {
  window.localStorage.clear();
  harness.reset();
  // The default viewer holds invoice.submit — the capability the server
  // gates every write on this card behind (routes/clerk/actions.ts).
  harness.me.data = {
    userId: "u-1",
    role: "firm_admin",
    capabilities: ["invoice.submit", "clerk.ask"],
  };
  harness.proposals.data = proposals([proposal()]);
  harness.proposals.isSuccess = true;
  harness.decisions.data = { decisions: [] };
  // The pre-round-28 default: no grants, flag dark — the card renders
  // exactly as it always did.
  harness.policies.data = { policies: [], enabled: false };
});

describe("ClerkActionsCard (console)", () => {
  test("records the app-specific recovery route and durable success", async () => {
    const { invalidatedKeys } = renderCard();
    await openResults({ decision: decision([]), drafts: null });
    expect(harness.execute.calls).toEqual([
      {
        data: {
          kind: "submit_overdue",
          clientPartyId: "cp-1",
          invoiceIds: ["inv-1", "inv-2"],
        },
      },
    ]);
    const records = readOperations(operationSessionKey({ userId: "u-1" })!);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: "succeeded",
      kind: "clerk",
      route: "/clients/cp-1?view=clerk",
      savedSummary:
        "A durable Clerk decision is available on the client record.",
    });
    expect(invalidatedKeys()).toEqual([getGetClientPortfolioQueryKey("cp-1")]);
  });

  test.each([
    {
      error: new TypeError("Failed to fetch"),
      status: "partial",
      summary:
        "Outcome unconfirmed. Reopen the client Clerk tab before retrying.",
    },
    {
      error: { status: 403, message: "Forbidden" },
      status: "failed",
      summary: "No completed decision was returned.",
    },
  ])(
    "preserves $status recovery when execution rejects",
    async ({ error, status, summary }) => {
      harness.execute.error = error;
      const { invalidatedKeys } = renderCard();
      await click(screen.getByTestId("button-approve-submit_overdue"));
      await click(screen.getByTestId("button-confirm-action"));
      const records = readOperations(operationSessionKey({ userId: "u-1" })!);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        status,
        savedSummary: summary,
        route: "/clients/cp-1?view=clerk",
      });
      expect(screen.queryByText("Batch result")).toBeNull();
      expect(screen.getByTestId("button-confirm-action")).toBeTruthy();
      expect(invalidatedKeys()).toEqual([]);
    },
  );

  test.each(["action", "automation"])(
    "revoking capabilities disables an already-open %s confirmation",
    async (mode) => {
      harness.policies.data = { policies: [], enabled: true };
      const { rerenderCard } = renderCard();
      await click(
        screen.getByTestId(
          mode === "action"
            ? "button-approve-submit_overdue"
            : "button-automate-submit_overdue",
        ),
      );
      harness.me.data = { userId: "u-1", role: "auditor", capabilities: [] };
      rerenderCard();
      const confirm = screen.getByTestId(
        mode === "action" ? "button-confirm-action" : "button-confirm-automate",
      ) as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
      await click(confirm);
      expect(harness.execute.calls).toEqual([]);
      expect(harness.policyCalls.grant).toEqual([]);
    },
  );

  test("F1: the open results dialog survives the proposals list refetching to empty", async () => {
    const { rerenderCard } = renderCard();
    await openResults({
      decision: decision([
        {
          invoiceId: "inv-1",
          invoiceNumber: "INV-001",
          outcome: "submitted",
          error: null,
        },
        {
          invoiceId: "inv-2",
          invoiceNumber: "INV-002",
          outcome: "submitted",
          error: null,
        },
      ]),
      drafts: null,
    });

    // The full batch went through: the proposals query refetches to [] (as
    // it will after closeDialog invalidates it). With no decision history
    // either, only the open dialog keeps the card mounted — the early
    // return must not fire mid-read.
    harness.proposals.data = proposals([]);
    rerenderCard();
    expect(screen.getByTestId("card-clerk-actions")).toBeTruthy();
    expect(screen.getByText("Batch result")).toBeTruthy();
    expect(screen.getByTestId("outcome-inv-1").textContent).toContain(
      "Submitted",
    );
  });

  test("closeDialog is a no-op while the execute mutation is in flight", async () => {
    const { invalidatedKeys, rerenderCard } = renderCard();
    await openResults({
      decision: decision([
        {
          invoiceId: "inv-1",
          invoiceNumber: "INV-001",
          outcome: "submitted",
          error: null,
        },
      ]),
      drafts: null,
    });

    // A batch in flight (isPending): Done must hold the dialog open — its
    // result would otherwise never be shown.
    harness.execute.pending = true;
    rerenderCard();
    await click(screen.getByTestId("button-close-action"));
    expect(screen.getByText("Batch result")).toBeTruthy();
    expect(invalidatedKeys()).not.toContainEqual(
      getGetActionProposalsQueryKey(),
    );

    // Once the flight lands, the same click closes normally.
    harness.execute.pending = false;
    rerenderCard();
    await click(screen.getByTestId("button-close-action"));
    expect(screen.queryByText("Batch result")).toBeNull();
  });

  test("proposals/decisions invalidations fire only on close after a decision", async () => {
    const { invalidatedKeys } = renderCard();

    // Opening and cancelling the confirmation touches nothing.
    await click(screen.getByTestId("button-approve-submit_overdue"));
    await click(screen.getByText("Cancel"));
    expect(invalidatedKeys()).toEqual([]);

    await openResults({
      decision: decision([
        {
          invoiceId: "inv-1",
          invoiceNumber: "INV-001",
          outcome: "submitted",
          error: null,
        },
      ]),
      drafts: null,
    });

    // Success refreshes the client portfolio immediately, but the
    // proposals/decisions refetch is deferred so the open dialog's backing
    // list cannot empty underneath it.
    const afterSuccess = invalidatedKeys();
    expect(afterSuccess).toContainEqual(getGetClientPortfolioQueryKey("cp-1"));
    expect(afterSuccess).not.toContainEqual(getGetActionProposalsQueryKey());
    expect(afterSuccess).not.toContainEqual(getGetActionDecisionsQueryKey());

    await click(screen.getByTestId("button-close-action"));
    const afterClose = invalidatedKeys();
    expect(afterClose).toContainEqual(getGetActionProposalsQueryKey());
    expect(afterClose).toContainEqual(getGetActionDecisionsQueryKey());
  });

  test("every contract outcome renders its shared mapped label — no raw enum leaks", async () => {
    const outcomes = Object.values(ActionTargetOutcomeOutcome);
    renderCard();
    await openResults({
      decision: decision(
        outcomes.map((outcome, i) => ({
          invoiceId: `inv-${i}`,
          invoiceNumber: `N${i}`,
          outcome,
          error: null,
        })),
      ),
      drafts: null,
    });

    outcomes.forEach((outcome, i) => {
      // The row is exactly invoice number + the vocabulary label: any raw
      // enum string ("skipped_not_eligible") would fail the equality.
      expect(screen.getByTestId(`outcome-inv-${i}`).textContent).toBe(
        `N${i}${ACTION_OUTCOME_LABELS[outcome]}`,
      );
    });

    // The tone wiring goes through the shared helper, not a local ternary.
    const toneOf = (i: number) =>
      screen.getByTestId(`outcome-inv-${i}`).querySelector("span:last-child")
        ?.className;
    expect(toneOf(outcomes.indexOf("submitted"))).toBe(
      "text-emerald-700 dark:text-emerald-400",
    );
    expect(toneOf(outcomes.indexOf("skipped_not_eligible"))).toBe(
      "text-muted-foreground",
    );
    expect(toneOf(outcomes.indexOf("failed"))).toBe(
      "text-amber-700 dark:text-amber-400",
    );
  });

  test("chaser drafts render subject/body and copy as subject + blank line + body", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const draft = chaserDraft();
    harness.proposals.data = proposals([
      proposal({ kind: "draft_chasers", title: "Draft 1 payment reminder" }),
    ]);
    renderCard();
    await openResults(
      {
        decision: decision(
          [
            {
              invoiceId: "inv-1",
              invoiceNumber: "INV-001",
              outcome: "drafted",
              error: null,
            },
          ],
          { kind: "draft_chasers" },
        ),
        drafts: [draft],
      },
      "draft_chasers",
    );

    const card = screen.getByTestId("draft-inv-1");
    expect(card.textContent).toContain(draft.subject);
    expect(card.textContent).toContain("Kindly arrange payment.");
    await click(screen.getByTestId("button-copy-draft-inv-1"));
    expect(writeText).toHaveBeenCalledWith(`${draft.subject}\n\n${draft.body}`);
  });

  test("past decisions keep the card visible when the proposals list is empty", () => {
    // A dark clerk_actions flag answers an empty proposals list, but the
    // decision strip is the firm's durable record of who approved what.
    harness.proposals.data = proposals([]);
    harness.decisions.data = {
      decisions: [
        decision([
          {
            invoiceId: "inv-1",
            invoiceNumber: "INV-001",
            outcome: "submitted",
            error: null,
          },
        ]),
      ],
    };
    renderCard();
    expect(screen.getByTestId("card-clerk-actions")).toBeTruthy();
    expect(screen.getByTestId("decision-dec-1").textContent).toContain(
      "1 completed",
    );
  });

  // ---- Standing approvals (round 28) --------------------------------------

  test("the automate affordance: submit kinds only, flag lit, no live grant — and granting sends kind + client + the default cap", async () => {
    harness.proposals.data = proposals([
      proposal(),
      proposal({ kind: "draft_chasers", title: "Draft 1 payment reminder" }),
    ]);
    harness.policies.data = { policies: [], enabled: true };
    const { invalidatedKeys } = renderCard();

    // draft_chasers is not automatable — no affordance, by design.
    expect(screen.getByTestId("button-automate-submit_overdue")).toBeTruthy();
    expect(screen.queryByTestId("button-automate-draft_chasers")).toBeNull();

    // The confirm dialog carries the consent-grade copy verbatim, restating
    // the default per-run cap of 10.
    await click(screen.getByTestId("button-automate-submit_overdue"));
    expect(
      screen.getByText(policyGrantDescription("submit_overdue", "console", 10)),
    ).toBeTruthy();
    expect(
      (screen.getByTestId("input-policy-cap") as HTMLInputElement).value,
    ).toBe("10");

    await click(screen.getByTestId("button-confirm-automate"));
    expect(harness.policyCalls.grant).toEqual([
      {
        data: {
          kind: "submit_overdue",
          clientPartyId: "cp-1",
          maxTargetsPerRun: 10,
        },
      },
    ]);
    // Granting closes the dialog and refetches the grants.
    expect(
      screen.queryByText(
        policyGrantDescription("submit_overdue", "console", 10),
      ),
    ).toBeNull();
    expect(invalidatedKeys()).toContainEqual(getGetActionPoliciesQueryKey());
  });

  test("the chosen cap flows into the consent copy and the grant body; out-of-bounds disables confirm", async () => {
    harness.policies.data = { policies: [], enabled: true };
    renderCard();
    await click(screen.getByTestId("button-automate-submit_overdue"));

    // Choosing 25: the copy restates 25 and the grant carries it.
    fireEvent.change(screen.getByTestId("input-policy-cap"), {
      target: { value: "25" },
    });
    expect(
      screen.getByText(policyGrantDescription("submit_overdue", "console", 25)),
    ).toBeTruthy();

    // Out of the contract's 1..50: confirm disables, nothing is sent.
    fireEvent.change(screen.getByTestId("input-policy-cap"), {
      target: { value: "0" },
    });
    expect(
      (screen.getByTestId("button-confirm-automate") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await click(screen.getByTestId("button-confirm-automate"));
    expect(harness.policyCalls.grant).toEqual([]);

    // Back in bounds: the grant sends the chosen 25.
    fireEvent.change(screen.getByTestId("input-policy-cap"), {
      target: { value: "25" },
    });
    await click(screen.getByTestId("button-confirm-automate"));
    expect(harness.policyCalls.grant).toEqual([
      {
        data: {
          kind: "submit_overdue",
          clientPartyId: "cp-1",
          maxTargetsPerRun: 25,
        },
      },
    ]);
  });

  test("no affordance while the policies flag is dark, or once a live grant exists", () => {
    // Dark flag (the beforeEach default): the proposal renders, the
    // affordance does not.
    renderCard();
    expect(screen.getByTestId("button-approve-submit_overdue")).toBeTruthy();
    expect(screen.queryByTestId("button-automate-submit_overdue")).toBeNull();
    cleanup();

    // A live grant of the kind: managing it replaces granting it again.
    harness.policies.data = { policies: [policy()], enabled: true };
    renderCard();
    expect(screen.queryByTestId("button-automate-submit_overdue")).toBeNull();
  });

  test("a live grant keeps the card up on a quiet day, and pause/revoke act on it", async () => {
    harness.proposals.data = proposals([]);
    harness.policies.data = {
      policies: [policy({ lastRunAt: "2026-07-28T06:10:00Z" })],
      enabled: true,
    };
    renderCard();
    expect(screen.getByTestId("card-clerk-actions")).toBeTruthy();
    const strip = screen.getByTestId("policy-submit_overdue");
    expect(strip.textContent).toContain("Auto-submit overdue invoices");
    expect(
      screen.getByTestId("text-policy-status-submit_overdue").textContent,
    ).toMatch(/^runs daily · up to 50 per run · last ran /);

    await click(screen.getByTestId("button-policy-pause-submit_overdue"));
    expect(harness.policyCalls.pause).toEqual([{ id: "pol-1" }]);
    await click(screen.getByTestId("button-policy-revoke-submit_overdue"));
    expect(harness.policyCalls.revoke).toEqual([{ id: "pol-1" }]);
  });

  test("a paused grant reads why and offers resume", async () => {
    harness.proposals.data = proposals([]);
    harness.policies.data = {
      policies: [
        policy({
          pausedAt: "2026-07-29T06:00:00Z",
          pausedReason: "failed_targets",
        }),
      ],
      enabled: true,
    };
    renderCard();
    expect(
      screen.getByTestId("text-policy-status-submit_overdue").textContent,
    ).toBe("paused — too many failures in the last run");
    expect(
      screen.queryByTestId("button-policy-pause-submit_overdue"),
    ).toBeNull();
    await click(screen.getByTestId("button-policy-resume-submit_overdue"));
    expect(harness.policyCalls.resume).toEqual([{ id: "pol-1" }]);
  });

  test("a policy-run decision line is tagged auto", () => {
    harness.proposals.data = proposals([]);
    harness.decisions.data = {
      decisions: [
        decision(
          [
            {
              invoiceId: "inv-1",
              invoiceNumber: "INV-001",
              outcome: "submitted",
              error: null,
            },
          ],
          { policyId: "pol-1" },
        ),
        decision(
          [
            {
              invoiceId: "inv-2",
              invoiceNumber: "INV-002",
              outcome: "submitted",
              error: null,
            },
          ],
          { id: "dec-2" },
        ),
      ],
    };
    renderCard();
    expect(screen.getByTestId("decision-dec-1").textContent).toContain(
      "· auto",
    );
    expect(screen.getByTestId("decision-dec-2").textContent).not.toContain(
      "· auto",
    );
  });

  test("any paused grant raises the amber header pill; none paused, no pill", () => {
    // One paused among two grants: the pill counts the paused ones and sits
    // in the HEADER, visible regardless of where the card is scrolled.
    harness.policies.data = {
      policies: [
        policy({
          pausedAt: "2026-07-29T06:00:00Z",
          pausedReason: "failed_targets",
        }),
        policy({ id: "pol-2", kind: "retry_failed" }),
      ],
      enabled: true,
    };
    renderCard();
    expect(screen.getByTestId("pill-automation-paused").textContent).toBe(
      "1 paused",
    );
    // The inline amber detail row stays alongside the pill.
    expect(
      screen.getByTestId("text-policy-status-submit_overdue").textContent,
    ).toBe("paused — too many failures in the last run");
    cleanup();

    harness.policies.data = { policies: [policy()], enabled: true };
    renderCard();
    expect(screen.queryByTestId("pill-automation-paused")).toBeNull();
  });

  // ---- Automation evidence (Prove with Clerk phase 2) ----------------------

  test("the grant dialog leads with the client's own record, above the consent copy", async () => {
    harness.proposals.data = proposals([
      proposal({ kind: "retry_failed", title: "Retry 2 failed submissions" }),
    ]);
    harness.policies.data = { policies: [], enabled: true };
    harness.evidence.data = evidence([
      // Only the granting kind's entry phrases the line.
      evidenceKind({ kind: "reconcile_matches", sample: 40, agreed: 38 }),
      evidenceKind(),
    ]);
    renderCard();
    await click(screen.getByTestId("button-automate-retry_failed"));

    const line = screen.getByTestId("text-policy-evidence");
    expect(line.textContent).toBe(
      policyEvidenceLine("retry_failed", {
        sample: 5,
        agreed: 3,
        medianLeadDays: 2,
      }),
    );
    // ABOVE the consent sentence, so the record is read before the grant.
    const description = screen.getByText(
      policyGrantDescription("retry_failed", "console", 10),
    );
    expect(
      line.compareDocumentPosition(description) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Advisory only: the evidence never gates the confirm button.
    expect(
      (screen.getByTestId("button-confirm-automate") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  test("no evidence or an empty sample renders no line — and never blocks granting", async () => {
    // No evidence at all (failed fetch, older server): nothing renders and
    // the grant still goes through.
    harness.policies.data = { policies: [], enabled: true };
    renderCard();
    await click(screen.getByTestId("button-automate-submit_overdue"));
    expect(screen.queryByTestId("text-policy-evidence")).toBeNull();
    await click(screen.getByTestId("button-confirm-automate"));
    expect(harness.policyCalls.grant).toHaveLength(1);
    cleanup();

    // An empty sample: no rate from nothing — no line, no placeholder.
    harness.evidence.data = evidence([
      evidenceKind({
        kind: "submit_overdue",
        sample: 0,
        agreed: 0,
        agreementRate: null,
        medianLeadDays: null,
      }),
    ]);
    renderCard();
    await click(screen.getByTestId("button-automate-submit_overdue"));
    expect(screen.queryByTestId("text-policy-evidence")).toBeNull();
    expect(
      (screen.getByTestId("button-confirm-automate") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  // ---- Capability gating ----------------------------------------------------

  test("a viewer without invoice.submit sees status, pill and run record — but no write affordances", () => {
    // An auditor has read access to everything on this card, and every
    // mutation would 403 server-side — so none may be offered.
    harness.me.data = {
      userId: "u-2",
      role: "auditor",
      capabilities: ["invoice.read", "clerk.ask"],
    };
    harness.policies.data = {
      policies: [
        policy({
          pausedAt: "2026-07-29T06:00:00Z",
          pausedReason: "failed_targets",
        }),
      ],
      enabled: true,
    };
    harness.decisions.data = {
      decisions: [
        decision([
          {
            invoiceId: "inv-1",
            invoiceNumber: "INV-001",
            outcome: "submitted",
            error: null,
          },
        ]),
      ],
    };
    renderCard();

    // The read surfaces stay: proposal evidence, grant status, the paused
    // pill and the decision record.
    expect(screen.getByTestId("card-clerk-actions")).toBeTruthy();
    expect(screen.getByTestId("action-target-inv-1")).toBeTruthy();
    expect(
      screen.getByTestId("text-policy-status-submit_overdue").textContent,
    ).toBe("paused — too many failures in the last run");
    expect(screen.getByTestId("pill-automation-paused").textContent).toBe(
      "1 paused",
    );
    expect(screen.getByTestId("decision-dec-1").textContent).toContain(
      "1 completed",
    );

    // No write affordances of any kind.
    expect(screen.queryByTestId("button-approve-submit_overdue")).toBeNull();
    expect(screen.queryByTestId("button-automate-submit_overdue")).toBeNull();
    expect(
      screen.queryByTestId("button-policy-pause-submit_overdue"),
    ).toBeNull();
    expect(
      screen.queryByTestId("button-policy-resume-submit_overdue"),
    ).toBeNull();
    expect(
      screen.queryByTestId("button-policy-revoke-submit_overdue"),
    ).toBeNull();
  });
});
