"use strict";

const {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual
} = require("node:crypto");
const { promisify } = require("node:util");

const scryptAsync = promisify(scrypt);
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(password, salt = randomBytes(16)) {
  validatePassword(password);
  const derived = await scryptAsync(password, salt, 64, SCRYPT_OPTIONS);
  return { hash: Buffer.from(derived).toString("base64"), salt: Buffer.from(salt).toString("base64") };
}

async function verifyPassword(password, encodedHash, encodedSalt) {
  if (typeof password !== "string" || !encodedHash || !encodedSalt) return false;
  const expected = Buffer.from(encodedHash, "base64");
  if (expected.length !== 64) return false;
  const actual = Buffer.from(await scryptAsync(password, Buffer.from(encodedSalt, "base64"), expected.length, SCRYPT_OPTIONS));
  return timingSafeEqual(actual, expected);
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 14 || password.length > 128) {
    throw new Error("La contraseña debe tener entre 14 y 128 caracteres");
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    throw new Error("La contraseña debe incluir mayúsculas, minúsculas y números");
  }
}

function encodeBase32(bytes) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value) {
  const normalized = String(value).toUpperCase().replace(/=|\s|-/g, "");
  let bits = 0;
  let buffer = 0;
  const output = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error("Secreto MFA inválido");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function generateMfaSecret() {
  return encodeBase32(randomBytes(20));
}

function generateTotp(secret, timestamp = Date.now(), options = {}) {
  const period = options.period || 30;
  const digits = options.digits || 6;
  const counter = options.counter ?? Math.floor(timestamp / 1000 / period);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = ((digest[offset] & 127) << 24)
    | ((digest[offset + 1] & 255) << 16)
    | ((digest[offset + 2] & 255) << 8)
    | (digest[offset + 3] & 255);
  return String(binary % (10 ** digits)).padStart(digits, "0");
}

function verifyTotp(secret, code, options = {}) {
  const normalized = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return null;
  const period = options.period || 30;
  const currentCounter = Math.floor((options.timestamp || Date.now()) / 1000 / period);
  const lastCounter = Number.isInteger(options.lastCounter) ? options.lastCounter : -1;
  const window = options.window ?? 1;
  for (let offset = -window; offset <= window; offset += 1) {
    const counter = currentCounter + offset;
    if (counter <= lastCounter || counter < 0) continue;
    const candidate = generateTotp(secret, 0, { period, digits: 6, counter });
    if (constantTimeTextEqual(candidate, normalized)) return counter;
  }
  return null;
}

function parseEncryptionKey(value) {
  const key = Buffer.from(String(value || ""), "base64");
  if (key.length !== 32) throw new Error("AUTH_ENCRYPTION_KEY debe contener exactamente 32 bytes en Base64");
  return key;
}

function encryptSecret(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

function decryptSecret(payload, key) {
  const [version, ivValue, tagValue, encryptedValue] = String(payload || "").split(":");
  if (version !== "v1" || !ivValue || !tagValue || !encryptedValue) throw new Error("Secreto cifrado inválido");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
}

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function generateSessionToken() {
  return randomBytes(32).toString("base64url");
}

function generateCsrfToken() {
  return randomBytes(24).toString("base64url");
}

function constantTimeTextEqual(left, right) {
  const leftHash = createHash("sha256").update(String(left)).digest();
  const rightHash = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(leftHash, rightHash);
}

module.exports = {
  constantTimeTextEqual,
  decryptSecret,
  encryptSecret,
  generateCsrfToken,
  generateMfaSecret,
  generateSessionToken,
  generateTotp,
  hashPassword,
  hashToken,
  parseEncryptionKey,
  validatePassword,
  verifyPassword,
  verifyTotp
};
