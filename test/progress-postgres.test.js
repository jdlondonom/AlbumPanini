"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const { PostgresDatabase, emptyProgress } = require("../lib/database");

// These tests need real transaction isolation, which pg-mem does not emulate.
// Point this only at the disposable database named below, never DATABASE_URL.
const integrationUrl = process.env.SCANNER_TEST_DATABASE_URL;

test("PostgreSQL real: migración, escrituras simultáneas e idempotencia persistente", { skip: !integrationUrl }, async t => {
  assert.equal(new URL(integrationUrl).pathname, "/panini_scanner_tests", "Utiliza exclusivamente la base efímera panini_scanner_tests");
  const database = new PostgresDatabase(new Pool({ connectionString: integrationUrl, max: 5 }), true);
  const otherInstance = new PostgresDatabase(new Pool({ connectionString: integrationUrl, max: 5 }), true);
  t.after(async () => {
    await database.close();
    await otherInstance.close();
  });
  await database.migrate();

  async function account() {
    const suffix = randomUUID();
    return database.createUser({ username: suffix, email: `${suffix}@example.test`, passwordHash: "test-hash", passwordSalt: "test-salt" });
  }
  function scan(scanId = randomUUID(), expectedRevision = 0) {
    return { scanId, expectedRevision, code: "QAT 5", key: "Catar::QAT 5" };
  }
  function assertOneConflict(results) {
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const rejected = results.find(result => result.status === "rejected");
    assert.equal(rejected.reason.errorCode, "PROGRESS_CONFLICT");
    assert.equal(rejected.reason.snapshot.revision, 1);
  }

  await t.test("migración repetible preserva payloads previos y añade revisión cero", async () => {
    const user = await account();
    const legacy = { ...emptyProgress(), owned: { "Catar::QAT 5": true }, adrenalynDuplicates: { "577": 3 } };
    // The URL is constrained to the disposable test database above.
    await database.pool.query("ALTER TABLE user_progress DROP COLUMN revision");
    await database.pool.query("INSERT INTO user_progress (user_id, payload, updated_at) VALUES ($1, $2::jsonb, $3)", [user.id, JSON.stringify(legacy), 123]);
    await database.migrate();
    await database.migrate();
    assert.deepEqual(await database.getProgress(user.id), { payload: legacy, revision: 0, updatedAt: 123 });
    const saved = await database.recordStickerScan(user.id, scan());
    assert.equal(saved.revision, 1);
    assert.equal(saved.payload.duplicates["Catar::QAT 5"], 1);
    assert.deepEqual(saved.payload.adrenalynDuplicates, legacy.adrenalynDuplicates);
  });

  await t.test("guardar y escanear al mismo tiempo, sin fila previa, no sobrescribe al ganador", async () => {
    for (let round = 0; round < 5; round += 1) {
      const user = await account();
      const manual = { ...emptyProgress(), owned: { "Colombia::COL 1": true } };
      const results = await Promise.allSettled([
        database.saveProgress(user.id, manual, 0),
        otherInstance.recordStickerScan(user.id, scan())
      ]);
      assertOneConflict(results);
      const winner = results.find(result => result.status === "fulfilled").value;
      const current = await database.getProgress(user.id);
      assert.equal(current.revision, 1);
      assert.deepEqual(current.payload, winner.payload);
      assert.equal(Object.keys(current.payload.owned).length, 1);
    }
  });

  await t.test("doble envío concurrente del mismo escaneo aplica una sola unidad", async () => {
    const user = await account();
    const confirmed = scan();
    const results = await Promise.all([
      database.recordStickerScan(user.id, confirmed),
      otherInstance.recordStickerScan(user.id, confirmed)
    ]);
    assert.deepEqual(results.map(result => result.replayed).sort(), [false, true]);
    assert.equal(results[0].revision, 1);
    assert.equal(results[1].revision, 1);
    assert.deepEqual((await database.getProgress(user.id)).payload.duplicates, {});
    const rows = await database.pool.query("SELECT * FROM sticker_scans WHERE user_id = $1", [user.id]);
    assert.equal(rows.rowCount, 1);
  });

  await t.test("capturas distintas en paralelo exigen reconfirmar la revisión y suman exactamente dos ejemplares", async () => {
    const user = await account();
    const scans = [scan(), scan()];
    const results = await Promise.allSettled([
      database.recordStickerScan(user.id, scans[0]),
      otherInstance.recordStickerScan(user.id, scans[1])
    ]);
    assertOneConflict(results);
    const loser = results.findIndex(result => result.status === "rejected");
    const confirmedAgain = await otherInstance.recordStickerScan(user.id, { ...scans[loser], expectedRevision: 1 });
    assert.equal(confirmedAgain.revision, 2);
    assert.equal(confirmedAgain.scan.action, "duplicate");
    assert.equal(confirmedAgain.payload.duplicates["Catar::QAT 5"], 1);
    assert.equal(confirmedAgain.payload.owned["Catar::QAT 5"], true);
  });

  await t.test("un reintento en otra instancia devuelve inventario actual sin perder otros cambios", async () => {
    const user = await account();
    const first = scan();
    await database.recordStickerScan(user.id, first);
    await otherInstance.recordStickerScan(user.id, scan(randomUUID(), 1));
    const current = await database.getProgress(user.id);
    const withAdrenalyn = { ...current.payload, adrenalyn: { "577": true } };
    await otherInstance.saveProgress(user.id, withAdrenalyn, 2);
    const retry = await database.recordStickerScan(user.id, first);
    assert.equal(retry.replayed, true);
    assert.equal(retry.revision, 3);
    assert.equal(retry.scan.action, "album");
    assert.deepEqual(retry.payload, withAdrenalyn);
    await assert.rejects(database.saveProgress(user.id, emptyProgress(), 1), error => error.errorCode === "PROGRESS_CONFLICT");
    assert.deepEqual((await database.getProgress(user.id)).payload, withAdrenalyn);
  });

  await t.test("fallar tras escribir progreso revierte la transacción y permite reintentar el mismo identificador", async () => {
    const user = await account();
    const confirmed = scan();
    const write = otherInstance.writeProgress;
    otherInstance.writeProgress = async function (client, ...args) {
      await write.call(this, client, ...args);
      await client.query("SELECT 1 / 0");
    };
    try {
      await assert.rejects(otherInstance.recordStickerScan(user.id, confirmed), /division by zero/);
    } finally {
      otherInstance.writeProgress = write;
    }
    assert.equal(await database.getProgress(user.id), null);
    assert.equal((await database.pool.query("SELECT * FROM sticker_scans WHERE user_id = $1", [user.id])).rowCount, 0);
    const retry = await database.recordStickerScan(user.id, confirmed);
    assert.equal(retry.revision, 1);
    assert.equal(retry.replayed, false);
    assert.deepEqual(retry.payload.duplicates, {});
  });
});
