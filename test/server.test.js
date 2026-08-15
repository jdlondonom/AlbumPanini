"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { createApp } = require("../server");
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
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "panini-auth-test-"));
  const databasePath = path.join(tempDirectory, "auth.sqlite");
  const encryptionKey = randomBytes(32);
  const { app, db } = await createApp({ databasePath, encryptionKey, disableRateLimit: true });
  const password = "ExamplePassword123!";
  const credentials = await hashPassword(password);
  const now = Date.now();
  db.prepare("INSERT INTO users (username, email, password_hash, password_salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("integration-user", "integration@example.com", credentials.hash, credentials.salt, now, now);

  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
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

  const user = db.prepare("SELECT * FROM users WHERE username = ?").get("integration-user");
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
  assert.match(appPage.headers.get("content-security-policy"), /script-src/);

  const logoutCsrf = csrfFrom(appHtml);
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

  const enabledUser = db.prepare("SELECT mfa_enabled, last_totp_counter FROM users WHERE username = ?").get("integration-user");
  assert.equal(enabledUser.mfa_enabled, 1);
  assert.ok(enabledUser.last_totp_counter >= 0);
});
