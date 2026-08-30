"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("../public/progress-sync");

const clone = value => JSON.parse(JSON.stringify(value));
const empty = () => ({ version: 5, owned: {}, collection: {}, duplicates: {}, adrenalyn: {}, adrenalynDuplicates: {} });
const progressWith = (key, extra = {}) => ({ ...empty(), owned: { [key]: true }, ...extra });
const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => clone(data) });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

class MemoryStorage {
  constructor() { this.values = new Map(); this.failWrites = false; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) {
    if (this.failWrites) throw new Error("Storage full");
    this.values.set(key, String(value));
  }
  backups() { return [...this.values].filter(([key]) => key.startsWith("meta:backup:")).map(([, value]) => JSON.parse(value)); }
}

function backend(progress = empty(), revision = 0) {
  const server = { progress: clone(progress), revision, requests: [], scans: new Map() };
  const current = () => ({ progress: clone(server.progress), revision: server.revision, updatedAt: server.revision + 1000 });
  server.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    server.requests.push({ url, method, init: clone(init) });
    if (url === "/api/progress" && method === "GET") return response(200, current());
    if (url === "/api/progress" && method === "PUT") {
      const expected = Number(init.headers["x-progress-revision"]);
      if (expected !== server.revision) return response(409, { error: "El inventario cambió", errorCode: "PROGRESS_CONFLICT", ...current() });
      server.progress = JSON.parse(init.body);
      server.revision++;
      return response(200, { saved: true, revision: server.revision, updatedAt: server.revision + 1000 });
    }
    if (url === "/api/scans" && method === "POST") {
      const { scanId, code, expectedRevision } = JSON.parse(init.body);
      if (server.scans.has(scanId)) return response(200, { saved: true, ...current(), scan: server.scans.get(scanId), replayed: true });
      if (expectedRevision !== server.revision) return response(409, { error: "Confirma nuevamente", errorCode: "PROGRESS_CONFLICT", ...current() });
      const key = `Catar::${code}`;
      const exists = Boolean(server.progress.owned[key] || server.progress.collection[key] || server.progress.duplicates[key]);
      if (exists) server.progress.duplicates[key] = (server.progress.duplicates[key] || 0) + 1;
      else server.progress.owned[key] = true;
      server.revision++;
      const scan = { id: scanId, code, key, action: exists ? "duplicate" : "album", duplicates: server.progress.duplicates[key] || 0 };
      server.scans.set(scanId, scan);
      return response(200, { saved: true, ...current(), scan, replayed: false });
    }
    throw new Error(`Unexpected request ${method} ${url}`);
  };
  return server;
}

function client(server, storage = new MemoryStorage(), overrides = {}) {
  const events = { progress: [], statuses: [], conflicts: [], auth: [] };
  const sync = create({
    fetch: server.fetch, storage, storageKey: "progress", pendingKey: "pending", metaKey: "meta", csrfToken: "test-csrf",
    onProgress: (progress, info) => events.progress.push({ progress, ...info }),
    onStatus: (state, text) => events.statuses.push({ state, text }),
    onConflict: conflict => events.conflicts.push(conflict),
    onAuthExpired: error => events.auth.push(error),
    ...overrides
  });
  return { sync, storage, events };
}

test("loads the authoritative inventory and passes detached snapshots to observers", async () => {
  const original = progressWith("Catar::QAT 5", { adrenalyn: { "577": true } });
  const server = backend(original, 3);
  const { sync, events } = client(server);
  assert.equal(sync.ready, false);
  const result = await sync.initialize();
  assert.equal(result.saved, true);
  assert.equal(sync.ready, true);
  assert.equal(sync.revision, 3);
  assert.equal(sync.pending, false);
  events.progress[0].progress.owned["invented"] = true;
  result.progress.adrenalyn["1"] = true;
  const refreshed = await sync.refresh();
  assert.deepEqual(refreshed.progress, original);
  assert.equal(events.progress.at(-1).source, "refresh");
  assert.equal(server.requests.some(item => item.method === "PUT"), false);
});

test("clones queued saves and serializes revisioned writes without losing later edits", async () => {
  const server = backend();
  const started = deferred();
  const release = deferred();
  let puts = 0;
  const { sync, storage } = client(server, undefined, {
    fetch: async (url, init) => {
      if (init.method === "PUT" && puts++ === 0) { started.resolve(); await release.promise; }
      return server.fetch(url, init);
    }
  });
  await sync.initialize();
  const first = progressWith("Catar::QAT 5");
  const firstSave = sync.save(first);
  first.owned["wrong-from-mutated-input"] = true;
  await started.promise;
  const second = progressWith("Catar::QAT 5", { duplicates: { "Catar::QAT 5": 2 }, adrenalyn: { "577": true } });
  const expected = clone(second);
  const secondSave = sync.save(second);
  second.duplicates["Catar::QAT 5"] = 99;
  release.resolve();
  await Promise.all([firstSave, secondSave]);
  assert.deepEqual(server.progress, expected);
  const writes = server.requests.filter(item => item.method === "PUT");
  assert.deepEqual(writes.map(item => item.init.headers["x-progress-revision"]), ["0", "1"]);
  assert.equal(JSON.parse(writes[0].init.body).owned["wrong-from-mutated-input"], undefined);
  assert.equal(sync.pending, false);
  assert.equal(JSON.parse(storage.getItem("meta")).revision, 2);
  assert.equal(storage.getItem("pending"), "false");
});

test("legacy pending data cannot overwrite remote inventory; accepting remote preserves a backup", async () => {
  const local = progressWith("Catar::QAT 5");
  const remote = progressWith("Colombia::COL 1");
  const storage = new MemoryStorage();
  storage.setItem("progress", JSON.stringify(local));
  storage.setItem("pending", "true");
  const server = backend(remote, 4);
  const { sync, events } = client(server, storage);
  const loaded = await sync.initialize();
  assert.equal(loaded.reason, "conflict");
  assert.equal(sync.conflicted, true);
  assert.equal(sync.pending, true);
  assert.deepEqual(JSON.parse(storage.getItem("progress")), local);
  assert.deepEqual(events.conflicts[0].remoteProgress, remote);
  assert.equal(server.requests.some(item => item.method === "PUT"), false);
  await assert.rejects(sync.flush(), error => error.code === "conflict");
  const accepted = await sync.adoptRemote();
  assert.equal(sync.conflicted, false);
  assert.equal(sync.pending, false);
  assert.deepEqual(accepted.progress, remote);
  assert.deepEqual(JSON.parse(storage.getItem(accepted.backupKey)).progress, local);
  assert.equal(events.progress.at(-1).source, "adopt");
});

test("only a genuinely new revision-zero inventory accepts legacy local migration", async () => {
  const local = progressWith("Catar::QAT 5");
  const storage = new MemoryStorage();
  storage.setItem("progress", JSON.stringify(local));
  const server = backend();
  const { sync } = client(server, storage);
  await sync.initialize();
  assert.deepEqual(server.progress, local);
  assert.equal(server.revision, 1);
  const pending = new MemoryStorage();
  pending.setItem("progress", JSON.stringify(local));
  pending.setItem("pending", "true");
  const existingEmpty = backend(empty(), 2);
  const later = client(existingEmpty, pending);
  assert.equal((await later.sync.initialize()).reason, "conflict");
  assert.equal(existingEmpty.requests.some(item => item.method === "PUT"), false);
});

test("a committed PUT with a lost response is recognized after reload without writing it again", async () => {
  const server = backend();
  const storage = new MemoryStorage();
  let loseResponse = true;
  const original = client(server, storage, {
    fetch: async (url, init) => {
      const result = await server.fetch(url, init);
      if (init.method === "PUT" && loseResponse) { loseResponse = false; throw new Error("Response lost"); }
      return result;
    }
  });
  await original.sync.initialize();
  const desired = progressWith("Catar::QAT 5");
  assert.equal((await original.sync.save(desired)).reason, "network");
  const journal = JSON.parse(storage.getItem("meta"));
  assert.equal(journal.inFlight.expectedRevision, 0);
  assert.deepEqual(journal.inFlight.progress, desired);
  const recovered = client(server, storage);
  const result = await recovered.sync.initialize();
  assert.equal(result.saved, true);
  assert.equal(recovered.sync.revision, 1);
  assert.equal(recovered.sync.pending, false);
  assert.equal(server.requests.filter(item => item.method === "PUT").length, 1);
});

test("later local edits survive recovery of an uncertain earlier PUT", async () => {
  const server = backend();
  const storage = new MemoryStorage();
  let lost = false;
  const { sync } = client(server, storage, {
    fetch: async (url, init) => {
      const result = await server.fetch(url, init);
      if (init.method === "PUT" && !lost) { lost = true; throw new Error("Response lost"); }
      return result;
    }
  });
  await sync.initialize();
  await sync.save(progressWith("Catar::QAT 5"));
  const next = progressWith("Catar::QAT 5", { duplicates: { "Catar::QAT 5": 1 } });
  assert.equal((await sync.save(next)).saved, true);
  assert.deepEqual(server.progress, next);
  assert.deepEqual(server.requests.filter(item => item.method === "PUT").map(item => item.init.headers["x-progress-revision"]), ["0", "1"]);
  assert.equal(sync.pending, false);
});

test("a retry losing the race to the original identical PUT accepts its 409 snapshot", async () => {
  const server = backend();
  let attempt = 0;
  let firstPayload;
  const { sync } = client(server, undefined, {
    fetch: async (url, init) => {
      if (init.method === "PUT") {
        attempt++;
        if (attempt === 1) { firstPayload = JSON.parse(init.body); throw new Error("Still in transit"); }
        if (attempt === 2) { server.progress = firstPayload; server.revision = 1; }
      }
      return server.fetch(url, init);
    }
  });
  await sync.initialize();
  await sync.save(progressWith("Catar::QAT 5"));
  assert.equal((await sync.flush()).saved, true);
  assert.equal(sync.conflicted, false);
  assert.equal(sync.revision, 1);
  assert.equal(server.revision, 1);
});

test("separate devices cannot replace each other's inventory with a stale snapshot", async () => {
  const server = backend();
  const pc = client(server);
  const phone = client(server);
  await Promise.all([pc.sync.initialize(), phone.sync.initialize()]);
  const pcChange = progressWith("Colombia::COL 1", { adrenalyn: { "577": true } });
  const phoneChange = progressWith("Catar::QAT 5");
  await pc.sync.save(pcChange);
  const result = await phone.sync.save(phoneChange);
  assert.equal(result.reason, "conflict");
  assert.deepEqual(server.progress, pcChange);
  assert.deepEqual(JSON.parse(phone.storage.getItem("progress")), phoneChange);
  assert.equal(phone.sync.revision, 0);
  assert.equal(phone.sync.conflicted, true);
  assert.deepEqual(phone.storage.backups()[0].progress, phoneChange);
  assert.equal(server.requests.filter(item => item.method === "PUT").at(-1).init.headers["x-progress-revision"], "0");
});

test("uncertain old pending progress is never rebased after a different remote write", async () => {
  const server = backend();
  const storage = new MemoryStorage();
  const original = client(server, storage, {
    fetch: async (url, init) => {
      if (init.method === "PUT") throw new Error("Offline");
      return server.fetch(url, init);
    }
  });
  await original.sync.initialize();
  const local = progressWith("Catar::QAT 5");
  await original.sync.save(local);
  server.progress = progressWith("Colombia::COL 1");
  server.revision = 5;
  const restarted = client(server, storage);
  const result = await restarted.sync.initialize();
  assert.equal(result.reason, "conflict");
  assert.equal(server.requests.some(item => item.method === "PUT"), false);
  assert.equal(JSON.parse(storage.getItem("meta")).inFlight.expectedRevision, 0);
  assert.deepEqual(JSON.parse(storage.getItem("progress")), local);
});

test("offline initialization does not mark the client ready or allow a scan", async () => {
  const server = backend();
  const { sync } = client(server, undefined, { fetch: async () => { throw new Error("Offline"); } });
  assert.equal((await sync.initialize()).reason, "network");
  assert.equal(sync.ready, false);
  await assert.rejects(sync.scan({ scanId: "scan-offline", code: "QAT 5", expectedRevision: 0 }), error => error.code === "network");
  assert.equal(server.requests.length, 0);
});

test("scan replay reuses its ID and stale original revision after a lost response without adding a duplicate", async () => {
  const server = backend();
  const storage = new MemoryStorage();
  let loseResponse = true;
  const first = client(server, storage, {
    fetch: async (url, init) => {
      const result = await server.fetch(url, init);
      if (url === "/api/scans" && loseResponse) { loseResponse = false; throw new Error("Response lost"); }
      return result;
    }
  });
  await first.sync.initialize();
  const pendingOperation = { scanId: "scan-one-physical-sticker", code: "QAT 5", expectedRevision: 0 };
  await assert.rejects(first.sync.scan(pendingOperation), error => error.code === "network");
  const afterReload = client(server, storage);
  await afterReload.sync.initialize();
  assert.equal(afterReload.sync.revision, 1);
  const replay = await afterReload.sync.scan(pendingOperation);
  assert.equal(replay.replayed, true);
  assert.equal(server.revision, 1);
  assert.deepEqual(server.progress.duplicates, {});
  const secondUnit = await afterReload.sync.scan({ scanId: "scan-another-physical-sticker", code: "QAT 5", expectedRevision: 1 });
  assert.equal(secondUnit.scan.action, "duplicate");
  assert.equal(server.progress.duplicates["Catar::QAT 5"], 1);
  assert.equal(afterReload.events.progress.at(-1).source, "scan");
});

test("scan revision conflicts refresh clean local state and require a new confirmation without saving", async () => {
  const server = backend();
  const { sync, events } = client(server);
  await sync.initialize();
  server.progress = progressWith("Colombia::COL 1");
  server.revision = 1;
  await assert.rejects(sync.scan({ scanId: "scan-stale-preview", code: "QAT 5", expectedRevision: 0 }), error => error.code === "conflict"
    && error.status === 409 && error.requestPath === "/api/scans" && error.data.errorCode === "PROGRESS_CONFLICT");
  assert.equal(sync.conflicted, false);
  assert.equal(sync.pending, false);
  assert.equal(sync.revision, 1);
  assert.equal(server.scans.size, 0);
  assert.deepEqual(events.progress.at(-1).progress, server.progress);
  assert.equal(events.progress.at(-1).source, "refresh");
});

test("an edit during a committed scan is preserved as a conflict, not uploaded over the scan", async () => {
  const server = backend();
  const started = deferred();
  const release = deferred();
  const { sync, storage } = client(server, undefined, {
    fetch: async (url, init) => {
      if (url === "/api/scans") { started.resolve(); await release.promise; }
      return server.fetch(url, init);
    }
  });
  await sync.initialize();
  const scan = sync.scan({ scanId: "scan-with-local-edit", code: "QAT 5", expectedRevision: 0 });
  await started.promise;
  const edited = progressWith("Colombia::COL 1");
  const save = sync.save(edited);
  release.resolve();
  const result = await scan;
  assert.equal(result.saved, true);
  assert.equal(result.conflicted, true);
  assert.equal((await save).reason, "conflict");
  assert.deepEqual(server.progress, progressWith("Catar::QAT 5"));
  assert.deepEqual(JSON.parse(storage.getItem("progress")), edited);
  assert.equal(server.requests.some(item => item.method === "PUT"), false);
});

test("storage failures prevent sending unjournaled writes and prevent discarding a conflict", async () => {
  const server = backend();
  const { sync, storage } = client(server);
  await sync.initialize();
  storage.failWrites = true;
  assert.equal((await sync.save(progressWith("Catar::QAT 5"))).reason, "storage");
  await assert.rejects(sync.flush(), error => error.code === "storage");
  assert.equal(server.requests.some(item => item.method === "PUT"), false);
  storage.failWrites = false;
  server.progress = progressWith("Colombia::COL 1");
  server.revision = 1;
  await sync.initialize();
  assert.equal(sync.conflicted, true);
  storage.failWrites = true;
  await assert.rejects(sync.adoptRemote(), error => error.code === "storage");
  assert.equal(sync.conflicted, true);
  assert.equal(sync.pending, true);
});

test("authentication expiry reports the session and keeps the pending snapshot", async () => {
  const server = backend();
  const { sync, storage, events } = client(server, undefined, {
    fetch: async (url, init) => init.method === "PUT"
      ? { status: 200, ok: true, redirected: true, url: "https://example.com/login", json: async () => { throw new Error("HTML"); } }
      : server.fetch(url, init)
  });
  await sync.initialize();
  const local = progressWith("Catar::QAT 5");
  assert.equal((await sync.save(local)).reason, "auth");
  assert.equal(events.auth.length, 1);
  assert.equal(sync.pending, true);
  assert.deepEqual(JSON.parse(storage.getItem("meta")).inFlight.progress, local);
  assert.equal(server.revision, 0);
});

test("the atomic metadata journal survives interrupted writes of compatibility mirrors", async () => {
  const server = backend();
  const storage = new MemoryStorage();
  const first = client(server, storage);
  await first.sync.initialize();
  const write = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (key === "progress") throw new Error("Mirror write interrupted");
    write(key, value);
  };
  const local = progressWith("Catar::QAT 5");
  assert.equal((await first.sync.save(local)).reason, "storage");
  storage.setItem = write;
  const recovered = client(server, storage);
  await recovered.sync.initialize();
  assert.deepEqual(server.progress, local);
  assert.equal(recovered.sync.pending, false);
});

test("a timed out request aborts its transport and retains the exact pending PUT for recovery", async () => {
  const server = backend();
  let signal;
  const { sync, storage } = client(server, undefined, {
    requestTimeoutMs: 15,
    fetch: async (url, init) => {
      if (init.method !== "PUT") return server.fetch(url, init);
      signal = init.signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
  });
  await sync.initialize();
  const local = progressWith("Catar::QAT 5");
  const result = await sync.save(local);
  assert.equal(result.reason, "network");
  assert.equal(result.error.timeout, true);
  assert.equal(result.error.requestPath, undefined);
  assert.equal(signal.aborted, true);
  assert.equal(sync.pending, true);
  const journal = JSON.parse(storage.getItem("meta"));
  assert.equal(journal.inFlight.expectedRevision, 0);
  assert.deepEqual(journal.inFlight.progress, local);
  assert.equal(server.revision, 0);
});

test("the request timeout covers a stalled response body even when the transport ignores abort", async () => {
  let signal;
  const { sync } = client(backend(), undefined, {
    requestTimeoutMs: 15,
    fetch: async (_url, init) => {
      signal = init.signal;
      return { ok: true, status: 200, json: () => new Promise(() => {}) };
    }
  });
  const result = await sync.initialize();
  assert.equal(result.reason, "network");
  assert.equal(result.error.timeout, true);
  assert.equal(result.error.requestPath, undefined);
  assert.equal(signal.aborted, true);
  assert.equal(sync.ready, false);
});

test("SCAN_ID_REUSED is a definitive API error, not an inventory revision conflict", async () => {
  const server = backend();
  const data = { error: "El escaneo ya se usó para otra lámina", errorCode: "SCAN_ID_REUSED" };
  const { sync, events } = client(server, undefined, {
    fetch: async (url, init) => url === "/api/scans" ? response(409, data) : server.fetch(url, init)
  });
  await sync.initialize();
  await assert.rejects(sync.scan({ scanId: "scan-reused-id", code: "QAT 5", expectedRevision: 0 }), error => {
    assert.equal(error.code, "api");
    assert.equal(error.status, 409);
    assert.equal(error.requestPath, "/api/scans");
    assert.deepEqual(error.data, data);
    return true;
  });
  assert.equal(sync.conflicted, false);
  assert.equal(sync.pending, false);
  assert.equal(events.conflicts.length, 0);
  assert.equal(server.revision, 0);
});

test("only a complete PROGRESS_CONFLICT response is treated as a snapshot conflict", async () => {
  for (const data of [
    { error: "Conflicto sin snapshot", errorCode: "PROGRESS_CONFLICT" },
    { error: "ID reutilizado", errorCode: "SCAN_ID_REUSED", progress: empty(), revision: 2 }
  ]) {
    const server = backend();
    const { sync } = client(server, undefined, {
      fetch: async (url, init) => url === "/api/scans" ? response(409, data) : server.fetch(url, init)
    });
    await sync.initialize();
    await assert.rejects(sync.scan({ scanId: "scan-api-rejection", code: "QAT 5", expectedRevision: 0 }), error => error.code === "api" && error.status === 409);
    assert.equal(sync.conflicted, false);
    assert.equal(sync.revision, 0);
  }
});

test("a PUT conflict cannot be mistaken for a rejected scan and local preflight errors have no requestPath", async () => {
  const server = backend();
  const { sync } = client(server);
  await sync.initialize();
  server.progress = progressWith("Colombia::COL 1");
  server.revision = 1;
  const saved = await sync.save(progressWith("Catar::QAT 5"));
  assert.equal(saved.reason, "conflict");
  assert.equal(saved.error.requestPath, "/api/progress");
  assert.equal(saved.error.data.errorCode, "PROGRESS_CONFLICT");
  await assert.rejects(sync.scan({ scanId: "scan-pending-before-reload", code: "QAT 5", expectedRevision: 0 }), error => {
    assert.equal(error.code, "conflict");
    assert.equal(error.requestPath, undefined);
    return true;
  });
  assert.equal(server.requests.some(item => item.url === "/api/scans"), false);
});

test("an unacknowledged response body does not claim an explicit HTTP rejection path", async () => {
  const server = backend();
  const { sync } = client(server, undefined, {
    fetch: async (url, init) => url === "/api/scans"
      ? { ok: true, status: 200, json: async () => { throw new Error("Response truncated"); } }
      : server.fetch(url, init)
  });
  await sync.initialize();
  await assert.rejects(sync.scan({ scanId: "scan-unreadable-response", code: "QAT 5", expectedRevision: 0 }), error => {
    assert.equal(error.code, "protocol");
    assert.equal(error.requestPath, undefined);
    return true;
  });
});

test("an untouched offline tab cannot erase another tab's pending journal on refresh, initialize or adoptRemote", async () => {
  const server = backend();
  const storage = new MemoryStorage();
  let offline = false;
  const fetcher = async (url, init) => {
    if (offline) throw new Error("Offline");
    return server.fetch(url, init);
  };
  const first = client(server, storage, { fetch: fetcher });
  const second = client(server, storage, { fetch: fetcher });
  await first.sync.initialize();
  await second.sync.initialize();
  offline = true;
  const local = progressWith("Catar::QAT 5", { adrenalyn: { "577": true }, adrenalynDuplicates: { "577": 2 } });
  assert.equal((await first.sync.save(local)).reason, "network");
  const journal = storage.getItem("meta");
  const mirror = storage.getItem("progress");
  await assert.rejects(second.sync.refresh(), error => error.code === "conflict" && error.data.reason === "other-tab-pending");
  assert.equal(storage.getItem("meta"), journal);
  assert.equal(storage.getItem("progress"), mirror);
  assert.equal(storage.getItem("pending"), "true");
  assert.equal((await second.sync.initialize()).reason, "conflict");
  await assert.rejects(second.sync.adoptRemote(), error => error.code === "conflict");
  assert.equal(storage.getItem("meta"), journal);
  assert.equal(server.requests.some(item => item.method === "PUT"), false);
  offline = false;
  assert.equal((await first.sync.flush()).saved, true);
  assert.deepEqual(server.progress, local);
  const recovered = await second.sync.refresh();
  assert.deepEqual(recovered.progress, local);
  assert.equal(second.sync.conflicted, false);
});

test("a conflicting new edit in another tab is backed up without replacing the first pending operation", async () => {
  const server = backend();
  const storage = new MemoryStorage();
  let offline = false;
  const fetcher = async (url, init) => {
    if (offline) throw new Error("Offline");
    return server.fetch(url, init);
  };
  const first = client(server, storage, { fetch: fetcher });
  const second = client(server, storage, { fetch: fetcher });
  await first.sync.initialize();
  await second.sync.initialize();
  offline = true;
  const original = progressWith("Catar::QAT 5");
  await first.sync.save(original);
  const journal = storage.getItem("meta");
  const otherIntent = progressWith("Colombia::COL 1", { adrenalyn: { "577": true } });
  const blocked = await second.sync.save(otherIntent);
  assert.equal(blocked.reason, "conflict");
  assert.equal(second.sync.conflicted, true);
  assert.equal(storage.getItem("meta"), journal);
  assert.equal(storage.getItem("progress"), JSON.stringify(original));
  const details = second.events.conflicts.at(-1);
  assert.equal(details.reason, "other-tab-pending");
  assert.deepEqual(JSON.parse(storage.getItem(details.backupKey)).progress, otherIntent);
  offline = false;
  await first.sync.flush();
  await assert.rejects(second.sync.flush(), error => error.code === "conflict");
  assert.deepEqual(server.progress, original);
  const accepted = await second.sync.adoptRemote();
  assert.deepEqual(accepted.progress, original);
  assert.deepEqual(JSON.parse(storage.getItem(accepted.backupKey)).progress, otherIntent);
});

test("a reload can resume the same pending journal it observed at construction", async () => {
  const server = backend();
  const storage = new MemoryStorage();
  const original = client(server, storage, {
    fetch: async (url, init) => {
      if (init.method === "PUT") throw new Error("Offline");
      return server.fetch(url, init);
    }
  });
  await original.sync.initialize();
  const progress = progressWith("Catar::QAT 5");
  await original.sync.save(progress);
  const reload = client(server, storage);
  assert.equal((await reload.sync.initialize()).saved, true);
  assert.deepEqual(server.progress, progress);
  assert.equal(reload.sync.pending, false);
});
