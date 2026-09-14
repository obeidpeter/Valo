import type { ClaimRecord } from "@workspace/api-client-react";

export function ClaimDetail({ claim }: { claim: ClaimRecord }) {
  return (
    <div className="space-y-3 text-sm" data-testid={`detail-claim-${claim.id}`}>
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase mb-1">
          Proposition (rendered verbatim to users)
        </p>
        <p className="border rounded-md p-3 bg-card">{claim.proposition}</p>
      </div>
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase mb-1">
          Protected facts
        </p>
        <div className="border rounded-md divide-y bg-card">
          {claim.protectedFacts.map((f) => (
            <div key={f.key} className="flex items-center gap-2 px-3 py-2">
              <code className="text-xs w-32 shrink-0">{f.key}</code>
              <span className="flex-1">{f.label}</span>
              <code className="text-xs text-muted-foreground">{f.kind}</code>
              <span className="font-medium tabular-nums">
                {f.value}
                {f.unit ? ` ${f.unit}` : ""}
              </span>
            </div>
          ))}
          {claim.protectedFacts.length === 0 && (
            <p className="px-3 py-2 text-muted-foreground">
              No protected facts on this version.
            </p>
          )}
        </div>
      </div>
      {claim.decisionNote && (
        <p className="text-xs text-muted-foreground">
          Decision note: {claim.decisionNote}
        </p>
      )}
    </div>
  );
}
