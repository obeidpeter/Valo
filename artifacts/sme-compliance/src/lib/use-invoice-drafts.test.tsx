// @vitest-environment jsdom
import { type PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ServerInvoiceDraft } from "./invoice-draft-api";
import { useInvoiceDrafts } from "./use-invoice-drafts";
import {
  draftStorageKey,
  emptyInvoiceDraft,
  listDraftRecoveries,
  saveDraftRecovery,
  saveInvoiceDraft,
  type DraftRecovery,
} from "./invoice-draft";

const harness = vi.hoisted(() => ({
  me: { userId: "user", firmId: "firm", clientPartyId: "client" },
  generation: 1,
  ending: false,
  listeners: new Set<() => void>(),
  api: { get: vi.fn(), save: vi.fn(), remove: vi.fn() },
}));
vi.mock("@workspace/api-client-react", async (original) => ({
  ...(await original<typeof import("@workspace/api-client-react")>()),
  useGetMe: () => ({ data: harness.me }),
}));
vi.mock("@workspace/web-ui", async (original) => ({
  ...(await original<typeof import("@workspace/web-ui")>()),
  webSession: {
    getGeneration: () => harness.generation,
    isEnding: () => harness.ending,
    subscribe: (listener: () => void) => {
      harness.listeners.add(listener);
      return () => harness.listeners.delete(listener);
    },
  },
}));
vi.mock("./invoice-draft-api", () => ({
  invoiceDraftApi: () => harness.api,
  listServerInvoiceDrafts: async () => ({ items: [], nextOffset: null }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const row = (invoiceNumber: string): ServerInvoiceDraft => ({
  id: crypto.randomUUID(),
  revision: 1,
  writeId: crypto.randomUUID(),
  draft: { ...emptyInvoiceDraft(), invoiceNumber },
  updatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
});
function renderDrafts(strict = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: PropsWithChildren) => {
    const content = (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return content;
  };
  return renderHook(() => useInvoiceDrafts(), {
    wrapper,
    reactStrictMode: strict,
  });
}
beforeEach(() => {
  harness.me = { userId: "user", firmId: "firm", clientPartyId: "client" };
  harness.generation = 1;
  harness.ending = false;
  harness.listeners.clear();
  harness.api.get.mockReset().mockRejectedValue({ status: 404 });
  harness.api.save.mockReset().mockImplementation(async (id, input) => ({
    ...row(input.draft.invoiceNumber),
    id,
    writeId: input.writeId,
    revision: input.expectedRevision + 1,
    draft: input.draft,
  }));
  harness.api.remove.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
  window.history.replaceState(null, "", "/invoices/new");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

test("StrictMode aborts the replayed effect's GET and leaves the editor usable", async () => {
  const old = deferred<ServerInvoiceDraft>();
  harness.api.get.mockReturnValueOnce(old.promise);
  const view = renderDrafts(true);
  await waitFor(() => expect(view.result.current.state.status).toBe("empty"));
  expect(harness.api.get).toHaveBeenCalledTimes(2);
  expect(harness.api.get.mock.calls[0][1].aborted).toBe(true);
  expect(harness.api.get.mock.calls[1][1].aborted).toBe(false);
  await act(async () => old.resolve(row("old lifecycle")));
  expect(view.result.current.draft.invoiceNumber).toBe("");
  act(() =>
    view.result.current.setDraft({
      ...emptyInvoiceDraft(),
      invoiceNumber: "usable",
    }),
  );
  await act(async () => {
    expect(await view.result.current.session.save()).toBe(true);
  });
  expect(view.result.current.state.status).toBe("saved");
  expect(view.result.current.draft.invoiceNumber).toBe("usable");
  expect(harness.api.save).toHaveBeenCalledTimes(1);
});

test("cross-tab recovery changes refresh the list without recreating the active session", async () => {
  const view = renderDrafts();
  await waitFor(() => expect(view.result.current.state.status).toBe("empty"));
  const session = view.result.current.session;
  const scopeKey = view.result.current.scopeKey;
  const recovery: DraftRecovery = {
    version: 2,
    id: crypto.randomUUID(),
    writerId: crypto.randomUUID(),
    revision: 0,
    draft: { ...emptyInvoiceDraft(), invoiceNumber: "another tab" },
    savedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const storageKey = `${scopeKey}:${recovery.id}:recovery:${recovery.writerId}`;
  act(() => {
    saveDraftRecovery(scopeKey, recovery);
    window.dispatchEvent(new StorageEvent("storage", { key: storageKey }));
  });
  expect(view.result.current.recoveries).toContainEqual(recovery);
  expect(view.result.current.session).toBe(session);
  expect(harness.api.get).toHaveBeenCalledTimes(1);
  act(() => {
    localStorage.removeItem(storageKey);
    window.dispatchEvent(new StorageEvent("storage", { key: storageKey }));
  });
  expect(view.result.current.recoveries).not.toContainEqual(recovery);
  expect(view.result.current.session).toBe(session);
});

test("saved recoveries and legacy drafts stay scoped across account changes", async () => {
  saveInvoiceDraft(draftStorageKey("user", "firm"), {
    ...emptyInvoiceDraft(),
    invoiceNumber: "first account legacy",
  });
  saveInvoiceDraft(draftStorageKey("other-user", "firm"), {
    ...emptyInvoiceDraft(),
    invoiceNumber: "second account legacy",
  });
  const view = renderDrafts();
  await waitFor(() => expect(view.result.current.state.status).toBe("empty"));
  const session = view.result.current.session;
  expect(view.result.current.legacy?.draft.invoiceNumber).toBe(
    "first account legacy",
  );
  act(() =>
    view.result.current.setDraft({
      ...emptyInvoiceDraft(),
      invoiceNumber: "saved copy",
    }),
  );
  await act(async () => {
    expect(await session.save()).toBe(true);
  });
  expect(
    view.result.current.recoveries.some(
      (copy) => copy.draft.invoiceNumber === "saved copy",
    ),
  ).toBe(true);
  harness.me = { ...harness.me };
  view.rerender();
  expect(view.result.current.session).toBe(session);
  harness.me = { ...harness.me, userId: "other-user" };
  view.rerender();
  expect(view.result.current.recoveries).toEqual([]);
  expect(view.result.current.legacy?.draft.invoiceNumber).toBe(
    "second account legacy",
  );
  expect(view.result.current.session).not.toBe(session);
});

test.each(["logout", "navigation", "scope change"])(
  "%s invalidates the hook before a late save settles",
  async (boundary) => {
    const response = deferred<ServerInvoiceDraft>();
    harness.api.save.mockReturnValue(response.promise);
    const view = renderDrafts();
    await waitFor(() => expect(view.result.current.state.status).toBe("empty"));
    const controller = view.result.current;
    let saving!: Promise<boolean>;
    act(() => {
      controller.setDraft({ ...emptyInvoiceDraft(), invoiceNumber: "A" });
      saving = controller.session.save();
      controller.setDraft({ ...emptyInvoiceDraft(), invoiceNumber: "B" });
    });
    const writes = vi.spyOn(Storage.prototype, "setItem");
    if (boundary === "logout") {
      act(() => {
        harness.ending = true;
        harness.generation++;
        harness.listeners.forEach((listener) => listener());
        localStorage.clear();
      });
      view.unmount();
      expect(writes).not.toHaveBeenCalled();
    } else if (boundary === "navigation") {
      view.unmount();
      expect(
        listDraftRecoveries(controller.scopeKey)[0].draft.invoiceNumber,
      ).toBe("B");
    } else {
      harness.me = { ...harness.me, userId: "other-user" };
      view.rerender();
      await waitFor(() =>
        expect(view.result.current.state.status).toBe("empty"),
      );
      expect(view.result.current.draft.invoiceNumber).toBe("");
    }
    expect(harness.api.save.mock.calls[0][2].aborted).toBe(true);
    writes.mockClear();
    const removals = vi.spyOn(Storage.prototype, "removeItem");
    await act(async () => {
      response.resolve(row("A"));
      expect(await saving).toBe(false);
    });
    act(() => {
      controller.newDraft(row("stale copy").draft);
      controller.setDraft(row("stale edit").draft);
      window.dispatchEvent(new Event("online"));
    });
    expect(harness.api.save).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();
    expect(removals).not.toHaveBeenCalled();
    if (boundary === "logout") expect(localStorage.length).toBe(0);
  },
);
