import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";

export interface QueryErrorProps {
  thing: string;
  onRetry: () => void;
  /** Optional display-ready detail; app adapters own error-message translation. */
  detail?: string | null;
}

/**
 * Shared failed-fetch state (design language §6). Render it in place of the
 * page's data widgets — the page header stays visible above it — and pass the
 * query's refetch so "Try again" actually retries.
 */
export function QueryError({ thing, onRetry, detail }: QueryErrorProps) {
  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" aria-hidden="true" />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 break-words">
          <p
            className="text-destructive dark:text-red-300"
            data-testid="text-error"
          >
            Unable to load {thing}.
          </p>
          {detail ? (
            <p
              className="text-xs text-muted-foreground mt-1"
              data-testid="text-error-detail"
            >
              {detail}
            </p>
          ) : null}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
