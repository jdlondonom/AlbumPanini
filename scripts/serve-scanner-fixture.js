"use strict";

// Opt-in browser fixture (not an automatically discovered node:test suite).
// Its users and progress live only in pg-mem and are
// discarded when this process stops. It never connects to DATABASE_URL.
if (process.env.PANINI_SCANNER_FIXTURE !== "1" || process.env.VERCEL || process.env.NODE_ENV === "production") {
  throw new Error("Solo para pruebas locales: define PANINI_SCANNER_FIXTURE=1");
}

const { randomBytes } = require("node:crypto");
const { newDb } = require("pg-mem");
const { createApp } = require("../lib/app");
const { PostgresDatabase } = require("../lib/database");
const { hashPassword, encryptSecret } = require("../lib/security");

(async () => {
  const adapter = newDb().adapters.createPg();
  const database = new PostgresDatabase(new adapter.Pool(), true);
  await database.migrate();
  const encryptionKey = randomBytes(32);
  const password = await hashPassword("EscanerPruebas2026!");
  const user = await database.createUser({ username: "scanner-test", email: "scanner@example.invalid", passwordHash: password.hash, passwordSalt: password.salt });
  await database.setMfaSecretIfMissing(user.id, encryptSecret("JBSWY3DPEHPK3PXP", encryptionKey));
  await database.activateMfa(user.id, 0);
  const { app } = await createApp({ database, encryptionKey, production: false });
  const server = app.listen(3011, "0.0.0.0", () => console.log("Fixture escáner lista en :3011. Cuenta sintética scanner-test; datos efímeros, sin conexión a PostgreSQL real."));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(async () => { await database.close(); process.exit(0); }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
