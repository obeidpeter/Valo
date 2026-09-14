import type {
  FirmApiKey,
  FirmWebhook,
  FirmWebhookDelivery,
} from "@workspace/api-client-react";
import { errorStatus, userErrorMessage } from "@/lib/errors";
import {
  formatDateTime,
  humanize,
  pillClasses,
  type BadgeTone,
} from "@/lib/format";

/** Toggle one value in a selection list, preserving first-picked order. */
export function toggleListValue(list: string[], value: string): string[] {
  return list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value];
}

/** An API key is live until its revocation stamp exists. */
export function apiKeyStatusLabel(key: Pick<FirmApiKey, "revokedAt">): string {
  return key.revokedAt ? "Revoked" : "Active";
}

export function apiKeyBadgeClasses(key: Pick<FirmApiKey, "revokedAt">): string {
  return pillClasses(key.revokedAt ? "slate" : "emerald");
}

/** Active/disabled pill for a webhook endpoint. */
export function webhookStatusLabel(hook: Pick<FirmWebhook, "active">): string {
  return hook.active ? "Active" : "Disabled";
}

export function webhookBadgeClasses(hook: Pick<FirmWebhook, "active">): string {
  return pillClasses(hook.active ? "emerald" : "slate");
}

// Delivery statuses (webhooks.ts dispatcher): pending = queued for its next
// attempt, failed = an attempt failed and retries remain, dead = gave up
// after the attempt cap, delivered = done.
const DELIVERY_LABELS: Record<string, string> = {
  pending: "Queued",
  delivered: "Delivered",
  failed: "Failed — retrying",
  dead: "Dead — gave up",
};

const DELIVERY_TONES: Record<string, BadgeTone> = {
  pending: "blue",
  delivered: "emerald",
  failed: "amber",
  dead: "red",
};

export function deliveryStatusLabel(status: string): string {
  return DELIVERY_LABELS[status] ?? humanize(status);
}

export function deliveryBadgeClasses(status: string): string {
  return pillClasses(DELIVERY_TONES[status] ?? "slate");
}

/**
 * Only a dead delivery can be re-queued — the server 409s anything else, so
 * the button only appears where the click can succeed.
 */
export function canRetryDelivery(
  delivery: Pick<FirmWebhookDelivery, "status">,
): boolean {
  return delivery.status === "dead";
}

/**
 * Inline note for a failed retry. A 409 means the world moved between render
 * and click — the delivery is no longer dead, or the endpoint was disabled —
 * so say that; anything else relays the server's words with a plain fallback.
 */
export function retryDeliveryErrorNote(err: unknown): string {
  if (errorStatus(err) === 409) {
    return "This delivery is not dead / endpoint disabled.";
  }
  return userErrorMessage(err) ?? "Could not retry the delivery. Try again.";
}

type RetryCallbacks = {
  onSuccess: () => void;
  onError: (err: unknown) => void;
  onSettled: () => void;
};

/**
 * The one place the retry path params are ordered: the webhook id is the
 * collection, the delivery id the member — swapping them would 404 every
 * retry. The component hands this its mutate; the tests hand it a mock.
 */
export function fireDeliveryRetry(
  mutate: (
    vars: { id: string; deliveryId: string },
    cbs: RetryCallbacks,
  ) => void,
  ids: { webhookId: string; deliveryId: string },
  cbs: RetryCallbacks,
): void {
  mutate({ id: ids.webhookId, deliveryId: ids.deliveryId }, cbs);
}

/**
 * Client-side vet of the endpoint URL before the create is attempted — the
 * same shape the server enforces (vetWebhookUrl), phrased for the field.
 * Null means "looks sendable"; the server stays the authority.
 */
export function webhookUrlProblem(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return "Enter the endpoint URL.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a full URL, including https://";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "The endpoint must use http(s).";
  }
  return null;
}

/** "Last used" line for a key row; a never-used key says so honestly. */
export function lastUsedLine(key: Pick<FirmApiKey, "lastUsedAt">): string {
  return key.lastUsedAt
    ? `Last used ${formatDateTime(key.lastUsedAt)}`
    : "Never used";
}
