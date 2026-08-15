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
  const db = await initDatabase(process.env.DATABASE_URL);
  try {
    await db.createUser({ username, email, passwordHash: credentials.hash, passwordSalt: credentials.salt });
  } catch (error) {
    if (error.code === "23505" || String(error.message).includes("unique")) throw new Error("El usuario o correo ya existe");
    throw error;
  } finally {
    await db.close();
  }
  console.log(`Cuenta creada para ${username}. MFA se configurará en el primer ingreso.`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
