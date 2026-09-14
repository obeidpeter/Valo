import { Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ClaimFormFields } from "./claim-form-fields";
import { formInvalid } from "./helpers";
import type { ClerkClaimsState } from "./use-clerk-claims";

export function DraftWithClerkPanel({
  state,
}: {
  state: Pick<
    ClerkClaimsState,
    | "draftTextareaRef"
    | "draftText"
    | "setDraftText"
    | "draftClaim"
    | "draftError"
    | "draftSuccess"
  >;
}) {
  const {
    draftTextareaRef,
    draftText,
    setDraftText,
    draftClaim,
    draftError,
    draftSuccess,
  } = state;
  return (
    <Card data-testid="card-draft-with-clerk">
      <CardHeader>
        <CardTitle className="text-base">Draft with Clerk</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Clerk structures the text into a draft claim — key, proposition,
          protected facts, citation. It enters the normal maker-checker flow:
          nothing goes live until a second operator approves it.
        </p>
        <Textarea
          ref={draftTextareaRef}
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          placeholder="Paste the statutory text, circular or guidance…"
          rows={6}
          maxLength={20000}
          data-testid="input-draft-source"
        />
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-muted-foreground">
            {draftText.trim().length < 40
              ? "Paste at least 40 characters of source text."
              : `${draftText.trim().length.toLocaleString()} characters`}
          </p>
          <Button
            onClick={() =>
              draftClaim.mutate({ data: { sourceText: draftText.trim() } })
            }
            disabled={draftText.trim().length < 40 || draftClaim.isPending}
            data-testid="draft-with-clerk"
          >
            <Sparkles className="w-4 h-4 mr-1" aria-hidden="true" />
            {draftClaim.isPending ? "Drafting…" : "Draft with Clerk"}
          </Button>
        </div>
        {draftError && (
          <Alert variant="destructive" data-testid="draft-with-clerk-error">
            <AlertTitle>Could not draft the claim</AlertTitle>
            <AlertDescription>{draftError}</AlertDescription>
          </Alert>
        )}
        {draftSuccess && (
          <p
            className="text-sm text-emerald-700 dark:text-emerald-400"
            data-testid="draft-with-clerk-result"
          >
            Draft {draftSuccess.claimKey} v{draftSuccess.version} created — it
            is in the register below as a normal draft.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function NewClaimPanel({
  state,
}: {
  state: Pick<
    ClerkClaimsState,
    | "createForm"
    | "setCreateForm"
    | "setCreateOpen"
    | "saveCreate"
    | "createClaim"
  >;
}) {
  const { createForm, setCreateForm, setCreateOpen, saveCreate, createClaim } =
    state;
  return (
    <Card data-testid="card-new-claim">
      <CardHeader>
        <CardTitle className="text-base">New claim version</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ClaimFormFields
          form={createForm}
          setForm={setCreateForm}
          keyLocked={false}
        />
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => setCreateOpen(false)}
            data-testid="button-cancel-create"
          >
            Cancel
          </Button>
          <Button
            onClick={saveCreate}
            disabled={formInvalid(createForm) || createClaim.isPending}
            data-testid="button-create-claim"
          >
            {createClaim.isPending ? "Creating…" : "Create draft"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
