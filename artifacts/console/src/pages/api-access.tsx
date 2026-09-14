import { ExternalLink } from "lucide-react";
import { usePageTitle } from "@/hooks/use-page-title";
import { ApiKeysCard } from "./api-access/api-keys-card";
import { WebhooksCard } from "./api-access/webhooks-card";

// The route's RoleGate and server both require firm_admin for integration access.
export function ApiAccess() {
  usePageTitle("API & webhooks");
  return (
    <div className="space-y-6">
      <div>
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          API &amp; webhooks
        </h1>
        <p className="text-muted-foreground mt-1">
          Machine access for your firm: API keys your integrations authenticate
          with, and webhook endpoints we push events to. Secrets are shown once
          at creation and never again.
        </p>
        <a
          href="/console/api-reference.html"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid="link-api-reference"
        >
          API reference
          <ExternalLink className="w-3 h-3" aria-hidden="true" />
        </a>
      </div>
      <ApiKeysCard />
      <WebhooksCard />
    </div>
  );
}
