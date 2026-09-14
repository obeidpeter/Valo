// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  getGetClerkClaimGapsQueryKey,
  getListClaimsQueryKey,
  type ClaimGapReport,
  type ClaimRecord,
} from "@workspace/api-client-react";
import { ClerkClaims } from "../clerk-claims";
import { useClerkClaims } from "./use-clerk-claims";
import { EMPTY_FORM, formFromClaim } from "./helpers";
import { claimFixture } from "./test-fixtures";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
let claims: ClaimRecord[];
let gaps: ClaimGapReport;
const readClaims = vi.fn<() => Promise<Response>>();
const readGaps = vi.fn<() => Promise<Response>>();
const write = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.clearAllMocks();
  claims = [claimFixture()];
  gaps = {
    windowDays: 30,
    totalQuestions: 2,
    refusedTotal: 1,
    byReason: [{ code: "NO_COVERAGE", count: 1 }],
    uncovered: [
      {
        question: "  Which statutory VAT rate applies to exported services?  ",
        createdAt: "2026-01-02T00:00:00Z",
        firmName: "Example firm",
      },
    ],
  };
  readClaims.mockReset().mockImplementation(async () => json(claims));
  readGaps.mockReset().mockImplementation(async () => json(gaps));
  write.mockReset().mockImplementation(async () => json(claimFixture()));
  // Keep generated hooks, API error parsing, query invalidation, and mutation
  // observers real. Every transport call is intercepted; no network is used.
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (init.method === "GET" && url === "/api/claims") return readClaims();
      if (init.method === "GET" && url === "/api/clerk/claim-gaps")
        return readGaps();
      if (
        init.method !== "GET" &&
        (url.startsWith("/api/claims") || url === "/api/clerk/claims/draft")
      )
        return write(url, init);
      throw new Error(`Unexpected request: ${init.method} ${url}`);
    }),
  );
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <StrictMode>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </StrictMode>
    );
  }
  return { client, wrapper: Wrapper };
}

async function renderState() {
  const options = setup();
  const hook = renderHook(useClerkClaims, options);
  await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
  return { ...hook, client: options.client };
}

async function renderPage() {
  const options = setup();
  const view = render(<ClerkClaims />, options);
  await screen.findByTestId("text-page-title");
  return { ...view, client: options.client };
}

const body = (index = 0) =>
  JSON.parse(write.mock.calls[index][1].body as string);
const button = (id: string) => screen.getByTestId(id) as HTMLButtonElement;

describe("claims orchestration lifecycle", () => {
  test("sorts without mutating query data and retains the independent gaps query policy", async () => {
    claims = [
      claimFixture({ id: "z", claimKey: "z.last" }),
      claimFixture({ id: "old", version: 1 }),
      claimFixture({ id: "new", version: 3 }),
    ];
    const { result, client } = await renderState();
    expect(result.current.sorted.map((claim) => claim.id)).toEqual([
      "new",
      "old",
      "z",
    ]);
    expect(
      client
        .getQueryData<ClaimRecord[]>(getListClaimsQueryKey())
        ?.map((claim) => claim.id),
    ).toEqual(["z", "old", "new"]);
    const query = client
      .getQueryCache()
      .find({ queryKey: getGetClerkClaimGapsQueryKey() });
    expect(query?.options).toMatchObject({ staleTime: 300000, retry: false });
    expect(write).not.toHaveBeenCalled();
  });

  test("create keeps work while pending, normalizes payload, then invalidates and resets only after success", async () => {
    const pending = deferred<Response>();
    write.mockReturnValueOnce(pending.promise);
    const { result, client } = await renderState();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const form = {
      ...formFromClaim(claimFixture()),
      claimKey: " vat.standard_rate ",
      title: " Standard VAT rate ",
      proposition: " The standard VAT rate is {rate}. ",
      citation: " VAT Act, s.4 ",
      facts: [
        {
          key: " rate ",
          label: " VAT rate ",
          kind: "rate" as const,
          value: " 7.5 ",
          unit: " % ",
        },
      ],
    };
    act(() => {
      result.current.setCreateOpen(true);
      result.current.setCreateForm(form);
    });
    act(() => result.current.saveCreate());
    await waitFor(() =>
      expect(result.current.createClaim.isPending).toBe(true),
    );
    expect(result.current.createOpen).toBe(true);
    expect(result.current.createForm).toEqual(form);
    expect(body()).toEqual({
      claimKey: "vat.standard_rate",
      title: "Standard VAT rate",
      proposition: "The standard VAT rate is {rate}.",
      citation: "VAT Act, s.4",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      reviewDueAt: null,
      applicability: {},
      protectedFacts: claimFixture().protectedFacts,
    });
    await act(async () =>
      pending.resolve(json(claimFixture({ id: "created" }))),
    );
    await waitFor(() =>
      expect(result.current.createClaim.isSuccess).toBe(true),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: getListClaimsQueryKey(),
    });
    expect(result.current).toMatchObject({
      createOpen: false,
      createForm: EMPTY_FORM,
      expandedId: "created",
      disabledBanner: false,
    });
    expect(toast).toHaveBeenLastCalledWith({
      title: "Draft vat.standard_rate v2 created",
      description: "Submit it for review when it is ready.",
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  test("edit has a missing-selection guard, retains work on a kill-switch failure, and recovers on success", async () => {
    const { result } = await renderState();
    act(() => result.current.saveEdit());
    expect(write).not.toHaveBeenCalled();
    const form = {
      ...formFromClaim(claimFixture()),
      category: "b2g" as const,
      effectiveTo: "2027-01-01",
      reviewDueAt: "2026-12-01",
    };
    act(() => {
      result.current.setEditing(claimFixture());
      result.current.setEditForm(form);
    });
    write.mockResolvedValueOnce(json({ error: "CLERK_DISABLED" }, 503));
    act(() => result.current.saveEdit());
    await waitFor(() => expect(result.current.updateClaim.isError).toBe(true));
    expect(result.current).toMatchObject({
      disabledBanner: true,
      editForm: form,
      editing: { id: "claim-1" },
    });
    expect(body()).toMatchObject({
      applicability: { category: "b2g" },
      effectiveTo: "2027-01-01",
      reviewDueAt: "2026-12-01",
    });
    expect(body()).not.toHaveProperty("claimKey");
    expect(toast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        description:
          "The clerk_ai kill switch is disabled, so the claims register is not accepting changes.",
      }),
    );
    act(() => result.current.saveEdit());
    await waitFor(() =>
      expect(result.current.updateClaim.isSuccess).toBe(true),
    );
    expect(result.current.editing).toBeNull();
    expect(result.current.disabledBanner).toBe(false);
    expect(toast).toHaveBeenLastCalledWith({ title: "Draft updated" });
  });

  test("submit and decision keep row-specific pending state and clear decision state on settlement", async () => {
    const submit = deferred<Response>();
    const decide = deferred<Response>();
    write
      .mockReturnValueOnce(submit.promise)
      .mockReturnValueOnce(decide.promise);
    const { result } = await renderState();
    const review = claimFixture({ id: "review", state: "review" });
    act(() => {
      result.current.setDecision({ claim: review, action: "reject" });
      result.current.setDecisionNote("Check citation");
    });
    act(() => {
      result.current.submitClaim.mutate({ id: "claim-1" });
      result.current.decideClaim.mutate({
        id: review.id,
        data: { action: "reject", note: "Check citation" },
      });
    });
    await waitFor(() =>
      expect(
        result.current.submitClaim.isPending &&
          result.current.decideClaim.isPending,
      ).toBe(true),
    );
    expect(result.current.rowBusy(claimFixture())).toBe(true);
    expect(result.current.rowBusy(review)).toBe(true);
    expect(result.current.rowBusy(claimFixture({ id: "unrelated" }))).toBe(
      false,
    );
    expect(result.current.confirmDisabled).toBe(true);
    await act(async () =>
      submit.resolve(json(claimFixture({ state: "review" }))),
    );
    await waitFor(() =>
      expect(result.current.submitClaim.isSuccess).toBe(true),
    );
    expect(result.current.rowBusy(claimFixture())).toBe(false);
    expect(result.current.rowBusy(review)).toBe(true);
    expect(toast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        description:
          "A second operator must approve it before the Clerk can quote it.",
      }),
    );
    await act(async () =>
      decide.resolve(json({ ...review, state: "rejected" })),
    );
    await waitFor(() =>
      expect(result.current.decideClaim.isSuccess).toBe(true),
    );
    expect(result.current.decision).toBeNull();
    expect(result.current.decisionNote).toBe("");
    expect(result.current.rowBusy(review)).toBe(false);
  });

  test.each([
    [
      403,
      "The author cannot approve this version.",
      "Maker-checker blocked this",
      "The author cannot approve this version.",
    ],
    [
      403,
      "Forbidden",
      "Maker-checker blocked this",
      "Your account does not have permission to do this.",
    ],
    [
      500,
      "Internal server error",
      "Something went wrong",
      "Valo could not finish this request. Check the latest status before trying again.",
    ],
  ])(
    "keeps the decision and note after HTTP %s (%s)",
    async (status, error, title, description) => {
      write.mockResolvedValueOnce(json({ error }, status));
      const { result } = await renderState();
      act(() => {
        result.current.setDecision({
          claim: claimFixture({ state: "review" }),
          action: "approve",
        });
        result.current.setDecisionNote("Reviewed statute");
      });
      act(() =>
        result.current.decideClaim.mutate({
          id: "claim-1",
          data: { action: "approve", note: "Reviewed statute" },
        }),
      );
      await waitFor(() =>
        expect(result.current.decideClaim.isError).toBe(true),
      );
      expect(result.current.decision?.action).toBe("approve");
      expect(result.current.decisionNote).toBe("Reviewed statute");
      expect(result.current.disabledBanner).toBe(false);
      expect(toast).toHaveBeenLastCalledWith({
        title,
        description,
        variant: "destructive",
      });
    },
  );

  test("draft failures stay inline, successful drafting stays a draft, and seeding clears stale results", async () => {
    const { result } = await renderState();
    const sourceText =
      "A statutory source passage long enough to draft a claim.";
    act(() => {
      result.current.setDraftOpen(true);
      result.current.setDraftText(sourceText);
    });
    for (const [status, message] of [
      [502, "Check the statutory passage."],
      [503, "Clerk is disabled."],
    ] as const) {
      write.mockResolvedValueOnce(json({ error: message }, status));
      act(() => result.current.draftClaim.mutate({ data: { sourceText } }));
      await waitFor(() => expect(result.current.draftError).toBe(message));
      expect(result.current.draftText).toBe(sourceText);
      expect(result.current.draftSuccess).toBeNull();
    }
    expect(result.current.disabledBanner).toBe(true);
    expect(toast).not.toHaveBeenCalled();
    act(() => result.current.applySeed(sourceText));
    expect(result.current.draftError).toBeNull();
    act(() => result.current.draftClaim.mutate({ data: { sourceText } }));
    await waitFor(() => expect(result.current.draftClaim.isSuccess).toBe(true));
    expect(result.current).toMatchObject({
      draftText: "",
      draftError: null,
      draftSuccess: { state: "draft" },
      expandedId: "claim-1",
      disabledBanner: false,
    });
    act(() => result.current.draftFromGap("  Another question?  "));
    expect(result.current).toMatchObject({
      draftOpen: true,
      draftText: "  Another question?  ",
      draftError: null,
      draftSuccess: null,
    });
    expect(
      write.mock.calls.every(([url]) => url === "/api/clerk/claims/draft"),
    ).toBe(true);
  });

  test("unmounting a pending draft does not leak its panel state into a new page instance", async () => {
    const pending = deferred<Response>();
    write.mockReturnValueOnce(pending.promise);
    const first = await renderState();
    act(() =>
      first.result.current.draftClaim.mutate({
        data: {
          sourceText:
            "The statutory source text for the previous page instance.",
        },
      }),
    );
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    first.unmount();
    const next = await renderState();
    await act(async () => pending.resolve(json(claimFixture())));
    await waitFor(() =>
      expect(first.client.getMutationCache().getAll()[0].state.status).toBe(
        "success",
      ),
    );
    expect(next.result.current).toMatchObject({
      draftOpen: false,
      draftText: "",
      draftSuccess: null,
      expandedId: null,
      disabledBanner: false,
    });
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe("route and component wiring", () => {
  test("seeding opens and focuses the source after mount, confirms overwrite, and never drafts automatically", async () => {
    await renderPage();
    const question = gaps.uncovered[0].question;
    fireEvent.click(button("button-draft-from-gap-0"));
    const source = screen.getByTestId(
      "input-draft-source",
    ) as HTMLTextAreaElement;
    expect(source.value).toBe(question);
    expect(document.activeElement).toBe(source);
    expect(window.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: "smooth",
    });
    expect(write).not.toHaveBeenCalled();
    fireEvent.change(source, {
      target: { value: "My unfinished source text" },
    });
    fireEvent.click(button("button-draft-from-gap-0"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(source.value).toBe("My unfinished source text");
    fireEvent.click(button("button-cancel-seed-overwrite"));
    expect(source.value).toBe("My unfinished source text");
    fireEvent.click(button("button-draft-from-gap-0"));
    fireEvent.click(button("button-confirm-seed-overwrite"));
    expect(source.value).toBe(question);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(button("button-draft-from-gap-0"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(write).not.toHaveBeenCalled();
    const pending = deferred<Response>();
    write.mockReturnValueOnce(pending.promise);
    fireEvent.click(button("draft-with-clerk"));
    await waitFor(() => expect(button("draft-with-clerk").disabled).toBe(true));
    expect(body()).toEqual({ sourceText: question.trim() });
    await act(async () => pending.resolve(json(claimFixture())));
    await screen.findByTestId("draft-with-clerk-result");
    expect(screen.getByTestId("detail-claim-claim-1")).toBeTruthy();
  });

  test("source length, loading errors, retry, and optional gaps keep their existing gates", async () => {
    readClaims.mockResolvedValueOnce(json({ error: "Unavailable" }, 500));
    readGaps.mockResolvedValue(json({ error: "Unavailable" }, 500));
    render(<ClerkClaims />, setup());
    expect(screen.queryByTestId("text-page-title")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /try again/i }));
    await screen.findByTestId("text-page-title");
    expect(screen.queryByTestId("card-claim-gaps")).toBeNull();
    fireEvent.click(button("button-toggle-draft-with-clerk"));
    const source = screen.getByTestId("input-draft-source");
    fireEvent.change(source, { target: { value: `  ${"x".repeat(39)}  ` } });
    expect(button("draft-with-clerk").disabled).toBe(true);
    fireEvent.change(source, { target: { value: "x".repeat(40) } });
    expect(button("draft-with-clerk").disabled).toBe(false);
    expect(source.getAttribute("maxlength")).toBe("20000");
    expect(write).not.toHaveBeenCalled();
  });

  test("register actions stay state-gated, overdue applies only to active claims, and resume is explicit", async () => {
    claims = (
      [
        "draft",
        "review",
        "active",
        "suspended",
        "superseded",
        "expired",
        "rejected",
      ] as const
    ).map((state) =>
      claimFixture({
        id: state,
        claimKey: `claim.${state}`,
        state,
        reviewDueAt: "2000-01-01",
      }),
    );
    await renderPage();
    for (const [state, actions] of Object.entries({
      draft: ["edit", "submit"],
      review: ["approve", "reject"],
      active: ["suspend"],
      suspended: ["resume"],
      superseded: [],
      expired: [],
      rejected: [],
    })) {
      const row = screen.getByTestId(`row-claim-claim.${state}-v2`);
      expect(within(row).getAllByRole("button")).toHaveLength(
        actions.length + 1,
      );
      for (const action of actions)
        expect(
          within(row).getByTestId(`button-${action}-${state}`),
        ).toBeTruthy();
    }
    expect(screen.getAllByTestId(/^badge-review-overdue-/)).toHaveLength(1);
    expect(screen.getByTestId("badge-review-overdue-active")).toBeTruthy();
    fireEvent.click(button("button-expand-active"));
    expect(button("button-expand-active").getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(screen.getByTestId("detail-claim-active")).toBeTruthy();
    fireEvent.click(button("button-expand-active"));
    expect(screen.queryByTestId("detail-claim-active")).toBeNull();
    fireEvent.click(button("button-resume-suspended"));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(write.mock.calls[0][0]).toBe("/api/claims/suspended/decision");
    expect(body()).toEqual({ action: "resume", note: null });
  });

  test.each(["reject", "suspend"] as const)(
    "%s requires a trimmed note and confirmation, while cancel does not write",
    async (action) => {
      claims = [
        claimFixture({ state: action === "reject" ? "review" : "active" }),
      ];
      const pending = deferred<Response>();
      write.mockReturnValueOnce(pending.promise);
      await renderPage();
      fireEvent.click(button(`button-${action}-claim-1`));
      expect(button("button-confirm-decision").disabled).toBe(true);
      fireEvent.change(screen.getByLabelText("Decision note (required)"), {
        target: { value: "  " },
      });
      expect(button("button-confirm-decision").disabled).toBe(true);
      fireEvent.click(button("button-cancel-decision"));
      expect(write).not.toHaveBeenCalled();
      fireEvent.click(button(`button-${action}-claim-1`));
      fireEvent.change(screen.getByLabelText("Decision note (required)"), {
        target: { value: "  Check citation  " },
      });
      fireEvent.click(button("button-confirm-decision"));
      await waitFor(() =>
        expect(button("button-confirm-decision").disabled).toBe(true),
      );
      expect(body()).toEqual({ action, note: "Check citation" });
      await act(async () =>
        pending.resolve(
          json(
            claimFixture({
              state: action === "reject" ? "rejected" : "suspended",
            }),
          ),
        ),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    },
  );

  test("approve allows an optional note but surfaces maker-checker rejection without closing", async () => {
    claims = [claimFixture({ state: "review" })];
    write.mockResolvedValueOnce(
      json({ error: "The author cannot approve this version." }, 403),
    );
    await renderPage();
    fireEvent.click(button("button-approve-claim-1"));
    expect(button("button-confirm-decision").disabled).toBe(false);
    fireEvent.click(button("button-confirm-decision"));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Maker-checker blocked this" }),
      ),
    );
    expect(body()).toEqual({ action: "approve", note: null });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(button("button-confirm-decision").disabled).toBe(false);
  });

  test("create and edit reuse the form, retain validation, and disable saves during requests", async () => {
    await renderPage();
    fireEvent.click(button("button-new-claim"));
    expect(button("button-create-claim").disabled).toBe(true);
    fireEvent.click(button("button-cancel-create"));
    fireEvent.click(button("button-edit-claim-1"));
    expect(
      (screen.getByLabelText("Claim key") as HTMLInputElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "x" },
    });
    expect(button("button-save-claim").disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Edited title" },
    });
    const pending = deferred<Response>();
    write.mockReturnValueOnce(pending.promise);
    fireEvent.click(button("button-save-claim"));
    await waitFor(() =>
      expect(button("button-save-claim").disabled).toBe(true),
    );
    expect(body()).toMatchObject({ title: "Edited title" });
    expect(body()).not.toHaveProperty("claimKey");
    await act(async () =>
      pending.resolve(json(claimFixture({ title: "Edited title" }))),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
