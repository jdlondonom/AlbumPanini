"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { newDb } = require("pg-mem");
const { PostgresDatabase, emptyProgress } = require("../lib/database");

async function createDatabase(t) {
  const memory = newDb();
  const adapter = memory.adapters.createPg();
  const database = new PostgresDatabase(new adapter.Pool(), true);
  await database.migrate();
  t.after(() => database.close());
  return database;
}

test("PostgreSQL conserva usuarios sin distinguir mayúsculas", async t => {
  const database = await createDatabase(t);
  await database.createUser({
    username: "Collector",
    email: "Collector@example.com",
    passwordHash: "hash",
    passwordSalt: "salt"
  });

  assert.equal((await database.getUserByIdentity("collector")).email, "Collector@example.com");
  assert.equal((await database.getUserByIdentity("COLLECTOR@EXAMPLE.COM")).username, "Collector");

  await assert.rejects(
    database.createUser({ username: "collector", email: "other@example.com", passwordHash: "hash", passwordSalt: "salt" }),
    /unique/i
  );

  assert.equal(await database.importUser({
    username: "Collector",
    email: "Collector@example.com",
    password_hash: "legacy-hash",
    password_salt: "legacy-salt",
    mfa_enabled: 0,
    last_totp_counter: -1
  }), false);
});

test("el límite de autenticación es compartido y reinicia por ventana", async t => {
  const database = await createDatabase(t);
  const now = 1_000_000;
  assert.equal((await database.consumeRateLimit("auth:127.0.0.1", 2, 60_000, now)).allowed, true);
  assert.equal((await database.consumeRateLimit("auth:127.0.0.1", 2, 60_000, now + 1)).allowed, true);
  assert.equal((await database.consumeRateLimit("auth:127.0.0.1", 2, 60_000, now + 2)).allowed, false);
  assert.equal((await database.consumeRateLimit("auth:127.0.0.1", 2, 60_000, now + 60_001)).allowed, true);
});

test("guardar progreso exige una revisión válida incluso fuera de la API", async t => {
  const database = await createDatabase(t);
  const user = await database.createUser({ username: "legacy", email: "legacy@example.test", passwordHash: "hash", passwordSalt: "salt" });
  const progress = { ...emptyProgress(), owned: { "Catar::QAT 5": true }, adrenalynDuplicates: { "577": 2 } };
  assert.equal((await database.saveProgress(user.id, progress, 0, 123)).revision, 1);
  await assert.rejects(database.saveProgress(user.id, emptyProgress()), error => error.errorCode === "INVALID_REVISION");
  await assert.rejects(database.saveProgress(user.id, emptyProgress(), 0), error => error.errorCode === "PROGRESS_CONFLICT");
  assert.equal((await database.getProgress(user.id)).revision, 1);
  assert.deepEqual((await database.getProgress(user.id)).payload, progress);
});
