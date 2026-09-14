import { test, expect, describe, vi } from "vitest";
import {
  MACHINE_CAPABILITIES,
  WEBHOOK_EVENTS,
} from "@workspace/api-zod/integrations";
import {
  MACHINE_CAPABILITY_OPTIONS,
  WEBHOOK_EVENT_OPTIONS,
  SIGNATURE_NOTE,
} from "./api-access/options";
import {
  toggleListValue,
  apiKeyStatusLabel,
  apiKeyBadgeClasses,
  webhookStatusLabel,
  webhookBadgeClasses,
  deliveryStatusLabel,
  deliveryBadgeClasses,
  webhookUrlProblem,
  lastUsedLine,
  canRetryDelivery,
  retryDeliveryErrorNote,
  fireDeliveryRetry,
} from "./api-access/helpers";

// Compare the UI's actual options with the contract used by server validation,
// not another independently maintained list of literal values.

describe("MACHINE_CAPABILITY_OPTIONS", () => {
  test("offers exactly the server's machine-safe allowlist, in order", () => {
    expect(MACHINE_CAPABILITY_OPTIONS.map((o) => o.value)).toEqual(
      MACHINE_CAPABILITIES,
    );
  });

  test("every option explains itself", () => {
    for (const option of MACHINE_CAPABILITY_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(0);
    }
  });
});

describe("WEBHOOK_EVENT_OPTIONS", () => {
  test("offers exactly the server's event catalogue, in order", () => {
    expect(WEBHOOK_EVENT_OPTIONS.map((o) => o.value)).toEqual(WEBHOOK_EVENTS);
  });

  test("every event has complete display copy", () => {
    for (const option of WEBHOOK_EVENT_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(0);
    }
  });
});

describe("SIGNATURE_NOTE", () => {
  test("states the exact signing recipe — the stored hash is the HMAC key", () => {
    // A receiver who keys the HMAC with the raw secret rejects every genuine
    // delivery, so the note must carry this recipe verbatim.
    expect(SIGNATURE_NOTE).toContain(
      "HMAC-SHA256 of the body keyed by sha256 of your secret",
    );
    expect(SIGNATURE_NOTE).toContain("X-Meridian-Signature");
    expect(SIGNATURE_NOTE).toContain("X-Valo-Signature");
  });
});

describe("toggleListValue", () => {
  test("adds a missing value at the end, preserving pick order", () => {
    expect(toggleListValue([], "a")).toEqual(["a"]);
    expect(toggleListValue(["b"], "a")).toEqual(["b", "a"]);
  });

  test("removes a present value without touching the rest", () => {
    expect(toggleListValue(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  test("returns a new array — never mutates the selection state", () => {
    const before = ["a"];
    toggleListValue(before, "b");
    expect(before).toEqual(["a"]);
  });
});

describe("API key status", () => {
  test("live until the revocation stamp exists", () => {
    expect(apiKeyStatusLabel({ revokedAt: null })).toBe("Active");
    expect(apiKeyBadgeClasses({ revokedAt: null })).toContain("emerald");
  });

  test("a revoked key reads as revoked in a neutral tone", () => {
    expect(apiKeyStatusLabel({ revokedAt: "2026-07-01T00:00:00Z" })).toBe(
      "Revoked",
    );
    expect(apiKeyBadgeClasses({ revokedAt: "2026-07-01T00:00:00Z" })).toContain(
      "slate",
    );
  });
});

describe("webhook status", () => {
  test("active endpoints are emerald, disabled ones neutral", () => {
    expect(webhookStatusLabel({ active: true })).toBe("Active");
    expect(webhookBadgeClasses({ active: true })).toContain("emerald");
    expect(webhookStatusLabel({ active: false })).toBe("Disabled");
    expect(webhookBadgeClasses({ active: false })).toContain("slate");
  });
});

describe("delivery status", () => {
  test("maps each dispatcher status to its meaning and tone", () => {
    expect(deliveryStatusLabel("pending")).toBe("Queued");
    expect(deliveryBadgeClasses("pending")).toContain("blue");
    expect(deliveryStatusLabel("delivered")).toBe("Delivered");
    expect(deliveryBadgeClasses("delivered")).toContain("emerald");
    // failed = an attempt failed but retries remain; dead = gave up.
    expect(deliveryStatusLabel("failed")).toBe("Failed — retrying");
    expect(deliveryBadgeClasses("failed")).toContain("amber");
    expect(deliveryStatusLabel("dead")).toBe("Dead — gave up");
    expect(deliveryBadgeClasses("dead")).toContain("red");
  });

  test("a status from a newer server humanizes into a slate pill", () => {
    expect(deliveryStatusLabel("snoozed")).toBe("Snoozed");
    expect(deliveryBadgeClasses("snoozed")).toContain("slate");
  });
});

describe("webhookUrlProblem", () => {
  test("asks for a URL when the field is empty", () => {
    expect(webhookUrlProblem("")).toBe("Enter the endpoint URL.");
    expect(webhookUrlProblem("   ")).toBe("Enter the endpoint URL.");
  });

  test("rejects text that does not parse as a URL", () => {
    expect(webhookUrlProblem("not a url")).toContain("full URL");
    expect(webhookUrlProblem("example.com/hooks")).toContain("full URL");
  });

  test("rejects non-http(s) schemes", () => {
    expect(webhookUrlProblem("ftp://example.com/x")).toBe(
      "The endpoint must use http(s).",
    );
  });

  test("accepts http(s) URLs — the server stays the authority on the rest", () => {
    expect(webhookUrlProblem("https://example.com/hooks/meridian")).toBeNull();
    expect(webhookUrlProblem("http://example.com/hooks")).toBeNull();
  });
});

describe("lastUsedLine", () => {
  test("a used key names the moment; an unused key says so honestly", () => {
    expect(lastUsedLine({ lastUsedAt: "2026-07-01T09:30:00Z" })).toContain(
      "Last used",
    );
    expect(lastUsedLine({ lastUsedAt: null })).toBe("Never used");
  });
});

// ---- Dead-delivery retry ----------------------------------------------------
// The Retry button appears only where a click can succeed (the server 409s
// anything that isn't dead), fires with the path params in webhook-then-
// delivery order, and a mid-flight 409 explains itself inline.

describe("canRetryDelivery", () => {
  test("only a dead delivery offers Retry", () => {
    expect(canRetryDelivery({ status: "dead" })).toBe(true);
    for (const status of ["pending", "delivered", "failed"] as const) {
      expect(canRetryDelivery({ status })).toBe(false);
    }
  });
});

describe("retryDeliveryErrorNote", () => {
  test("a 409 names the race — no longer dead, or the endpoint is disabled", () => {
    expect(retryDeliveryErrorNote({ status: 409 })).toBe(
      "This delivery is not dead / endpoint disabled.",
    );
  });

  test("other failures relay the server's words when it sent any", () => {
    expect(
      retryDeliveryErrorNote({
        status: 500,
        data: { error: "outbox is full" },
      }),
    ).toBe("outbox is full");
  });

  test("a wordless failure falls back to the plain try-again line", () => {
    expect(retryDeliveryErrorNote({})).toBe(
      "Could not retry the delivery. Try again.",
    );
  });
});

describe("fireDeliveryRetry", () => {
  test("fires the mutation once with webhook-then-delivery path params", () => {
    const mutate = vi.fn();
    const cbs = {
      onSuccess: vi.fn(),
      onError: vi.fn(),
      onSettled: vi.fn(),
    };
    fireDeliveryRetry(mutate, { webhookId: "wh_1", deliveryId: "d_9" }, cbs);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({ id: "wh_1", deliveryId: "d_9" }, cbs);
  });

  test("the 409 path lands in the inline note via the wired onError", () => {
    // Mimic the mutation rejecting: call the handed-over onError with a 409
    // and check the note the component would render.
    const notes: string[] = [];
    const mutate = vi.fn(
      (
        _vars: { id: string; deliveryId: string },
        cbs: { onError: (err: unknown) => void; onSettled: () => void },
      ) => {
        cbs.onError({ status: 409 });
        cbs.onSettled();
      },
    );
    fireDeliveryRetry(
      mutate,
      { webhookId: "wh_1", deliveryId: "d_9" },
      {
        onSuccess: () => notes.push("success"),
        onError: (err) => notes.push(retryDeliveryErrorNote(err)),
        onSettled: () => notes.push("settled"),
      },
    );
    expect(notes).toEqual([
      "This delivery is not dead / endpoint disabled.",
      "settled",
    ]);
  });
});
