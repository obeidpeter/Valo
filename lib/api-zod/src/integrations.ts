// Browser-safe integration contracts. Keep permissions, credentials and UI copy
// in their owning applications; these are the values accepted by the server.
export const MACHINE_CAPABILITIES = Object.freeze([
  "invoice.read",
  "invoice.write",
  "statement.write",
] as const);

export type MachineCapability = (typeof MACHINE_CAPABILITIES)[number];

export const WEBHOOK_EVENTS = Object.freeze([
  "invoice.stamped",
  "invoice.settled",
  "statement.reconciled",
] as const);

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
