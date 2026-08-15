"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { randomBytes } = require("node:crypto");
const { newDb } = require("pg-mem");
const { createApp } = require("../lib/app");
const { createHandler } = require("../api/index");
const { PostgresDatabase } = require("../lib/database");
const { decryptSecret, generateTotp, hashPassword } = require("../lib/security");

function cookieFrom(response) {
  const cookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")];
  const raw = cookies.filter(Boolean).at(-1);
  return raw ? raw.split(";", 1)[0] : "";
}

function csrfFrom(html) {
  return html.match(/name="csrf" value="([^"]+)"/)?.[1] || "";
}

test("login, alta MFA y acceso protegido funcionan de extremo a extremo", async t => {
  const memory = newDb();
  const adapter = memory.adapters.createPg();
  const database = new PostgresDatabase(new adapter.Pool(), true);
  await database.migrate();
  const encryptionKey = randomBytes(32);
  const { app, db } = await createApp({ database, encryptionKey, disableRateLimit: true });
  const password = "ExamplePassword123!";
  const credentials = await hashPassword(password);
  await db.createUser({
    username: "integration-user",
    email: "integration@example.com",
    passwordHash: credentials.hash,
    passwordSalt: credentials.salt
  });

  const server = http.createServer(createHandler(async () => ({ app })));
  server.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await db.close();
  });

  const blocked = await fetch(`${baseUrl}/app`, { redirect: "manual" });
  assert.equal(blocked.status, 303);
  assert.equal(blocked.headers.get("location"), "/login");

  const loginPage = await fetch(`${baseUrl}/login`, { redirect: "manual" });
  const anonymousCookie = cookieFrom(loginPage);
  const loginHtml = await loginPage.text();
  const loginCsrf = csrfFrom(loginHtml);
  assert.match(loginPage.headers.get("set-cookie"), /HttpOnly/i);
  assert.match(loginPage.headers.get("set-cookie"), /SameSite=Strict/i);
  assert.ok(loginCsrf);

  const passwordStep = await fetch(`${baseUrl}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: anonymousCookie },
    body: new URLSearchParams({ identity: "integration-user", password, csrf: loginCsrf })
  });
  assert.equal(passwordStep.status, 303);
  assert.equal(passwordStep.headers.get("location"), "/mfa/setup");
  const pendingCookie = cookieFrom(passwordStep);

  const setupPage = await fetch(`${baseUrl}/mfa/setup`, { headers: { cookie: pendingCookie } });
  const setupHtml = await setupPage.text();
  const setupCsrf = csrfFrom(setupHtml);
  assert.equal(setupPage.status, 200);
  assert.match(setupHtml, /data:image\/png;base64/);
  assert.ok(setupCsrf);

  const user = await db.getUserByIdentity("integration-user");
  const secret = decryptSecret(user.mfa_secret, encryptionKey);
  const code = generateTotp(secret);
  const mfaStep = await fetch(`${baseUrl}/mfa/setup`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: pendingCookie },
    body: new URLSearchParams({ code, csrf: setupCsrf })
  });
  assert.equal(mfaStep.status, 303);
  assert.equal(mfaStep.headers.get("location"), "/app");
  const authenticatedCookie = cookieFrom(mfaStep);

  const appPage = await fetch(`${baseUrl}/app`, { headers: { cookie: authenticatedCookie } });
  const appHtml = await appPage.text();
  assert.equal(appPage.status, 200);
  assert.match(appHtml, /Mi Álbum 2026/);
  assert.match(appHtml, /integration-user/);
  assert.doesNotMatch(appHtml, /__CSRF_TOKEN__/);
  assert.doesNotMatch(appHtml, /__AUTH_USER_ID__/);
  assert.match(appPage.headers.get("content-security-policy"), /script-src/);
  const logoutCsrf = csrfFrom(appHtml);

  const invalidProgress = await fetch(`${baseUrl}/api/progress`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-csrf-token": logoutCsrf, cookie: authenticatedCookie },
    body: JSON.stringify({ version: 3, owned: { "Colombia::COL 1": false }, collection: {}, duplicates: {} })
  });
  assert.equal(invalidProgress.status, 400);

  const progress = { version: 3, owned: { "Colombia::COL 1": true }, collection: {}, duplicates: { "Colombia::COL 2": 2 } };
  const savedProgress = await fetch(`${baseUrl}/api/progress`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": logoutCsrf,
      cookie: authenticatedCookie
    },
    body: JSON.stringify(progress)
  });
  assert.equal(savedProgress.status, 200);

  const loadedProgress = await fetch(`${baseUrl}/api/progress`, { headers: { cookie: authenticatedCookie } });
  assert.equal(loadedProgress.status, 200);
  assert.deepEqual((await loadedProgress.json()).progress, progress);

  const rejectedLogout = await fetch(`${baseUrl}/logout`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: authenticatedCookie },
    body: new URLSearchParams({ csrf: "incorrecto" })
  });
  assert.equal(rejectedLogout.status, 403);

  const logout = await fetch(`${baseUrl}/logout`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: authenticatedCookie },
    body: new URLSearchParams({ csrf: logoutCsrf })
  });
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get("location"), "/login");

  const afterLogout = await fetch(`${baseUrl}/app`, { redirect: "manual", headers: { cookie: authenticatedCookie } });
  assert.equal(afterLogout.status, 303);
  assert.equal(afterLogout.headers.get("location"), "/login");

  const enabledUser = await db.getUserByIdentity("integration-user");
  assert.equal(enabledUser.mfa_enabled, true);
  assert.ok(enabledUser.last_totp_counter >= 0);
});

test("producción acepta el proxy HTTPS de Vercel y emite cookies Secure", async t => {
  const memory = newDb();
  const adapter = memory.adapters.createPg();
  const database = new PostgresDatabase(new adapter.Pool(), true);
  await database.migrate();
  const { app } = await createApp({
    database,
    encryptionKey: randomBytes(32),
    production: true,
    trustProxy: 1,
    disableRateLimit: true
  });
  const server = http.createServer(createHandler(async () => ({ app })));
  server.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await database.close();
  });

  const insecure = await fetch(`${baseUrl}/login`);
  assert.equal(insecure.status, 426);

  const secure = await fetch(`${baseUrl}/login`, { headers: { "x-forwarded-proto": "https" } });
  assert.equal(secure.status, 200);
  assert.match(secure.headers.get("set-cookie"), /Secure/i);
  assert.match(secure.headers.get("strict-transport-security"), /max-age/i);
});
