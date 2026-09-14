import type {
  ProtectedFact,
  ProtectedFactKind,
} from "@workspace/api-client-react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FACT_KINDS } from "./helpers";

export function FactsEditor({
  facts,
  onChange,
}: {
  facts: ProtectedFact[];
  onChange: (facts: ProtectedFact[]) => void;
}) {
  const set = (i: number, patch: Partial<ProtectedFact>) =>
    onChange(facts.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <div className="space-y-2">
      {facts.map((fact, i) => (
        <div
          key={i}
          className="grid grid-cols-12 gap-2"
          data-testid={`row-fact-${i}`}
        >
          <div className="col-span-2">
            <Input
              placeholder="key"
              value={fact.key}
              onChange={(e) => set(i, { key: e.target.value })}
              aria-label={`Fact ${i + 1} key`}
              data-testid={`input-fact-key-${i}`}
            />
          </div>
          <div className="col-span-3">
            <Input
              placeholder="Label"
              value={fact.label}
              onChange={(e) => set(i, { label: e.target.value })}
              aria-label={`Fact ${i + 1} label`}
              data-testid={`input-fact-label-${i}`}
            />
          </div>
          <div className="col-span-2">
            <Select
              value={fact.kind}
              onValueChange={(v) => set(i, { kind: v as ProtectedFactKind })}
            >
              <SelectTrigger
                aria-label={`Fact ${i + 1} kind`}
                data-testid={`select-fact-kind-${i}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FACT_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2">
            <Input
              placeholder="Value"
              value={fact.value}
              onChange={(e) => set(i, { value: e.target.value })}
              aria-label={`Fact ${i + 1} value`}
              data-testid={`input-fact-value-${i}`}
            />
          </div>
          <div className="col-span-2">
            <Input
              placeholder="Unit"
              value={fact.unit ?? ""}
              onChange={(e) => set(i, { unit: e.target.value })}
              aria-label={`Fact ${i + 1} unit`}
              data-testid={`input-fact-unit-${i}`}
            />
          </div>
          <div className="col-span-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onChange(facts.filter((_, j) => j !== i))}
              disabled={facts.length === 1}
              aria-label={`Remove fact ${i + 1}`}
              data-testid={`button-remove-fact-${i}`}
            >
              <Trash2 className="w-4 h-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() =>
          onChange([
            ...facts,
            { key: "", label: "", kind: "text", value: "", unit: "" },
          ])
        }
        data-testid="button-add-fact"
      >
        <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> Add fact
      </Button>
    </div>
  );
}
