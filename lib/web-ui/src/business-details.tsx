import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { RotateCcw, Save } from "lucide-react";
import { LiveStatus } from "./live-status";
import { useUnsavedWork } from "./unsaved-work";

export interface BusinessDetailsRecord {
  id: string;
  legalName: string;
  tin?: string | null;
  cacNumber?: string | null;
  street?: string | null;
  city?: string | null;
  countryCode: string;
  /** The server's updatedAt; when present it rides every save as the
   *  optimistic-concurrency stamp (R113). */
  updatedAt?: string;
}

export type BusinessDetailsPatch = Partial<
  Omit<BusinessDetailsRecord, "id" | "updatedAt">
> & {
  /** The stamp of the record the user edited, so a newer save by someone
   *  else answers 409 instead of being overwritten. */
  expectedUpdatedAt?: string;
};

export function useBusinessDetailsSaveScope(
  account: { userId: string; firmId?: string | null } | undefined,
  partyId: string,
  canEdit: boolean,
  permissionError: unknown,
  party: { mergedIntoId?: string | null } | undefined,
) {
  const key = JSON.stringify([account?.userId, account?.firmId, partyId]);
  const scope = JSON.stringify([
    key,
    canEdit,
    Boolean(permissionError),
    party?.mergedIntoId,
  ]);
  const token = useMemo(() => ({ scope }), [scope]);
  const active = useRef<object | null>(token);
  useLayoutEffect(() => {
    active.current = token;
    return () => {
      active.current = null;
    };
  }, [token]);
  const isCurrent = () => active.current === token;
  const assertCurrent = () => {
    if (!isCurrent())
      throw new Error(
        "Business access changed. Review this account before saving again.",
      );
  };
  return { key, isCurrent, assertCurrent };
}

const fields = [
  {
    key: "legalName",
    label: "Legal business name",
    autoComplete: "organization",
  },
  { key: "tin", label: "Tax identification number (TIN)", autoComplete: "off" },
  { key: "cacNumber", label: "CAC number", autoComplete: "off" },
  { key: "street", label: "Street address", autoComplete: "street-address" },
  { key: "city", label: "City", autoComplete: "address-level2" },
  { key: "countryCode", label: "Country code", autoComplete: "country" },
] as const;
type Field = (typeof fields)[number]["key"];
type Values = Record<Field, string>;
type Errors = Partial<Record<Field, string>>;

function valuesFor(party: BusinessDetailsRecord): Values {
  return {
    legalName: party.legalName,
    tin: party.tin ?? "",
    cacNumber: party.cacNumber ?? "",
    street: party.street ?? "",
    city: party.city ?? "",
    countryCode: party.countryCode,
  };
}

function sameValues(a: Values, b: Values) {
  return fields.every(({ key }) => a[key] === b[key]);
}

function normalize(key: Field, value: string): string {
  if (key === "tin") return value.trim().replace(/\s+/g, "");
  if (key === "cacNumber")
    return value.trim().toUpperCase().replace(/\s+/g, "");
  if (key === "countryCode") return value.trim().toUpperCase();
  return value.trim();
}

function changedFields(baseline: Values, values: Values): BusinessDetailsPatch {
  const patch: BusinessDetailsPatch = {};
  for (const { key } of fields) {
    const value = normalize(key, values[key]);
    if (value === normalize(key, baseline[key])) continue;
    if (key === "legalName" || key === "countryCode") patch[key] = value;
    else patch[key] = value || null;
  }
  return patch;
}

function validate(patch: BusinessDetailsPatch): Errors {
  const errors: Errors = {};
  if (patch.legalName !== undefined && !patch.legalName) {
    errors.legalName = "Enter the legal business name.";
  }
  // Match the server's structural checks; these do not establish registry verification.
  if (patch.tin && !/^\d{8,10}(-\d{4})?$/.test(patch.tin)) {
    errors.tin =
      "Enter 8 to 10 digits, optionally followed by a hyphen and 4 digits.";
  }
  if (patch.cacNumber && !/^(RC|BN)\d{2,8}$/.test(patch.cacNumber)) {
    errors.cacNumber = "Enter RC or BN followed by 2 to 8 digits.";
  }
  if (
    patch.countryCode !== undefined &&
    !/^[A-Z]{2}$/.test(patch.countryCode)
  ) {
    errors.countryCode = "Enter a two-letter country code, such as NG.";
  }
  return errors;
}

export function BusinessDetailsForm(props: {
  party: BusinessDetailsRecord;
  onSave: (patch: BusinessDetailsPatch) => Promise<BusinessDetailsRecord>;
  disabledReason?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  return <BusinessDetailsEditor key={props.party.id} {...props} />;
}

function BusinessDetailsEditor({
  party,
  onSave,
  disabledReason,
  onDirtyChange,
}: {
  party: BusinessDetailsRecord;
  onSave: (patch: BusinessDetailsPatch) => Promise<BusinessDetailsRecord>;
  disabledReason?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const id = useId();
  const [observedParty, setObservedParty] = useState(party);
  const [latestSaved, setLatestSaved] = useState(() => valuesFor(party));
  const [latestStamp, setLatestStamp] = useState(party.updatedAt);
  const [baseline, setBaseline] = useState(() => valuesFor(party));
  // The stamp travels with the baseline, never with the latest refetch: a
  // newer record that arrived while the user was typing is exactly the case
  // the server must refuse.
  const [baselineStamp, setBaselineStamp] = useState(party.updatedAt);
  const [values, setValues] = useState(() => valuesFor(party));
  const [errors, setErrors] = useState<Errors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const savePromise = useRef<Promise<boolean> | null>(null);
  const lifetime = useRef(0);
  const inputs = useRef<Partial<Record<Field, HTMLInputElement | null>>>({});
  const dirty = !sameValues(baseline, values);
  const patch = changedFields(baseline, values);
  const newerDetails = dirty && !sameValues(latestSaved, baseline);

  useLayoutEffect(() => {
    lifetime.current += 1;
    return () => {
      lifetime.current += 1;
    };
  }, [disabledReason]);

  useUnsavedWork({ dirty, save, discard, disabledReason });

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  // Adopt new records only when pristine. Tracking the observed object also
  // prevents a stale prop from undoing the just-returned PATCH response.
  if (observedParty !== party) {
    setObservedParty(party);
    setLatestSaved(valuesFor(party));
    setLatestStamp(party.updatedAt);
    if (!dirty && !savingRef.current) {
      setBaseline(valuesFor(party));
      setValues(valuesFor(party));
      setBaselineStamp(party.updatedAt);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save();
  }

  function discard() {
    if (savingRef.current) return false;
    setBaseline(latestSaved);
    setValues(latestSaved);
    setBaselineStamp(latestStamp);
    setErrors({});
    setSaveError(null);
    setSaved(false);
    return true;
  }

  function save(): Promise<boolean> {
    if (savePromise.current) return savePromise.current;
    if (disabledReason) return Promise.resolve(false);
    // Whitespace/case-only edits have no server patch, but are safe to leave
    // only after explicitly normalizing them back to the saved baseline.
    if (!Object.keys(patch).length) {
      setValues(baseline);
      return Promise.resolve(true);
    }
    const nextErrors = validate(patch);
    setErrors(nextErrors);
    const invalid = fields.find(({ key }) => nextErrors[key]);
    if (invalid) {
      inputs.current[invalid.key]?.focus();
      return Promise.resolve(false);
    }
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    const version = lifetime.current;
    const promise = persist(version);
    savePromise.current = promise;
    void promise.then(() => {
      if (savePromise.current === promise) savePromise.current = null;
    });
    return promise;
  }

  async function persist(version: number): Promise<boolean> {
    try {
      const updated = await onSave(
        baselineStamp ? { ...patch, expectedUpdatedAt: baselineStamp } : patch,
      );
      if (version !== lifetime.current) return false;
      if (updated.id !== party.id)
        throw new Error(
          "The saved business record did not match this business.",
        );
      setBaseline(valuesFor(updated));
      setValues(valuesFor(updated));
      setLatestSaved(valuesFor(updated));
      setLatestStamp(updated.updatedAt);
      setBaselineStamp(updated.updatedAt);
      setSaved(true);
      return true;
    } catch (error) {
      if (version !== lifetime.current) return false;
      setSaveError(
        error instanceof Error
          ? error.message
          : "Business details could not be saved. Please try again.",
      );
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <form
      aria-label="Business details"
      className="grid max-w-2xl gap-5"
      onSubmit={submit}
      noValidate
      aria-busy={saving}
    >
      {disabledReason ? (
        <p role="alert" className="text-sm text-destructive">
          {disabledReason}
        </p>
      ) : null}
      <div className="space-y-2 text-sm">
        {/* Present from the first render so the 409 notice is announced as a
            change rather than a freshly mounted region (R115). */}
        <LiveStatus className="text-muted-foreground">
          {newerDetails
            ? "Newer saved details are available. Your unsaved changes have not been replaced."
            : null}
        </LiveStatus>
        {newerDetails ? (
          <details>
            <summary className="min-h-11 cursor-pointer py-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Review newer saved details
            </summary>
            <dl className="space-y-3">
              {fields
                .filter(({ key }) => latestSaved[key] !== baseline[key])
                .map(({ key, label }) => (
                  <div key={key} className="min-w-0 space-y-1 break-words">
                    <dt className="font-medium">{label}</dt>
                    <dd className="m-0">
                      Latest saved: {latestSaved[key] || "Not provided"}
                    </dd>
                    <dd className="m-0">
                      Your value: {values[key] || "Not provided"}
                    </dd>
                  </div>
                ))}
            </dl>
          </details>
        ) : null}
      </div>
      {saveError ? (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      ) : null}
      {Object.values(errors).some(Boolean) ? (
        <p role="alert" className="text-sm text-destructive">
          Correct the highlighted business details.
        </p>
      ) : null}
      <fieldset
        disabled={saving || Boolean(disabledReason)}
        className="m-0 min-w-0 space-y-4 border-0 p-0"
      >
        <legend className="mi-sr-only">Business identity and address</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map(({ key, label, autoComplete }) => (
            <div
              key={key}
              className={
                key === "legalName" || key === "street"
                  ? "min-w-0 space-y-2 sm:col-span-2"
                  : "min-w-0 space-y-2"
              }
            >
              <label
                htmlFor={`${id}-${key}`}
                className="block text-sm font-medium"
              >
                {label}
              </label>
              <input
                id={`${id}-${key}`}
                name={key}
                type="text"
                autoComplete={autoComplete}
                required={key === "legalName" || key === "countryCode"}
                value={values[key]}
                ref={(element) => {
                  inputs.current[key] = element;
                }}
                aria-invalid={errors[key] ? true : undefined}
                aria-describedby={
                  errors[key] ? `${id}-${key}-error` : undefined
                }
                className="flex min-h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 py-2 text-base shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 md:text-sm"
                onChange={(event) => {
                  if (savingRef.current || disabledReason) return;
                  setValues((current) => ({
                    ...current,
                    [key]: event.target.value,
                  }));
                  setErrors((current) => ({ ...current, [key]: undefined }));
                  setSaved(false);
                }}
              />
              {errors[key] ? (
                <p
                  id={`${id}-${key}-error`}
                  className="text-sm text-destructive"
                >
                  {errors[key]}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        {/* Only the hard block disables the buttons. Saving and "nothing to
            save" are aria-disabled so the control under the keyboard keeps
            focus through the save and after it (R115); submit() refuses. */}
        <button
          type="submit"
          disabled={Boolean(disabledReason)}
          aria-busy={saving || undefined}
          aria-disabled={saving || !Object.keys(patch).length || undefined}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-primary bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 aria-disabled:opacity-50"
        >
          <Save className="size-4 shrink-0" aria-hidden="true" />
          {saving ? "Saving business details..." : "Save business details"}
        </button>
        <button
          type="button"
          aria-disabled={!dirty || saving || undefined}
          className="mi-today__text-action"
          onClick={() => {
            if (!dirty || saving) return;
            discard();
          }}
        >
          <RotateCcw aria-hidden="true" />
          Discard changes
        </button>
        <p role="status" className="text-sm text-muted-foreground">
          {saving
            ? "Saving..."
            : saved
              ? "Business details saved."
              : dirty
                ? "Unsaved changes"
                : ""}
        </p>
      </div>
    </form>
  );
}
