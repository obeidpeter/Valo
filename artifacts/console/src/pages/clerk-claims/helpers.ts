import type {
  ClaimGapReport,
  ClaimRecord,
  ProtectedFact,
  ProtectedFactKind,
} from "@workspace/api-client-react";
import type { BadgeTone } from "@/lib/format";
import type { ClaimForm, DecisionAction } from "./types";

export const STATE_TONE: Record<string, BadgeTone> = {
  draft: "slate",
  review: "amber",
  active: "emerald",
  suspended: "red",
  superseded: "slate",
  expired: "slate",
  rejected: "slate",
};

export const FACT_KINDS: ProtectedFactKind[] = [
  "rate",
  "amount",
  "duration",
  "date",
  "count",
  "text",
];

export { CATEGORIES } from "./types";

export const EMPTY_FORM: ClaimForm = {
  claimKey: "",
  title: "",
  proposition: "",
  citation: "",
  effectiveFrom: new Date().toISOString().slice(0, 10),
  effectiveTo: "",
  reviewDueAt: "",
  category: "none",
  facts: [{ key: "", label: "", kind: "rate", value: "", unit: "" }],
};

export function formFromClaim(claim: ClaimRecord): ClaimForm {
  const category = claim.applicability?.category;
  return {
    claimKey: claim.claimKey,
    title: claim.title,
    proposition: claim.proposition,
    citation: claim.citation,
    effectiveFrom: claim.effectiveFrom.slice(0, 10),
    effectiveTo: claim.effectiveTo ? claim.effectiveTo.slice(0, 10) : "",
    reviewDueAt: claim.reviewDueAt ? claim.reviewDueAt.slice(0, 10) : "",
    category:
      category === "b2b" || category === "b2g" || category === "b2c"
        ? category
        : "none",
    facts:
      claim.protectedFacts.length > 0
        ? claim.protectedFacts.map((f) => ({ ...f, unit: f.unit ?? "" }))
        : [{ key: "", label: "", kind: "rate", value: "", unit: "" }],
  };
}

export function formInvalid(form: ClaimForm): boolean {
  return (
    form.claimKey.trim().length < 3 ||
    form.title.trim().length < 3 ||
    form.proposition.trim().length < 10 ||
    form.citation.trim().length < 3 ||
    !form.effectiveFrom ||
    form.facts.length === 0 ||
    form.facts.some((f) => !f.key.trim() || !f.label.trim() || !f.value.trim())
  );
}

export function factsPayload(facts: ProtectedFact[]): ProtectedFact[] {
  return facts.map((f) => ({
    key: f.key.trim(),
    label: f.label.trim(),
    kind: f.kind,
    value: f.value.trim(),
    unit: f.unit?.trim() ? f.unit.trim() : undefined,
  }));
}

// Gap-to-claim wiring: an uncovered question seeds the "Draft with Clerk"
// panel — the question text VERBATIM as the source text (never rephrased or
// prefixed; the operator adds the statutory context), panel open, any stale
// error/success from an earlier drafting attempt cleared. Only a seed:
// drafting still takes the operator's click, and the drafted record still
// walks the full maker-checker flow.
export function seededDraftState(question: string): {
  draftOpen: true;
  draftText: string;
  draftError: null;
  draftSuccess: null;
} {
  return {
    draftOpen: true,
    draftText: question,
    draftError: null,
    draftSuccess: null,
  };
}

// Seeding must never clobber work in progress: if the panel already holds
// non-empty text that DIFFERS from the incoming question, replacing it needs
// the operator's explicit OK first. An empty or whitespace-only panel seeds
// silently, and re-seeding the same question (modulo surrounding whitespace)
// is a no-op worth no interruption.
export function shouldConfirmSeedOverwrite(
  currentText: string,
  question: string,
): boolean {
  const current = currentText.trim();
  return current.length > 0 && current !== question.trim();
}

// The claim-gaps headline, phrased as one sentence so the card reads the same
// whether the register covered everything or left questions unanswered.
export function claimGapSummary(report: ClaimGapReport): string {
  if (report.refusedTotal === 0) {
    return `No refused questions in the last ${report.windowDays} days — the register covered everything Ask Clerk was asked.`;
  }
  return `${report.refusedTotal} of ${report.totalQuestions} question(s) refused in the last ${report.windowDays} days.`;
}

export const DECISION_COPY: Record<
  DecisionAction,
  { title: string; help: string; confirm: string; noteRequired: boolean }
> = {
  approve: {
    title: "Approve",
    help: "Approving activates this version and supersedes any currently active version of the same claim. The author of a version can never approve it — the server enforces this.",
    confirm: "Approve",
    noteRequired: false,
  },
  reject: {
    title: "Reject",
    help: "Rejecting sends this version back to its author. A note explaining why is required.",
    confirm: "Reject",
    noteRequired: true,
  },
  suspend: {
    title: "Suspend",
    help: "Suspending immediately stops the Clerk from quoting this claim. A note explaining why is required.",
    confirm: "Suspend",
    noteRequired: true,
  },
};
