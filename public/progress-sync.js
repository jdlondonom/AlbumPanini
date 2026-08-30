(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PaniniProgressSync = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EMPTY_PROGRESS = {
    version: 5, owned: {}, collection: {}, duplicates: {}, adrenalyn: {}, adrenalynDuplicates: {}
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const validRevision = value => Number.isSafeInteger(value) && value >= 0;
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!record(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  };
  const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  const hasProgress = progress => Object.entries(progress).some(([key, value]) => key !== "version" && record(value) && Object.keys(value).length);

  class SyncError extends Error {
    constructor(code, message, options = {}) {
      super(message);
      this.name = "ProgressSyncError";
      this.code = code;
      Object.assign(this, options);
    }
  }

  /**
   * create({ fetch, storage, storageKey, pendingKey, metaKey, csrfToken,
   *   initialProgress?, normalizeProgress?, requestTimeoutMs?, onProgress?, onStatus?,
   *   onConflict?, onAuthExpired? })
   *
   * onProgress receives (clonedProgress, { source }); sources include remote,
   * refresh, scan, adopt and local. onStatus receives (pending|saved|error, text).
   * onConflict receives { localProgress, remoteProgress, revision, reason,
   * backupKey }. Observers cannot mutate the engine's internal snapshots.
   *
   * initialize/save resolve { saved, reason?, progress, revision, ready,
   * conflicted, pending }, including recoverable failures. flush/refresh/scan/
   * adoptRemote reject ProgressSyncError (code: network|conflict|auth|storage|
   * protocol|api). Explicit HTTP rejections also carry requestPath; local
   * preflight failures and uncertain transport errors never claim that origin.
   * scan returns the server response; it never generates IDs or
   * retries scans. The caller must persist a scan ID before calling it and reuse
   * that ID after an uncertain response. ready means initial reconciliation
   * completed, not a guarantee that the network is currently available.
   *
   * Saves are cloned immediately and serialized, coalescing unsent snapshots
   * to the most recent local intent. A failed PUT retains its original revision
   * and exact snapshot. No pending snapshot is silently rebased onto a newer
   * remote revision. Metadata stores the local snapshot as well as its base in
   * a single storage value so a reload can recover interrupted mirror writes.
   */
  function create(options) {
    const { fetch: fetcher, storage, storageKey, pendingKey, metaKey, csrfToken } = options || {};
    if (typeof fetcher !== "function" || !storage || !storageKey || !pendingKey || !metaKey) {
      throw new TypeError("Faltan fetch, storage o las claves de sincronización");
    }
    const normalize = value => clone(options.normalizeProgress ? options.normalizeProgress(clone(value)) : value);
    const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0 ? options.requestTimeoutMs : 15_000;
    const notify = (name, ...args) => {
      try { if (typeof options[name] === "function") options[name](...args); } catch (_) { /* UI observers do not invalidate a committed write. */ }
    };
    const status = (state, text) => notify("onStatus", state, text);
    const readJson = key => {
      try { return JSON.parse(storage.getItem(key)); } catch (_) { return null; }
    };
    let lastJournalText;
    try { lastJournalText = storage.getItem(metaKey); } catch (_) { lastJournalText = null; }
    let storedMeta;
    try { storedMeta = JSON.parse(lastJournalText); } catch (_) { storedMeta = null; }
    const usableMeta = record(storedMeta) && storedMeta.format === 1 && record(storedMeta.localProgress)
      && (storedMeta.revision === null || (validRevision(storedMeta.revision) && record(storedMeta.acknowledged)));
    const storedProgress = readJson(storageKey);
    let local = normalize(usableMeta ? storedMeta.localProgress : record(storedProgress) ? storedProgress : options.initialProgress || EMPTY_PROGRESS);
    let acknowledged = usableMeta && record(storedMeta.acknowledged) ? normalize(storedMeta.acknowledged) : null;
    let revision = usableMeta ? storedMeta.revision : null;
    let updatedAt = usableMeta ? storedMeta.updatedAt || null : null;
    let inFlight = usableMeta && record(storedMeta.inFlight) && validRevision(storedMeta.inFlight.expectedRevision)
      && record(storedMeta.inFlight.progress) ? clone(storedMeta.inFlight) : null;
    let dirty;
    try { dirty = usableMeta ? Boolean(storedMeta.pending) : storage.getItem(pendingKey) === "true"; } catch (_) { dirty = false; }
    dirty = dirty || Boolean(inFlight) || Boolean(acknowledged && !equal(local, acknowledged));
    let conflict = usableMeta && record(storedMeta.conflict) ? clone(storedMeta.conflict) : null;
    let ready = false;
    let queue = Promise.resolve();
    let generation = 0;
    let backupSequence = 0;
    let blockedJournalText = null;
    let blockedBackupProgress = null;

    function view(extra = {}) {
      return { progress: clone(local), revision, ready, conflicted: Boolean(conflict), pending: dirty || Boolean(inFlight), ...extra };
    }

    function enqueue(operation) {
      const result = queue.then(operation);
      queue = result.catch(() => {});
      return result;
    }

    function ensureJournalWritable() {
      let currentText;
      try { currentText = storage.getItem(metaKey); }
      catch (cause) { throw new SyncError("storage", "No se pudo comprobar el progreso pendiente en este navegador", { cause }); }
      if (currentText === lastJournalText || currentText === null) return;
      let current;
      try { current = JSON.parse(currentText); }
      catch (cause) { throw new SyncError("storage", "Otra pestaña cambió el respaldo local; no se reemplazó", { cause }); }
      if (!record(current) || current.format !== 1 || !record(current.localProgress)
        || (!current.pending && !current.inFlight && !current.conflict)) return;

      // A clean tab must not replace another tab's unsent journal on focus or
      // refresh. Our own new intent is separately backed up before blocking;
      // the other tab keeps the exact journal (including its uncertain PUT).
      const other = {
        progress: record(current.acknowledged) ? clone(current.acknowledged) : clone(EMPTY_PROGRESS),
        revision: validRevision(current.revision) ? current.revision : 0,
        updatedAt: current.updatedAt || null
      };
      let backupKey = conflict?.reason === "other-tab-pending" ? conflict.backupKey : null;
      if (!backupKey || blockedJournalText !== currentText || !equal(blockedBackupProgress, local)) {
        backupKey = backup("other-tab-pending", other);
        blockedJournalText = currentText;
        blockedBackupProgress = clone(local);
      }
      conflict = {
        localProgress: clone(local), remoteProgress: other.progress,
        revision: other.revision, updatedAt: other.updatedAt,
        pendingProgress: clone(current.localProgress), reason: "other-tab-pending", backupKey
      };
      notify("onConflict", clone(conflict));
      throw new SyncError("conflict", "Otra pestaña tiene cambios pendientes. Sincronízala antes de continuar", { data: clone(conflict) });
    }

    function persist() {
      ensureJournalWritable();
      try {
        // This one value is the authoritative recovery journal. The two legacy
        // keys remain mirrors for the existing app and portable exports.
        const journalText = JSON.stringify({
          format: 1, revision, updatedAt, acknowledged, localProgress: local,
          pending: dirty || Boolean(inFlight), inFlight, conflict
        });
        storage.setItem(metaKey, journalText);
        lastJournalText = journalText;
        storage.setItem(storageKey, JSON.stringify(local));
        storage.setItem(pendingKey, String(dirty || Boolean(inFlight)));
      } catch (cause) {
        throw new SyncError("storage", "No se pudo conservar el progreso en este navegador", { cause });
      }
    }

    function backup(reason, remote) {
      const key = `${metaKey}:backup:${Date.now()}:${++backupSequence}:${Math.random().toString(36).slice(2, 10)}`;
      try {
        storage.setItem(key, JSON.stringify({
          exportedAt: new Date().toISOString(), reason, progress: local,
          baseRevision: revision, acknowledged, inFlight,
          remoteRevision: remote.revision, remoteProgress: remote.progress
        }));
      } catch (cause) {
        throw new SyncError("storage", "No se pudo respaldar la copia local; no se reemplazó", { cause });
      }
      return key;
    }

    function report(error) {
      if (error.code === "auth") {
        status("error", "La sesión terminó. Inicia sesión para continuar");
        notify("onAuthExpired", error);
      } else if (error.code === "conflict") {
        status("error", conflict?.reason === "other-tab-pending"
          ? "Otra pestaña tiene cambios pendientes. Sincronízala antes de continuar"
          : conflict ? "Hay cambios en otro dispositivo: revisa el conflicto" : "El inventario cambió. Confirma la lámina nuevamente");
      } else if (error.code === "storage") {
        status("error", error.message);
      } else {
        status("error", dirty || inFlight ? "Pendiente de sincronizar" : "Sin conexión con tu inventario");
      }
      return view({ saved: false, reason: error.code || "api", error });
    }

    async function performRequest(path, init, signal) {
      let response;
      try { response = await fetcher(path, { credentials: "same-origin", cache: "no-store", ...init, signal }); }
      catch (cause) { throw new SyncError("network", "No se pudo conectar con el inventario", { cause }); }
      let loginRedirect = false;
      try { loginRedirect = response.redirected && new URL(response.url, "https://local.invalid").pathname === "/login"; } catch (_) { /* Invalid redirects are rejected below. */ }
      if (loginRedirect || response.status === 401 || response.status === 403) {
        throw new SyncError("auth", "La sesión no permite guardar el inventario", {
          status: response.status,
          ...(response.status === 401 || response.status === 403 ? { requestPath: path } : {})
        });
      }
      let data;
      try { data = await response.json(); }
      catch (cause) { throw new SyncError("protocol", "El servidor no devolvió un inventario válido", { status: response.status, cause }); }
      if (!response.ok) {
        const progressConflict = response.status === 409 && data?.errorCode === "PROGRESS_CONFLICT"
          && record(data.progress) && validRevision(data.revision);
        throw new SyncError(progressConflict ? "conflict" : response.status >= 500 ? "network" : "api",
          typeof data?.error === "string" ? data.error : "No se pudo guardar el inventario", { status: response.status, data, requestPath: path });
      }
      return data;
    }

    async function request(path, init = {}) {
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new SyncError("network", "La solicitud tardó demasiado; conserva el escaneo y reintenta", { timeout: true });
          reject(error);
          controller.abort(error);
        }, requestTimeoutMs);
      });
      try {
        // Race the complete response, including JSON consumption. The timeout
        // also works with a transport that does not honor AbortSignal promptly.
        return await Promise.race([performRequest(path, init, controller.signal), timeout]);
      } finally { clearTimeout(timer); }
    }

    function remoteSnapshot(data) {
      if (!record(data) || !record(data.progress) || !validRevision(data.revision)) {
        throw new SyncError("protocol", "El servidor no devolvió una revisión válida");
      }
      return { progress: normalize(data.progress), revision: data.revision, updatedAt: data.updatedAt || null };
    }

    function publish(source) {
      notify("onProgress", clone(local), { source });
    }

    function acceptRemote(remote, source) {
      ensureJournalWritable();
      local = clone(remote.progress);
      acknowledged = clone(remote.progress);
      revision = remote.revision;
      updatedAt = remote.updatedAt;
      inFlight = null;
      dirty = false;
      conflict = null;
      ready = true;
      persist();
      publish(source);
      status("saved", "Sincronizado");
    }

    function acknowledge(remote) {
      ensureJournalWritable();
      acknowledged = clone(remote.progress);
      revision = remote.revision;
      updatedAt = remote.updatedAt;
      inFlight = null;
      dirty = !equal(local, acknowledged);
      conflict = null;
      ready = true;
      persist();
    }

    function rejectConflict(remote, reason, httpError = null) {
      ready = true;
      dirty = true;
      conflict = {
        localProgress: clone(local), remoteProgress: clone(remote.progress),
        revision: remote.revision, updatedAt: remote.updatedAt, reason, backupKey: null
      };
      // A backup is created before resolving or replacing any local snapshot.
      // If storage is full the in-memory copy stays untouched and writes stop.
      conflict.backupKey = backup(reason, remote);
      persist();
      notify("onConflict", clone(conflict));
      publish("local");
      throw httpError || new SyncError("conflict", "El progreso cambió en otro dispositivo", { status: 409, data: clone(remote) });
    }

    function reconcile(remote, source) {
      ensureJournalWritable();
      if (conflict?.reason === "other-tab-pending" && !dirty && !inFlight) conflict = null;
      if (!dirty && !inFlight && !conflict) {
        if (!ready && revision === null && remote.revision === 0 && !hasProgress(remote.progress) && hasProgress(local)) {
          acknowledged = clone(remote.progress);
          revision = 0;
          updatedAt = remote.updatedAt;
          dirty = true;
          ready = true;
          persist();
          publish("local");
          return;
        }
        acceptRemote(remote, source);
        return;
      }
      if (revision !== null && remote.revision < revision) rejectConflict(remote, "remote-revision-replaced");
      if (equal(remote.progress, local)) {
        acceptRemote(remote, source);
        return;
      }
      if (inFlight && remote.revision >= inFlight.expectedRevision && equal(remote.progress, inFlight.progress)) {
        // The exact PUT was applied, even when its response never reached us.
        acknowledge(remote);
        publish("local");
        return;
      }
      if (revision !== null && remote.revision === revision && acknowledged && equal(remote.progress, acknowledged) && !conflict) {
        ready = true;
        persist();
        publish("local");
        return;
      }
      if (revision === null && remote.revision === 0 && !hasProgress(remote.progress) && !conflict) {
        acknowledged = clone(remote.progress);
        revision = 0;
        updatedAt = remote.updatedAt;
        ready = true;
        persist();
        publish("local");
        return;
      }
      rejectConflict(remote, revision === null ? "legacy-pending-with-remote-data" : "remote-revision-changed");
    }

    async function readRemote(source) {
      ensureJournalWritable();
      const remote = remoteSnapshot(await request("/api/progress"));
      reconcile(remote, source);
      return remote;
    }

    async function sendAttempt() {
      const attempt = clone(inFlight);
      // The attempt and its original revision must be durable before sending.
      persist();
      try {
        const data = await request("/api/progress", {
          method: "PUT",
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken, "x-progress-revision": String(attempt.expectedRevision) },
          body: JSON.stringify(attempt.progress)
        });
        if (!validRevision(data?.revision) || data.revision <= attempt.expectedRevision || data.saved !== true) {
          throw new SyncError("protocol", "No se pudo verificar la revisión guardada");
        }
        acknowledge({ progress: attempt.progress, revision: data.revision, updatedAt: data.updatedAt || null });
      } catch (error) {
        if (error.code !== "conflict" || error.requestPath !== "/api/progress" || error.data?.errorCode !== "PROGRESS_CONFLICT") throw error;
        const remote = remoteSnapshot(error.data);
        if (remote.revision > attempt.expectedRevision && equal(remote.progress, attempt.progress)) {
          acknowledge(remote);
          return;
        }
        rejectConflict(remote, "put-revision-conflict", error);
      }
    }

    async function flushInternal() {
      ensureJournalWritable();
      if (conflict?.reason === "other-tab-pending" && !dirty && !inFlight) {
        conflict = null;
        ready = false;
      }
      if (conflict) throw new SyncError("conflict", "Resuelve el conflicto antes de continuar", { data: clone(conflict) });
      if (!ready) await readRemote("remote");
      // Only a previously interrupted operation can be here: all methods share
      // this queue. Reconcile before retrying it with the SAME base revision.
      if (inFlight) {
        await readRemote("remote");
        if (inFlight) await sendAttempt();
      }
      while (dirty) {
        if (equal(local, acknowledged)) { dirty = false; break; }
        if (!validRevision(revision)) throw new SyncError("protocol", "Falta una revisión para guardar");
        inFlight = { progress: clone(local), expectedRevision: revision };
        status("pending", "Sincronizando…");
        await sendAttempt();
      }
      persist();
      status("saved", "Sincronizado");
      return view({ saved: true });
    }

    function initialize() {
      return enqueue(async () => {
        try {
          status("pending", "Conectando…");
          await readRemote("remote");
          return await flushInternal();
        } catch (error) { return report(error); }
      });
    }

    function save(progress) {
      try {
        local = normalize(progress);
        generation++;
        dirty = !acknowledged || !equal(local, acknowledged) || Boolean(inFlight);
        if (conflict) {
          conflict.localProgress = clone(local);
          notify("onConflict", clone(conflict));
        }
        persist();
      } catch (error) { return Promise.resolve(report(error)); }
      status("pending", "Sincronizando…");
      return enqueue(async () => {
        try { return await flushInternal(); } catch (error) { return report(error); }
      });
    }

    function strict(operation) {
      return enqueue(async () => {
        try { return await operation(); }
        catch (error) { report(error); throw error; }
      });
    }

    function flush() { return strict(flushInternal); }

    function refresh() {
      return strict(async () => {
        await flushInternal();
        await readRemote("refresh");
        await flushInternal();
        return view({ saved: true });
      });
    }

    function scan({ scanId, code, expectedRevision }) {
      return strict(async () => {
        if (typeof scanId !== "string" || !scanId || typeof code !== "string" || !code || !validRevision(expectedRevision)) {
          throw new SyncError("api", "La confirmación de escaneo está incompleta");
        }
        await flushInternal();
        const beforeGeneration = generation;
        let data;
        try {
          // A replay deliberately keeps its original expectedRevision. The
          // server must look up scanId before rejecting a stale revision.
          data = await request("/api/scans", {
            method: "POST",
            headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
            body: JSON.stringify({ scanId, code, expectedRevision })
          });
        } catch (error) {
          if (error.code === "conflict" && error.data) {
            const remote = remoteSnapshot(error.data);
            if (generation === beforeGeneration && !dirty && !inFlight) acceptRemote(remote, "refresh");
            else rejectConflict(remote, "local-changes-during-scan", error);
          }
          throw error;
        }
        const remote = remoteSnapshot(data);
        if (data.saved !== true || !record(data.scan)) throw new SyncError("protocol", "No se pudo verificar el escaneo guardado");
        if (generation !== beforeGeneration && !equal(local, remote.progress)) {
          // The scan is already committed, but another local edit was based on
          // the older snapshot. Preserve it instead of overwriting either side.
          try { rejectConflict(remote, "local-changes-during-scan"); }
          catch (error) {
            if (error.code !== "conflict") throw error;
            report(error);
          }
          return { ...clone(data), conflicted: true };
        }
        acceptRemote(remote, "scan");
        return clone(data);
      });
    }

    function adoptRemote() {
      return strict(async () => {
        ensureJournalWritable();
        const remote = remoteSnapshot(await request("/api/progress"));
        ensureJournalWritable();
        const backupKey = backup("accept-remote", remote);
        acceptRemote(remote, "adopt");
        return view({ saved: true, backupKey });
      });
    }

    return {
      initialize, save, flush, refresh, scan, adoptRemote,
      get revision() { return revision; },
      get ready() { return ready; },
      get conflicted() { return Boolean(conflict); },
      get pending() { return dirty || Boolean(inFlight); }
    };
  }

  return { create, SyncError };
});
