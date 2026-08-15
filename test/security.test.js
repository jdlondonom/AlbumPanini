"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const {
  decryptSecret,
  encryptSecret,
  generateMfaSecret,
  generateTotp,
  hashPassword,
  verifyPassword,
  verifyTotp
} = require("../lib/security");

test("scrypt valida la contraseña correcta y rechaza otra", async () => {
  const stored = await hashPassword("ExamplePassword123!");
  assert.equal(await verifyPassword("ExamplePassword123!", stored.hash, stored.salt), true);
  assert.equal(await verifyPassword("WrongPassword123!", stored.hash, stored.salt), false);
});

test("TOTP coincide con el vector SHA-1 de RFC 6238", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(generateTotp(secret, 59_000, { digits: 8 }), "94287082");
});

test("TOTP acepta una vez y rechaza reutilización del contador", () => {
  const secret = generateMfaSecret();
  const timestamp = 1_800_000_000_000;
  const code = generateTotp(secret, timestamp);
  const counter = verifyTotp(secret, code, { timestamp, window: 0 });
  assert.equal(typeof counter, "number");
  assert.equal(verifyTotp(secret, code, { timestamp, window: 0, lastCounter: counter }), null);
});

test("el secreto MFA se cifra con AES-256-GCM", () => {
  const key = randomBytes(32);
  const secret = generateMfaSecret();
  const encrypted = encryptSecret(secret, key);
  assert.notEqual(encrypted, secret);
  assert.equal(decryptSecret(encrypted, key), secret);
  assert.throws(() => decryptSecret(encrypted, randomBytes(32)));
});
