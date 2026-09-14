// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { useBusinessDetailsSaveScope } from "./business-details";

afterEach(cleanup);

const initial = {
  account: { userId: "user-a", firmId: "firm-a" },
  partyId: "party-a",
  canEdit: true,
  permissionError: undefined as unknown,
  party: { mergedIntoId: null as string | null },
};

test("equivalent account objects preserve the active save scope", () => {
  const view = renderHook(
    (props) =>
      useBusinessDetailsSaveScope(
        props.account,
        props.partyId,
        props.canEdit,
        props.permissionError,
        props.party,
      ),
    { initialProps: initial },
  );
  const original = view.result.current;
  view.rerender({
    ...initial,
    account: { ...initial.account },
    party: { ...initial.party },
  });
  expect(original.isCurrent()).toBe(true);
  expect(() => original.assertCurrent()).not.toThrow();
  view.unmount();
  expect(original.isCurrent()).toBe(false);
});

test.each([
  { account: { userId: "user-b", firmId: "firm-a" } },
  { account: { userId: "user-a", firmId: "firm-b" } },
  { partyId: "party-b" },
  { canEdit: false },
  { permissionError: new Error("Permission lookup failed") },
  { party: { mergedIntoId: "merged-party" } },
])("scope change %o permanently invalidates earlier saves", (change) => {
  const view = renderHook(
    (props) =>
      useBusinessDetailsSaveScope(
        props.account,
        props.partyId,
        props.canEdit,
        props.permissionError,
        props.party,
      ),
    { initialProps: initial, reactStrictMode: true },
  );
  const original = view.result.current;
  view.rerender({ ...initial, ...change });
  expect(original.isCurrent()).toBe(false);
  expect(() => original.assertCurrent()).toThrow("Business access changed");
  expect(view.result.current.isCurrent()).toBe(true);
  view.rerender(initial);
  expect(original.isCurrent()).toBe(false);
  expect(view.result.current.isCurrent()).toBe(true);
});
