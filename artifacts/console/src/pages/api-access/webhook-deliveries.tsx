import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListFirmWebhookDeliveries,
  getListFirmWebhookDeliveriesQueryKey,
  useRetryFirmWebhookDelivery,
} from "@workspace/api-client-react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { formatDateTime } from "@/lib/format";
import {
  fireDeliveryRetry,
  retryDeliveryErrorNote,
  canRetryDelivery,
  deliveryBadgeClasses,
  deliveryStatusLabel,
} from "./helpers";

export function WebhookDeliveries({ webhookId }: { webhookId: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useListFirmWebhookDeliveries(
    webhookId,
    {
      query: {
        queryKey: getListFirmWebhookDeliveriesQueryKey(webhookId),
        retry: false,
      },
    },
  );
  const retry = useRetryFirmWebhookDelivery();
  // Only the row whose Retry fired disables; a failed retry keeps its note
  // inline on that row until the next attempt.
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryNotes, setRetryNotes] = useState<Record<string, string>>({});

  const handleRetry = (deliveryId: string) => {
    setRetryingId(deliveryId);
    setRetryNotes((notes) => {
      const next = { ...notes };
      delete next[deliveryId];
      return next;
    });
    fireDeliveryRetry(
      retry.mutate,
      { webhookId, deliveryId },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: getListFirmWebhookDeliveriesQueryKey(webhookId),
          });
        },
        onError: (err) =>
          setRetryNotes((notes) => ({
            ...notes,
            [deliveryId]: retryDeliveryErrorNote(err),
          })),
        onSettled: () => setRetryingId(null),
      },
    );
  };

  if (isLoading) return <Skeleton className="h-12" />;
  if (isError)
    return <QueryError thing="the deliveries" onRetry={() => refetch()} />;
  if ((data ?? []).length === 0)
    return (
      <p
        className="text-xs text-muted-foreground"
        data-testid="text-no-deliveries"
      >
        No deliveries yet — they appear here as subscribed events happen.
      </p>
    );
  return (
    <ul className="space-y-2" data-testid="list-deliveries">
      {(data ?? []).map((d) => (
        <li
          key={d.id}
          className="rounded-md border p-2 text-xs"
          data-testid={`row-delivery-${d.id}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className={deliveryBadgeClasses(d.status)}>
                {deliveryStatusLabel(d.status)}
              </span>
              <code className="font-mono">{d.eventType}</code>
              <span className="text-muted-foreground">
                {d.attempts} attempt{d.attempts === 1 ? "" : "s"}
              </span>
            </div>
            {canRetryDelivery(d) && (
              <Button
                size="sm"
                variant="secondary"
                className="h-6 px-2 text-xs"
                disabled={retryingId === d.id}
                onClick={() => handleRetry(d.id)}
                data-testid={`button-retry-delivery-${d.id}`}
              >
                <RotateCcw
                  className={`w-3 h-3 mr-1 ${retryingId === d.id ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                {retryingId === d.id ? "Trying again…" : "Try again"}
              </Button>
            )}
          </div>
          <p className="mt-1 text-muted-foreground" aria-live="polite">
            Created {formatDateTime(d.createdAt)}
            {d.deliveredAt && <> · delivered {formatDateTime(d.deliveredAt)}</>}
            {retryingId === d.id && <> · retrying…</>}
          </p>
          {d.lastError && (
            <p className="mt-1 break-all text-red-700 dark:text-red-400">
              {d.lastError}
            </p>
          )}
          {retryNotes[d.id] && (
            <p
              className="mt-1 text-amber-700 dark:text-amber-400"
              role="alert"
              data-testid={`text-retry-note-${d.id}`}
            >
              {retryNotes[d.id]}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
