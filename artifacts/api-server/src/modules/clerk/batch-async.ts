import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  getDb,
  hasDatabaseContext,
  runInBypassContext,
  clerkBatchesTable,
  clerkCasesTable,
  type ClerkBatch,
} from "@workspace/db";
import { DomainError } from "../errors";
import { appendAudit } from "../audit/audit";
import {
  CLERK_ENTITLEMENT_FLAG_KEY,
  isEffectiveFeatureEnabled,
  isFeatureEnabled,
} from "../flags/flags";
import { registerSweep } from "../pipeline/sweeps";
import { logger } from "../../lib/logger";
import { assertFirmClerkBudget } from "./budget";
import { segmentDocument, type BatchSegment } from "./batch";
import {
  createExtractionCase,
  creatorClientParty,
  decodeBase64Checked,
  extractPdfText,
  resolveTextSource,
} from "./cases";
import {
  probeBundle,
  rasterizeBundlePages,
  rasterizeBundleThumbs,
  segmentScanBundle,
  type ScanSegment,
} from "./scan-batch";
import {
  assertClerkEnabled,
  CLERK_FLAG_KEY,
  type ClerkGateway,
} from "./gateway";
import { getClerkGateway } from "./provider";
import { inClerkScope } from "./scope";

// Async batch intake (Clerk idea #8). The synchronous batch route caps at 10
// segments because the request holds the caller while every model call runs;
// a month-end bundle needs more. Here the route only QUEUES: it resolves the
// document text, inserts a clerk_batches row and returns 202 — no model call
// in the request. Processing happens out of band with the digest
// split-pattern: short transactions around the model calls, never across them.
//
// The concurrency story, stated once:
//  - SEGMENT ONCE, PERSIST, THEN CURSOR. Segmentation output is stored on the
//    row and processedSegments is a cursor into it — resume, reclaim and
//    slicing never re-segment, so shifted boundaries can't defeat the
//    duplicate guard or double the token spend.
//  - EVERY WRITE IS FENCED on the claim stamp (claimedAt doubles as an
//    ownership token, refreshed as a heartbeat on each write). A processor
//    that loses the fence stops writing immediately, so a reclaimed batch has
//    exactly one live writer.
//  - SLICES, NOT MARATHONS. One processBatch call handles at most one slice
//    (~1 segmentation + SEGMENTS_PER_SLICE extractions), then re-parks with
//    progress. The kick loops slices back-to-back; the shared sweep does one
//    slice per pass so it can never stall the minute-sensitive sweeps behind
//    it. A slice is minutes at worst — far inside the reclaim window.
//  - THE KILL SWITCH PARKS, the retention sweep is the backstop for content
//    held by batches that never get processed at all.
//
// Each segment then walks the EXACT same createExtractionCase path as a
// single upload — same duplicate guard, same extraction, same pre-flight,
// same human review. The batch machinery adds throughput, never authority.

const MAX_ASYNC_BATCH_SEGMENTS = 50;
// Extractions per processBatch call; also bounds a sweep pass's model calls.
export const SEGMENTS_PER_SLICE = 10;
// A claim whose heartbeat is older than this belongs to a dead processor.
const RECLAIM_AFTER_MS = 10 * 60_000;

export interface CreateBatchInput {
  sourceType: "pdf" | "text";
  name?: string | null;
  text?: string;
  pdfBase64?: string;
}

// Queue one bundle. Runs on a NO_CONTEXT route: the insert commits in its own
// firm-scoped transaction so the processor (other connections) can see it
// immediately. A PDF with no text layer is a SCANNED bundle (round-5 idea
// #1): the original bytes are stored for the processor to rasterize — no
// model call and no full render in the request; the probe only validates the
// page cap and that the first page renders.
export async function createClerkBatch(
  input: CreateBatchInput,
  actorId: string,
  ctx: { firmId?: string | null } = {},
): Promise<ClerkBatch> {
  await assertClerkEnabled();
  let fullText: string | null = null;
  let sourcePdfB64: string | null = null;
  let sourceKind: "text" | "scan" = "text";
  let pages = 0;
  if (input.sourceType === "pdf" && input.pdfBase64) {
    const buf = decodeBase64Checked(input.pdfBase64, "PDF");
    const text = (await extractPdfText(buf)).trim();
    if (text) {
      fullText = text;
    } else {
      sourceKind = "scan";
      pages = await probeBundle(buf);
      sourcePdfB64 = buf.toString("base64");
    }
  } else {
    fullText = await resolveTextSource(
      input.sourceType,
      input,
      "Upload the invoices one at a time as images instead.",
    );
  }
  const firmId = ctx.firmId ?? null;
  const batch = await inClerkScope(firmId, async () => {
    const [row] = await getDb()
      .insert(clerkBatchesTable)
      .values({
        firmId,
        createdBy: actorId,
        name: input.name?.trim() || "Batch intake",
        sourceText: fullText,
        sourceKind,
        sourcePdfB64,
        status: "queued",
      })
      .returning();
    await appendAudit({
      actorId,
      firmId: firmId ?? undefined,
      action: "clerk.batch.queue",
      entityType: "clerk_batch",
      entityId: row.id,
      after:
        sourceKind === "scan"
          ? { sourceType: input.sourceType, kind: sourceKind, pages }
          : {
              sourceType: input.sourceType,
              kind: sourceKind,
              chars: fullText?.length ?? 0,
            },
    });
    return row;
  });
  return batch;
}

// Claim the batch with a compare-and-set: queued, or processing with a stale
// heartbeat (dead processor). Exactly one caller wins; everyone else no-ops.
async function claimBatch(
  batchId: string,
): Promise<{ batch: ClerkBatch; stamp: Date } | null> {
  if (!hasDatabaseContext())
    return runInBypassContext(() => claimBatch(batchId));
  const stamp = new Date();
  const staleBefore = new Date(Date.now() - RECLAIM_AFTER_MS);
  const [claimed] = await getDb()
    .update(clerkBatchesTable)
    .set({ status: "processing", claimedAt: stamp })
    .where(
      and(
        eq(clerkBatchesTable.id, batchId),
        or(
          eq(clerkBatchesTable.status, "queued"),
          and(
            eq(clerkBatchesTable.status, "processing"),
            lt(clerkBatchesTable.claimedAt, staleBefore),
          ),
        ),
      ),
    )
    .returning();
  return claimed ? { batch: claimed, stamp } : null;
}

// Fenced write: only the processor holding the current stamp may write, and
// each write refreshes the stamp (heartbeat). Returns the new stamp, or null
// when the fence was lost — the caller must stop touching the batch.
async function fencedPatch(
  batchId: string,
  stamp: Date,
  patch: Partial<typeof clerkBatchesTable.$inferInsert>,
): Promise<Date | null> {
  if (!hasDatabaseContext())
    return runInBypassContext(() => fencedPatch(batchId, stamp, patch));
  const next = new Date();
  const rows = await getDb()
    .update(clerkBatchesTable)
    .set({ claimedAt: next, ...patch })
    .where(
      and(
        eq(clerkBatchesTable.id, batchId),
        eq(clerkBatchesTable.status, "processing"),
        eq(clerkBatchesTable.claimedAt, stamp),
      ),
    )
    .returning({ id: clerkBatchesTable.id });
  if (rows.length === 0) return null;
  return "claimedAt" in patch ? null : next;
}

export type SliceOutcome =
  | "noop" // nothing claimed (someone else owns it, or Clerk is off)
  | "terminal" // done or failed
  | "parked" // kill switch / budget: back in the queue, content intact
  | "more"; // slice finished, segments remain — call again to continue

async function hasBatchBudget(firmId: string): Promise<boolean> {
  try {
    await assertFirmClerkBudget(firmId);
    return true;
  } catch (error) {
    if (
      error instanceof DomainError &&
      error.code === "CLERK_BUDGET_EXHAUSTED"
    ) {
      return false;
    }
    // Infrastructure failures leave the claim and persisted cursor intact.
    // The kick/sweep reports the error; stale-claim recovery retries the batch.
    throw error;
  }
}

// Process one SLICE of a batch. Safe to call concurrently and repeatedly:
// the claim + fence decide, the cursor resumes.
export async function processBatch(
  batchId: string,
  gateway: ClerkGateway,
): Promise<SliceOutcome> {
  if (!(await isFeatureEnabled(CLERK_FLAG_KEY))) return "noop";
  const [candidate] = await runInBypassContext(() =>
    getDb()
      .select({ firmId: clerkBatchesTable.firmId })
      .from(clerkBatchesTable)
      .where(eq(clerkBatchesTable.id, batchId))
      .limit(1),
  );
  if (
    !candidate ||
    (candidate.firmId &&
      !(await isEffectiveFeatureEnabled(
        CLERK_ENTITLEMENT_FLAG_KEY,
        candidate.firmId,
      )))
  ) {
    return "noop";
  }
  const claimed = await claimBatch(batchId);
  if (!claimed) return "noop";
  const { batch } = claimed;
  let stamp: Date | null = claimed.stamp;

  const park = async (
    counters: Partial<typeof clerkBatchesTable.$inferInsert> = {},
  ): Promise<SliceOutcome> => {
    if (stamp) {
      await fencedPatch(batchId, stamp, {
        status: "queued",
        claimedAt: null,
        ...counters,
      });
    }
    return "parked";
  };
  const fail = async (
    reason: string,
    counters: Partial<typeof clerkBatchesTable.$inferInsert> = {},
  ): Promise<SliceOutcome> => {
    if (stamp) {
      await fencedPatch(batchId, stamp, {
        status: "failed",
        failReason: reason,
        sourceText: null,
        segments: null,
        sourcePdfB64: null,
        scanSegments: null,
        claimedAt: null,
        ...counters,
      });
    }
    return "terminal";
  };

  // ---- Stage 1: segmentation (once per batch, persisted) ----
  // Text bundles segment the document text; scan bundles rasterize
  // thumbnails and ask for page ranges (validated fail-closed). Either way
  // the split persists ONCE and the cursor resumes into it.
  const isScan = batch.sourceKind === "scan";
  let segments: BatchSegment[] | null = batch.segments;
  let scanSegments: ScanSegment[] | null = batch.scanSegments;
  if (isScan ? !scanSegments : !segments) {
    if (isScan ? !batch.sourcePdfB64 : !batch.sourceText?.trim()) {
      return fail("The batch has no document content to process.");
    }
    // Budget pre-check BEFORE the segmentation call: an exhausted allowance
    // parks the batch (it self-heals next month; the retention sweep is the
    // backstop) instead of burning the document with a misleading failure.
    if (batch.firmId && !(await hasBatchBudget(batch.firmId))) {
      return park();
    }
    try {
      if (isScan) {
        const buf = Buffer.from(batch.sourcePdfB64!, "base64");
        const thumbs = await rasterizeBundleThumbs(buf);
        scanSegments = await segmentScanBundle(thumbs, gateway, batch.firmId);
      } else {
        segments = await segmentDocument(
          batch.sourceText!,
          MAX_ASYNC_BATCH_SEGMENTS,
          gateway,
          batch.firmId,
        );
      }
    } catch (err) {
      // Kill switch mid-flight parks work instead of destroying it.
      if (err instanceof DomainError && err.code === "CLERK_DISABLED") {
        return park();
      }
      const message =
        err instanceof DomainError
          ? err.message
          : "Segmentation failed unexpectedly.";
      return fail(message);
    }
    // Text: the segments carry the content, the raw document drops here.
    // Scan: the PDF must SURVIVE — extraction re-rasterizes from it, so any
    // process can resume; it clears at terminal states instead.
    stamp = await fencedPatch(
      batchId,
      stamp,
      isScan
        ? { scanSegments, totalSegments: scanSegments!.length }
        : { segments, totalSegments: segments!.length, sourceText: null },
    );
    if (!stamp) return "noop";
  }

  // ---- Stage 2: one slice of extractions, cursor-resumed ----
  const totalCount = isScan ? scanSegments!.length : segments!.length;
  // Scan slices re-rasterize the full pages ONCE, lazily, from the stored
  // PDF — resumable from any process, and a slice that only skips
  // duplicates never pays for a render.
  let fullPages: string[] | null = null;
  const segmentCaseInput = async (at: number) => {
    const label = isScan ? scanSegments![at].label : segments![at].label;
    const name =
      label?.trim() ||
      `${batch.name ?? "Batch intake"} (${at + 1}/${totalCount})`;
    if (!isScan) {
      return { sourceType: "text" as const, name, text: segments![at].text };
    }
    if (!fullPages) {
      fullPages = await rasterizeBundlePages(
        Buffer.from(batch.sourcePdfB64!, "base64"),
      );
    }
    const range = scanSegments![at];
    return {
      sourceType: "pdf" as const,
      name,
      scanPagesB64: fullPages.slice(range.startPage - 1, range.endPage),
    };
  };

  // Scope register-history preflight to the batch's OWNER (SEC-03): a
  // client_user's batch must never surface a sibling client's ledger.
  const clientPartyId = await creatorClientParty(batch.createdBy);
  let cursor = batch.processedSegments;
  let created = batch.createdCases;
  let skipped = batch.skippedDuplicates;
  let inSlice = 0;
  while (cursor < totalCount && inSlice < SEGMENTS_PER_SLICE) {
    // Same budget semantics as the sync batch: a firm that runs dry mid-batch
    // keeps what was already created; the counters make the shortfall visible.
    if (batch.firmId && !(await hasBatchBudget(batch.firmId))) {
      return fail(
        created > 0
          ? `The firm's Clerk allowance ran out after ${created} invoice(s).`
          : "The firm's monthly Clerk allowance is exhausted.",
        {
          processedSegments: cursor,
          createdCases: created,
          skippedDuplicates: skipped,
        },
      );
    }
    try {
      await createExtractionCase(
        await segmentCaseInput(cursor),
        batch.createdBy,
        gateway,
        undefined,
        // The batch row does not record the creator's role, so supplier
        // memory stays conservatively client-scoped (creator's own cases) —
        // a staff-created batch just gets a smaller exemplar pool. The
        // resolved client party (null for staff) scopes history preflight.
        // batchId links the case back for review-queue grouping.
        { firmId: batch.firmId, clientScoped: true, clientPartyId, batchId },
      );
      created += 1;
    } catch (err) {
      if (err instanceof DomainError && err.code === "DUPLICATE_SOURCE") {
        skipped += 1;
      } else if (err instanceof DomainError && err.code === "CLERK_DISABLED") {
        return park({
          processedSegments: cursor,
          createdCases: created,
          skippedDuplicates: skipped,
        });
      } else {
        const message =
          err instanceof DomainError
            ? err.message
            : "A segment failed unexpectedly.";
        return fail(message, {
          processedSegments: cursor + 1,
          createdCases: created,
          skippedDuplicates: skipped,
        });
      }
    }
    cursor += 1;
    inSlice += 1;
    stamp = await fencedPatch(batchId, stamp, {
      processedSegments: cursor,
      createdCases: created,
      skippedDuplicates: skipped,
    });
    if (!stamp) return "noop"; // fence lost: someone else owns the batch now
  }

  if (cursor < totalCount) {
    // Slice budget spent; park with progress so the next call (or sweep
    // pass) continues from the cursor without re-segmenting.
    await fencedPatch(batchId, stamp, {
      status: "queued",
      claimedAt: null,
      processedSegments: cursor,
      createdCases: created,
      skippedDuplicates: skipped,
    });
    return "more";
  }

  await fencedPatch(batchId, stamp, {
    status: "done",
    processedSegments: cursor,
    createdCases: created,
    skippedDuplicates: skipped,
    sourceText: null,
    segments: null,
    sourcePdfB64: null,
    scanSegments: null,
    claimedAt: null,
  });
  await appendAudit({
    actorId: batch.createdBy,
    firmId: batch.firmId ?? undefined,
    action: "clerk.batch.processed",
    entityType: "clerk_batch",
    entityId: batch.id,
    after: { segments: totalCount, created, skippedDuplicates: skipped },
  });
  return "terminal";
}

// Decided-case counts per batch (round-8 idea #3): the review queue shows
// "reviewed R of C" per bundle. Decided = the operator ruled (approved or
// rejected); failed extractions await a retry, not a review.
export async function reviewedCounts(
  batchIds: string[],
): Promise<Map<string, number>> {
  if (batchIds.length === 0) return new Map();
  const rows = await getDb()
    .select({
      batchId: clerkCasesTable.batchId,
      reviewed: sql<number>`count(*)::int`,
    })
    .from(clerkCasesTable)
    .where(
      and(
        inArray(clerkCasesTable.batchId, batchIds),
        inArray(clerkCasesTable.status, ["approved", "rejected"]),
      ),
    )
    .groupBy(clerkCasesTable.batchId);
  return new Map(rows.map((r) => [r.batchId as string, Number(r.reviewed)]));
}

// Fire-and-forget kick from the route: processes slice after slice in this
// process; if it dies, the sweep's reclaim picks the batch up.
export function kickBatchProcessing(batchId: string): void {
  void (async () => {
    const gateway = await getClerkGateway();
    let outcome: SliceOutcome;
    do {
      outcome = await processBatch(batchId, gateway);
    } while (outcome === "more");
  })().catch((err) => {
    logger.warn({ err, batchId }, "async batch kick failed; sweep will retry");
  });
}

export async function sweepClerkBatches(): Promise<void> {
  if (!(await isFeatureEnabled(CLERK_FLAG_KEY))) return;
  const staleBefore = new Date(Date.now() - RECLAIM_AFTER_MS);
  // ONE slice of the oldest claimable batch per pass: the shared sweep loop
  // has minute-sensitive statutory work behind this, so a pass is bounded at
  // roughly a slice's worth of model calls; the queue drains across passes
  // (and the kick path drives the interactive case slice-to-slice anyway).
  const candidates = await runInBypassContext(() =>
    getDb()
      .select({ id: clerkBatchesTable.id, firmId: clerkBatchesTable.firmId })
      .from(clerkBatchesTable)
      .where(
        or(
          eq(clerkBatchesTable.status, "queued"),
          and(
            eq(clerkBatchesTable.status, "processing"),
            lt(clerkBatchesTable.claimedAt, staleBefore),
          ),
        ),
      )
      .orderBy(asc(clerkBatchesTable.createdAt))
      .limit(25),
  );
  let candidate: (typeof candidates)[number] | undefined;
  for (const row of candidates) {
    if (
      row.firmId &&
      !(await isEffectiveFeatureEnabled(CLERK_ENTITLEMENT_FLAG_KEY, row.firmId))
    ) {
      continue;
    }
    // Budget PEEK before claiming: claim + park both write the row (refreshing
    // updated_at), so a permanently-exhausted firm's batch cycling through the
    // sweep would keep itself forever inside the retention window. Skip it
    // without a write and let another entitled firm make progress.
    if (row.firmId && !(await hasBatchBudget(row.firmId))) {
      continue;
    }
    candidate = row;
    break;
  }
  if (!candidate) return;
  // No provider configured: leave the batches queued for when one exists.
  let gateway: ClerkGateway;
  try {
    gateway = await getClerkGateway();
  } catch {
    return;
  }
  await processBatch(candidate.id, gateway);
}

registerSweep("clerk.batches", sweepClerkBatches);
