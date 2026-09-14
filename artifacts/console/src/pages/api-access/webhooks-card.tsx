import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListFirmWebhooks,
  useCreateFirmWebhook,
  useDisableFirmWebhook,
  getListFirmWebhooksQueryKey,
  type FirmWebhook,
  type FirmWebhookCreated,
} from "@workspace/api-client-react";
import { ChevronDown, Plus, Webhook } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
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
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { userErrorMessage } from "@/lib/errors";
import { pillClasses } from "@/lib/format";
import { SecretPanel } from "./secret-panel";
import { SIGNATURE_NOTE, WEBHOOK_EVENT_OPTIONS } from "./options";
import {
  toggleListValue,
  webhookUrlProblem,
  webhookBadgeClasses,
  webhookStatusLabel,
} from "./helpers";
import { WebhookDeliveries } from "./webhook-deliveries";

export function WebhooksCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {
    data: hooks,
    isLoading,
    error,
    refetch,
  } = useListFirmWebhooks({
    query: { queryKey: getListFirmWebhooksQueryKey(), retry: false },
  });
  const create = useCreateFirmWebhook();
  const disable = useDisableFirmWebhook();

  const [showCreate, setShowCreate] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [urlTouched, setUrlTouched] = useState(false);
  const [registered, setRegistered] = useState<FirmWebhookCreated | null>(null);
  const [disableTarget, setDisableTarget] = useState<FirmWebhook | null>(null);
  // Which endpoint's delivery history is expanded.
  const [openDeliveries, setOpenDeliveries] = useState<string | null>(null);

  const urlProblem = webhookUrlProblem(url);

  const openCreate = () => {
    setUrl("");
    setEvents([]);
    setCreateError(null);
    setUrlTouched(false);
    setRegistered(null);
    setShowCreate(true);
  };

  const handleCreate = () => {
    create.mutate(
      { data: { url: url.trim(), events } },
      {
        onSuccess: (hook) => {
          setRegistered(hook);
          setCreateError(null);
          void queryClient.invalidateQueries({
            queryKey: getListFirmWebhooksQueryKey(),
          });
        },
        onError: (err) =>
          setCreateError(
            userErrorMessage(err) ??
              "Could not register the endpoint. Try again.",
          ),
      },
    );
  };

  const handleDisable = (hook: FirmWebhook) => {
    disable.mutate(
      { id: hook.id },
      {
        onSuccess: () => {
          toast({ title: "Webhook disabled" });
          void queryClient.invalidateQueries({
            queryKey: getListFirmWebhooksQueryKey(),
          });
        },
        onError: (err) =>
          toast({
            title: "Could not disable the webhook",
            description: userErrorMessage(err),
            variant: "destructive",
          }),
        onSettled: () => setDisableTarget(null),
      },
    );
  };

  const eventLabel = (value: string) =>
    WEBHOOK_EVENT_OPTIONS.find((o) => o.value === value)?.label ?? value;

  return (
    <Card data-testid="card-webhooks">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2">
            <Webhook className="w-4 h-4 text-primary" aria-hidden="true" />
            Webhooks
          </span>
          <Button
            size="sm"
            onClick={openCreate}
            data-testid="button-new-webhook"
          >
            <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> Add endpoint
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-3">
          We POST subscribed events to your endpoint as they happen. Payloads
          are pointer-only — an entity type and id your systems resolve back
          through the API — never amounts, names or documents.
        </p>
        {isLoading ? (
          <Skeleton className="h-16" />
        ) : error ? (
          <QueryError thing="your webhooks" onRetry={() => refetch()} />
        ) : (hooks ?? []).length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-no-webhooks"
          >
            No endpoints yet — add one to push stamped/settled invoices and
            reconciled statements into your own systems.
          </p>
        ) : (
          <ul className="divide-y" data-testid="list-webhooks">
            {(hooks ?? []).map((hook) => {
              const deliveriesOpen = openDeliveries === hook.id;
              return (
                <li
                  key={hook.id}
                  className="py-3"
                  data-testid={`row-webhook-${hook.id}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-sm">{hook.url}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {hook.events.map((event) => (
                          <span key={event} className={pillClasses("violet")}>
                            {eventLabel(event)}
                          </span>
                        ))}
                        <span>
                          Secret{" "}
                          <code className="font-mono">
                            {hook.secretPrefix}…
                          </code>
                        </span>
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className={webhookBadgeClasses(hook)}>
                        {webhookStatusLabel(hook)}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-expanded={deliveriesOpen}
                        aria-controls={`deliveries-${hook.id}`}
                        onClick={() =>
                          setOpenDeliveries(deliveriesOpen ? null : hook.id)
                        }
                        data-testid={`button-deliveries-${hook.id}`}
                      >
                        <ChevronDown
                          className={`w-4 h-4 mr-1 transition-transform ${
                            deliveriesOpen ? "rotate-180" : ""
                          }`}
                          aria-hidden="true"
                        />
                        Deliveries
                      </Button>
                      {hook.active && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setDisableTarget(hook)}
                          data-testid={`button-disable-${hook.id}`}
                        >
                          Disable
                        </Button>
                      )}
                    </div>
                  </div>
                  {deliveriesOpen && (
                    <div
                      id={`deliveries-${hook.id}`}
                      className="mt-3 border-l-2 border-muted pl-3"
                      data-testid={`section-deliveries-${hook.id}`}
                    >
                      <WebhookDeliveries webhookId={hook.id} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      <Dialog
        open={showCreate}
        onOpenChange={(o) => {
          if (!o) setShowCreate(false);
        }}
      >
        <DialogContent>
          {registered ? (
            <>
              <DialogHeader>
                <DialogTitle>Webhook registered</DialogTitle>
                <DialogDescription>
                  Deliveries to{" "}
                  <span className="break-all font-mono text-xs">
                    {registered.url}
                  </span>{" "}
                  start with the next subscribed event.
                </DialogDescription>
              </DialogHeader>
              <SecretPanel
                secret={registered.secret}
                what="signing secret"
                note={SIGNATURE_NOTE}
              />
              <DialogFooter>
                <Button
                  onClick={() => setShowCreate(false)}
                  data-testid="button-close-webhook-secret"
                >
                  I&apos;ve stored it
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Add a webhook endpoint</DialogTitle>
                <DialogDescription>
                  Pick the events to push. You&apos;ll get a signing secret
                  exactly once, on the next screen — deliveries are signed so
                  your receiver can verify they came from us.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="webhook-url">Endpoint URL</Label>
                  <Input
                    id="webhook-url"
                    type="url"
                    value={url}
                    maxLength={500}
                    placeholder="https://example.com/hooks/valo"
                    onChange={(e) => setUrl(e.target.value)}
                    onBlur={() => setUrlTouched(true)}
                    aria-invalid={urlTouched && !!urlProblem}
                    aria-describedby={
                      urlTouched && urlProblem ? "webhook-url-error" : undefined
                    }
                    data-testid="input-webhook-url"
                  />
                  {urlTouched && urlProblem && (
                    <p
                      id="webhook-url-error"
                      role="alert"
                      className="text-sm text-destructive dark:text-red-300"
                      data-testid="text-webhook-url-error"
                    >
                      {urlProblem}
                    </p>
                  )}
                </div>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Events</legend>
                  {WEBHOOK_EVENT_OPTIONS.map((option) => (
                    <div key={option.value} className="flex items-start gap-2">
                      <Checkbox
                        id={`event-${option.value}`}
                        checked={events.includes(option.value)}
                        onCheckedChange={() =>
                          setEvents((selected) =>
                            toggleListValue(selected, option.value),
                          )
                        }
                        className="mt-0.5"
                        data-testid={`checkbox-event-${option.value}`}
                      />
                      <Label
                        htmlFor={`event-${option.value}`}
                        className="font-normal"
                      >
                        <span className="block text-sm">{option.label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      </Label>
                    </div>
                  ))}
                </fieldset>
                {createError && (
                  <p
                    className="text-sm text-destructive dark:text-red-300"
                    role="alert"
                    data-testid="text-webhook-error"
                  >
                    {createError}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setShowCreate(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={
                    !!urlProblem || events.length === 0 || create.isPending
                  }
                  data-testid="button-create-webhook"
                >
                  {create.isPending ? "Registering…" : "Register endpoint"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={disableTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDisableTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable this endpoint?</AlertDialogTitle>
            <AlertDialogDescription>
              Deliveries to{" "}
              <span className="break-all font-mono text-xs">
                {disableTarget?.url}
              </span>{" "}
              stop immediately. The delivery history stays visible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={disable.isPending}
              onClick={() => disableTarget && handleDisable(disableTarget)}
              data-testid="button-confirm-disable"
            >
              {disable.isPending ? "Disabling…" : "Disable endpoint"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
