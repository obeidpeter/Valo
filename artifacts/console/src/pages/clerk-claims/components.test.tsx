// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ClaimFormFields } from "./claim-form-fields";
import { ClaimDetail } from "./claim-detail";
import { FactsEditor } from "./facts-editor";
import { factsPayload, formFromClaim, formInvalid } from "./helpers";
import { claimFixture } from "./test-fixtures";

afterEach(cleanup);

describe("protected facts editor", () => {
  test("edits immutably, adds a text fact, and cannot remove the last fact", () => {
    const original = claimFixture().protectedFacts;
    function Editor() {
      const [facts, setFacts] = useState(original);
      return <FactsEditor facts={facts} onChange={setFacts} />;
    }
    render(<Editor />);
    const remove = () =>
      screen.getByLabelText("Remove fact 1") as HTMLButtonElement;
    expect(remove().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Fact 1 value"), {
      target: { value: "8" },
    });
    expect(original[0].value).toBe("7.5");
    fireEvent.click(screen.getByTestId("button-add-fact"));
    expect(remove().disabled).toBe(false);
    expect(screen.getByLabelText("Fact 2 kind").textContent).toBe("text");
    for (const [field, value] of Object.entries({
      key: "count",
      label: "Count",
      value: "2",
      unit: "items",
    })) {
      fireEvent.change(screen.getByLabelText(`Fact 2 ${field}`), {
        target: { value },
      });
    }
    fireEvent.click(remove());
    expect(
      (screen.getByLabelText("Fact 1 key") as HTMLInputElement).value,
    ).toBe("count");
    expect(screen.queryByTestId("row-fact-1")).toBeNull();
    expect(remove().disabled).toBe(true);
  });
});

describe("shared claim form", () => {
  test("locks only the existing claim key and preserves other fields during edits", () => {
    function Form({ keyLocked }: { keyLocked: boolean }) {
      const [form, setForm] = useState(formFromClaim(claimFixture()));
      return (
        <ClaimFormFields form={form} setForm={setForm} keyLocked={keyLocked} />
      );
    }
    const view = render(<Form keyLocked />);
    expect(
      (screen.getByLabelText("Claim key") as HTMLInputElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Edited title" },
    });
    fireEvent.change(screen.getByLabelText("Review due (optional)"), {
      target: { value: "2026-12-01" },
    });
    fireEvent.change(screen.getByLabelText("Fact 1 label"), {
      target: { value: "Protected rate" },
    });
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Edited title",
    );
    expect(
      (screen.getByLabelText("Review due (optional)") as HTMLInputElement)
        .value,
    ).toBe("2026-12-01");
    expect(
      (screen.getByLabelText("Proposition") as HTMLTextAreaElement).value,
    ).toBe(claimFixture().proposition);
    expect(screen.getByLabelText("Applicability category").textContent).toBe(
      "Any (no category)",
    );
    view.rerender(<Form keyLocked={false} />);
    expect(
      (screen.getByLabelText("Claim key") as HTMLInputElement).disabled,
    ).toBe(false);
  });

  test("keeps validation, date/category normalization, and fact payload semantics", () => {
    const claim = claimFixture({
      applicability: { category: "b2g" },
      reviewDueAt: "2026-12-01T00:00:00Z",
      effectiveTo: "2027-01-01T00:00:00Z",
    });
    const form = formFromClaim(claim);
    expect(form).toMatchObject({
      category: "b2g",
      effectiveFrom: "2026-01-01",
      effectiveTo: "2027-01-01",
      reviewDueAt: "2026-12-01",
    });
    expect(form.facts[0]).not.toBe(claim.protectedFacts[0]);
    expect(formInvalid(form)).toBe(false);
    for (const patch of [
      { claimKey: " x " },
      { title: " x " },
      { proposition: "short" },
      { citation: " x " },
      { effectiveFrom: "" },
      { facts: [] },
      { facts: [{ ...form.facts[0], value: " " }] },
      { facts: [{ ...form.facts[0], key: " " }] },
      { facts: [{ ...form.facts[0], label: " " }] },
    ])
      expect(formInvalid({ ...form, ...patch })).toBe(true);
    expect(formFromClaim(claimFixture({ protectedFacts: [] })).facts).toEqual([
      { key: "", label: "", kind: "rate", value: "", unit: "" },
    ]);
    expect(
      factsPayload([
        {
          key: " rate ",
          label: " Rate ",
          kind: "rate",
          value: " 7.5 ",
          unit: "  ",
        },
      ]),
    ).toEqual([
      {
        key: "rate",
        label: "Rate",
        kind: "rate",
        value: "7.5",
        unit: undefined,
      },
    ]);
  });
});

describe("claim detail", () => {
  test("renders the proposition verbatim with protected values and decision note", () => {
    render(
      <ClaimDetail
        claim={claimFixture({ decisionNote: "Checked against the statute." })}
      />,
    );
    expect(screen.getByText("The standard VAT rate is {rate}.")).toBeTruthy();
    expect(screen.getByText("7.5 %")).toBeTruthy();
    expect(
      screen.getByText("Decision note: Checked against the statute."),
    ).toBeTruthy();
  });

  test("retains the empty-facts message and omits an absent decision note", () => {
    render(
      <ClaimDetail
        claim={claimFixture({ protectedFacts: [], decisionNote: null })}
      />,
    );
    expect(
      screen.getByText("No protected facts on this version."),
    ).toBeTruthy();
    expect(screen.queryByText(/Decision note:/)).toBeNull();
  });
});
