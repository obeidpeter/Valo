// @vitest-environment jsdom
// The dashboard's "Clerk suggests" card. The pins that matter:
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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
// the invalidation assertions below compare against the genuine keys.
const harness = vi.hoisted(() => ({
  proposals: {
    data: undefined as unknown,
    isSuccess: false,
  },
  policies: {
    data: undefined as unknown,
  },
  decisions: {
    data: undefined as unknown,
  },
  evidence: {
    data: undefined as unknown,
  },
  execute: {
    calls: [] as unknown[],
    pending: false,
    result: null as unknown,
  },
  policyCalls: {
    grant: [] as unknown[],
    pause: [] as unknown[],
    resume: [] as unknown[],
    revoke: [] as unknown[],
  },
  reset() {
    this.proposals.data = undefined;
    this.proposals.isSuccess = false;
    this.policies.data = undefined;
    this.decisions.data = undefined;
    this.evidence.data = undefined;
    this.execute.calls = [];
    this.execute.pending = false;
    this.execute.result = null;
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
    useGetActionProposals: () => ({
      data: harness.proposals.data,
      isSuccess: harness.proposals.isSuccess,
    }),
    useGetActionPolicies: () => ({
      data: harness.policies.data,
    }),
    useGetActionDecisions: () => ({
      data: harness.decisions.data,
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
        return Promise.resolve(harness.execute.result);
      },
    }),
  };
});

// Import AFTER the mock so the page module binds the stand-ins.
import { ClerkActionsCard } from "./dashboard";
import {
  ActionTargetOutcomeOutcome,
  getGetActionDecisionsQueryKey,
  getGetActionPoliciesQueryKey,
  getGetActionProposalsQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetReceivablesSummaryQueryKey,
  getGetPenaltyExposureQueryKey,
  getGetMonthEndCloseQueryKey,
  getListInvoicesQueryKey,
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
  return { actions, note: "Nothing runs until you approve." };
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

function evidenceKind(
  over: Partial<AutomationEvidenceKind> = {},
): AutomationEvidenceKind {
  return {
    kind: "submit_overdue",
    sample: 12,
    agreed: 9,
    disagreed: 1,
    pending: 2,
    agreementRate: 0.75,
    medianLeadDays: 4,
    exposureFloorNgn: null,
    note: "Backtested against your own submissions.",
    ...over,
  };
}

function evidence(kinds: AutomationEvidenceKind[]): AutomationEvidence {
  return { windowMonths: 6, asOf: "2026-08-06", kinds };
}

function policy(over: Partial<ClerkActionPolicy> = {}): ClerkActionPolicy {
  return {
    id: "pol-1",
    firmId: "f-1",
    clientPartyId: "cp-1",
    kind: "submit_overdue",
    maxTargetsPerRun: 50,
    grantedBy: "u-1",
    grantedByRole: "client_user",
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

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
  harness.proposals.data = proposals([proposal()]);
  harness.proposals.isSuccess = true;
  // The pre-round-28 default: no grants, flag dark — the card renders
  // exactly as it always did.
  harness.policies.data = { policies: [], enabled: false };
  harness.decisions.data = { decisions: [] };
});

describe("ClerkActionsCard (SME dashboard)", () => {
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
    // it will after closeDialog invalidates it). The card must NOT take its
    // empty-list early return while the dialog is up.
    harness.proposals.data = proposals([]);
    rerenderCard();
    expect(screen.getByTestId("clerk-actions")).toBeTruthy();
    expect(screen.getByText("Batch result")).toBeTruthy();
    expect(screen.getByTestId("outcome-inv-1").textContent).toContain(
      "Submitted",
    );
    // No grants and no history: the quiet line has nothing to point at, so
    // the dialog-open survival renders without it.
    expect(screen.queryByTestId("text-actions-empty")).toBeNull();
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

    // A second batch is now in flight (isPending): Done must hold the
    // dialog open — its result would otherwise never be shown.
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

    // Success refreshes the dashboard's fact cards immediately, but the
    // proposals/decisions refetch is deferred so the open dialog's backing
    // list cannot empty underneath it.
    const afterSuccess = invalidatedKeys();
    expect(afterSuccess).toEqual([
      getListInvoicesQueryKey(),
      getGetDashboardSummaryQueryKey(),
      getGetReceivablesSummaryQueryKey(),
      getGetPenaltyExposureQueryKey(),
      getGetMonthEndCloseQueryKey(),
    ]);
    expect(harness.execute.calls).toEqual([
      {
        data: {
          kind: "submit_overdue",
          clientPartyId: "cp-1",
          invoiceIds: ["inv-1", "inv-2"],
        },
      },
    ]);
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

    // The confirm dialog carries the consent-grade copy verbatim (the SME
    // audience clause), restating the default per-run cap of 10.
    await click(screen.getByTestId("button-automate-submit_overdue"));
    expect(
      screen.getByText(policyGrantDescription("submit_overdue", "sme", 10)),
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
      screen.queryByText(policyGrantDescription("submit_overdue", "sme", 10)),
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
      screen.getByText(policyGrantDescription("submit_overdue", "sme", 25)),
    ).toBeTruthy();

    // Out of the contract's 1..50: confirm disables, nothing is sent.
    fireEvent.change(screen.getByTestId("input-policy-cap"), {
      target: { value: "51" },
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
    expect(screen.getByTestId("clerk-actions")).toBeTruthy();
    // The quiet line explains the silence; an active grant raises no pill.
    expect(screen.getByTestId("text-actions-empty").textContent).toBe(
      "Nothing to suggest right now — automation and history below.",
    );
    expect(screen.queryByTestId("pill-automation-paused")).toBeNull();
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
          pausedReason: "consent_missing",
        }),
      ],
      enabled: true,
    };
    renderCard();
    expect(
      screen.getByTestId("text-policy-status-submit_overdue").textContent,
    ).toBe("paused — compliance consent is missing");
    expect(
      screen.queryByTestId("button-policy-pause-submit_overdue"),
    ).toBeNull();
    await click(screen.getByTestId("button-policy-resume-submit_overdue"));
    expect(harness.policyCalls.resume).toEqual([{ id: "pol-1" }]);
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
    // A live proposal is on the card (the beforeEach default), so the quiet
    // empty line stays out of the way.
    expect(screen.queryByTestId("text-actions-empty")).toBeNull();
    cleanup();

    harness.policies.data = { policies: [policy()], enabled: true };
    renderCard();
    expect(screen.queryByTestId("pill-automation-paused")).toBeNull();
  });

  // ---- Automation evidence (Prove with Clerk phase 2) ----------------------

  test("the grant dialog leads with the client's own record, above the consent copy", async () => {
    harness.policies.data = { policies: [], enabled: true };
    harness.evidence.data = evidence([
      // A non-grantable kind in the payload must not leak into the dialog —
      // only the granting kind's entry phrases the line.
      evidenceKind({ kind: "reconcile_matches", sample: 40, agreed: 38 }),
      evidenceKind(),
    ]);
    renderCard();
    await click(screen.getByTestId("button-automate-submit_overdue"));

    const line = screen.getByTestId("text-policy-evidence");
    expect(line.textContent).toBe(
      policyEvidenceLine("submit_overdue", {
        sample: 12,
        agreed: 9,
        medianLeadDays: 4,
      }),
    );
    // ABOVE the consent sentence, so the record is read before the grant.
    const description = screen.getByText(
      policyGrantDescription("submit_overdue", "sme", 10),
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

  // ---- The run record (round 29) -------------------------------------------

  test("run history keeps the card up and tags policy runs auto", () => {
    // A quiet day: no proposals, no live grants — but the owner's evidence
    // of what automation did must stay visible.
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
    expect(screen.getByTestId("clerk-actions")).toBeTruthy();
    expect(screen.getByText("Recent activity")).toBeTruthy();
    // History alone also earns the quiet explanation line.
    expect(screen.getByTestId("text-actions-empty")).toBeTruthy();
    expect(screen.getByTestId("decision-dec-1").textContent).toContain(
      "1 completed",
    );
    expect(screen.getByTestId("decision-dec-1").textContent).toContain(
      "· auto",
    );
    expect(screen.getByTestId("decision-dec-2").textContent).not.toContain(
      "· auto",
    );
  });
});
