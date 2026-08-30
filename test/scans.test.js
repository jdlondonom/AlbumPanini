"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { randomBytes, randomUUID } = require("node:crypto");
const { newDb } = require("pg-mem");
const { createApp } = require("../lib/app");
const { PostgresDatabase, emptyProgress } = require("../lib/database");
const { hashToken } = require("../lib/security");
const { loadStickerCatalog, normalizeStickerCode } = require("../lib/sticker-catalog");

async function fixture(t) {
  const adapter = newDb().adapters.createPg();
  const database = new PostgresDatabase(new adapter.Pool(), true);
  await database.migrate();
  const { app } = await createApp({ database, encryptionKey: randomBytes(32), production: false, disableRateLimit: true });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await database.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function account(stage = "authenticated", expiresAt = Date.now() + 60_000) {
    const suffix = randomUUID();
    const user = await database.createUser({ username: suffix, email: `${suffix}@example.test`, passwordHash: "test-hash", passwordSalt: "test-salt" });
    const rawToken = randomBytes(32).toString("hex");
    const csrf = randomBytes(32).toString("hex");
    await database.createSession({ tokenHash: hashToken(rawToken), userId: user.id, stage, csrfToken: csrf, createdAt: Date.now(), expiresAt });
    return { user, headers: { cookie: `panini_session=${rawToken}`, "x-csrf-token": csrf, "content-type": "application/json" } };
  }

  const owner = await account();
  async function request(route, { method = "GET", body, headers = owner.headers } = {}) {
    const response = await fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    assert.match(response.headers.get("content-type"), /application\/json/);
    return { status: response.status, data: await response.json() };
  }
  function scan(code, expectedRevision, scanId = randomUUID(), headers) {
    return request("/api/scans", { method: "POST", headers, body: { scanId, code, expectedRevision } });
  }
  function save(progress, revision, headers = owner.headers) {
    return request("/api/progress", { method: "PUT", headers: { ...headers, "x-progress-revision": String(revision) }, body: progress });
  }
  return { database, owner, account, request, scan, save };
}

test("el escáner valida el mismo catálogo que la app, incluyendo QAT 5, 00 y Coca-Cola", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "panini-mundial-2026.html"), "utf8");
  const catalog = loadStickerCatalog(html);
  assert.equal(catalog.size, 994);
  assert.deepEqual(catalog.get("QAT 5"), { code: "QAT 5", key: "Catar::QAT 5", team: "Catar", player: "Homam Ahmed" });
  assert.equal(catalog.get("00").key, "Panini::00");
  assert.equal(catalog.get("CC 14").key, "Coca-Cola::CC 14");
  assert.equal(catalog.has("QAT 21"), false);
  assert.equal(normalizeStickerCode(" qat05 "), "QAT 5");
  assert.equal(normalizeStickerCode("QAT 5 otro texto"), null);
  assert.equal(normalizeStickerCode({ code: "QAT 5" }), null);
  const injected = html.replace(/const COCA_COLA_LAMINAS\s*=\s*\[/, 'const COCA_COLA_LAMINAS = [(()=>{throw new Error("never execute")})(),');
  assert.throws(() => loadStickerCatalog(injected), SyntaxError);
});

test("la primera confirmación va al álbum, cada captura nueva suma una repetida y los reintentos no duplican", async t => {
  const api = await fixture(t);
  const initial = await api.request("/api/progress");
  assert.deepEqual(initial.data, { progress: emptyProgress(), updatedAt: null, revision: 0 });
  const id = randomUUID();
  const first = await api.scan("QAT 5", 0, id);
  assert.equal(first.status, 200);
  assert.equal(first.data.revision, 1);
  assert.equal(first.data.progress.owned["Catar::QAT 5"], true);
  assert.deepEqual(first.data.progress.duplicates, {});
  assert.deepEqual(first.data.scan, { id, code: "QAT 5", key: "Catar::QAT 5", action: "album", duplicates: 0 });
  assert.equal(first.data.replayed, false);

  const retry = await api.scan(" qat05 ", 0, id.toUpperCase());
  assert.equal(retry.status, 200);
  assert.equal(retry.data.replayed, true);
  assert.equal(retry.data.revision, 1);
  assert.deepEqual(retry.data.progress, first.data.progress);

  const repeat = await api.scan("QAT 5", 1);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.data.scan.action, "duplicate");
  assert.equal(repeat.data.scan.duplicates, 1);
  assert.equal(repeat.data.revision, 2);
  const lateRetry = await api.scan("QAT 5", 0, id);
  assert.equal(lateRetry.data.replayed, true);
  assert.equal(lateRetry.data.scan.action, "album");
  assert.equal(lateRetry.data.revision, 2);
  assert.deepEqual(lateRetry.data.progress, repeat.data.progress);

  const reused = await api.scan("QAT 6", 2, id);
  assert.equal(reused.status, 409);
  assert.equal(reused.data.errorCode, "SCAN_ID_REUSED");
  assert.equal(reused.data.revision, 2);
  assert.deepEqual(reused.data.progress, repeat.data.progress);

  const special = await api.scan("00", 2);
  assert.equal(special.data.progress.owned["Panini::00"], true);
  const promo = await api.scan("CC 14", 3);
  assert.equal(promo.status, 200);
  assert.equal(promo.data.progress.owned["Coca-Cola::CC 14"], true);
});

test("una copia en colección o repetidas cuenta como existente y Adrenalyn se conserva", async t => {
  const api = await fixture(t);
  const initial = {
    ...emptyProgress(),
    collection: { "Catar::QAT 5": true },
    duplicates: { "Colombia::COL 1": 2 },
    adrenalyn: { "577": true },
    adrenalynDuplicates: { "577": 3 }
  };
  assert.equal((await api.save(initial, 0)).status, 200);
  const collection = await api.scan("QAT 5", 1);
  assert.equal(collection.status, 200);
  assert.equal(collection.data.scan.action, "duplicate");
  assert.deepEqual(collection.data.progress.collection, initial.collection);
  assert.equal(collection.data.progress.owned["Catar::QAT 5"], undefined);
  assert.equal(collection.data.progress.duplicates["Catar::QAT 5"], 1);
  const duplicatesOnly = await api.scan("COL 1", 2);
  assert.equal(duplicatesOnly.data.scan.action, "duplicate");
  assert.equal(duplicatesOnly.data.progress.duplicates["Colombia::COL 1"], 3);
  assert.equal(duplicatesOnly.data.progress.owned["Colombia::COL 1"], undefined);
  assert.deepEqual(duplicatesOnly.data.progress.adrenalyn, initial.adrenalyn);
  assert.deepEqual(duplicatesOnly.data.progress.adrenalynDuplicates, initial.adrenalynDuplicates);

  const staleManualSave = await api.save(initial, 1);
  assert.equal(staleManualSave.status, 409);
  assert.equal(staleManualSave.data.errorCode, "PROGRESS_CONFLICT");
  assert.equal(staleManualSave.data.revision, 3);
  assert.deepEqual(staleManualSave.data.progress, duplicatesOnly.data.progress);
  const conflictId = randomUUID();
  const staleScan = await api.scan("QAT 6", 1, conflictId);
  assert.equal(staleScan.status, 409);
  assert.equal(staleScan.data.errorCode, "PROGRESS_CONFLICT");
  assert.deepEqual(staleScan.data.progress, duplicatesOnly.data.progress);
  assert.equal((await api.scan("QAT 6", 3, conflictId)).data.revision, 4);
});

test("el límite de 99 repetidas rechaza sin guardar y una confirmación nueva puede reintentarse después", async t => {
  const api = await fixture(t);
  const payload = { ...emptyProgress(), owned: { "Catar::QAT 5": true }, duplicates: { "Catar::QAT 5": 99 } };
  await api.save(payload, 0);
  const id = randomUUID();
  const limited = await api.scan("QAT 5", 1, id);
  assert.equal(limited.status, 422);
  assert.equal(limited.data.errorCode, "DUPLICATE_LIMIT");
  assert.equal(limited.data.revision, 1);
  assert.deepEqual(limited.data.progress, payload);
  assert.equal((await api.database.pool.query("SELECT * FROM sticker_scans")).rowCount, 0);
  payload.duplicates["Catar::QAT 5"] = 98;
  assert.equal((await api.save(payload, 1)).status, 200);
  const accepted = await api.scan("QAT 5", 2, id);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.scan.duplicates, 99);
  assert.equal(accepted.data.replayed, false);
});

test("peticiones antiguas, códigos desconocidos y datos inválidos nunca crean progreso", async t => {
  const api = await fixture(t);
  const oldClient = await api.request("/api/progress", { method: "PUT", body: emptyProgress() });
  assert.equal(oldClient.status, 428);
  assert.equal(oldClient.data.errorCode, "REVISION_REQUIRED");
  for (const revision of ["-1", "0.1", "NaN", "", "9007199254740992"]) {
    assert.equal((await api.save(emptyProgress(), revision)).status, 400);
  }
  for (const code of ["QAT 21", "ZZZ 5", "QAT 5 seguido de texto", "CC 15", "577", null, { code: "QAT 5" }]) {
    const response = await api.scan(code, 0);
    assert.equal(response.status, 400);
    assert.equal(response.data.errorCode, "UNKNOWN_STICKER");
  }
  assert.equal((await api.scan("QAT 5", 0, "not-a-uuid")).status, 400);
  assert.equal((await api.scan("QAT 5", undefined)).status, 400);
  assert.equal((await api.scan("QAT 5", "0")).status, 400);
  assert.equal((await api.scan("QAT 5", -1)).status, 400);
  assert.equal((await api.scan("QAT 5", 0.5)).status, 400);
  assert.equal(await api.database.getProgress(api.owner.user.id), null);
  assert.equal((await api.database.pool.query("SELECT * FROM sticker_scans")).rowCount, 0);
});

test("escaneos requieren sesión autenticada y CSRF, y los identificadores se aíslan por usuario", async t => {
  const api = await fixture(t);
  assert.equal((await api.request("/api/progress", { headers: {} })).status, 401);
  assert.equal((await api.scan("QAT 5", 0, randomUUID(), {})).status, 401);
  const pending = await api.account("mfa_verify");
  assert.equal((await api.scan("QAT 5", 0, randomUUID(), pending.headers)).status, 401);
  const expired = await api.account("authenticated", Date.now() - 1);
  assert.equal((await api.scan("QAT 5", 0, randomUUID(), expired.headers)).status, 401);
  const noCsrf = { ...api.owner.headers };
  delete noCsrf["x-csrf-token"];
  assert.equal((await api.scan("QAT 5", 0, randomUUID(), noCsrf)).status, 403);
  const wrongCsrf = { ...api.owner.headers, "x-csrf-token": "incorrect" };
  assert.equal((await api.scan("QAT 5", 0, randomUUID(), wrongCsrf)).status, 403);
  assert.equal(await api.database.getProgress(api.owner.user.id), null);

  const id = randomUUID();
  await api.scan("QAT 5", 0, id);
  const second = await api.account();
  const secondScan = await api.scan("QAT 6", 0, id, second.headers);
  assert.equal(secondScan.status, 200);
  assert.equal(secondScan.data.replayed, false);
  assert.deepEqual(secondScan.data.progress.owned, { "Catar::QAT 6": true });
  assert.deepEqual((await api.request("/api/progress")).data.progress.owned, { "Catar::QAT 5": true });
});
