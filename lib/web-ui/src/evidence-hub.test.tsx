// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { EvidenceHub } from "./evidence-hub";
import { EvidenceReview } from "./evidence-review";
import { EvidenceUpload } from "./evidence-files";
import { EvidenceCreate } from "./evidence-create";
import { EvidenceAssignment } from "./evidence-assignment";
import { EvidenceFileRow } from "./evidence-files";
import {
  evidenceFixtureDetail,
  evidenceFixtureIds,
  evidenceFixtureMe,
} from "./evidence-fixtures";
import type { EvidenceApi, EvidenceDetailView } from "./evidence-types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

test("client and staff labels resolve from scoped lookups with generic fallbacks", async () => {
  const api = apiFor();
  api.clientName = vi.fn().mockResolvedValue({
    id: evidenceFixtureIds.client,
    label: "Example Client Ltd",
  });
  vi.mocked(api.owners!).mockResolvedValue([
    { id: evidenceFixtureIds.user, label: "Ada Okafor" },
  ]);
  await openDetail(api);
  await screen.findAllByText("Example Client Ltd");
  const metadata = screen.getByRole("region", { name: "Request details" });
  expect(within(metadata).getAllByText("Ada Okafor").length).toBe(2);
  expect(api.clientName).toHaveBeenCalledWith(
    evidenceFixtureIds.client,
    expect.any(AbortSignal),
  );
});

test("clean image previews revoke object URLs when closed", async () => {
  const api = apiFor();
  const create = vi.fn().mockReturnValue("blob:evidence-preview");
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(class extends URL {}, {
      createObjectURL: create,
      revokeObjectURL: revoke,
    }),
  );
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const file = {
    ...evidenceFixtureDetail.files[0],
    contentType: "image/png" as const,
    byteSize: bytes.length,
  };
  vi.mocked(api.download).mockResolvedValue(new Blob([bytes]));
  render(
    <ul>
      <EvidenceFileRow
        api={api}
        file={file}
        latest
        accepted={false}
        canReview={false}
        scanAvailable
        disabled={false}
        onChanged={vi.fn()}
      />
    </ul>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview image" }));
  await screen.findByRole("img", { name: `Evidence: ${file.filename}` });
  fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
  expect(screen.queryByRole("img")).toBeNull();
  expect(revoke).toHaveBeenCalledWith("blob:evidence-preview");
});

test("assignment uses a scoped owner and clearing deadline sends null with stable retries", async () => {
  const api = apiFor();
  const newOwner = "00000000-0000-4000-8000-000000000099";
  vi.mocked(api.owners!).mockResolvedValue([
    { id: newOwner, label: "Tunde Akin" },
  ]);
  vi.mocked(api.update).mockRejectedValueOnce(new TypeError("Network error"));
  const changed = vi.fn();
  render(
    <EvidenceAssignment
      api={api}
      detail={evidenceFixtureDetail}
      disabled={false}
      onChanged={changed}
      onDirty={vi.fn()}
      onBusy={vi.fn()}
      refresh={vi.fn()}
    />,
  );
  await screen.findByRole("option", { name: "Tunde Akin" });
  fireEvent.change(screen.getByRole("combobox", { name: "Request owner" }), {
    target: { value: newOwner },
  });
  fireEvent.change(screen.getByLabelText("Request deadline (optional)"), {
    target: { value: "" },
  });
  fireEvent.submit(screen.getByRole("form"));
  await screen.findByRole("button", { name: "Retry assignment" });
  fireEvent.click(screen.getByRole("button", { name: "Retry assignment" }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(vi.mocked(api.update).mock.calls[0]).toEqual(
    vi.mocked(api.update).mock.calls[1],
  );
  expect(vi.mocked(api.update).mock.calls[0][1]).toMatchObject({
    expectedVersion: 2,
    ownerId: newOwner,
    dueAt: null,
  });
});

test.each(["invoiceId", "filingId"] as const)(
  "central creation selects named %s records without UUID input",
  async (kind) => {
    const api = apiFor();
    const options = vi.fn().mockResolvedValue({
      items: [
        {
          id: evidenceFixtureIds.invoice,
          label: kind === "invoiceId" ? "INV-2026-09" : "VAT | 2026-09",
        },
      ],
      hasMore: false,
    });
    api.invoices = options;
    api.filings = options;
    render(
      <EvidenceCreate
        api={api}
        me={evidenceFixtureMe}
        client={{ id: evidenceFixtureIds.client, label: "Example Client Ltd" }}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Signed evidence" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Linked to" }), {
      target: { value: kind },
    });
    await screen.findByRole("option", {
      name: kind === "invoiceId" ? "INV-2026-09" : "VAT | 2026-09",
    });
    fireEvent.change(
      screen.getByRole("combobox", {
        name: kind === "invoiceId" ? "Invoice" : "Filing",
        exact: true,
      }),
      { target: { value: evidenceFixtureIds.invoice } },
    );
    expect(
      screen.queryByRole("textbox", { name: /Invoice ID|Filing ID/ }),
    ).toBeNull();
    fireEvent.submit(screen.getByRole("form"));
    await waitFor(() => expect(api.create).toHaveBeenCalledOnce());
    expect(vi.mocked(api.create).mock.calls[0][0]).toHaveProperty(
      kind,
      evidenceFixtureIds.invoice,
    );
    expect(options).toHaveBeenCalledWith(
      evidenceFixtureIds.client,
      "",
      0,
      expect.any(AbortSignal),
    );
  },
);

test("accepted requests can request changes, cancelled requests cannot review or reassign", async () => {
  const detail = structuredClone(evidenceFixtureDetail);
  detail.request.status = "accepted";
  const api = apiFor(detail);
  await openDetail(api);
  expect(screen.getByRole("option", { name: "Needs changes" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Edit assignment and deadline" }),
  ).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Review comment" }), {
    target: { value: "Please upload the complete document." },
  });
  const cancelled = structuredClone(detail);
  cancelled.request.status = "cancelled";
  vi.mocked(api.review).mockResolvedValue(cancelled);
  fireEvent.submit(screen.getByRole("form", { name: "Review evidence" }));
  await waitFor(() =>
    expect(screen.queryByRole("form", { name: "Review evidence" })).toBeNull(),
  );
});

test("scan errors remain quarantined and retries preserve the idempotency key", async () => {
  const api = apiFor();
  const file = {
    ...evidenceFixtureDetail.files[0],
    scanStatus: "quarantined" as const,
    scanError: "Unavailable",
  };
  vi.mocked(api.scan).mockRejectedValueOnce(new Error("Disconnected"));
  const changed = vi.fn();
  render(
    <ul>
      <EvidenceFileRow
        api={api}
        file={file}
        latest
        accepted={false}
        canReview
        scanAvailable
        disabled={false}
        onChanged={changed}
      />
    </ul>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry scan" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Retry scan" }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(vi.mocked(api.scan).mock.calls[0]).toEqual(
    vi.mocked(api.scan).mock.calls[1],
  );
  expect(
    screen.queryByRole("button", { name: "Download", exact: true }),
  ).toBeNull();
});

test("notification deep links load an authorised request directly", async () => {
  window.history.replaceState(
    null,
    "",
    `/?requestId=${evidenceFixtureIds.request}`,
  );
  const api = apiFor();
  render(<EvidenceHub api={api} me={evidenceFixtureMe} />);
  await screen.findByRole("heading", { name: "File versions (1)" });
  expect(api.detail).toHaveBeenCalledWith(
    evidenceFixtureIds.request,
    expect.any(AbortSignal),
  );
});
function apiFor(detail = structuredClone(evidenceFixtureDetail)): EvidenceApi {
  return {
    update: vi.fn().mockResolvedValue(detail),
    list: vi.fn().mockResolvedValue({
      items: [detail.request],
      total: 1,
      uploadAvailable: true,
      scanAvailable: true,
      notice: null,
    }),
    detail: vi.fn().mockResolvedValue(detail),
    create: vi.fn().mockResolvedValue(detail),
    upload: vi.fn().mockResolvedValue(detail),
    review: vi.fn().mockResolvedValue(detail),
    scan: vi.fn().mockResolvedValue(detail),
    assist: vi.fn().mockResolvedValue({
      summary: "Review the source.",
      checks: [],
      suggestedDocumentType: null,
      extractedText: null,
    }),
    download: vi.fn().mockResolvedValue(new Blob(["%PDF-test"])),
    pack: vi.fn().mockResolvedValue(new Blob(["PK\u0003\u0004"])),
    clients: vi
      .fn()
      .mockResolvedValue([
        { id: evidenceFixtureIds.client, label: "Example Client Ltd" },
      ]),
    owners: vi.fn().mockResolvedValue([]),
  };
}
async function openDetail(api: EvidenceApi, client = false) {
  render(
    <EvidenceHub
      api={api}
      me={
        client
          ? {
              ...evidenceFixtureMe,
              role: "client_user",
              clientPartyId: evidenceFixtureIds.client,
            }
          : evidenceFixtureMe
      }
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: /Delivery note for September/ }),
  );
  await screen.findByRole("heading", { name: "File versions (1)" });
}

test("dark or missing read capability makes no evidence calls", () => {
  const api = apiFor();
  const view = render(
    <EvidenceHub api={api} me={{ ...evidenceFixtureMe, features: [] }} />,
  );
  expect(api.list).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toMatch(/not yet enabled/);
  view.rerender(
    <EvidenceHub api={api} me={{ ...evidenceFixtureMe, capabilities: [] }} />,
  );
  expect(api.list).not.toHaveBeenCalled();
});

test.each(["firm_staff", "firm_admin"] as const)(
  "%s retains the client picker when its account carries a default client ID",
  async (role) => {
    const api = apiFor();
    api.clientName = vi.fn().mockResolvedValue({
      id: evidenceFixtureIds.client,
      label: "Example Client Ltd",
    });
    render(
      <EvidenceHub
        api={api}
        me={{
          ...evidenceFixtureMe,
          role,
          clientPartyId: evidenceFixtureIds.client,
          workspaceName: "Example Firm",
        }}
      />,
    );
    await screen.findByRole("combobox", { name: "Client", exact: true });
    const row = await screen.findByRole("button", {
      name: /Delivery note for September/,
    });
    await waitFor(() =>
      expect(row.textContent).toContain("Example Client Ltd"),
    );
    expect(row.textContent).not.toContain("Example Firm");
    expect(
      vi.mocked(api.list).mock.calls.at(-1)?.[0].clientPartyId,
    ).toBeUndefined();
  },
);

test("an embedded invoice's client wins over a staff account's default client", async () => {
  const api = apiFor();
  render(
    <EvidenceHub
      api={api}
      embedded
      invoiceId={evidenceFixtureIds.invoice}
      client={{ id: evidenceFixtureIds.client, label: "Invoice Client" }}
      me={{
        ...evidenceFixtureMe,
        role: "firm_staff",
        clientPartyId: "00000000-0000-4000-8000-000000000099",
        workspaceName: "Example Firm",
      }}
    />,
  );
  await screen.findByRole("button", { name: /Delivery note for September/ });
  expect(
    screen.queryByRole("combobox", { name: "Client", exact: true }),
  ).toBeNull();
  expect(vi.mocked(api.list).mock.calls.at(-1)?.[0].clientPartyId).toBe(
    evidenceFixtureIds.client,
  );
});

test("client scope and invoice scope are fixed; status filters reset pagination", async () => {
  const api = apiFor();
  vi.mocked(api.list).mockResolvedValue({
    items: [evidenceFixtureDetail.request],
    total: 42,
    uploadAvailable: true,
    scanAvailable: true,
    notice: null,
  });
  render(
    <EvidenceHub
      api={api}
      me={{
        ...evidenceFixtureMe,
        role: "client_user",
        clientPartyId: evidenceFixtureIds.client,
      }}
      invoiceId={evidenceFixtureIds.invoice}
      embedded
    />,
  );
  await screen.findByRole("button", { name: /Delivery note for September/ });
  expect(screen.queryByRole("combobox", { name: "Client" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() =>
    expect(api.list).toHaveBeenLastCalledWith(
      expect.objectContaining({
        offset: 20,
        limit: 20,
        invoiceId: evidenceFixtureIds.invoice,
        clientPartyId: evidenceFixtureIds.client,
      }),
      expect.any(AbortSignal),
    ),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Status" }), {
    target: { value: "needs_changes" },
  });
  await waitFor(() =>
    expect(api.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0, status: "needs_changes" }),
      expect.any(AbortSignal),
    ),
  );
});

test("client receives upload controls only, PDFs never preview, and dark scanning does not block uploads", async () => {
  const detail = structuredClone(evidenceFixtureDetail);
  detail.files[0].scanStatus = "quarantined";
  detail.files[0].scanError = "Provider unavailable";
  const api = apiFor(detail);
  vi.mocked(api.list).mockResolvedValue({
    items: [detail.request],
    total: 1,
    uploadAvailable: true,
    scanAvailable: false,
    notice: "Private uploads are available.",
  });
  await openDetail(api, true);
  expect(screen.getByRole("form", { name: "Upload evidence" })).toBeTruthy();
  expect(screen.queryByRole("form", { name: "Review evidence" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Request evidence" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Download", exact: true }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Preview image" })).toBeNull();
  expect(document.querySelector("iframe, object, embed, img")).toBeNull();
  expect(
    (screen.getByLabelText("PDF or photo (up to 5 MB)") as HTMLInputElement)
      .disabled,
  ).toBe(false);
});

test("failed upload retries the identical body and UUID, without sensitive storage", async () => {
  const api = apiFor();
  vi.mocked(api.upload).mockRejectedValueOnce(new TypeError("Network error"));
  const stored = vi.spyOn(Storage.prototype, "setItem");
  const changed = vi.fn();
  render(
    <EvidenceUpload
      api={api}
      detail={evidenceFixtureDetail}
      disabled={false}
      onChanged={changed}
      onDirty={vi.fn()}
      onBusy={vi.fn()}
      refresh={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText("PDF or photo (up to 5 MB)"), {
    target: {
      files: [
        new File(["%PDF-test"], "delivery.pdf", { type: "application/pdf" }),
      ],
    },
  });
  fireEvent.submit(screen.getByRole("form"));
  fireEvent.submit(screen.getByRole("form"));
  await screen.findByRole("button", { name: "Retry upload" });
  expect(api.upload).toHaveBeenCalledTimes(1);
  expect(
    (screen.getByLabelText("PDF or photo (up to 5 MB)") as HTMLInputElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry upload" }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(vi.mocked(api.upload).mock.calls[1]).toEqual(
    vi.mocked(api.upload).mock.calls[0],
  );
  expect(stored).not.toHaveBeenCalled();
});

test("creation has exactly one anchor, a bounded title and stable retry UUID", async () => {
  const api = apiFor();
  vi.mocked(api.create).mockRejectedValueOnce(new Error("Disconnected"));
  const created = vi.fn();
  render(
    <EvidenceCreate
      api={api}
      me={evidenceFixtureMe}
      client={{ id: evidenceFixtureIds.client, label: "Example Client Ltd" }}
      onClose={vi.fn()}
      onCreated={created}
    />,
  );
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "September receipt" },
  });
  fireEvent.change(screen.getByLabelText("Period"), {
    target: { value: "2026-09" },
  });
  fireEvent.submit(screen.getByRole("form"));
  await screen.findByRole("button", { name: "Retry request" });
  fireEvent.click(screen.getByRole("button", { name: "Retry request" }));
  await waitFor(() => expect(created).toHaveBeenCalledOnce());
  const calls = vi.mocked(api.create).mock.calls;
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0][0]).toMatchObject({
    period: "2026-09",
    title: "September receipt",
  });
  expect(calls[0][0]).not.toHaveProperty("invoiceId");
  expect(calls[0][0]).not.toHaveProperty("filingId");
});

test("acceptance requires latest clean file; cancellation requires a comment", async () => {
  const api = apiFor();
  const detail: EvidenceDetailView = {
    ...evidenceFixtureDetail,
    request: { ...evidenceFixtureDetail.request, latestFileId: "new-file" },
    files: [
      ...evidenceFixtureDetail.files,
      {
        ...evidenceFixtureDetail.files[0],
        id: "new-file",
        scanStatus: "quarantined",
      },
    ],
  };
  render(
    <EvidenceReview
      api={api}
      detail={detail}
      disabled={false}
      onChanged={vi.fn()}
      refresh={vi.fn()}
      onDirty={vi.fn()}
      onBusy={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText("Review file"), {
    target: { value: evidenceFixtureIds.file },
  });
  expect(
    (
      screen.getByRole("option", {
        name: "Accept evidence",
      }) as HTMLOptionElement
    ).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Decision"), {
    target: { value: "accepted" },
  });
  fireEvent.submit(screen.getByRole("form"));
  expect(api.review).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Decision"), {
    target: { value: "cancelled" },
  });
  fireEvent.submit(screen.getByRole("form"));
  expect(api.review).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Review comment"), {
    target: { value: "Duplicate request" },
  });
  fireEvent.submit(screen.getByRole("form"));
  await waitFor(() => expect(api.review).toHaveBeenCalledOnce());
  expect(vi.mocked(api.review).mock.calls[0][1]).toMatchObject({
    decision: "cancelled",
    comment: "Duplicate request",
    expectedVersion: 2,
  });
});

test("failed reviews preserve comment and idempotency, while conflicts refresh", async () => {
  const api = apiFor();
  const refresh = vi.fn();
  vi.mocked(api.review)
    .mockRejectedValueOnce(new Error("Disconnected"))
    .mockRejectedValueOnce({ status: 409 });
  render(
    <EvidenceReview
      api={api}
      detail={evidenceFixtureDetail}
      disabled={false}
      onChanged={vi.fn()}
      refresh={refresh}
      onDirty={vi.fn()}
      onBusy={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText("Review comment"), {
    target: { value: "Please include the signature." },
  });
  fireEvent.submit(screen.getByRole("form"));
  await screen.findByRole("button", { name: "Retry review" });
  fireEvent.click(screen.getByRole("button", { name: "Retry review" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(vi.mocked(api.review).mock.calls[0]).toEqual(
    vi.mocked(api.review).mock.calls[1],
  );
  expect(
    (screen.getByLabelText("Review comment") as HTMLTextAreaElement).value,
  ).toBe("Please include the signature.");
});

test("load errors focus a retry alert and recover; stale cross-scope reads are ignored", async () => {
  const api = apiFor();
  let resolveOld: (detail: EvidenceDetailView) => void = () => {};
  vi.mocked(api.detail).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const view = render(<EvidenceHub api={api} me={evidenceFixtureMe} />);
  fireEvent.click(
    await screen.findByRole("button", { name: /Delivery note for September/ }),
  );
  await screen.findByText("Loading evidence details...");
  view.rerender(
    <EvidenceHub
      api={api}
      me={{ ...evidenceFixtureMe, userId: "different-user", features: [] }}
    />,
  );
  await act(async () => resolveOld(evidenceFixtureDetail));
  expect(screen.queryByRole("dialog")).toBeNull();
  vi.mocked(api.list).mockRejectedValueOnce({ status: 503 });
  view.rerender(<EvidenceHub api={api} me={evidenceFixtureMe} />);
  const alert = await screen.findByRole("alert");
  await waitFor(() => expect(document.activeElement).toBe(alert));
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  await screen.findByRole("button", { name: /Delivery note for September/ });
});
