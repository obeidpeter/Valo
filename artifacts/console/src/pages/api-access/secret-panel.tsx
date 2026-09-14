import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-7 px-2 text-muted-foreground hover:text-foreground"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 2000);
          },
          () => {
            /* clipboard unavailable — the value stays selectable on screen */
          },
        );
      }}
    >
      {copied ? (
        <CheckCircle2
          className="h-3.5 w-3.5 text-emerald-600"
          aria-hidden="true"
        />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

// Shown-once secret panel, shared by both create dialogs. The secret exists
// only in the dialog's state — closing it is the last time it can be read.
export function SecretPanel({
  secret,
  what,
  note,
}: {
  secret: string;
  what: string;
  note?: string;
}) {
  return (
    <div className="space-y-3">
      <div
        className="rounded-md border border-amber-300 bg-amber-50 p-2.5 dark:border-amber-700 dark:bg-amber-950/40"
        role="alert"
      >
        <p className="flex items-start gap-1.5 text-xs font-semibold text-amber-900 dark:text-amber-200">
          <AlertCircle
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          This {what} is shown once — right now. Store it in your secret manager
          before closing this dialog; we keep only a fingerprint and can never
          show it again.
        </p>
      </div>
      <div className="rounded-md border bg-background p-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase text-muted-foreground">
            Secret
          </p>
          <CopyButton value={secret} label={`Copy ${what}`} />
        </div>
        <code
          className="block break-all font-mono text-xs"
          data-testid="text-shown-once-secret"
        >
          {secret}
        </code>
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
