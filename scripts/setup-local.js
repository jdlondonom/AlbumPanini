"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env.local");

if (fs.existsSync(envPath)) {
  console.log(".env.local ya existe; no se modificó.");
  process.exit(0);
}

const content = [
  `AUTH_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
  "AUTH_DATABASE_PATH=./data/auth.sqlite",
  "HOST=127.0.0.1",
  "PORT=3010",
  "NODE_ENV=development",
  ""
].join("\n");

fs.writeFileSync(envPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
console.log("Configuración local creada en .env.local.");
