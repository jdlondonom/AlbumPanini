"use strict";

const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env.local"), quiet: true });
const { initDatabase } = require("../lib/database");
const { hashPassword, parseEncryptionKey } = require("../lib/security");

function argument(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find(value => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}

function hiddenQuestion(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("La creación de usuarios requiere una terminal interactiva para ocultar la contraseña");
  }
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    };
    const onData = chunk => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Operación cancelada"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (/^[\x20-\x7E]$/.test(character)) {
          value += character;
          process.stdout.write("•");
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  const username = argument("username").trim();
  const email = argument("email").trim().toLowerCase();
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) throw new Error("El usuario debe tener entre 3 y 40 caracteres válidos");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error("Correo inválido");
  parseEncryptionKey(process.env.AUTH_ENCRYPTION_KEY);
  const password = await hiddenQuestion("Contraseña: ");
  const confirmation = await hiddenQuestion("Confirma la contraseña: ");
  if (password !== confirmation) throw new Error("Las contraseñas no coinciden");
  const credentials = await hashPassword(password);
  const databasePath = process.env.AUTH_DATABASE_PATH || path.resolve(__dirname, "..", "data", "auth.sqlite");
  const db = initDatabase(databasePath);
  const now = Date.now();
  try {
    db.prepare("INSERT INTO users (username, email, password_hash, password_salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(username, email, credentials.hash, credentials.salt, now, now);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw new Error("El usuario o correo ya existe");
    throw error;
  } finally {
    db.close();
  }
  console.log(`Cuenta local creada para ${username}. MFA se configurará en el primer ingreso.`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
