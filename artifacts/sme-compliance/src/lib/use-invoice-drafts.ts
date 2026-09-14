import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useGetMe } from "@workspace/api-client-react";
import { useUrlParam, webSession } from "@workspace/web-ui";
import {
  draftStorageKey,
  listDraftRecoveries,
  loadInvoiceDraft,
  saveDraftRecovery,
  INVOICE_DRAFT_TTL_MS,
  type DraftRecovery,
  type DraftState,
} from "./invoice-draft";
import { InvoiceDraftSession } from "./invoice-draft-session";
import { invoiceDraftApi, listServerInvoiceDrafts } from "./invoice-draft-api";
import { submissionStorageKey } from "./invoice-submission";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function useInvoiceDrafts() {
  const { data: me } = useGetMe();
  const queryClient = useQueryClient();
  const clientId = me?.clientPartyId ?? "";
  const scopeKey = me ? draftStorageKey(me.userId, me.firmId, clientId) : "";
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const sessionGeneration = webSession.getGeneration();
  const initialId = useRef(crypto.randomUUID());
  const [urlId, setUrlId] = useUrlParam("draft");
  const id = UUID.test(urlId) ? urlId : initialId.current;
  const [seed, setSeed] = useState<{
    scopeKey: string;
    recovery: DraftRecovery;
  }>();
  const [localCatalogue, setLocalCatalogue] = useState(() => ({
    scopeKey,
    items: scopeKey ? listDraftRecoveries(scopeKey) : [],
  }));
  const refreshRecoveries = useCallback(() => {
    setLocalCatalogue({
      scopeKey,
      items: scopeKey ? listDraftRecoveries(scopeKey) : [],
    });
  }, [scopeKey]);
  useEffect(refreshRecoveries, [refreshRecoveries]);
  // Never display another account's catalogue while the refresh effect catches up.
  const recoveries =
    localCatalogue.scopeKey === scopeKey ? localCatalogue.items : [];
  const session = useMemo(
    () =>
      new InvoiceDraftSession(
        scopeKey,
        id,
        invoiceDraftApi(clientId),
        seed?.scopeKey === scopeKey && seed.recovery.id === id
          ? seed.recovery
          : scopeKey
            ? listDraftRecoveries(scopeKey).find((copy) => copy.id === id)
            : undefined,
        () =>
          !webSession.isEnding() &&
          webSession.getGeneration() === sessionGeneration &&
          currentScope.current === scopeKey,
      ),
    [scopeKey, id, clientId, seed, sessionGeneration],
  );
  const state = useSyncExternalStore(
    session.subscribe,
    session.snapshot,
    session.snapshot,
  );
  const latest = useRef(session);
  latest.current = session;
  useEffect(() => {
    if (!UUID.test(urlId)) setUrlId(id);
  }, [urlId, id, setUrlId]);
  useEffect(() => {
    if (!scopeKey || !clientId || !session.activate()) return;
    const unsubscribe = webSession.subscribe(() => {
      if (!session.isCurrent()) session.invalidate();
    });
    void session.load();
    const onStorage = (event: StorageEvent) => {
      if (event.key === submissionStorageKey(scopeKey, id))
        session.refreshSubmission();
      if (event.key === `${scopeKey}:${id}:notice`) session.externalChange();
      if (event.key?.startsWith(`${scopeKey}:`)) refreshRecoveries();
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") {
        session.persist();
        void session.save();
      }
    };
    const onUnload = (event: BeforeUnloadEvent) => {
      session.persist();
      if (session.state.dirty && !session.state.localSaved) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const onOnline = () => {
      if (session.state.status !== "conflict") void session.save();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("pagehide", session.persist);
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      session.deactivate();
      unsubscribe();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pagehide", session.persist);
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [session, scopeKey, clientId, id, refreshRecoveries]);
  useEffect(() => {
    if (!state.dirty || state.status !== "local") return;
    const timer = setTimeout(() => void session.save(), 400);
    return () => clearTimeout(timer);
  }, [session, state.draft, state.dirty, state.status]);
  useEffect(() => {
    if (state.status === "saved" && session.isActive()) {
      void queryClient.invalidateQueries({
        queryKey: ["invoice-drafts", scopeKey],
      });
      refreshRecoveries();
    }
  }, [
    state.status,
    state.revision,
    scopeKey,
    queryClient,
    session,
    refreshRecoveries,
  ]);
  const catalogue = useInfiniteQuery({
    queryKey: ["invoice-drafts", scopeKey],
    queryFn: ({ pageParam, signal }) =>
      listServerInvoiceDrafts(clientId, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    enabled: !!scopeKey && !!clientId,
  });
  const newDraft = (draft?: DraftState) => {
    if (!session.isCurrent()) return;
    const submission = session.refreshSubmission();
    if (submission && submission.status !== "succeeded") return;
    session.persist();
    if (!session.canLeave()) return;
    const nextId = crypto.randomUUID();
    const recovery: DraftRecovery | undefined = draft
      ? {
          version: 2,
          id: nextId,
          writerId: crypto.randomUUID(),
          revision: 0,
          draft,
          savedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + INVOICE_DRAFT_TTL_MS).toISOString(),
        }
      : undefined;
    if (recovery) saveDraftRecovery(scopeKey, recovery);
    setSeed(recovery ? { scopeKey, recovery } : undefined);
    setUrlId(nextId);
  };
  const select = (value: string) => {
    if (!session.isCurrent()) return;
    const submission = session.refreshSubmission();
    if (submission && submission.status !== "succeeded") return;
    session.persist();
    if (!session.canLeave()) return;
    const [kind, draftId, writerId] = value.split(":");
    const recovery =
      kind === "local"
        ? recoveries.find(
            (copy) => copy.id === draftId && copy.writerId === writerId,
          )
        : undefined;
    setSeed(recovery ? { scopeKey, recovery } : undefined);
    setUrlId(draftId);
  };
  const legacyKey = me ? draftStorageKey(me.userId, me.firmId) : "";
  const legacy = useMemo(
    () => (legacyKey ? loadInvoiceDraft(legacyKey) : undefined),
    [legacyKey],
  );
  return {
    session,
    state,
    draft: state.draft,
    setDraft: session.edit,
    id,
    scopeKey,
    latest,
    catalogue,
    recoveries,
    legacy,
    newDraft,
    select,
  };
}
export type InvoiceDraftController = ReturnType<typeof useInvoiceDrafts>;
