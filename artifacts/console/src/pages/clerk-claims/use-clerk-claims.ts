import { useEffect, useMemo, useRef, useState } from "react";
import {
  useListClaims,
  useCreateClaim,
  useUpdateClaim,
  useSubmitClaim,
  useDecideClaim,
  useDraftClaimWithClerk,
  useGetClerkClaimGaps,
  getListClaimsQueryKey,
  getGetClerkClaimGapsQueryKey,
} from "@workspace/api-client-react";
import type { ClaimRecord } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { errorStatus, killSwitchTripped, userErrorMessage } from "@/lib/errors";
import { clerkDisabledToast, serverErrorToast } from "@/pages/clerk-shared";
import {
  DECISION_COPY,
  EMPTY_FORM,
  factsPayload,
  seededDraftState,
  shouldConfirmSeedOverwrite,
} from "./helpers";
import type { ClaimForm, DecisionAction } from "./types";

// Clerk v0 claims register admin. The register is the ONLY source the Clerk
// may answer from: every claim version walks draft -> review -> active under
// maker-checker (the author of a version can never approve it — the server
// answers 403 CLAIM_SELF_APPROVAL if they try). If the clerk_ai kill switch is
// off the server answers 503 CLERK_DISABLED and this page says so.

export function useClerkClaims() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [disabledBanner, setDisabledBanner] = useState(false);

  const { data: claims, isLoading, error, refetch } = useListClaims();

  // Register gaps (pure ledger SQL, no model call): the real client questions
  // Ask Clerk refused because no active claim covered them. Renders only on
  // success, like the other decision-support cards.
  const { data: gaps } = useGetClerkClaimGaps(undefined, {
    query: {
      queryKey: getGetClerkClaimGapsQueryKey(),
      staleTime: 5 * 60_000,
      retry: false,
    },
  });

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<ClaimForm>(EMPTY_FORM);
  // Draft-with-Clerk panel: Clerk structures pasted source text into a draft
  // claim. Errors and the success note render inline, in the panel itself.
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftSuccess, setDraftSuccess] = useState<ClaimRecord | null>(null);
  const [editing, setEditing] = useState<ClaimRecord | null>(null);
  const [editForm, setEditForm] = useState<ClaimForm>(EMPTY_FORM);
  const [decision, setDecision] = useState<{
    claim: ClaimRecord;
    action: DecisionAction;
  } | null>(null);
  const [decisionNote, setDecisionNote] = useState("");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListClaimsQueryKey() });

  // "Draft claim from this" on an uncovered gap row: prefill the existing
  // Draft-with-Clerk panel with the refused question verbatim. Nothing is
  // created here — the operator reviews the seeded text, clicks draft, and
  // the result is an ordinary draft under maker-checker. A dirty panel
  // (non-empty differing text) is never overwritten silently: the seed parks
  // in pendingSeed and the confirm dialog below asks first.
  const draftTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [pendingSeed, setPendingSeed] = useState<string | null>(null);
  // Focus lands in the seeded textarea AFTER the panel has committed (it may
  // only mount on this very update), so keyboard and screen-reader users
  // arrive at the text the click just planted instead of staying on a button
  // at the bottom of the page.
  const [seedFocusTick, setSeedFocusTick] = useState(0);
  useEffect(() => {
    if (seedFocusTick > 0) draftTextareaRef.current?.focus();
  }, [seedFocusTick]);

  const applySeed = (question: string) => {
    const seed = seededDraftState(question);
    setDraftOpen(seed.draftOpen);
    setDraftText(seed.draftText);
    setDraftError(seed.draftError);
    setDraftSuccess(seed.draftSuccess);
    // The panel renders above the register table; bring it into view.
    window.scrollTo({ top: 0, behavior: "smooth" });
    setSeedFocusTick((t) => t + 1);
  };

  const draftFromGap = (question: string) => {
    if (shouldConfirmSeedOverwrite(draftText, question)) {
      setPendingSeed(question);
      return;
    }
    applySeed(question);
  };

  // 503 = the clerk_ai kill switch is off (CLERK_DISABLED); 403 = maker-checker
  // refused the decision (CLAIM_SELF_APPROVAL) — relay the server's own words.
  const handleServerError = (err: unknown, fallback: string) => {
    if (killSwitchTripped(err)) {
      setDisabledBanner(true);
      clerkDisabledToast(
        toast,
        "The clerk_ai kill switch is disabled, so the claims register is not accepting changes.",
      );
      return;
    }
    if (errorStatus(err) === 403) {
      toast({
        title: "Maker-checker blocked this",
        description:
          userErrorMessage(err) ??
          "The author of a claim version cannot approve it. A second operator must review and approve.",
        variant: "destructive",
      });
      return;
    }
    serverErrorToast(toast, err, fallback);
  };

  const createClaim = useCreateClaim({
    mutation: {
      onSuccess: (claim) => {
        invalidate();
        setDisabledBanner(false);
        setCreateOpen(false);
        setCreateForm(EMPTY_FORM);
        setExpandedId(claim.id);
        toast({
          title: `Draft ${claim.claimKey} v${claim.version} created`,
          description: "Submit it for review when it is ready.",
        });
      },
      onError: (e) => handleServerError(e, "Could not create the draft."),
    },
  });
  // The drafted record is a plain draft — maker-checker is untouched: it
  // still needs submit + a second operator's approval like any other version.
  // 502 CLERK_DRAFT_FAILED / 503 CLERK_DISABLED render inline in the panel.
  const draftClaim = useDraftClaimWithClerk({
    mutation: {
      onSuccess: (claim) => {
        invalidate();
        setDisabledBanner(false);
        setDraftText("");
        setDraftError(null);
        setDraftSuccess(claim);
        setExpandedId(claim.id);
        toast({
          title: `Draft ${claim.claimKey} v${claim.version} created`,
          description:
            "Clerk drafted it from your source text — review, edit and submit it like any draft.",
        });
      },
      onError: (e) => {
        setDraftSuccess(null);
        if (killSwitchTripped(e)) setDisabledBanner(true);
        setDraftError(
          userErrorMessage(e) ??
            (killSwitchTripped(e)
              ? "Clerk is switched off (clerk_ai kill switch), so it cannot draft claims right now."
              : "Clerk could not draft a claim from this text. Trim it to the relevant passage and try again."),
        );
      },
    },
  });
  const updateClaim = useUpdateClaim({
    mutation: {
      onSuccess: () => {
        invalidate();
        setDisabledBanner(false);
        setEditing(null);
        toast({ title: "Draft updated" });
      },
      onError: (e) => handleServerError(e, "Could not update the draft."),
    },
  });
  const submitClaim = useSubmitClaim({
    mutation: {
      onSuccess: (claim) => {
        invalidate();
        setDisabledBanner(false);
        toast({
          title: `${claim.claimKey} v${claim.version} submitted for review`,
          description:
            "A second operator must approve it before the Clerk can quote it.",
        });
      },
      onError: (e) => handleServerError(e, "Could not submit the draft."),
    },
  });
  const decideClaim = useDecideClaim({
    mutation: {
      onSuccess: (claim) => {
        invalidate();
        setDisabledBanner(false);
        setDecision(null);
        setDecisionNote("");
        toast({
          title:
            claim.state === "active"
              ? `${claim.claimKey} v${claim.version} is now active`
              : `${claim.claimKey} v${claim.version} ${claim.state}`,
          description:
            claim.state === "active"
              ? "The Clerk may quote this version from now on."
              : claim.state === "suspended"
                ? "The Clerk can no longer quote this version."
                : undefined,
        });
      },
      onError: (e) => handleServerError(e, "Could not record the decision."),
    },
  });

  // Grouped by claimKey, newest version first within each key.
  const sorted = useMemo(
    () =>
      [...(claims ?? [])].sort(
        (a, b) => a.claimKey.localeCompare(b.claimKey) || b.version - a.version,
      ),
    [claims],
  );

  const saveCreate = () => {
    createClaim.mutate({
      data: {
        claimKey: createForm.claimKey.trim(),
        title: createForm.title.trim(),
        proposition: createForm.proposition.trim(),
        citation: createForm.citation.trim(),
        effectiveFrom: createForm.effectiveFrom,
        effectiveTo: createForm.effectiveTo || null,
        reviewDueAt: createForm.reviewDueAt || null,
        applicability:
          createForm.category === "none"
            ? {}
            : { category: createForm.category },
        protectedFacts: factsPayload(createForm.facts),
      },
    });
  };

  const saveEdit = () => {
    if (!editing) return;
    updateClaim.mutate({
      id: editing.id,
      data: {
        title: editForm.title.trim(),
        proposition: editForm.proposition.trim(),
        citation: editForm.citation.trim(),
        effectiveFrom: editForm.effectiveFrom,
        effectiveTo: editForm.effectiveTo || null,
        reviewDueAt: editForm.reviewDueAt || null,
        applicability:
          editForm.category === "none" ? {} : { category: editForm.category },
        protectedFacts: factsPayload(editForm.facts),
      },
    });
  };

  // Per-row pending: only the row whose mutation is in flight shows busy.
  const rowBusy = (claim: ClaimRecord) =>
    (submitClaim.isPending && submitClaim.variables?.id === claim.id) ||
    (decideClaim.isPending && decideClaim.variables?.id === claim.id);

  // Review-due dates are YYYY-MM-DD, so plain string comparison works. An
  // ACTIVE claim past its review date stays visible in the register, but the
  // Clerk refuses to answer from it until it is re-confirmed — flag it loudly.
  const today = new Date().toISOString().slice(0, 10);

  const decisionCopy = decision ? DECISION_COPY[decision.action] : null;
  const confirmDisabled =
    decideClaim.isPending ||
    (decisionCopy?.noteRequired === true && !decisionNote.trim());

  return {
    disabledBanner,
    isLoading,
    error,
    refetch,
    gaps,
    expandedId,
    setExpandedId,
    createOpen,
    setCreateOpen,
    createForm,
    setCreateForm,
    draftOpen,
    setDraftOpen,
    draftText,
    setDraftText,
    draftError,
    draftSuccess,
    editing,
    setEditing,
    editForm,
    setEditForm,
    decision,
    setDecision,
    decisionNote,
    setDecisionNote,
    draftTextareaRef,
    pendingSeed,
    setPendingSeed,
    applySeed,
    draftFromGap,
    createClaim,
    draftClaim,
    updateClaim,
    submitClaim,
    decideClaim,
    sorted,
    saveCreate,
    saveEdit,
    rowBusy,
    today,
    decisionCopy,
    confirmDisabled,
  };
}

export type ClerkClaimsState = ReturnType<typeof useClerkClaims>;
