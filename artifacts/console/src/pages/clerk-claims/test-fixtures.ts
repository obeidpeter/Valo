import type { ClaimRecord } from "@workspace/api-client-react";

export function claimFixture(
  overrides: Partial<ClaimRecord> = {},
): ClaimRecord {
  return {
    id: "claim-1",
    claimKey: "vat.standard_rate",
    version: 2,
    state: "draft",
    title: "Standard VAT rate",
    proposition: "The standard VAT rate is {rate}.",
    protectedFacts: [
      { key: "rate", label: "VAT rate", kind: "rate", value: "7.5", unit: "%" },
    ],
    citation: "VAT Act, s.4",
    applicability: {},
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveTo: null,
    reviewDueAt: null,
    createdBy: "maker-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
