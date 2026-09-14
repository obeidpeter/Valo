import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe,
  useGetActionProposals,
  getGetActionProposalsQueryKey,
  useExecuteAction,
  getGetActionDecisionsQueryKey,
  useGetActionDecisions,
  getGetActionPoliciesQueryKey,
  useGetActionPolicies,
  useGetClientAutomationEvidence,
  getGetClientAutomationEvidenceQueryKey,
  useGrantActionPolicy,
  usePauseActionPolicy,
  useResumeActionPolicy,
  useRevokeActionPolicy,
  getGetClientPortfolioQueryKey,
} from "@workspace/api-client-react";
import type {
  ActionProposal,
  ClerkActionDecision,
  ClerkActionPolicy,
  PaymentChaserDraft,
} from "@workspace/api-client-react";
import {
  beginOperation,
  operationSessionKey,
  updateOperation,
  ClerkActionsPanel,
  ClerkActionDialog,
  ClerkAutomationDialog,
  useActionPolicyControls,
  useClerkActionsDialog,
} from "@workspace/web-ui";
import { useToast } from "@/hooks/use-toast";
import { errorStatus, userErrorMessage } from "@/lib/errors";
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
  // The server gates every write on this card behind invoice.submit
  // (routes/clerk/actions.ts: execute for submit kinds, grant/pause/resume/
  // revoke all assertCan invoice.submit). Mirror that here so a read-only
  // viewer (auditor) sees the status, the paused pill and the run record —
  // but no buttons that could only ever 403.
  const { data: me } = useGetMe();
  const canAct = !!me?.capabilities.includes("invoice.submit");
  const operationKey = operationSessionKey(me);
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
  // Standing approvals (round 28): the client's live grants plus the
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
      description: userErrorMessage(e),
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
      const operation = beginOperation(operationKey, {
        title: `Run Clerk action: ${policyKindLabel(action.kind)}`,
        kind: "clerk",
        route: `/clients/${clientPartyId}?view=clerk`,
        detail: `${action.targets.length} target${action.targets.length === 1 ? "" : "s"}`,
      });
      try {
        const res = await execute.mutateAsync({
          data: {
            kind: action.kind,
            invoiceIds: action.targets.map((t) => t.invoiceId),
            clientPartyId,
          },
        });
        updateOperation(operationKey, operation?.id, {
          status: "succeeded",
          detail:
            "The approved Clerk action finished and its decision was recorded.",
          savedSummary:
            "A durable Clerk decision is available on the client record.",
        });
        return { decision: res.decision, drafts: res.drafts };
      } catch (error) {
        const outcomeUnknown = errorStatus(error) === undefined;
        updateOperation(operationKey, operation?.id, {
          status: outcomeUnknown ? "partial" : "failed",
          detail: outcomeUnknown
            ? "The connection ended before the Clerk decision was returned."
            : "The Clerk action failed before completion.",
          savedSummary: outcomeUnknown
            ? "Outcome unconfirmed. Reopen the client Clerk tab before retrying."
            : "No completed decision was returned.",
        });
        throw error;
      }
    },
    onExecuted: () => {
      queryClient.invalidateQueries({
        queryKey: getGetClientPortfolioQueryKey(clientPartyId),
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
        description: userErrorMessage(e),
        variant: "destructive",
      }),
  });
  const { confirming, decision, drafts, closeDialog } = dialog;

  // The dialog must survive the proposals list emptying after a full batch
  // (the SME card's F1 lesson): stay mounted while the dialog is up, defer
  // the proposals refetch to closeDialog. A live standing approval also
  // keeps the card up — it must stay manageable on a quiet day.
  const hasDecisions = (decisions?.decisions.length ?? 0) > 0;
  if (
    !isSuccess ||
    !proposals ||
    (proposals.actions.length === 0 &&
      !dialog.dialogOpen &&
      !hasDecisions &&
      livePolicies.length === 0)
  ) {
    return null;
  }

  return (
    <ClerkActionsPanel
      testId="card-clerk-actions"
      compact
      canAct={canAct}
      executePending={execute.isPending}
      policyBusy={policyBusy}
      pausedCount={pausedCount}
      pausedPillClassName={summaryPillClasses("amber")}
      emptyText={
        proposals.actions.length === 0
          ? "Nothing to batch right now — the checks behind the dashboards found no overdue invoices, failed submissions or payment follow-ups for this client."
          : null
      }
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
      historyTitle="Recent decisions"
      history={(decisions?.decisions ?? [])
        .slice(0, 5)
        .map((item) => ({ id: item.id, text: decisionLine(item) }))}
      note={proposals.note}
    >
      <ClerkActionDialog
        open={!!confirming}
        close={closeDialog}
        pending={execute.isPending}
        canAct={canAct}
        title={confirming?.title ?? ""}
        description={
          confirming
            ? actionConfirmDescription(
                confirming.kind,
                confirming.targets.length,
                "console",
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
          if (canAct && confirming) void dialog.runAction(confirming);
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
        draftInstructions="Drafted reminders — copy each for the client to send. This dialog will not show them again: copy them before closing."
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
                "console",
                policyCap ?? POLICY_CAP_DEFAULT,
              )
            : ""
        }
        cap={capInput}
        setCap={setCapInput}
        min={POLICY_CAP_MIN}
        max={POLICY_CAP_MAX}
        pending={grant.isPending}
        canAct={canAct}
        valid={policyCap !== null}
        confirm={() => {
          if (canAct) confirmGrant();
        }}
      />
    </ClerkActionsPanel>
  );
}
