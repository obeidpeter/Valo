// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import type {
  CreateFirmApiKeyInput,
  CreateFirmWebhookInput,
  FirmApiKey,
  FirmApiKeyCreated,
  FirmWebhook,
  FirmWebhookCreated,
  FirmWebhookDelivery,
} from "@workspace/api-client-react";

const harness = vi.hoisted(() => ({
  keys: [] as FirmApiKey[],
  webhooks: [] as FirmWebhook[],
  deliveries: [] as FirmWebhookDelivery[],
  createKey:
    vi.fn<
      (vars: { data: CreateFirmApiKeyInput }) => Promise<FirmApiKeyCreated>
    >(),
  revokeKey: vi.fn<(vars: { id: string }) => Promise<void>>(),
  createWebhook:
    vi.fn<
      (vars: { data: CreateFirmWebhookInput }) => Promise<FirmWebhookCreated>
    >(),
  disableWebhook: vi.fn<(vars: { id: string }) => Promise<void>>(),
  retryDelivery:
    vi.fn<(vars: { id: string; deliveryId: string }) => Promise<void>>(),
  toast: vi.fn(),
}));

// Keep generated keys and React Query's actual pending/callback lifecycle.
// Only the network-facing hook functions are substituted.
vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  useListFirmApiKeys: () => ({ data: harness.keys }),
  useListFirmWebhooks: () => ({ data: harness.webhooks }),
  useListFirmWebhookDeliveries: () => ({ data: harness.deliveries }),
  useCreateFirmApiKey: () => useMutation({ mutationFn: harness.createKey }),
  useRevokeFirmApiKey: () => useMutation({ mutationFn: harness.revokeKey }),
  useCreateFirmWebhook: () =>
    useMutation({ mutationFn: harness.createWebhook }),
  useDisableFirmWebhook: () =>
    useMutation({ mutationFn: harness.disableWebhook }),
  useRetryFirmWebhookDelivery: () =>
    useMutation({ mutationFn: harness.retryDelivery }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: harness.toast }),
}));

import { ApiAccess } from "../api-access";
import { ApiKeysCard } from "./api-keys-card";
import { WebhooksCard } from "./webhooks-card";
import { WebhookDeliveries } from "./webhook-deliveries";
import {
  getListFirmApiKeysQueryKey,
  getListFirmWebhooksQueryKey,
  getListFirmWebhookDeliveriesQueryKey,
} from "@workspace/api-client-react";

const key: FirmApiKey = {
  id: "key-1",
  name: "ERP",
  capabilities: ["invoice.read"],
  keyPrefix: "mk_test",
  createdAt: "2026-09-14T08:00:00Z",
  lastUsedAt: null,
  revokedAt: null,
};
const webhook: FirmWebhook = {
  id: "hook-1",
  url: "https://example.com/events",
  events: ["invoice.stamped"],
  active: true,
  secretPrefix: "whsec_test",
  createdAt: "2026-09-14T08:00:00Z",
};
const delivery: FirmWebhookDelivery = {
  id: "delivery-1",
  eventType: "invoice.stamped",
  status: "dead",
  attempts: 5,
  lastError: "Receiver unavailable",
  createdAt: "2026-09-14T08:00:00Z",
  deliveredAt: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const clients: QueryClient[] = [];
function renderSettings(component = <ApiAccess />) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  clients.push(client);
  const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
  render(
    <QueryClientProvider client={client}>{component}</QueryClientProvider>,
  );
  return invalidate;
}

function click(testId: string) {
  fireEvent.click(screen.getByTestId(testId));
}
function disabled(testId: string) {
  return (screen.getByTestId(testId) as HTMLButtonElement).disabled;
}
function fillKey() {
  click("button-new-api-key");
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: " ERP " },
  });
  click("checkbox-cap-invoice.read");
}
function fillWebhook() {
  click("button-new-webhook");
  fireEvent.change(screen.getByLabelText("Endpoint URL"), {
    target: { value: webhook.url },
  });
  click("checkbox-event-invoice.stamped");
}

beforeEach(() => {
  vi.resetAllMocks();
  harness.keys = [];
  harness.webhooks = [];
  harness.deliveries = [];
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

test("the existing named route composes both settings sections and the API reference", () => {
  renderSettings();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "API & webhooks",
  );
  expect(screen.getByTestId("text-no-api-keys")).toBeTruthy();
  expect(screen.getByTestId("text-no-webhooks")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "API reference" }).getAttribute("href"),
  ).toBe("/console/api-reference.html");
});

describe("API key management", () => {
  test("validates the selection, disables duplicate submission while pending, and shows the secret only in the completed dialog", async () => {
    const request = deferred<FirmApiKeyCreated>();
    harness.createKey.mockReturnValue(request.promise);
    const invalidate = renderSettings(<ApiKeysCard />);
    click("button-new-api-key");
    expect(disabled("button-create-api-key")).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: " ERP " },
    });
    expect(disabled("button-create-api-key")).toBe(true);
    click("checkbox-cap-invoice.read");
    click("button-create-api-key");
    await waitFor(() => expect(disabled("button-create-api-key")).toBe(true));
    click("button-create-api-key");
    expect(harness.createKey).toHaveBeenCalledTimes(1);
    expect(harness.createKey.mock.calls[0][0]).toEqual({
      data: { name: "ERP", capabilities: ["invoice.read"] },
    });
    await act(async () =>
      request.resolve({ ...key, secret: "test-key-shown-once" }),
    );
    expect(
      (await screen.findByTestId("text-shown-once-secret")).textContent,
    ).toBe("test-key-shown-once");
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: getListFirmApiKeysQueryKey(),
    });
    click("button-close-api-key-secret");
    expect(screen.queryByTestId("text-shown-once-secret")).toBeNull();
    click("button-new-api-key");
    expect(screen.queryByText("test-key-shown-once")).toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
    expect(
      screen
        .getByTestId("checkbox-cap-invoice.read")
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  test("retains form values on failure and resets the error when starting a new key", async () => {
    harness.createKey.mockRejectedValue({
      status: 400,
      data: { error: "Choose a different name" },
    });
    renderSettings(<ApiKeysCard />);
    fillKey();
    click("button-create-api-key");
    expect((await screen.findByTestId("text-api-key-error")).textContent).toBe(
      "Choose a different name",
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      " ERP ",
    );
    expect(disabled("button-create-api-key")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    click("button-new-api-key");
    expect(screen.queryByTestId("text-api-key-error")).toBeNull();
  });

  test("requires confirmation to revoke, hides revoked actions, and invalidates the key list", async () => {
    harness.keys = [key, { ...key, id: "revoked", revokedAt: key.createdAt }];
    harness.revokeKey.mockResolvedValue();
    const invalidate = renderSettings(<ApiKeysCard />);
    expect(screen.queryByTestId("button-revoke-revoked")).toBeNull();
    click("button-revoke-key-1");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(harness.revokeKey).not.toHaveBeenCalled();
    click("button-revoke-key-1");
    click("button-confirm-revoke");
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: getListFirmApiKeysQueryKey(),
      }),
    );
    expect(harness.revokeKey.mock.calls[0][0]).toEqual({ id: key.id });
    expect(harness.toast).toHaveBeenCalledWith({ title: 'Revoked "ERP"' });
  });
});

describe("webhook management", () => {
  test("validates URL and event choices, guards pending creation, and resets the one-time signing secret", async () => {
    const request = deferred<FirmWebhookCreated>();
    harness.createWebhook.mockReturnValue(request.promise);
    const invalidate = renderSettings(<WebhooksCard />);
    click("button-new-webhook");
    const input = screen.getByLabelText("Endpoint URL");
    fireEvent.change(input, { target: { value: "not-a-url" } });
    fireEvent.blur(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByTestId("text-webhook-url-error")).toBeTruthy();
    expect(disabled("button-create-webhook")).toBe(true);
    fireEvent.change(input, { target: { value: webhook.url } });
    expect(disabled("button-create-webhook")).toBe(true);
    click("checkbox-event-invoice.stamped");
    click("button-create-webhook");
    await waitFor(() => expect(disabled("button-create-webhook")).toBe(true));
    click("button-create-webhook");
    expect(harness.createWebhook).toHaveBeenCalledTimes(1);
    expect(harness.createWebhook.mock.calls[0][0]).toEqual({
      data: { url: webhook.url, events: ["invoice.stamped"] },
    });
    await act(async () =>
      request.resolve({ ...webhook, secret: "test-signing-secret" }),
    );
    expect(
      (await screen.findByTestId("text-shown-once-secret")).textContent,
    ).toBe("test-signing-secret");
    expect(
      screen.getByText(
        /HMAC-SHA256 of the body keyed by sha256 of your secret/,
      ),
    ).toBeTruthy();
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: getListFirmWebhooksQueryKey(),
    });
    click("button-close-webhook-secret");
    click("button-new-webhook");
    expect(screen.queryByText("test-signing-secret")).toBeNull();
    expect(
      (screen.getByLabelText("Endpoint URL") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.queryByTestId("text-webhook-url-error")).toBeNull();
    expect(
      screen
        .getByTestId("checkbox-event-invoice.stamped")
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  test("a rejected registration keeps the URL and event selection without exposing a secret", async () => {
    harness.createWebhook.mockRejectedValue({
      status: 400,
      data: { error: "Endpoint address is not allowed" },
    });
    renderSettings(<WebhooksCard />);
    fillWebhook();
    click("button-create-webhook");
    expect((await screen.findByTestId("text-webhook-error")).textContent).toBe(
      "Endpoint address is not allowed",
    );
    expect(
      (screen.getByLabelText("Endpoint URL") as HTMLInputElement).value,
    ).toBe(webhook.url);
    expect(
      screen
        .getByTestId("checkbox-event-invoice.stamped")
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByTestId("text-shown-once-secret")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    click("button-new-webhook");
    expect(screen.queryByTestId("text-webhook-error")).toBeNull();
  });

  test("keeps disabled endpoint history available and confirms disabling an active endpoint", async () => {
    harness.webhooks = [webhook, { ...webhook, id: "disabled", active: false }];
    harness.disableWebhook.mockResolvedValue();
    const invalidate = renderSettings(<WebhooksCard />);
    expect(screen.queryByTestId("button-disable-disabled")).toBeNull();
    click("button-deliveries-disabled");
    expect(
      screen
        .getByTestId("button-deliveries-disabled")
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByTestId("text-no-deliveries")).toBeTruthy();
    click("button-deliveries-hook-1");
    expect(screen.queryByTestId("section-deliveries-disabled")).toBeNull();
    click("button-disable-hook-1");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(harness.disableWebhook).not.toHaveBeenCalled();
    click("button-disable-hook-1");
    click("button-confirm-disable");
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: getListFirmWebhooksQueryKey(),
      }),
    );
    expect(harness.disableWebhook.mock.calls[0][0]).toEqual({ id: webhook.id });
    expect(harness.toast).toHaveBeenCalledWith({ title: "Webhook disabled" });
  });
});

describe("delivery retries", () => {
  beforeEach(() => {
    harness.deliveries = [delivery];
  });

  test("retries only a dead row, guards repeated clicks, and invalidates the exact endpoint history", async () => {
    harness.deliveries.push({
      ...delivery,
      id: "delivered",
      status: "delivered",
    });
    const request = deferred<void>();
    harness.retryDelivery.mockReturnValue(request.promise);
    const invalidate = renderSettings(
      <WebhookDeliveries webhookId={webhook.id} />,
    );
    expect(screen.queryByTestId("button-retry-delivery-delivered")).toBeNull();
    click("button-retry-delivery-delivery-1");
    expect(disabled("button-retry-delivery-delivery-1")).toBe(true);
    click("button-retry-delivery-delivery-1");
    await waitFor(() => expect(harness.retryDelivery).toHaveBeenCalledTimes(1));
    expect(harness.retryDelivery.mock.calls[0][0]).toEqual({
      id: webhook.id,
      deliveryId: delivery.id,
    });
    await act(async () => request.resolve());
    await waitFor(() =>
      expect(disabled("button-retry-delivery-delivery-1")).toBe(false),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: getListFirmWebhookDeliveriesQueryKey(webhook.id),
    });
  });

  test.each([
    [{ status: 409 }, "This delivery is not dead / endpoint disabled."],
    [{}, "Could not retry the delivery. Try again."],
  ])(
    "keeps a failed or unknown retry outcome inline until another attempt",
    async (error, message) => {
      harness.retryDelivery.mockRejectedValueOnce(error);
      const invalidate = renderSettings(
        <WebhookDeliveries webhookId={webhook.id} />,
      );
      click("button-retry-delivery-delivery-1");
      const note = await screen.findByTestId("text-retry-note-delivery-1");
      expect(note.textContent).toBe(message);
      expect(note.getAttribute("role")).toBe("alert");
      expect(invalidate).not.toHaveBeenCalled();
      expect(disabled("button-retry-delivery-delivery-1")).toBe(false);
      const retry = deferred<void>();
      harness.retryDelivery.mockReturnValueOnce(retry.promise);
      click("button-retry-delivery-delivery-1");
      expect(screen.queryByTestId("text-retry-note-delivery-1")).toBeNull();
      expect(disabled("button-retry-delivery-delivery-1")).toBe(true);
      await act(async () => retry.resolve());
      await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    },
  );
});
