import {
  MACHINE_CAPABILITIES,
  WEBHOOK_EVENTS,
  type MachineCapability,
  type WebhookEvent,
} from "@workspace/api-zod/integrations";

// Copy is exhaustive over the shared server/browser contract; adding a value
// requires its label here, while ordering and membership come from the contract.
type IntegrationOptionCopy = { label: string; description: string };
const MACHINE_CAPABILITY_COPY = {
  "invoice.read": {
    label: "Read invoices",
    description: "Pull invoice data and statuses.",
  },
  "invoice.write": {
    label: "Write draft invoices",
    description:
      "Create and edit drafts. A person must still submit invoices to the submission service.",
  },
  "statement.write": {
    label: "Upload bank statements",
    description: "Upload statement files for reconciliation.",
  },
} satisfies Record<MachineCapability, IntegrationOptionCopy>;

const WEBHOOK_EVENT_COPY = {
  "invoice.stamped": {
    label: "Invoice stamped",
    description:
      "An invoice was accepted and stamped by the submission service.",
  },
  "invoice.settled": {
    label: "Invoice settled",
    description: "A payment was matched and the invoice settled.",
  },
  "statement.reconciled": {
    label: "Statement reconciled",
    description: "A bank statement finished its reconciliation pass.",
  },
} satisfies Record<WebhookEvent, IntegrationOptionCopy>;

export const MACHINE_CAPABILITY_OPTIONS = MACHINE_CAPABILITIES.map((value) => ({
  value,
  ...MACHINE_CAPABILITY_COPY[value],
}));

export const WEBHOOK_EVENT_OPTIONS = WEBHOOK_EVENTS.map((value) => ({
  value,
  ...WEBHOOK_EVENT_COPY[value],
}));

/**
 * The receiver-side verification recipe. The stored sha256 of the secret IS
 * the HMAC key (the raw secret is never kept), so the note must say exactly
 * that — a receiver who keys the HMAC with the raw secret will reject every
 * genuine delivery.
 */
export const SIGNATURE_NOTE =
  "Each delivery carries an X-Valo-Signature header: HMAC-SHA256 of the body keyed by sha256 of your secret (hash your stored secret once, then verify each request body against the header). The legacy X-Meridian-Signature header remains available for existing integrations.";
