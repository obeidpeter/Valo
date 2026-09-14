import { Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { ClerkDisabledBanner, ClerkPageHeader } from "@/components/clerk-shell";
import { usePageTitle } from "@/hooks/use-page-title";
import { useClerkClaims } from "./clerk-claims/use-clerk-claims";
import {
  DraftWithClerkPanel,
  NewClaimPanel,
} from "./clerk-claims/draft-panels";
import { ClaimsRegister } from "./clerk-claims/claims-register";
import { ClaimGapsCard } from "./clerk-claims/claim-gaps-card";
import {
  SeedOverwriteDialog,
  ClaimDecisionDialog,
  EditClaimDialog,
} from "./clerk-claims/claim-dialogs";

// Keep the route and existing helper imports stable. Child modules import
// helpers directly so the facade never becomes an internal dependency.
export {
  claimGapSummary,
  seededDraftState,
  shouldConfirmSeedOverwrite,
} from "./clerk-claims/helpers";

export function ClerkClaims() {
  usePageTitle("Claims register");
  const state = useClerkClaims();
  const {
    isLoading,
    error,
    refetch,
    setDraftOpen,
    setCreateOpen,
    disabledBanner,
    draftOpen,
    createOpen,
    gaps,
    draftFromGap,
  } = state;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error)
    return <QueryError thing="the claims register" onRetry={() => refetch()} />;

  return (
    <div className="space-y-6">
      <ClerkPageHeader
        eyebrow="Claims register"
        title="Approved facts"
        titleTestId="text-page-title"
        description="Every binding fact Clerk states comes from an active record here. Maker-checker: the author of a version can never approve it."
        right={
          <div className="flex gap-2 flex-wrap">
            <Button
              variant="secondary"
              onClick={() => setDraftOpen((o) => !o)}
              data-testid="button-toggle-draft-with-clerk"
            >
              <Sparkles className="w-4 h-4 mr-1" aria-hidden="true" /> Draft
              with Clerk
            </Button>
            <Button
              onClick={() => setCreateOpen((o) => !o)}
              data-testid="button-new-claim"
            >
              <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> New claim
              version
            </Button>
          </div>
        }
      />

      {disabledBanner && (
        <ClerkDisabledBanner>
          The register is read-only while it is off — re-enable it under Feature
          flags.
        </ClerkDisabledBanner>
      )}

      {draftOpen && <DraftWithClerkPanel state={state} />}
      {createOpen && <NewClaimPanel state={state} />}
      <ClaimsRegister state={state} />
      {gaps && <ClaimGapsCard gaps={gaps} draftFromGap={draftFromGap} />}
      <SeedOverwriteDialog state={state} />
      <ClaimDecisionDialog state={state} />
      <EditClaimDialog state={state} />
    </div>
  );
}
