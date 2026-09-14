import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListFirmApiKeys,
  useCreateFirmApiKey,
  useRevokeFirmApiKey,
  getListFirmApiKeysQueryKey,
  type FirmApiKey,
  type FirmApiKeyCreated,
} from "@workspace/api-client-react";
import { KeyRound, Plus } from "lucide-react";
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
import { MACHINE_CAPABILITY_OPTIONS } from "./options";
import {
  toggleListValue,
  apiKeyBadgeClasses,
  apiKeyStatusLabel,
  lastUsedLine,
} from "./helpers";

export function ApiKeysCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {
    data: keys,
    isLoading,
    error,
    refetch,
  } = useListFirmApiKeys({
    query: { queryKey: getListFirmApiKeysQueryKey(), retry: false },
  });
  const create = useCreateFirmApiKey();
  const revoke = useRevokeFirmApiKey();

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);
  // The one moment the full key exists client-side.
  const [minted, setMinted] = useState<FirmApiKeyCreated | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<FirmApiKey | null>(null);

  const openCreate = () => {
    setName("");
    setCapabilities([]);
    setCreateError(null);
    setMinted(null);
    setShowCreate(true);
  };

  const handleCreate = () => {
    create.mutate(
      { data: { name: name.trim(), capabilities } },
      {
        onSuccess: (key) => {
          setMinted(key);
          setCreateError(null);
          void queryClient.invalidateQueries({
            queryKey: getListFirmApiKeysQueryKey(),
          });
        },
        onError: (err) =>
          setCreateError(
            userErrorMessage(err) ?? "Could not create the key. Try again.",
          ),
      },
    );
  };

  const handleRevoke = (key: FirmApiKey) => {
    revoke.mutate(
      { id: key.id },
      {
        onSuccess: () => {
          toast({ title: `Revoked "${key.name}"` });
          void queryClient.invalidateQueries({
            queryKey: getListFirmApiKeysQueryKey(),
          });
        },
        onError: (err) =>
          toast({
            title: "Could not revoke the key",
            description: userErrorMessage(err),
            variant: "destructive",
          }),
        onSettled: () => setRevokeTarget(null),
      },
    );
  };

  const capabilityLabel = (value: string) =>
    MACHINE_CAPABILITY_OPTIONS.find((o) => o.value === value)?.label ?? value;

  return (
    <Card data-testid="card-api-keys">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-primary" aria-hidden="true" />
            API keys
          </span>
          <Button
            size="sm"
            onClick={openCreate}
            data-testid="button-new-api-key"
          >
            <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> New key
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-3">
          Machine credentials for server-to-server callers (
          <code className="text-[11px]">Authorization: Bearer mk_…</code>). Each
          key carries exactly the capabilities you pick — nothing can submit to
          the government submission service, spend Clerk tokens or manage
          accounts.
        </p>
        {isLoading ? (
          <Skeleton className="h-16" />
        ) : error ? (
          <QueryError thing="your API keys" onRetry={() => refetch()} />
        ) : (keys ?? []).length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-no-api-keys"
          >
            No API keys yet — create one to let an integration read or stage
            data for this firm.
          </p>
        ) : (
          <ul className="divide-y" data-testid="list-api-keys">
            {(keys ?? []).map((key) => (
              <li
                key={key.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
                data-testid={`row-api-key-${key.id}`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {key.name}{" "}
                    <code className="ml-1 font-mono text-xs text-muted-foreground">
                      {key.keyPrefix}…
                    </code>
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {key.capabilities.map((cap) => (
                      <span key={cap} className={pillClasses("teal")}>
                        {capabilityLabel(cap)}
                      </span>
                    ))}
                    <span>{lastUsedLine(key)}</span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={apiKeyBadgeClasses(key)}>
                    {apiKeyStatusLabel(key)}
                  </span>
                  {!key.revokedAt && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setRevokeTarget(key)}
                      data-testid={`button-revoke-${key.id}`}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              </li>
            ))}
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
          {minted ? (
            <>
              <DialogHeader>
                <DialogTitle>API key created</DialogTitle>
                <DialogDescription>
                  &quot;{minted.name}&quot; can now authenticate with the
                  capabilities you granted.
                </DialogDescription>
              </DialogHeader>
              <SecretPanel secret={minted.secret} what="API key" />
              <DialogFooter>
                <Button
                  onClick={() => setShowCreate(false)}
                  data-testid="button-close-api-key-secret"
                >
                  I&apos;ve stored it
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>New API key</DialogTitle>
                <DialogDescription>
                  The key is scoped to your firm and to the capabilities you
                  pick here. You&apos;ll see the secret exactly once, on the
                  next screen.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="api-key-name">Name</Label>
                  <Input
                    id="api-key-name"
                    value={name}
                    maxLength={80}
                    placeholder="e.g. ERP export job"
                    onChange={(e) => setName(e.target.value)}
                    data-testid="input-api-key-name"
                  />
                </div>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Capabilities</legend>
                  {MACHINE_CAPABILITY_OPTIONS.map((option) => (
                    <div key={option.value} className="flex items-start gap-2">
                      <Checkbox
                        id={`cap-${option.value}`}
                        checked={capabilities.includes(option.value)}
                        onCheckedChange={() =>
                          setCapabilities((caps) =>
                            toggleListValue(caps, option.value),
                          )
                        }
                        className="mt-0.5"
                        data-testid={`checkbox-cap-${option.value}`}
                      />
                      <Label
                        htmlFor={`cap-${option.value}`}
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
                    data-testid="text-api-key-error"
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
                    name.trim() === "" ||
                    capabilities.length === 0 ||
                    create.isPending
                  }
                  data-testid="button-create-api-key"
                >
                  {create.isPending ? "Creating…" : "Create key"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(o) => {
          if (!o) setRevokeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke &quot;{revokeTarget?.name}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Anything using this key stops authenticating immediately. This
              cannot be undone — you would mint a new key instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={revoke.isPending}
              onClick={() => revokeTarget && handleRevoke(revokeTarget)}
              data-testid="button-confirm-revoke"
            >
              {revoke.isPending ? "Revoking…" : "Revoke key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
