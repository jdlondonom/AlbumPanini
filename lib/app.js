"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const QRCode = require("qrcode");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local"), quiet: true });

const { initDatabase } = require("./database");
const {
  constantTimeTextEqual,
  decryptSecret,
  encryptSecret,
  generateCsrfToken,
  generateMfaSecret,
  generateSessionToken,
  hashPassword,
  hashToken,
  parseEncryptionKey,
  verifyPassword,
  verifyTotp
} = require("./security");

const COOKIE_NAME = "panini_session";
const APP_PATH = path.join(__dirname, "..", "panini-mundial-2026.html");
const AUTHENTICATED_TTL = 8 * 60 * 60 * 1000;
const PENDING_TTL = 10 * 60 * 1000;
const ANONYMOUS_TTL = 20 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const ACCOUNT_LOCK_MS = 15 * 60 * 1000;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function authPage({ title, eyebrow, body, status = 200 }) {
  return {
    status,
    html: `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#10233f">
  <title>${escapeHtml(title)} · Mi Álbum 2026</title>
  <link rel="stylesheet" href="/assets/auth.css">
</head>
<body>
  <main class="auth-shell">
    <section class="auth-card" aria-labelledby="auth-title">
      <div class="auth-brand"><span aria-hidden="true">26</span><strong>Mi Álbum 2026</strong></div>
      <p class="auth-eyebrow">${escapeHtml(eyebrow)}</p>
      <h1 id="auth-title">${escapeHtml(title)}</h1>
      ${body}
    </section>
    <p class="auth-foot">Acceso local · Contraseña cifrada · Verificación en dos pasos</p>
  </main>
</body>
</html>`
  };
}

function sendAuthPage(res, page) {
  res.status(page.status).type("html").send(page.html);
}

function csrfField(token) {
  return `<input type="hidden" name="csrf" value="${escapeHtml(token)}">`;
}

function messageBox(message, type = "error") {
  return message ? `<p class="auth-message auth-message--${type}" role="alert">${escapeHtml(message)}</p>` : "";
}

function sanitizeProgress(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Progreso inválido");
  const sanitizeFlags = source => {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Inventario inválido");
    const result = {};
    const entries = Object.entries(source);
    if (entries.length > 1_200) throw new Error("Inventario demasiado grande");
    for (const [key, flag] of entries) {
      if (typeof key !== "string" || key.length < 1 || key.length > 120 || flag !== true) throw new Error("Estado de lámina inválido");
      result[key] = true;
    }
    return result;
  };
  const sanitizeDuplicates = source => {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Inventario de repetidas inválido");
    const result = {};
    const entries = Object.entries(source);
    if (entries.length > 1_200) throw new Error("Inventario demasiado grande");
    for (const [key, count] of entries) {
      if (typeof key !== "string" || key.length < 1 || key.length > 120 || !Number.isInteger(count) || count < 1 || count > 99) {
        throw new Error("Cantidad de repetidas inválida");
      }
      result[key] = count;
    }
    return result;
  };
  return {
    version: 3,
    owned: sanitizeFlags(value.owned),
    collection: sanitizeFlags(value.collection),
    duplicates: sanitizeDuplicates(value.duplicates)
  };
}

function renderLogin(csrf, message = "") {
  return authPage({
    title: "Ingresa a tu colección",
    eyebrow: "Acceso protegido",
    body: `${messageBox(message)}
      <form method="post" action="/login" class="auth-form">
        ${csrfField(csrf)}
        <label>Usuario o correo
          <input name="identity" autocomplete="username" maxlength="254" required autofocus>
        </label>
        <label>Contraseña
          <input name="password" type="password" autocomplete="current-password" maxlength="128" required>
        </label>
        <button type="submit">Continuar</button>
      </form>
      <p class="auth-help">Después de validar la contraseña te pediremos el código de tu aplicación autenticadora.</p>`
  });
}

function renderMfaVerify(csrf, message = "") {
  return authPage({
    title: "Verificación en dos pasos",
    eyebrow: "Segundo factor",
    body: `${messageBox(message)}
      <p class="auth-copy">Escribe el código de seis dígitos generado por tu aplicación autenticadora.</p>
      <form method="post" action="/mfa" class="auth-form">
        ${csrfField(csrf)}
        <label>Código temporal
          <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus>
        </label>
        <button type="submit">Verificar e ingresar</button>
      </form>`
  });
}

function renderMfaSetup(csrf, qrDataUrl, secret, message = "") {
  return authPage({
    title: "Configura tu MFA",
    eyebrow: "Primera entrada",
    body: `${messageBox(message)}
      <p class="auth-copy">Escanea este código con Google Authenticator, Microsoft Authenticator, 1Password u otra aplicación TOTP.</p>
      <img class="auth-qr" src="${qrDataUrl}" alt="Código QR para configurar la autenticación multifactor">
      <details class="auth-secret">
        <summary>Ingresar la clave manualmente</summary>
        <code>${escapeHtml(secret)}</code>
      </details>
      <form method="post" action="/mfa/setup" class="auth-form">
        ${csrfField(csrf)}
        <label>Código de comprobación
          <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus>
        </label>
        <button type="submit">Activar MFA e ingresar</button>
      </form>
      <p class="auth-help">La clave MFA queda cifrada en la base de datos y nunca se incluye en GitHub.</p>`
  });
}

async function createApp(options = {}) {
  if (!fs.existsSync(APP_PATH)) throw new Error(`No se encontró la aplicación en ${APP_PATH}`);
  const encryptionKey = options.encryptionKey || parseEncryptionKey(process.env.AUTH_ENCRYPTION_KEY);
  const production = options.production ?? (process.env.NODE_ENV === "production" || process.env.VERCEL === "1");
  const disableRateLimit = Boolean(options.disableRateLimit);
  const db = options.database || await initDatabase(options.databaseUrl || process.env.DATABASE_URL, { pool: options.pool });
  const appHtml = fs.readFileSync(APP_PATH, "utf8");
  const inlineScript = appHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
  const scriptHash = `'sha256-${createHash("sha256").update(inlineScript).digest("base64")}'`;
  const dummyPassword = await hashPassword("NotARealAccount123!");

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", options.trustProxy ?? (production ? 1 : false));
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", scriptHash],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    referrerPolicy: { policy: "no-referrer" }
  }));
  app.use(express.urlencoded({ extended: false, limit: "10kb" }));
  app.use(express.json({ limit: "256kb" }));
  app.use(cookieParser());
  app.use("/assets", express.static(path.join(__dirname, "..", "public"), { dotfiles: "deny", etag: true, fallthrough: false, maxAge: "1h" }));
  app.use((req, res, next) => {
    if (production && !req.secure && req.path !== "/health") {
      return sendAuthPage(res, authPage({
        title: "Se requiere HTTPS",
        eyebrow: "Conexión no segura",
        status: 426,
        body: "<p class=\"auth-copy\">En producción, publica la aplicación detrás de HTTPS antes de iniciar sesión.</p>"
      }));
    }
    res.set("Cache-Control", "no-store");
    next();
  });

  const authLimiter = async (req, res, next) => {
    if (disableRateLimit) return next();
    try {
      const result = await db.consumeRateLimit(`auth:${req.ip}`, 20, 15 * 60 * 1000);
      res.set("RateLimit-Remaining", String(result.remaining));
      if (result.allowed) return next();
      res.set("Retry-After", String(Math.max(1, Math.ceil((result.expiresAt - Date.now()) / 1000))));
      return sendAuthPage(res, authPage({
        title: "Demasiados intentos",
        eyebrow: "Protección activa",
        status: 429,
        body: "<p class=\"auth-copy\">Espera quince minutos antes de intentarlo nuevamente.</p>"
      }));
    } catch (error) {
      next(error);
    }
  };

  function cookieOptions(ttl) {
    return { httpOnly: true, sameSite: "strict", secure: production, path: "/", maxAge: ttl };
  }

  async function createSession(res, stage, userId = null) {
    const token = generateSessionToken();
    const tokenHash = hashToken(token);
    const csrfToken = generateCsrfToken();
    const ttl = stage === "authenticated" ? AUTHENTICATED_TTL : stage === "anonymous" ? ANONYMOUS_TTL : PENDING_TTL;
    const now = Date.now();
    await db.createSession({ tokenHash, userId, stage, csrfToken, expiresAt: now + ttl, createdAt: now });
    res.cookie(COOKIE_NAME, token, cookieOptions(ttl));
    return { token_hash: tokenHash, user_id: userId, stage, csrf_token: csrfToken, expires_at: now + ttl };
  }

  async function deleteSession(req, res) {
    if (req.session?.token_hash) await db.deleteSession(req.session.token_hash);
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "strict", secure: production, path: "/" });
  }

  async function replaceSession(req, res, stage, userId = null) {
    if (req.session?.token_hash) await deleteSession(req, res);
    return createSession(res, stage, userId);
  }

  app.use(async (req, res, next) => {
    const rawToken = req.cookies[COOKIE_NAME];
    if (!rawToken) return next();
    const session = await db.getSession(hashToken(rawToken));
    if (!session) {
      res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "strict", secure: production, path: "/" });
      return next();
    }
    req.session = session;
    if (session.user_id) req.user = await db.getUserById(session.user_id);
    next();
  });

  async function ensureAnonymousSession(req, res) {
    if (req.session?.stage === "anonymous") return req.session;
    return replaceSession(req, res, "anonymous");
  }

  function verifyCsrf(req, res, next) {
    const submittedToken = req.body?.csrf || req.get("x-csrf-token") || "";
    if (!req.session || !constantTimeTextEqual(submittedToken, req.session.csrf_token)) {
      return sendAuthPage(res, authPage({
        title: "Solicitud inválida",
        eyebrow: "Protección CSRF",
        status: 403,
        body: "<p class=\"auth-copy\">Recarga la página e inténtalo nuevamente.</p>"
      }));
    }
    next();
  }

  function requirePending(stage) {
    return (req, res, next) => {
      if (!req.session || req.session.stage !== stage || !req.user) return res.redirect(303, "/login");
      next();
    };
  }

  function requireAuth(req, res, next) {
    if (!req.session || req.session.stage !== "authenticated" || !req.user) return res.redirect(303, "/login");
    next();
  }

  const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  async function sendMfaSetupPage(res, session, user, message = "") {
    const secret = decryptSecret(user.mfa_secret, encryptionKey);
    const issuer = "Mi Album 2026";
    const label = `${issuer}:${user.email}`;
    const uri = `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    const qr = await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 1, width: 240 });
    sendAuthPage(res, renderMfaSetup(session.csrf_token, qr, secret, message));
  }

  app.get("/health", (req, res) => res.json({ status: "ok" }));
  app.get("/", (req, res) => res.redirect(303, req.session?.stage === "authenticated" ? "/app" : "/login"));
  app.get("/login", asyncRoute(async (req, res) => {
    if (req.session?.stage === "authenticated") return res.redirect(303, "/app");
    const session = await ensureAnonymousSession(req, res);
    sendAuthPage(res, renderLogin(session.csrf_token));
  }));

  app.post("/login", authLimiter, verifyCsrf, asyncRoute(async (req, res) => {
    const identity = typeof req.body.identity === "string" ? req.body.identity.trim().slice(0, 254) : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const user = await db.getUserByIdentity(identity);
    const passwordValid = user
      ? await verifyPassword(password, user.password_hash, user.password_salt)
      : await verifyPassword(password, dummyPassword.hash, dummyPassword.salt);
    const now = Date.now();
    const locked = Boolean(user?.locked_until && user.locked_until > now);
    if (!user || !passwordValid || locked) {
      if (user && !locked) await db.recordFailedLogin(user.id, MAX_FAILED_LOGINS, ACCOUNT_LOCK_MS, now);
      return sendAuthPage(res, renderLogin(req.session.csrf_token, "Credenciales incorrectas o acceso temporalmente bloqueado."));
    }
    await db.clearFailedLogins(user.id, now);
    if (!user.mfa_secret) {
      const encrypted = encryptSecret(generateMfaSecret(), encryptionKey);
      await db.setMfaSecretIfMissing(user.id, encrypted, now);
    }
    const stage = user.mfa_enabled ? "mfa_verify" : "mfa_setup";
    await replaceSession(req, res, stage, user.id);
    res.redirect(303, stage === "mfa_setup" ? "/mfa/setup" : "/mfa");
  }));

  app.get("/mfa/setup", requirePending("mfa_setup"), asyncRoute(async (req, res) => {
    await sendMfaSetupPage(res, req.session, req.user);
  }));

  app.post("/mfa/setup", authLimiter, requirePending("mfa_setup"), verifyCsrf, asyncRoute(async (req, res) => {
    const secret = decryptSecret(req.user.mfa_secret, encryptionKey);
    const counter = verifyTotp(secret, req.body.code, { lastCounter: req.user.last_totp_counter });
    if (counter === null) return sendMfaSetupPage(res, req.session, req.user, "El código no es válido o ya fue utilizado. Escanea nuevamente si es necesario.");
    const activated = await db.activateMfa(req.user.id, counter);
    if (!activated) return sendMfaSetupPage(res, req.session, req.user, "El código no es válido o ya fue utilizado.");
    await replaceSession(req, res, "authenticated", req.user.id);
    res.redirect(303, "/app");
  }));

  app.get("/mfa", requirePending("mfa_verify"), (req, res) => sendAuthPage(res, renderMfaVerify(req.session.csrf_token)));
  app.post("/mfa", authLimiter, requirePending("mfa_verify"), verifyCsrf, asyncRoute(async (req, res) => {
    const secret = decryptSecret(req.user.mfa_secret, encryptionKey);
    const counter = verifyTotp(secret, req.body.code, { lastCounter: req.user.last_totp_counter });
    if (counter === null) return sendAuthPage(res, renderMfaVerify(req.session.csrf_token, "El código no es válido o ya fue utilizado."));
    const verified = await db.updateTotpCounter(req.user.id, counter);
    if (!verified) return sendAuthPage(res, renderMfaVerify(req.session.csrf_token, "El código no es válido o ya fue utilizado."));
    await replaceSession(req, res, "authenticated", req.user.id);
    res.redirect(303, "/app");
  }));

  app.get(["/app", "/panini-mundial-2026.html"], requireAuth, (req, res) => {
    const rendered = appHtml
      .replaceAll("__AUTH_USER__", escapeHtml(req.user.username))
      .replaceAll("__AUTH_USER_ID__", escapeHtml(req.user.id))
      .replaceAll("__CSRF_TOKEN__", escapeHtml(req.session.csrf_token));
    res.type("html").send(rendered);
  });

  app.get("/api/progress", requireAuth, asyncRoute(async (req, res) => {
    const saved = await db.getProgress(req.user.id);
    res.json({
      progress: saved?.payload || { version: 3, owned: {}, collection: {}, duplicates: {} },
      updatedAt: saved?.updatedAt || null
    });
  }));

  app.put("/api/progress", requireAuth, verifyCsrf, asyncRoute(async (req, res) => {
    let progress;
    try {
      progress = sanitizeProgress(req.body);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const updatedAt = await db.saveProgress(req.user.id, progress);
    res.json({ saved: true, updatedAt });
  }));

  app.post("/logout", requireAuth, verifyCsrf, asyncRoute(async (req, res) => {
    await deleteSession(req, res);
    res.redirect(303, "/login");
  }));

  app.use((req, res) => sendAuthPage(res, authPage({
    title: "Página no encontrada",
    eyebrow: "Error 404",
    status: 404,
    body: "<p class=\"auth-copy\"><a href=\"/\">Volver al inicio</a></p>"
  })));

  app.use((error, req, res, next) => {
    console.error("Error interno:", error.message);
    if (res.headersSent) return next(error);
    sendAuthPage(res, authPage({
      title: "No pudimos completar la solicitud",
      eyebrow: "Error interno",
      status: 500,
      body: "<p class=\"auth-copy\">Inténtalo nuevamente. No se modificaron tus credenciales.</p>"
    }));
  });

  return { app, db };
}

async function start() {
  const { app } = await createApp();
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT) || 3010;
  app.listen(port, host, () => {
    console.log(`Mi Álbum 2026 disponible en http://${host}:${port}`);
  });
}

if (require.main === module) {
  start().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createApp };
