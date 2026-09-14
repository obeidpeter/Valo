import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CATEGORIES } from "./helpers";
import type { CategoryOption, ClaimForm } from "./types";
import { FactsEditor } from "./facts-editor";

// The one claim form, shared by the "new version" panel and the draft-edit
// dialog. claimKey is immutable once a draft exists (a new key means a new
// draft, not an edit).
export function ClaimFormFields({
  form,
  setForm,
  keyLocked,
}: {
  form: ClaimForm;
  setForm: (form: ClaimForm) => void;
  keyLocked: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="claim-key">Claim key</Label>
          <Input
            id="claim-key"
            placeholder="vat.standard_rate"
            value={form.claimKey}
            disabled={keyLocked}
            onChange={(e) => setForm({ ...form, claimKey: e.target.value })}
            data-testid="input-claim-key"
          />
          <p className="text-xs text-muted-foreground">
            Reuse an existing key to draft the next version of that claim.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="claim-title">Title</Label>
          <Input
            id="claim-title"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            data-testid="input-claim-title"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="claim-proposition">Proposition</Label>
        <Textarea
          id="claim-proposition"
          value={form.proposition}
          onChange={(e) => setForm({ ...form, proposition: e.target.value })}
          placeholder="The standard VAT rate on taxable supplies is {rate}."
          data-testid="input-claim-proposition"
        />
        <p className="text-xs text-muted-foreground">
          Reference facts as {"{key}"} placeholders — they are rendered verbatim
          from the protected facts below.
        </p>
      </div>
      <div className="space-y-1">
        <Label>Protected facts</Label>
        <FactsEditor
          facts={form.facts}
          onChange={(facts) => setForm({ ...form, facts })}
        />
      </div>
      <div className="grid sm:grid-cols-4 gap-3">
        <div className="space-y-1">
          <Label htmlFor="claim-citation">Citation</Label>
          <Input
            id="claim-citation"
            placeholder="VAT Act, s.4"
            value={form.citation}
            onChange={(e) => setForm({ ...form, citation: e.target.value })}
            data-testid="input-claim-citation"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="claim-from">Effective from</Label>
          <Input
            id="claim-from"
            type="date"
            value={form.effectiveFrom}
            onChange={(e) =>
              setForm({ ...form, effectiveFrom: e.target.value })
            }
            data-testid="input-claim-from"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="claim-to">Effective to (optional)</Label>
          <Input
            id="claim-to"
            type="date"
            value={form.effectiveTo}
            onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })}
            data-testid="input-claim-to"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="claim-review-due">Review due (optional)</Label>
          <Input
            id="claim-review-due"
            type="date"
            value={form.reviewDueAt}
            onChange={(e) => setForm({ ...form, reviewDueAt: e.target.value })}
            data-testid="input-claim-review-due"
          />
        </div>
        <div className="space-y-1">
          <Label>Category</Label>
          <Select
            value={form.category}
            onValueChange={(v) =>
              setForm({ ...form, category: v as CategoryOption })
            }
          >
            <SelectTrigger
              aria-label="Applicability category"
              data-testid="select-claim-category"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c === "none" ? "Any (no category)" : c.toUpperCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
