import { Fragment } from "react";
import {
  BookOpenCheck,
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  Send,
  Sparkles,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { ScrollRegion } from "@/components/scroll-region";
import { formatDate, pillClasses } from "@/lib/format";
import { ClaimDetail } from "./claim-detail";
import { formFromClaim, STATE_TONE } from "./helpers";
import type { ClerkClaimsState } from "./use-clerk-claims";

export function ClaimsRegister({
  state,
}: {
  state: Pick<
    ClerkClaimsState,
    | "sorted"
    | "setCreateOpen"
    | "setDraftOpen"
    | "expandedId"
    | "rowBusy"
    | "setExpandedId"
    | "today"
    | "setEditing"
    | "setEditForm"
    | "submitClaim"
    | "setDecision"
    | "setDecisionNote"
    | "decideClaim"
  >;
}) {
  const {
    sorted,
    setCreateOpen,
    setDraftOpen,
    expandedId,
    rowBusy,
    setExpandedId,
    today,
    setEditing,
    setEditForm,
    submitClaim,
    setDecision,
    setDecisionNote,
    decideClaim,
  } = state;
  return (
    <Card>
      <CardContent className="pt-6">
        {sorted.length === 0 ? (
          // First-run empty state: both drafting paths, right here. Either
          // way the result is a plain draft — maker-checker still needs a
          // second operator before Clerk can quote anything.
          <EmptyState
            icon={BookOpenCheck}
            title="No claims in the register yet"
            description="Clerk only ever answers from approved claims. Draft the first one — by hand, or let Clerk structure a statutory passage into a draft for you."
            className="py-8"
          >
            <div className="flex flex-wrap justify-center gap-2 mt-1">
              <Button
                size="sm"
                onClick={() => setCreateOpen(true)}
                data-testid="button-empty-new-claim"
              >
                <Plus className="w-4 h-4 mr-1" aria-hidden="true" />
                New claim version
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDraftOpen(true)}
                data-testid="button-empty-draft-with-clerk"
              >
                <Sparkles className="w-4 h-4 mr-1" aria-hidden="true" />
                Draft with Clerk
              </Button>
            </div>
          </EmptyState>
        ) : (
          <ScrollRegion label="Claims register table">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Claim</th>
                  <th className="py-2 pr-3 font-medium">Title</th>
                  <th className="py-2 pr-3 font-medium">State</th>
                  <th className="py-2 pr-3 font-medium">Citation</th>
                  <th className="py-2 pr-3 font-medium">Effective</th>
                  <th className="py-2 pr-3 font-medium">Review due</th>
                  <th className="py-2 pr-3 font-medium text-right">Facts</th>
                  <th className="py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {sorted.map((claim) => {
                  const expanded = expandedId === claim.id;
                  const busy = rowBusy(claim);
                  const Chevron = expanded ? ChevronDown : ChevronRight;
                  return (
                    <Fragment key={claim.id}>
                      <tr
                        className="hover:bg-muted/40"
                        data-testid={`row-claim-${claim.claimKey}-v${claim.version}`}
                      >
                        <td className="py-2.5 pr-3 align-top">
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedId(expanded ? null : claim.id)
                            }
                            className="flex items-center gap-1.5 text-left"
                            aria-expanded={expanded}
                            data-testid={`button-expand-${claim.id}`}
                          >
                            <Chevron
                              className="w-4 h-4 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                            <code className="text-xs">{claim.claimKey}</code>
                            <span className="text-xs text-muted-foreground">
                              v{claim.version}
                            </span>
                          </button>
                        </td>
                        <td className="py-2.5 pr-3 align-top max-w-56">
                          <span className="block truncate">{claim.title}</span>
                        </td>
                        <td className="py-2.5 pr-3 align-top">
                          <span
                            className={pillClasses(
                              STATE_TONE[claim.state] ?? "slate",
                            )}
                          >
                            {claim.state}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 align-top max-w-40">
                          <span className="block truncate text-muted-foreground">
                            {claim.citation}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 align-top whitespace-nowrap text-muted-foreground">
                          {formatDate(claim.effectiveFrom)} →{" "}
                          {claim.effectiveTo
                            ? formatDate(claim.effectiveTo)
                            : "open"}
                        </td>
                        <td className="py-2.5 pr-3 align-top whitespace-nowrap">
                          {!claim.reviewDueAt ? (
                            <span className="text-muted-foreground">—</span>
                          ) : claim.state === "active" &&
                            claim.reviewDueAt.slice(0, 10) < today ? (
                            <span
                              className={pillClasses("red")}
                              data-testid={`badge-review-overdue-${claim.id}`}
                            >
                              {formatDate(claim.reviewDueAt)} · overdue
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              {formatDate(claim.reviewDueAt)}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 pr-3 align-top text-right tabular-nums">
                          {claim.protectedFacts.length}
                        </td>
                        <td className="py-2 align-top">
                          <div className="flex justify-end gap-1.5 flex-wrap">
                            {claim.state === "draft" && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setEditing(claim);
                                    setEditForm(formFromClaim(claim));
                                  }}
                                  disabled={busy}
                                  data-testid={`button-edit-${claim.id}`}
                                >
                                  <Pencil
                                    className="w-3.5 h-3.5 mr-1"
                                    aria-hidden="true"
                                  />
                                  Edit
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() =>
                                    submitClaim.mutate({ id: claim.id })
                                  }
                                  disabled={busy}
                                  data-testid={`button-submit-${claim.id}`}
                                >
                                  <Send
                                    className="w-3.5 h-3.5 mr-1"
                                    aria-hidden="true"
                                  />
                                  {busy ? "Submitting…" : "Submit for review"}
                                </Button>
                              </>
                            )}
                            {claim.state === "review" && (
                              <>
                                <Button
                                  size="sm"
                                  onClick={() => {
                                    setDecision({ claim, action: "approve" });
                                    setDecisionNote("");
                                  }}
                                  disabled={busy}
                                  data-testid={`button-approve-${claim.id}`}
                                >
                                  Approve
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  onClick={() => {
                                    setDecision({ claim, action: "reject" });
                                    setDecisionNote("");
                                  }}
                                  disabled={busy}
                                  data-testid={`button-reject-${claim.id}`}
                                >
                                  Reject
                                </Button>
                              </>
                            )}
                            {claim.state === "active" && (
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={() => {
                                  setDecision({ claim, action: "suspend" });
                                  setDecisionNote("");
                                }}
                                disabled={busy}
                                data-testid={`button-suspend-${claim.id}`}
                              >
                                Suspend
                              </Button>
                            )}
                            {claim.state === "suspended" && (
                              <Button
                                size="sm"
                                onClick={() =>
                                  decideClaim.mutate({
                                    id: claim.id,
                                    data: { action: "resume", note: null },
                                  })
                                }
                                disabled={busy}
                                data-testid={`button-resume-${claim.id}`}
                              >
                                {busy ? "Resuming…" : "Resume"}
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="bg-muted/30">
                          <td colSpan={8} className="px-4 py-3">
                            <ClaimDetail claim={claim} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </ScrollRegion>
        )}
      </CardContent>
    </Card>
  );
}
