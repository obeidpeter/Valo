// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SecretPanel } from "./secret-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("copies the exact secret, resets feedback, and clears the feedback timer on unmount", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const view = render(<SecretPanel secret="test-key-only" what="API key" />);
  expect(screen.getByRole("alert").textContent).toContain("shown once");
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Copy API key" })),
  );
  expect(writeText).toHaveBeenCalledWith("test-key-only");
  expect(screen.getByText("Copied")).toBeTruthy();
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.queryByText("Copied")).toBeNull();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Copy API key" })),
  );
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test("clipboard rejection keeps the secret available without claiming it was copied", async () => {
  const writeText = vi
    .fn()
    .mockRejectedValue(new Error("Clipboard permission denied"));
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(
    <SecretPanel
      secret="test-signing-only"
      what="signing secret"
      note="Signing instructions"
    />,
  );
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Copy signing secret" }),
    ),
  );
  expect(screen.queryByText("Copied")).toBeNull();
  expect(screen.getByTestId("text-shown-once-secret").textContent).toBe(
    "test-signing-only",
  );
  expect(screen.getByText("Signing instructions")).toBeTruthy();
});

test("a browser without clipboard support still exposes a selectable secret", () => {
  vi.stubGlobal("navigator", {});
  render(<SecretPanel secret="test-manual-copy" what="API key" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy API key" }));
  expect(screen.queryByText("Copied")).toBeNull();
  expect(screen.getByTestId("text-shown-once-secret").textContent).toBe(
    "test-manual-copy",
  );
});
