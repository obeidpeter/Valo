import type { ReactNode } from "react";
import { Send, Sparkles } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

export interface ClerkActionRow {
  kind: string;
  title: string;
  why: string;
  targets: { id: string; text: string }[];
  notes: string[];
  approve: () => void;
  automate?: () => void;
}

export interface ClerkPolicyRow {
  id: string;
  kind: string;
  title: string;
  status: string;
  paused: boolean;
  toggle: () => void;
  revoke: () => void;
}

interface ClerkActionsPanelProps {
  testId: string;
  compact?: boolean;
  canAct: boolean;
  executePending: boolean;
  policyBusy: boolean;
  pausedCount: number;
  pausedPillClassName: string;
  emptyText: string | null;
  emptyTestId?: string;
  actions: ClerkActionRow[];
  policies: ClerkPolicyRow[];
  historyTitle: string;
  history: { id: string; text: string }[];
  note: string;
  children: ReactNode;
}

export function ClerkActionsPanel(props: ClerkActionsPanelProps) {
  return (
    <Card data-testid={props.testId}>
      <CardHeader>
        <CardTitle
          className={`flex items-center gap-2${props.compact ? " text-base" : ""}`}
        >
          <Sparkles className="w-5 h-5" aria-hidden="true" /> Clerk suggests
          {props.pausedCount > 0 && (
            <span
              className={`ml-auto ${props.pausedPillClassName}`}
              data-testid="pill-automation-paused"
            >
              {props.pausedCount} paused
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {props.emptyText && (
          <p
            className="text-sm text-muted-foreground"
            data-testid={props.emptyTestId}
          >
            {props.emptyText}
          </p>
        )}
        <ClerkProposals {...props} />
        <ClerkPolicies {...props} />
        {props.history.length > 0 && (
          <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground text-sm">
              {props.historyTitle}
            </p>
            {props.history.map((entry) => (
              <p key={entry.id} data-testid={`decision-${entry.id}`}>
                {entry.text}
              </p>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground pt-3 border-t">
          {props.note}
        </p>
      </CardContent>
      {props.children}
    </Card>
  );
}

function ClerkProposals({
  actions,
  canAct,
  executePending,
  policyBusy,
  compact,
}: Pick<
  ClerkActionsPanelProps,
  "actions" | "canAct" | "executePending" | "policyBusy" | "compact"
>) {
  return actions.map((action) => (
    <div
      key={action.kind}
      className="space-y-2"
      data-testid={`action-${action.kind}`}
    >
      <p className={`font-medium${compact ? " text-sm" : ""}`}>
        {action.title}
      </p>
      <p className="text-sm text-muted-foreground">{action.why}</p>
      <div className="space-y-1 text-xs text-muted-foreground">
        {action.targets.map((target) => (
          <p key={target.id} data-testid={`action-target-${target.id}`}>
            {target.text}
          </p>
        ))}
        {action.notes.map((note) => (
          <p key={note}>{note}</p>
        ))}
      </div>
      {canAct && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={action.approve}
            disabled={executePending}
            data-testid={`button-approve-${action.kind}`}
          >
            <Send className="w-4 h-4 mr-2" aria-hidden="true" /> Review &amp;
            approve
          </Button>
          {action.automate && (
            <Button
              size="sm"
              variant="outline"
              onClick={action.automate}
              disabled={policyBusy}
              data-testid={`button-automate-${action.kind}`}
            >
              Automate daily
            </Button>
          )}
        </div>
      )}
    </div>
  ));
}

function ClerkPolicies({
  policies,
  canAct,
  policyBusy,
}: Pick<ClerkActionsPanelProps, "policies" | "canAct" | "policyBusy">) {
  if (policies.length === 0) return null;
  return (
    <div className="space-y-2 border-t pt-3">
      <p className="font-medium text-foreground text-sm">Automation</p>
      {policies.map((policy) => (
        <div
          key={policy.id}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
          data-testid={`policy-${policy.kind}`}
        >
          <span className="font-medium text-foreground">{policy.title}</span>
          <span
            className={
              policy.paused
                ? "text-amber-700 dark:text-amber-400"
                : "text-muted-foreground"
            }
            data-testid={`text-policy-status-${policy.kind}`}
          >
            {policy.status}
          </span>
          {canAct && (
            <span className="ml-auto flex gap-1">
              <Button
                size="sm"
                variant="outline"
                onClick={policy.toggle}
                disabled={policyBusy}
                data-testid={`button-policy-${policy.paused ? "resume" : "pause"}-${policy.kind}`}
              >
                {policy.paused ? "Resume" : "Pause"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={policy.revoke}
                disabled={policyBusy}
                data-testid={`button-policy-revoke-${policy.kind}`}
              >
                Revoke
              </Button>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
