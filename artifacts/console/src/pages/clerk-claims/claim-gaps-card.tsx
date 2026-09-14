import type { ClaimGapReport } from "@workspace/api-client-react";
import { Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDate, pillClasses } from "@/lib/format";
import { claimGapSummary } from "./helpers";

export function ClaimGapsCard({
  gaps,
  draftFromGap,
}: {
  gaps: ClaimGapReport;
  draftFromGap: (question: string) => void;
}) {
  return (
    <Card data-testid="card-claim-gaps">
      <CardHeader>
        <CardTitle className="text-base">
          Register gaps — refused questions
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Real client questions Ask Clerk refused because no active claim
          covered them. Each one is a candidate for the next draft — “Draft
          claim from this” seeds the Draft-with-Clerk panel with the question,
          or use “New claim version” above; nothing is created automatically.
        </p>
        {gaps.refusedTotal === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-claim-gaps-empty"
          >
            {claimGapSummary(gaps)}
          </p>
        ) : (
          <>
            <p className="text-sm" data-testid="text-claim-gaps-summary">
              {claimGapSummary(gaps)}
            </p>
            <div
              className="flex flex-wrap gap-2"
              data-testid="claim-gaps-reasons"
            >
              {gaps.byReason.map((r) => (
                <span
                  key={r.code}
                  className={pillClasses("amber")}
                  data-testid={`pill-gap-reason-${r.code}`}
                >
                  {r.code.replace(/_/g, " ")}
                  <span className="tabular-nums font-semibold">{r.count}</span>
                </span>
              ))}
            </div>
            {gaps.uncovered.length > 0 && (
              <div
                className="border rounded-md divide-y"
                data-testid="claim-gaps-uncovered"
              >
                {gaps.uncovered.map((q, i) => (
                  <div
                    key={i}
                    className="flex items-start justify-between gap-3 px-3 py-2 text-sm"
                    data-testid={`row-gap-question-${i}`}
                  >
                    <div className="min-w-0">
                      <p>“{q.question}”</p>
                      <p className="text-xs text-muted-foreground">
                        {q.firmName ? `${q.firmName} · ` : ""}
                        {formatDate(q.createdAt)}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => draftFromGap(q.question)}
                      data-testid={`button-draft-from-gap-${i}`}
                    >
                      <Sparkles
                        className="w-3.5 h-3.5 mr-1"
                        aria-hidden="true"
                      />
                      Draft claim from this
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
