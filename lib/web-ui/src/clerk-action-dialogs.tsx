import { useId } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  ClerkActionDialogFrame,
  ClerkDialogFooter,
  ClerkDialogHeader,
} from "./clerk-action-dialog-frame";

export interface ClerkActionResultView {
  summary: string;
  outcomes: {
    id: string;
    invoiceNumber: string;
    label: string;
    className: string;
  }[];
}

export interface ClerkActionDraftView {
  id: string;
  subject: string;
  detail: string;
  body: string;
  copy: () => void;
}

export function ClerkActionDialog({
  open,
  close,
  pending,
  canAct,
  title,
  description,
  confirmLabel,
  confirm,
  result,
  drafts,
  draftInstructions,
}: {
  open: boolean;
  close: () => void;
  pending: boolean;
  canAct: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  confirm: () => void;
  result: ClerkActionResultView | null;
  drafts: ClerkActionDraftView[];
  draftInstructions: string;
}) {
  return (
    <ClerkActionDialogFrame open={open} close={close}>
      {result === null ? (
        <>
          <ClerkDialogHeader
            title={`Approve: ${title}`}
            description={description}
          />
          <ClerkDialogFooter>
            <Button variant="outline" onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button
              onClick={confirm}
              disabled={pending || !canAct}
              data-testid="button-confirm-action"
            >
              {pending ? "Working\u2026" : confirmLabel}
            </Button>
          </ClerkDialogFooter>
        </>
      ) : (
        <>
          <ClerkDialogHeader
            title="Batch result"
            description={result.summary}
            descriptionTestId="text-action-outcome"
          />
          <div className="space-y-1 text-sm">
            {result.outcomes.map((outcome) => (
              <p
                key={outcome.id}
                className="flex justify-between gap-3"
                data-testid={`outcome-${outcome.id}`}
              >
                <span className="truncate">{outcome.invoiceNumber}</span>
                <span className={outcome.className}>{outcome.label}</span>
              </p>
            ))}
          </div>
          <ClerkDrafts drafts={drafts} instructions={draftInstructions} />
          <ClerkDialogFooter>
            <Button onClick={close} data-testid="button-close-action">
              Done
            </Button>
          </ClerkDialogFooter>
        </>
      )}
    </ClerkActionDialogFrame>
  );
}

function ClerkDrafts({
  drafts,
  instructions,
}: {
  drafts: ClerkActionDraftView[];
  instructions: string;
}) {
  if (drafts.length === 0) return null;
  return (
    <div className="space-y-3 border-t pt-3">
      <p className="text-sm font-medium">{instructions}</p>
      {drafts.map((draft) => (
        <div
          key={draft.id}
          className="rounded-md border p-3 space-y-1.5 text-sm"
          data-testid={`draft-${draft.id}`}
        >
          <div className="flex items-center justify-between gap-3">
            <p className="font-medium truncate">{draft.subject}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={draft.copy}
              data-testid={`button-copy-draft-${draft.id}`}
            >
              Copy
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{draft.detail}</p>
          <p className="whitespace-pre-wrap text-xs">{draft.body}</p>
        </div>
      ))}
    </div>
  );
}

export function ClerkAutomationDialog({
  open,
  close,
  title,
  evidence,
  description,
  cap,
  setCap,
  min,
  max,
  pending,
  canAct,
  valid,
  confirm,
}: {
  open: boolean;
  close: () => void;
  title: string;
  evidence: string | null;
  description: string;
  cap: string;
  setCap: (value: string) => void;
  min: number;
  max: number;
  pending: boolean;
  canAct: boolean;
  valid: boolean;
  confirm: () => void;
}) {
  const capId = useId();
  return (
    <ClerkActionDialogFrame open={open} close={close}>
      <ClerkDialogHeader
        title={title}
        evidence={evidence}
        description={description}
      />
      <div className="space-y-1.5">
        <Label htmlFor={capId}>Daily limit (invoices per run)</Label>
        <Input
          id={capId}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={cap}
          onChange={(event) => setCap(event.target.value)}
          data-testid="input-policy-cap"
        />
      </div>
      <ClerkDialogFooter>
        <Button variant="outline" onClick={close} disabled={pending}>
          Cancel
        </Button>
        <Button
          onClick={confirm}
          disabled={pending || !valid || !canAct}
          data-testid="button-confirm-automate"
        >
          {pending ? "Working\u2026" : "Turn on daily automation"}
        </Button>
      </ClerkDialogFooter>
    </ClerkActionDialogFrame>
  );
}
