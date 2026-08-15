"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env.local"), quiet: true });
const { initDatabase } = require("../lib/database");
const { decryptSecret, parseEncryptionKey } = require("../lib/security");

async function main() {
  const legacyPath = path.resolve(__dirname, "..", "data", "auth.sqlite");
  if (!fs.existsSync(legacyPath)) throw new Error(`No se encontró la base anterior en ${legacyPath}`);
  const encryptionKey = parseEncryptionKey(process.env.AUTH_ENCRYPTION_KEY);
  const legacy = new DatabaseSync(legacyPath, { readOnly: true });
  let target;
  let imported = 0;
  let skipped = 0;
  try {
    target = await initDatabase(process.env.DATABASE_URL);
    const users = legacy.prepare(`
      SELECT username, email, password_hash, password_salt, mfa_secret, mfa_enabled,
             last_totp_counter, created_at, updated_at
      FROM users
    `).all();
    for (const user of users) {
      if (user.mfa_secret) decryptSecret(user.mfa_secret, encryptionKey);
      if (await target.importUser(user)) imported += 1;
      else skipped += 1;
    }
  } finally {
    legacy.close();
    if (target) await target.close();
  }
  console.log(`Migración terminada: ${imported} usuario(s) importado(s), ${skipped} omitido(s) por existir previamente.`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
