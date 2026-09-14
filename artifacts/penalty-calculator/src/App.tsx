import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { requestAdvisoryReview } from "@workspace/api-client-react";
import { userErrorMessage } from "@workspace/api-errors";
import { ADVISORY_EMAIL } from "@workspace/format";
import { trackUsabilityEvent } from "@workspace/web-ui";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/hooks/use-toast";
import {
  calculatePenalty,
  formatNaira,
  BAND_LABELS,
  SMALL_TURNOVER_CEILING,
  MEDIUM_TURNOVER_CEILING,
  S103_FIRST_DAY,
  S103_PER_ADDITIONAL_DAY,
  S104_PER_INVOICE,
} from "@/lib/penalty";
import {
  WAVES,
  waveForBand,
  waveStatus,
  formatWaveDate,
  type WaveStatus,
} from "@/lib/deadlines";

const MODEL_BASIS_REVIEWED = "28 August 2026";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

/** Thousands-grouped plain number, e.g. 850,000,000 (no currency symbol). */
const GROUPED_NUMBER = new Intl.NumberFormat("en-NG", {
  maximumFractionDigits: 2,
});

interface ParsedNumber {
  /** True when the field is empty — distinct from an explicit 0. */
  isBlank: boolean;
  /** False when the text cannot be read as a single number (e.g. "5m", "1.5.3"). */
  isValid: boolean;
  /** Parsed value; 0 when blank or invalid. */
  value: number;
}

function parseNumberInput(raw: string): ParsedNumber {
  const trimmed = raw.trim();
  if (trimmed === "") return { isBlank: true, isValid: true, value: 0 };
  const cleaned = trimmed.replace(/^₦/, "").replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned))
    return { isBlank: false, isValid: false, value: 0 };
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { isBlank: false, isValid: false, value: 0 };
  return { isBlank: false, isValid: true, value: n };
}

function NumberField({
  id,
  label,
  hint,
  prefix,
  value,
  onChange,
  onBlur,
  error,
  echo,
  inputMode = "numeric",
}: {
  id: string;
  label: string;
  hint: string;
  prefix?: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  /** Inline validation message; when set the field is marked invalid. */
  error?: string;
  /** Echo of how the input was interpreted, e.g. "= ₦850,000,000 — Large band". */
  echo?: string;
  inputMode?: "numeric" | "decimal";
}) {
  const hintId = `${id}-hint`;
  const echoId = `${id}-echo`;
  const errorId = `${id}-error`;
  const describedBy = [
    error ? errorId : null,
    echo && !error ? echoId : null,
    hintId,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="relative">
        {prefix && (
          <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-muted-foreground">
            {prefix}
          </span>
        )}
        <input
          id={id}
          inputMode={inputMode}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder="0"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`w-full rounded-md border bg-card py-2.5 pr-3 text-foreground shadow-sm outline-none transition focus:ring-2 ${
            error
              ? "border-destructive focus:border-destructive focus:ring-destructive/30"
              : "border-input focus:border-ring focus:ring-ring/30"
          } ${prefix ? "pl-8" : "pl-3"}`}
        />
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        echo && (
          <p id={echoId} className="text-xs font-medium text-foreground">
            {echo}
          </p>
        )
      )}
      <p id={hintId} className="text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}

function ResultRow({
  label,
  detail,
  amount,
  strong,
}: {
  label: string;
  detail: string;
  amount: number;
  strong?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div>
        <p
          className={`text-sm ${strong ? "font-semibold text-foreground" : "font-medium text-foreground"}`}
        >
          {label}
        </p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      <p
        className={`shrink-0 tabular-nums ${
          strong
            ? "text-xl font-bold text-primary"
            : "text-base font-semibold text-foreground"
        }`}
      >
        {formatNaira(amount)}
      </p>
    </div>
  );
}

const WAVE_STATUS_PILL: Record<WaveStatus, string> = {
  upcoming:
    "bg-slate-100 text-slate-800 border-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-800",
  onboarding:
    "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-900",
  "deadline-passed":
    "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-900",
  "enforcement-active":
    "bg-red-100 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-900",
};

export default function App() {
  const { toast } = useToast();
  const [turnover, setTurnover] = useState("");
  const [days, setDays] = useState("");
  const [invoices, setInvoices] = useState("");
  const [email, setEmail] = useState("");
  const [submittedEmail, setSubmittedEmail] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [contactConsent, setContactConsent] = useState(false);
  const [advisoryStatus, setAdvisoryStatus] = useState<
    "idle" | "pending" | "success" | "error"
  >("idle");
  const [advisoryError, setAdvisoryError] = useState("");
  const [touched, setTouched] = useState({
    turnover: false,
    days: false,
    invoices: false,
  });
  const startedRef = useRef(false);
  const completedRef = useRef(false);

  const turnoverParsed = parseNumberInput(turnover);
  const daysParsed = parseNumberInput(days);
  const invoicesParsed = parseNumberInput(invoices);

  const result = useMemo(
    () =>
      calculatePenalty({
        annualTurnover: turnoverParsed.value,
        daysAccessNotGranted: daysParsed.value,
        nonCompliantInvoiceCount: invoicesParsed.value,
      }),
    [turnoverParsed.value, daysParsed.value, invoicesParsed.value],
  );

  /** Turnover blank/invalid is distinct from ₦0 — never assert a band without it. */
  const hasTurnover = !turnoverParsed.isBlank && turnoverParsed.isValid;
  const activeWave = waveForBand(result.band);
  const activeWaveStatus = waveStatus(activeWave);

  const perInvoice = S104_PER_INVOICE[result.band];
  const dayCount = Math.floor(Math.max(0, daysParsed.value));
  const invoiceCount = Math.floor(Math.max(0, invoicesParsed.value));

  const turnoverError = turnoverParsed.isValid
    ? undefined
    : "Enter a number, such as 850,000,000.";
  const daysError = daysParsed.isValid
    ? undefined
    : "Enter a whole number of days, like 3.";
  const invoicesError = invoicesParsed.isValid
    ? undefined
    : "Enter a whole number of invoices, like 12.";

  const turnoverEcho = hasTurnover
    ? `${formatNaira(turnoverParsed.value)}: ${BAND_LABELS[result.band]} turnover band`
    : undefined;
  const daysEcho =
    daysParsed.isValid &&
    !daysParsed.isBlank &&
    !Number.isInteger(daysParsed.value)
      ? `Counted as ${dayCount} day${dayCount === 1 ? "" : "s"}`
      : undefined;
  const invoicesEcho =
    invoicesParsed.isValid &&
    !invoicesParsed.isBlank &&
    !Number.isInteger(invoicesParsed.value)
      ? `Counted as ${invoiceCount} invoice${invoiceCount === 1 ? "" : "s"}`
      : undefined;

  const markStarted = () => {
    if (startedRef.current) return;
    startedRef.current = true;
    trackUsabilityEvent("calculator_started", "calculator");
  };

  useEffect(() => {
    const complete =
      hasTurnover &&
      result.total > 0 &&
      turnoverParsed.isValid &&
      daysParsed.isValid &&
      invoicesParsed.isValid;
    if (!complete || completedRef.current) return;
    completedRef.current = true;
    trackUsabilityEvent("calculator_completed", "calculator");
  }, [
    daysParsed.isValid,
    hasTurnover,
    invoicesParsed.isValid,
    result.total,
    turnoverParsed.isValid,
  ]);

  useEffect(
    () => () => {
      if (startedRef.current && !completedRef.current) {
        trackUsabilityEvent("workflow_abandoned", "calculator");
      }
    },
    [],
  );

  const handleTurnoverBlur = () => {
    setTouched((current) => ({ ...current, turnover: true }));
    if (hasTurnover) setTurnover(GROUPED_NUMBER.format(turnoverParsed.value));
  };

  const summaryText = useMemo(() => {
    return [
      "Valo e-invoicing penalty estimate",
      hasTurnover
        ? `Annual turnover: ${formatNaira(turnoverParsed.value)} (${BAND_LABELS[result.band]} band)`
        : "Annual turnover: not provided",
      `Days a systems audit was blocked (s.103): ${dayCount}; estimate: ${formatNaira(result.section103)}`,
      `Invoices without a valid e-invoice stamp (s.104): ${invoiceCount}; estimate: ${formatNaira(result.section104)}`,
      `Total estimate: ${formatNaira(result.total)}`,
      "",
      "Based on Valo's planning assumptions, not official penalty amounts. Estimate only, not legal or tax advice. The tax authority determines actual penalties.",
    ].join("\n");
  }, [hasTurnover, turnoverParsed.value, result, dayCount, invoiceCount]);

  const handleCopySummary = async () => {
    try {
      await navigator.clipboard.writeText(summaryText);
      toast({ title: "Estimate copied" });
    } catch {
      toast({
        title: "Could not copy the estimate",
        description:
          "Your browser blocked copying. Check clipboard permissions and try again.",
        variant: "destructive",
      });
    }
  };

  const mailtoHref = useMemo(() => {
    const subject = "Valo compliance review request";
    const body = [
      summaryText,
      "",
      businessName.trim() ? `Business: ${businessName.trim()}` : "",
      email.trim() ? `Reply to: ${email.trim()}` : "",
      "Please contact me to review my e-invoicing compliance.",
    ]
      .filter(Boolean)
      .join("\n");
    return `mailto:${ADVISORY_EMAIL}?subject=${encodeURIComponent(
      subject,
    )}&body=${encodeURIComponent(body)}`;
  }, [businessName, summaryText, email]);

  const handleAdvisorySubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (advisoryStatus === "pending" || advisoryStatus === "success") return;
    if (!contactConsent) {
      setAdvisoryStatus("error");
      setAdvisoryError(
        "Confirm that Valo may contact you about this estimate.",
      );
      return;
    }
    setAdvisoryStatus("pending");
    setAdvisoryError("");
    const normalizedEmail = email.trim();
    try {
      await requestAdvisoryReview({
        email: normalizedEmail,
        ...(businessName.trim() ? { businessName: businessName.trim() } : {}),
        estimateSummary: summaryText,
        consent: true,
      });
      setSubmittedEmail(normalizedEmail);
      setAdvisoryStatus("success");
      trackUsabilityEvent("advisory_request", "calculator");
    } catch (error) {
      setAdvisoryStatus("error");
      setAdvisoryError(
        userErrorMessage(error) ??
          "Could not confirm your review request. Contact us by email below if you are unsure whether it arrived.",
      );
    }
  };

  return (
    <>
      <Toaster />
      <div>
        {/* Intro */}
        <div className="max-w-3xl border-b border-slate-200 pb-6">
          <p className="mb-2 inline-flex items-center gap-2 text-xs font-bold text-teal-700">
            <ShieldCheck className="size-4" aria-hidden="true" />
            Valo planning estimate
          </p>
          <h1
            className="text-2xl font-extrabold text-slate-950 md:text-3xl"
            data-testid="text-page-title"
          >
            E-invoicing penalty estimator
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Estimate possible penalties under s.103 (blocking a tax-authority
            systems audit) and s.104 (invoices issued without a valid e-invoice
            stamp), using Valo's planning assumptions. Your entries are
            calculated in your browser and are sent only if you submit a review
            request or send them by email.
          </p>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-5">
          {/* Inputs */}
          <div className="order-1 lg:order-none lg:col-span-3 lg:col-start-1 lg:row-start-1">
            <div className="rounded-lg border border-card-border bg-card p-5 shadow-sm sm:p-6">
              <h2 className="text-base font-semibold">Your details</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Enter annual turnover and counts for the affected period. Blank
                day or invoice counts are treated as zero. Without turnover, the
                estimate assumes the small band.
              </p>

              <div className="mt-5 space-y-5">
                <NumberField
                  id="turnover"
                  label="Annual turnover"
                  prefix="₦"
                  inputMode="decimal"
                  hint={`Sets your turnover band: small up to ${formatNaira(
                    SMALL_TURNOVER_CEILING,
                  )}, medium above that up to ${formatNaira(MEDIUM_TURNOVER_CEILING)}, large above that.`}
                  value={turnover}
                  onChange={(value) => {
                    markStarted();
                    setTurnover(value);
                  }}
                  onBlur={handleTurnoverBlur}
                  error={touched.turnover ? turnoverError : undefined}
                  echo={turnoverEcho}
                />
                <NumberField
                  id="days"
                  label="Days a tax-authority systems audit was blocked (s.103)"
                  inputMode="numeric"
                  hint={`${formatNaira(S103_FIRST_DAY)} for the first day, then ${formatNaira(
                    S103_PER_ADDITIONAL_DAY,
                  )} for each additional day.`}
                  value={days}
                  onChange={(value) => {
                    markStarted();
                    setDays(value);
                  }}
                  onBlur={() =>
                    setTouched((current) => ({ ...current, days: true }))
                  }
                  error={touched.days ? daysError : undefined}
                  echo={daysEcho}
                />
                <NumberField
                  id="invoices"
                  label="Invoices issued without a valid e-invoice stamp (s.104)"
                  inputMode="numeric"
                  hint={
                    hasTurnover
                      ? `Estimate uses ${formatNaira(perInvoice)} per invoice in your ${
                          BAND_LABELS[result.band]
                        } band.`
                      : `Planning amount per invoice: ${formatNaira(
                          S104_PER_INVOICE.small,
                        )} (Small), ${formatNaira(S104_PER_INVOICE.medium)} (Medium), ${formatNaira(
                          S104_PER_INVOICE.large,
                        )} (Large).`
                  }
                  value={invoices}
                  onChange={(value) => {
                    markStarted();
                    setInvoices(value);
                  }}
                  onBlur={() =>
                    setTouched((current) => ({ ...current, invoices: true }))
                  }
                  error={touched.invoices ? invoicesError : undefined}
                  echo={invoicesEcho}
                />
              </div>
            </div>
          </div>

          {/* Results */}
          <section
            aria-label="Estimated penalties"
            className="order-2 lg:order-none lg:col-span-2 lg:col-start-4 lg:row-span-2 lg:row-start-1"
          >
            <div className="sticky top-6 rounded-lg border border-teal-800/25 bg-card p-5 shadow-sm sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold">Estimated penalties</h2>
                <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground">
                  {hasTurnover
                    ? `${BAND_LABELS[result.band]} band`
                    : "Enter turnover to see your band"}
                </span>
              </div>

              <div
                aria-live="polite"
                className="mt-4 rounded-md bg-[#071a1c] p-4 text-center"
              >
                <p className="text-xs font-semibold text-white/55">
                  Total estimate
                </p>
                <p
                  className="mt-1 text-3xl font-extrabold tabular-nums text-lime-300"
                  data-testid="text-total"
                >
                  {formatNaira(result.total)}
                </p>
              </div>

              <div className="mt-2 divide-y divide-border">
                <ResultRow
                  label="s.103: Systems access"
                  detail={
                    dayCount > 0
                      ? `${dayCount} day${dayCount === 1 ? "" : "s"} audit was blocked`
                      : "No days entered"
                  }
                  amount={result.section103}
                />
                <ResultRow
                  label="s.104: Invoice compliance"
                  detail={
                    invoiceCount > 0
                      ? hasTurnover
                        ? `${invoiceCount} × ${formatNaira(perInvoice)}`
                        : `${invoiceCount} × ${formatNaira(perInvoice)} (assumes small band; enter turnover)`
                      : "No invoices entered"
                  }
                  amount={result.section104}
                />
                <ResultRow
                  label="Total estimate"
                  detail="s.103 + s.104"
                  amount={result.total}
                  strong
                />
              </div>

              <div
                className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                data-testid="notice-model-basis"
              >
                <p className="font-semibold">
                  Estimate, not an official penalty
                </p>
                <p className="mt-1">
                  These amounts use Valo's planning assumptions. They are not
                  official penalty amounts, a tax demand, or legal or tax
                  advice. Assumptions last reviewed {MODEL_BASIS_REVIEWED}.
                  Check current FIRS notices or speak to a tax advisor before
                  relying on this estimate.
                </p>
              </div>

              <a
                href="/#product-tour"
                data-testid="link-product-cta"
                className={`mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 ${FOCUS_RING}`}
              >
                See Valo's invoice tools
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
              <p className="mt-3 text-center text-xs text-muted-foreground">
                Already a customer?{" "}
                <a
                  href="/login"
                  data-testid="link-product-signin"
                  className={`font-medium text-foreground underline underline-offset-2 rounded ${FOCUS_RING}`}
                >
                  Sign in
                </a>
              </p>
            </div>
          </section>

          {/* Optional contact */}
          <div className="order-3 lg:order-none lg:col-span-3 lg:col-start-1 lg:row-start-2">
            <form
              onSubmit={handleAdvisorySubmit}
              className="rounded-lg border border-card-border bg-card p-5 shadow-sm sm:p-6"
            >
              <h2 className="text-base font-semibold">
                Talk to an advisor (optional)
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Request review sends your email, optional business name and
                estimate summary to the Valo advisory team. You can also send
                these details by email. Otherwise, your entries stay on your
                device.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label
                    htmlFor="advisor-business"
                    className="block text-sm font-medium text-foreground"
                  >
                    Business name{" "}
                    <span className="text-muted-foreground">(optional)</span>
                  </label>
                  <input
                    id="advisor-business"
                    type="text"
                    autoComplete="organization"
                    maxLength={120}
                    disabled={advisoryStatus === "success"}
                    value={businessName}
                    onChange={(event) => setBusinessName(event.target.value)}
                    placeholder="Company name"
                    className="w-full rounded-md border border-input bg-card px-3 py-2.5 text-foreground shadow-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/30"
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="advisor-email"
                    className="block text-sm font-medium text-foreground"
                  >
                    Your email
                  </label>
                  <input
                    id="advisor-email"
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={254}
                    disabled={advisoryStatus === "success"}
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@company.com"
                    className="w-full rounded-md border border-input bg-card px-3 py-2.5 text-foreground shadow-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/30"
                  />
                </div>
              </div>
              <div className="mt-4 flex items-start gap-2.5">
                <input
                  id="advisor-consent"
                  type="checkbox"
                  required
                  disabled={advisoryStatus === "success"}
                  checked={contactConsent}
                  onChange={(event) => setContactConsent(event.target.checked)}
                  className="mt-0.5 size-5 shrink-0 accent-primary"
                />
                <label
                  htmlFor="advisor-consent"
                  className="text-sm leading-5 text-muted-foreground"
                >
                  Valo may use my email, business name, and estimate to contact
                  me about this review.
                </label>
              </div>

              {advisoryStatus === "success" && (
                <div
                  className="mt-4 flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
                  role="status"
                  data-testid="notice-review-sent"
                >
                  <CheckCircle2
                    className="mt-0.5 size-4 shrink-0"
                    aria-hidden="true"
                  />
                  Request sent. The advisory team will reply to {submittedEmail}
                  .
                </div>
              )}
              {advisoryStatus === "error" && (
                <p className="mt-4 text-sm text-destructive" role="alert">
                  {advisoryError}
                </p>
              )}

              <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                <button
                  type="submit"
                  disabled={
                    advisoryStatus === "pending" || advisoryStatus === "success"
                  }
                  data-testid="link-request-review"
                  className={`inline-flex items-center justify-center rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 ${FOCUS_RING}`}
                >
                  {advisoryStatus === "pending" && (
                    <LoaderCircle
                      className="mr-2 size-4 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  {advisoryStatus === "pending"
                    ? "Sending…"
                    : advisoryStatus === "success"
                      ? "Request sent"
                      : "Request review"}
                </button>
                <button
                  type="button"
                  onClick={handleCopySummary}
                  data-testid="button-copy-summary"
                  className={`inline-flex items-center justify-center gap-2 rounded-md border border-input bg-card px-4 py-2.5 text-sm font-semibold text-foreground shadow-sm transition hover:bg-muted ${FOCUS_RING}`}
                >
                  <Copy className="h-4 w-4" aria-hidden="true" />
                  Copy estimate
                </button>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Online request unavailable?{" "}
                <a
                  href={mailtoHref}
                  data-testid="link-request-review-email"
                  className={`font-medium text-foreground underline underline-offset-2 rounded ${FOCUS_RING}`}
                >
                  Open email draft
                </a>{" "}
                or write to{" "}
                <a
                  href={`mailto:${ADVISORY_EMAIL}`}
                  className={`font-medium text-foreground underline underline-offset-2 rounded ${FOCUS_RING}`}
                >
                  {ADVISORY_EMAIL}
                </a>
                .
              </p>
            </form>
          </div>
        </div>

        {/* Deadlines */}
        <section className="mt-12">
          <h2 className="text-xl font-bold">
            Setup and enforcement planning dates
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Valo's planning model groups taxpayers by size. These dates and
            countdowns are assumptions, not confirmation of current deadlines or
            enforcement. Check the tax authority's official notices. Assumptions
            last reviewed {MODEL_BASIS_REVIEWED}.
          </p>

          <div className="mt-5 grid gap-4 md:grid-cols-3">
            {WAVES.map((wave) => {
              const isActive = hasTurnover && wave.band === result.band;
              const status = waveStatus(wave);
              return (
                <div
                  key={wave.band}
                  aria-current={isActive ? "true" : undefined}
                  className={`rounded-lg border p-5 shadow-sm transition ${
                    isActive
                      ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                      : "border-card-border bg-card"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">{wave.name}</h3>
                    {isActive && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                        <Check className="h-3 w-3" aria-hidden="true" />
                        Your band
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {wave.threshold}
                  </p>
                  <div className="mt-3">
                    <span
                      className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full border ${
                        WAVE_STATUS_PILL[status.status]
                      }`}
                    >
                      {status.label}
                    </span>
                  </div>
                  <dl className="mt-3 space-y-1.5 text-xs">
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Setup target</dt>
                      <dd className="font-medium">
                        {formatWaveDate(wave.onboardingBy)}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">
                        Assumed enforcement
                      </dt>
                      <dd className="font-medium">
                        {formatWaveDate(wave.enforcementFrom)}
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-xs font-medium text-foreground">
                    {status.detail}
                  </p>
                  <p className="mt-2 text-xs leading-relaxed text-foreground/80">
                    {wave.summary}
                  </p>
                </div>
              );
            })}
          </div>

          {hasTurnover && (
            <div className="mt-4 rounded-md border border-border bg-secondary/40 p-4 text-sm">
              <span className="font-medium">
                Your band ({BAND_LABELS[result.band]}):
              </span>{" "}
              <span className="text-muted-foreground">
                {activeWaveStatus.detail}. {activeWave.summary}
              </span>
            </div>
          )}
        </section>

        {/* Methodology */}
        <section className="mt-12 rounded-lg border border-card-border bg-card p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold">How this is calculated</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            The amounts below are Valo's planning assumptions, not official
            penalties. Ask a tax advisor to check the current official amounts
            and how they apply to your business. Assumptions last reviewed{" "}
            {MODEL_BASIS_REVIEWED}.
          </p>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">
                Turnover band:
              </span>{" "}
              small up to {formatNaira(SMALL_TURNOVER_CEILING)}, medium above
              that up to {formatNaira(MEDIUM_TURNOVER_CEILING)}, large above
              that.
            </li>
            <li>
              <span className="font-medium text-foreground">s.103:</span>{" "}
              {formatNaira(S103_FIRST_DAY)} for the first day a systems audit is
              blocked, plus {formatNaira(S103_PER_ADDITIONAL_DAY)} for every
              additional day.
            </li>
            <li>
              <span className="font-medium text-foreground">s.104:</span> per
              invoice issued without a valid e-invoice stamp:{" "}
              {formatNaira(S104_PER_INVOICE.small)} (Small),{" "}
              {formatNaira(S104_PER_INVOICE.medium)} (Medium),{" "}
              {formatNaira(S104_PER_INVOICE.large)} (Large).
            </li>
          </ul>
        </section>
      </div>

      {/* Live total bar on small screens (visual duplicate of the results card) */}
      {hasTurnover && (
        <div
          aria-hidden="true"
          className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 backdrop-blur lg:hidden"
        >
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
            <span className="text-sm text-muted-foreground">
              Total estimate
            </span>
            <span className="text-base font-bold tabular-nums text-primary">
              {formatNaira(result.total)}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
