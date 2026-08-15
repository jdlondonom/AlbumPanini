"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { newDb } = require("pg-mem");
const { PostgresDatabase } = require("../lib/database");

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
