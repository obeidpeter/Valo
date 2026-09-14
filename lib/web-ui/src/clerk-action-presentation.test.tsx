// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ClerkActionsPanel } from "./clerk-action-sections";
import {
  ClerkActionDialog,
  ClerkAutomationDialog,
} from "./clerk-action-dialogs";

afterEach(cleanup);

function panelProps() {
  return {
    testId: "test-clerk",
    canAct: true,
    executePending: false,
    policyBusy: false,
    pausedCount: 1,
    pausedPillClassName: "paused-tone",
    emptyText: null,
    actions: [
      {
        kind: "submit_overdue",
        title: "Submit overdue invoices",
        why: "Ready for review",
        targets: [{ id: "inv-1", text: "INV-001" }],
        notes: ["One more invoice"],
        approve: vi.fn(),
        automate: vi.fn(),
      },
    ],
    policies: [
      {
        id: "pol-1",
        kind: "retry_failed",
        title: "Retry failed submissions",
        status: "Paused by you",
        paused: true,
        toggle: vi.fn(),
        revoke: vi.fn(),
      },
    ],
    historyTitle: "Recent decisions",
    history: [{ id: "dec-1", text: "One invoice completed" }],
    note: "Approval required",
    children: null,
  };
}

describe("shared Clerk sections", () => {
  test("read-only adapters retain proposals, paused status and history without write controls", () => {
    render(<ClerkActionsPanel {...panelProps()} canAct={false} />);
    expect(screen.getByTestId("action-target-inv-1").textContent).toBe(
      "INV-001",
    );
    expect(screen.getByTestId("pill-automation-paused").textContent).toBe(
      "1 paused",
    );
    expect(
      screen.getByTestId("text-policy-status-retry_failed").textContent,
    ).toBe("Paused by you");
    expect(screen.getByTestId("decision-dec-1").textContent).toBe(
      "One invoice completed",
    );
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  test("writable adapters receive only the selected action and policy commands", () => {
    const props = panelProps();
    const { rerender } = render(<ClerkActionsPanel {...props} />);
    fireEvent.click(screen.getByTestId("button-approve-submit_overdue"));
    fireEvent.click(screen.getByTestId("button-automate-submit_overdue"));
    fireEvent.click(screen.getByTestId("button-policy-resume-retry_failed"));
    fireEvent.click(screen.getByTestId("button-policy-revoke-retry_failed"));
    expect(props.actions[0].approve).toHaveBeenCalledOnce();
    expect(props.actions[0].automate).toHaveBeenCalledOnce();
    expect(props.policies[0].toggle).toHaveBeenCalledOnce();
    expect(props.policies[0].revoke).toHaveBeenCalledOnce();
    rerender(
      <ClerkActionsPanel
        {...props}
        policies={[{ ...props.policies[0], paused: false }]}
      />,
    );
    fireEvent.click(screen.getByTestId("button-policy-pause-retry_failed"));
    expect(props.policies[0].toggle).toHaveBeenCalledTimes(2);
  });

  test("pending commands cannot be resubmitted from the shared controls", () => {
    const props = panelProps();
    render(<ClerkActionsPanel {...props} executePending policyBusy />);
    for (const button of screen.getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(props.actions[0].approve).not.toHaveBeenCalled();
    expect(props.actions[0].automate).not.toHaveBeenCalled();
    expect(props.policies[0].toggle).not.toHaveBeenCalled();
    expect(props.policies[0].revoke).not.toHaveBeenCalled();
  });
});

function actionDialogProps() {
  return {
    open: true,
    close: vi.fn(),
    pending: false,
    canAct: true,
    title: "Submit one invoice",
    description: "A scoped approval description",
    confirmLabel: "Approve one invoice",
    confirm: vi.fn(),
    result: null,
    drafts: [],
    draftInstructions: "Copy for your client to send",
  };
}

describe("shared Clerk dialogs", () => {
  test("confirmation preserves accessible names and app callbacks", () => {
    const props = actionDialogProps();
    render(<ClerkActionDialog {...props} />);
    const dialog = screen.getByRole("dialog", {
      name: "Approve: Submit one invoice",
    });
    const description = document.getElementById(
      dialog.getAttribute("aria-describedby")!,
    );
    expect(description?.textContent).toBe(props.description);
    fireEvent.click(
      screen.getByRole("button", { name: "Approve one invoice" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.confirm).toHaveBeenCalledOnce();
    expect(props.close).toHaveBeenCalledOnce();
  });

  test.each([
    { pending: true, canAct: true },
    { pending: false, canAct: false },
  ])(
    "blocks confirmation with $pending pending and $canAct permission",
    (gate) => {
      const props = actionDialogProps();
      render(<ClerkActionDialog {...props} {...gate} />);
      const button = screen.getByTestId(
        "button-confirm-action",
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
      expect(props.confirm).not.toHaveBeenCalled();
    },
  );

  test("results show mapped outcomes and transient drafts through app callbacks", () => {
    const props = actionDialogProps();
    const copy = vi.fn();
    render(
      <ClerkActionDialog
        {...props}
        result={{
          summary: "One reminder drafted",
          outcomes: [
            {
              id: "inv-1",
              invoiceNumber: "INV-001",
              label: "Drafted",
              className: "success-tone",
            },
          ],
        }}
        drafts={[
          {
            id: "inv-1",
            subject: "Payment reminder",
            detail: "INV-001 to Buyer",
            body: "Please arrange payment.",
            copy,
          },
        ]}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Batch result" })).toBeTruthy();
    expect(screen.getByTestId("outcome-inv-1").textContent).toBe(
      "INV-001Drafted",
    );
    expect(screen.getByText(props.draftInstructions)).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-copy-draft-inv-1"));
    fireEvent.click(screen.getByTestId("button-close-action"));
    expect(copy).toHaveBeenCalledOnce();
    expect(props.close).toHaveBeenCalledOnce();
    expect(props.confirm).not.toHaveBeenCalled();
  });

  test("automation labels the cap, leads with evidence, and keeps validation with the controller", () => {
    const confirm = vi.fn();
    const setCap = vi.fn();
    const props = {
      open: true,
      close: vi.fn(),
      title: "Submit overdue",
      evidence: "Your own record",
      description: "Scoped daily consent",
      cap: "",
      setCap,
      min: 1,
      max: 50,
      pending: false,
      canAct: true,
      valid: false,
      confirm,
    };
    const { rerender } = render(<ClerkAutomationDialog {...props} />);
    const input = screen.getByRole("spinbutton", {
      name: "Daily limit (invoices per run)",
    });
    fireEvent.change(input, { target: { value: "12" } });
    expect(setCap).toHaveBeenCalledWith("12");
    const button = screen.getByTestId(
      "button-confirm-automate",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(confirm).not.toHaveBeenCalled();
    const evidence = screen.getByTestId("text-policy-evidence");
    expect(
      evidence.compareDocumentPosition(screen.getByText(props.description)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    rerender(<ClerkAutomationDialog {...props} cap="12" valid />);
    fireEvent.click(screen.getByTestId("button-confirm-automate"));
    expect(confirm).toHaveBeenCalledOnce();
  });
});
