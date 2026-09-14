import { useQueryClient } from "@tanstack/react-query";
import {
  useGetActionProposals,
  getGetActionProposalsQueryKey,
  useExecuteAction,
  useGetActionDecisions,
  getGetActionDecisionsQueryKey,
  useGetActionPolicies,
  getGetActionPoliciesQueryKey,
  useGetClientAutomationEvidence,
  getGetClientAutomationEvidenceQueryKey,
  useGrantActionPolicy,
  usePauseActionPolicy,
  useResumeActionPolicy,
  useRevokeActionPolicy,
  getListInvoicesQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetReceivablesSummaryQueryKey,
  getGetPenaltyExposureQueryKey,
  getGetMonthEndCloseQueryKey,
} from "@workspace/api-client-react";
import type {
  ActionProposal,
  ClerkActionDecision,
  ClerkActionPolicy,
  PaymentChaserDraft,
} from "@workspace/api-client-react";
import {
  ClerkActionsPanel,
  ClerkActionDialog,
  ClerkAutomationDialog,
  useActionPolicyControls,
  useClerkActionsDialog,
} from "@workspace/web-ui";
import { useToast } from "@/hooks/use-toast";
import { serverErrorMessage } from "@/lib/errors";
import {
  ACTION_OUTCOME_LABELS,
  ACTION_TARGET_DISPLAY_CAP,
  POLICY_CAP_DEFAULT,
  POLICY_CAP_MAX,
  POLICY_CAP_MIN,
  actionConfirmButtonLabel,
  actionConfirmDescription,
  actionOutcomeSummary,
  actionOutcomeToneClasses,
  actionTargetOverflowNote,
  actionTruncatedNote,
  automatableActionKind,
  type AutomatableActionKind,
  decisionLine,
  draftClipboardText,
  formatAmount,
  formatDate,
  parsePolicyCap,
  policyEvidenceLine,
  policyGrantDescription,
  policyKindLabel,
  policyStatusLine,
  summaryPillClasses,
} from "@/lib/format";

// App adapter: queries, permissions, recovery and invalidations stay local.
// Shared sections render the existing action copy and headless dialog state.
export function ClerkActionsCard({ clientPartyId }: { clientPartyId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const execute = useExecuteAction();
  const { data: proposals, isSuccess } = useGetActionProposals(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetActionProposalsQueryKey({ clientPartyId }),
        staleTime: 60_000,
        retry: false,
      },
    },
  );
  // The run record (round 29): who approved what — including the sweep's
  // policy runs — with per-target outcomes. The console card has carried
  // this strip since round 22; the SME owner who GRANTS an automation gets
  // the same evidence where they granted it.
  const { data: decisions } = useGetActionDecisions(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetActionDecisionsQueryKey({ clientPartyId }),
        staleTime: 60_000,
        retry: false,
      },
    },
  );
  // Standing approvals (round 28): the owner's live grants plus the
  // clerk_action_policies flag — `enabled` gates the "automate" affordance,
  // while existing grants stay visible (and revocable) regardless.
  const { data: policies } = useGetActionPolicies(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetActionPoliciesQueryKey({ clientPartyId }),
        staleTime: 60_000,
        retry: false,
      },
    },
  );
  // Automation evidence (Prove with Clerk phase 2): the client's OWN
  // backtest, fetched at the card level so the grant dialog opens with it.
  // Render-on-success and advisory only — no evidence (empty sample, failed
  // fetch, older server) means no line, and the line never gates granting.
  const { data: evidence } = useGetClientAutomationEvidence(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetClientAutomationEvidenceQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  const onPolicyChanged = () =>
    queryClient.invalidateQueries({
      queryKey: getGetActionPoliciesQueryKey(),
    });
  const policyError = (e: unknown) =>
    toast({
      title: "Automation change failed",
      description: serverErrorMessage(e),
      variant: "destructive",
    });
  const grant = useGrantActionPolicy({
    mutation: { onSuccess: onPolicyChanged, onError: policyError },
  });
  const pause = usePauseActionPolicy({
    mutation: { onSuccess: onPolicyChanged, onError: policyError },
  });
  const resume = useResumeActionPolicy({
    mutation: { onSuccess: onPolicyChanged, onError: policyError },
  });
  const revoke = useRevokeActionPolicy({
    mutation: { onSuccess: onPolicyChanged, onError: policyError },
  });
  const {
    automating,
    capInput,
    setCapInput,
    policyCap,
    beginAutomate,
    closeAutomate,
    confirmGrant,
    policyBusy,
    livePolicies,
    policyByKind,
    pausedCount,
  } = useActionPolicyControls<
    ActionProposal,
    ClerkActionPolicy,
    AutomatableActionKind
  >({
    clientPartyId,
    policies,
    grant,
    pause,
    resume,
    revoke,
    automatableKind: automatableActionKind,
    parseCap: parsePolicyCap,
    defaultCap: POLICY_CAP_DEFAULT,
  });
  // "Your own record" for the kind being granted: shown ABOVE the consent
  // sentence so the decision is evidence-backed. Null (no backtest entry or
  // an empty sample) renders nothing — no placeholder, no gating.
  const automatingKind = automating
    ? automatableActionKind(automating.kind)
    : null;
  const automatingEvidenceLine = automatingKind
    ? policyEvidenceLine(
        automatingKind,
        evidence?.kinds.find((k) => k.kind === automatingKind),
      )
    : null;
  const dialog = useClerkActionsDialog<
    ActionProposal,
    ClerkActionDecision,
    PaymentChaserDraft
  >({
    mutation: execute,
    run: async (action) => {
      const res = await execute.mutateAsync({
        data: {
          kind: action.kind,
          invoiceIds: action.targets.map((t) => t.invoiceId),
          clientPartyId,
        },
      });
      return { decision: res.decision, drafts: res.drafts };
    },
    onExecuted: () => {
      // Not awaited: a background refetch rejection must not surface as a
      // false "action failed" error after the batch already ran. The
      // no-args keys prefix-match every param variant. The proposals and
      // decisions queries are deliberately NOT here — see the hook's
      // onCloseAfterDecision (the F1 rule).
      queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
      queryClient.invalidateQueries({
        queryKey: getGetDashboardSummaryQueryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: getGetReceivablesSummaryQueryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: getGetPenaltyExposureQueryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: getGetMonthEndCloseQueryKey(),
      });
    },
    onCloseAfterDecision: () => {
      queryClient.invalidateQueries({
        queryKey: getGetActionProposalsQueryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: getGetActionDecisionsQueryKey(),
      });
    },
    onError: (e) =>
      toast({
        title: "Action failed",
        description: serverErrorMessage(e),
        variant: "destructive",
      }),
  });
  const { confirming, decision, drafts, closeDialog } = dialog;
  // The card must survive the proposals list emptying: after a full batch
  // submits, the refetched list is [] and an early return would unmount the
  // OPEN results view mid-read (review F1) — so the card stays mounted while
  // the dialog is up. A live standing approval also keeps the card up — it
  // must stay manageable on a quiet day — and so does run history (round
  // 29): the owner's evidence of what automation did must not vanish just
  // because today's batch already ran.
  const hasDecisions = (decisions?.decisions.length ?? 0) > 0;
  if (
    !isSuccess ||
    !proposals ||
    (proposals.actions.length === 0 &&
      !dialog.dialogOpen &&
      livePolicies.length === 0 &&
      !hasDecisions)
  ) {
    return null;
  }

  return (
    <ClerkActionsPanel
      testId="clerk-actions"
      canAct={true}
      executePending={execute.isPending}
      policyBusy={policyBusy}
      pausedCount={pausedCount}
      pausedPillClassName={summaryPillClasses("amber")}
      emptyText={
        proposals.actions.length === 0 &&
        (livePolicies.length > 0 || hasDecisions)
          ? "Nothing to suggest right now — automation and history below."
          : null
      }
      emptyTestId="text-actions-empty"
      actions={proposals.actions.map((action) => ({
        kind: action.kind,
        title: action.title,
        why: action.why,
        targets: action.targets
          .slice(0, ACTION_TARGET_DISPLAY_CAP)
          .map((target) => ({
            id: target.invoiceId,
            text:
              `${target.invoiceNumber} · issued ${formatDate(target.issueDate)}` +
              (action.kind === "submit_overdue"
                ? ` · ${target.daysOverdue} day${target.daysOverdue === 1 ? "" : "s"} past the window`
                : "") +
              (target.grandTotal
                ? ` · ${formatAmount(target.grandTotal, target.currency)}`
                : "") +
              (target.note ? ` · ${target.note}` : ""),
          })),
        notes: [
          ...(action.targets.length > ACTION_TARGET_DISPLAY_CAP
            ? [actionTargetOverflowNote(action.targets.length)]
            : []),
          ...(action.truncated
            ? [actionTruncatedNote(action.targets.length, action.targetCount)]
            : []),
        ],
        approve: () => dialog.beginConfirm(action),
        automate:
          policies?.enabled &&
          automatableActionKind(action.kind) &&
          !policyByKind.has(action.kind)
            ? () => beginAutomate(action)
            : undefined,
      }))}
      policies={livePolicies.map((policy) => ({
        id: policy.id,
        kind: policy.kind,
        title: policyKindLabel(policy.kind),
        status: policyStatusLine(policy),
        paused: !!policy.pausedAt,
        toggle: () =>
          policy.pausedAt
            ? resume.mutate({ id: policy.id })
            : pause.mutate({ id: policy.id }),
        revoke: () => revoke.mutate({ id: policy.id }),
      }))}
      historyTitle="Recent activity"
      history={(decisions?.decisions ?? [])
        .slice(0, 5)
        .map((item) => ({ id: item.id, text: decisionLine(item) }))}
      note={proposals.note}
    >
      <ClerkActionDialog
        open={!!confirming}
        close={closeDialog}
        pending={execute.isPending}
        canAct={true}
        title={confirming?.title ?? ""}
        description={
          confirming
            ? actionConfirmDescription(
                confirming.kind,
                confirming.targets.length,
                "sme",
              )
            : ""
        }
        confirmLabel={
          confirming
            ? actionConfirmButtonLabel(
                confirming.kind,
                confirming.targets.length,
              )
            : ""
        }
        confirm={() => {
          if (confirming) void dialog.runAction(confirming);
        }}
        result={
          decision === null
            ? null
            : {
                summary: actionOutcomeSummary(decision),
                outcomes: decision.targets.map((target) => ({
                  id: target.invoiceId,
                  invoiceNumber: target.invoiceNumber,
                  label:
                    (ACTION_OUTCOME_LABELS[target.outcome] ?? target.outcome) +
                    (target.error ? ` — ${target.error}` : ""),
                  className: actionOutcomeToneClasses(target.outcome),
                })),
              }
        }
        drafts={(drafts ?? []).map((draft) => ({
          id: draft.invoiceId,
          subject: draft.subject,
          detail: `${draft.invoiceNumber} · to ${draft.buyerName} · reminder #${draft.stage}`,
          body: draft.body,
          copy: () => {
            void navigator.clipboard.writeText(draftClipboardText(draft));
          },
        }))}
        draftInstructions="Your drafted reminders — copy each into your own email. This dialog will not show them again: copy them before closing."
      />
      <ClerkAutomationDialog
        open={!!automating}
        close={closeAutomate}
        title={automating ? policyKindLabel(automating.kind) : ""}
        evidence={automatingEvidenceLine}
        description={
          automating
            ? policyGrantDescription(
                automating.kind,
                "sme",
                policyCap ?? POLICY_CAP_DEFAULT,
              )
            : ""
        }
        cap={capInput}
        setCap={setCapInput}
        min={POLICY_CAP_MIN}
        max={POLICY_CAP_MAX}
        pending={grant.isPending}
        canAct={true}
        valid={policyCap !== null}
        confirm={confirmGrant}
      />
    </ClerkActionsPanel>
  );
}
