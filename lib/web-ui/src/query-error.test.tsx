// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryError } from "./query-error";

afterEach(cleanup);

test("announces the failure with readable dark-mode text and a labelled retry", () => {
  const retry = vi.fn();
  render(<QueryError thing="your invoices" onRetry={retry} />);
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("Unable to load your invoices.");
  expect(alert.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(screen.getByTestId("text-error").className).toContain(
    "dark:text-red-300",
  );
  expect(screen.queryByTestId("text-error-detail")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(retry).toHaveBeenCalledTimes(1);
});

test.each([undefined, null, ""])("omits an empty detail (%s)", (detail) => {
  render(<QueryError thing="records" detail={detail} onRetry={() => {}} />);
  expect(screen.queryByTestId("text-error-detail")).toBeNull();
});

test("renders detail as text and allows long unbroken content to wrap", () => {
  const detail = '<img src="missing" onerror="alert(1)">' + "x".repeat(300);
  render(<QueryError thing="records" detail={detail} onRetry={() => {}} />);
  const message = screen.getByTestId("text-error-detail");
  expect(message.textContent).toBe(detail);
  expect(message.querySelector("img")).toBeNull();
  expect(message.parentElement?.className).toContain("min-w-0");
  expect(message.parentElement?.className).toContain("break-words");
});

test("retrying inside a form never submits the surrounding form", () => {
  const retry = vi.fn();
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  render(
    <form onSubmit={submit}>
      <QueryError thing="records" onRetry={retry} />
    </form>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(retry).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
});
