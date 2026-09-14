import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ClaimFormFields } from "./claim-form-fields";
import { formInvalid } from "./helpers";
import type { ClerkClaimsState } from "./use-clerk-claims";

export function SeedOverwriteDialog({
  state,
}: {
  state: Pick<ClerkClaimsState, "pendingSeed" | "setPendingSeed" | "applySeed">;
}) {
  const { pendingSeed, setPendingSeed, applySeed } = state;
  return (
    <AlertDialog
      open={pendingSeed !== null}
      onOpenChange={(open) => {
        if (!open) setPendingSeed(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Replace the draft panel text?</AlertDialogTitle>
          <AlertDialogDescription>
            The Draft-with-Clerk panel already has source text in it. Seeding
            this question replaces that text, and it is not saved anywhere.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-seed-overwrite">
            Keep my text
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (pendingSeed !== null) applySeed(pendingSeed);
              setPendingSeed(null);
            }}
            data-testid="button-confirm-seed-overwrite"
          >
            Replace it
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ClaimDecisionDialog({
  state,
}: {
  state: Pick<
    ClerkClaimsState,
    | "decision"
    | "setDecision"
    | "setDecisionNote"
    | "decisionCopy"
    | "decisionNote"
    | "decideClaim"
    | "confirmDisabled"
  >;
}) {
  const {
    decision,
    setDecision,
    setDecisionNote,
    decisionCopy,
    decisionNote,
    decideClaim,
    confirmDisabled,
  } = state;
  return (
    <Dialog
      open={decision != null}
      onOpenChange={(o) => {
        if (!o) {
          setDecision(null);
          setDecisionNote("");
        }
      }}
    >
      <DialogContent>
        {decision && decisionCopy && (
          <>
            <DialogHeader>
              <DialogTitle>
                {decisionCopy.title} {decision.claim.claimKey} v
                {decision.claim.version}
              </DialogTitle>
              <DialogDescription>{decisionCopy.help}</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="decision-note">
                Decision note{" "}
                {decisionCopy.noteRequired ? "(required)" : "(optional)"}
              </Label>
              <Textarea
                id="decision-note"
                value={decisionNote}
                onChange={(e) => setDecisionNote(e.target.value)}
                placeholder="What did you check it against?"
                data-testid="input-decision-note"
              />
            </div>
            <DialogFooter>
              <Button
                variant="secondary"
                onClick={() => {
                  setDecision(null);
                  setDecisionNote("");
                }}
                data-testid="button-cancel-decision"
              >
                Cancel
              </Button>
              <Button
                variant={
                  decision.action === "approve" ? "default" : "destructive"
                }
                onClick={() =>
                  decideClaim.mutate({
                    id: decision.claim.id,
                    data: {
                      action: decision.action,
                      note: decisionNote.trim() ? decisionNote.trim() : null,
                    },
                  })
                }
                disabled={confirmDisabled}
                data-testid="button-confirm-decision"
              >
                {decideClaim.isPending ? "Recording…" : decisionCopy.confirm}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function EditClaimDialog({
  state,
}: {
  state: Pick<
    ClerkClaimsState,
    | "editing"
    | "setEditing"
    | "editForm"
    | "setEditForm"
    | "saveEdit"
    | "updateClaim"
  >;
}) {
  const { editing, setEditing, editForm, setEditForm, saveEdit, updateClaim } =
    state;
  return (
    <Dialog open={editing != null} onOpenChange={(o) => !o && setEditing(null)}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Edit draft {editing?.claimKey} v{editing?.version}
          </DialogTitle>
          <DialogDescription>
            Only drafts can be edited. Drafts are invisible to the Clerk until a
            second operator approves them.
          </DialogDescription>
        </DialogHeader>
        <ClaimFormFields form={editForm} setForm={setEditForm} keyLocked />
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => setEditing(null)}
            data-testid="button-cancel-edit"
          >
            Cancel
          </Button>
          <Button
            onClick={saveEdit}
            disabled={formInvalid(editForm) || updateClaim.isPending}
            data-testid="button-save-claim"
          >
            {updateClaim.isPending ? "Saving…" : "Save draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
