import type {
  ClaimDecisionInputAction,
  ProtectedFact,
} from "@workspace/api-client-react";

// "none" is a UI-only sentinel because Radix Select cannot hold an empty value.
export const CATEGORIES = ["none", "b2b", "b2g", "b2c"] as const;

export type CategoryOption = (typeof CATEGORIES)[number];

export interface ClaimForm {
  claimKey: string;
  title: string;
  proposition: string;
  citation: string;
  effectiveFrom: string;
  effectiveTo: string;
  reviewDueAt: string;
  category: CategoryOption;
  facts: ProtectedFact[];
}

export type DecisionAction = Extract<
  ClaimDecisionInputAction,
  "approve" | "reject" | "suspend"
>;
