"use strict";

const { Pool } = require("pg");

function numeric(value) {
  return value === null || value === undefined ? null : Number(value);
}

function normalizeUser(row) {
  if (!row) return null;
  return {
    ...row,
    id: numeric(row.id),
    mfa_enabled: Boolean(row.mfa_enabled),
    last_totp_counter: numeric(row.last_totp_counter),
    failed_attempts: numeric(row.failed_attempts),
    locked_until: numeric(row.locked_until),
    created_at: numeric(row.created_at),
    updated_at: numeric(row.updated_at)
  };
}

function normalizeSession(row) {
  if (!row) return null;
  return {
    ...row,
    user_id: numeric(row.user_id),
    expires_at: numeric(row.expires_at),
    created_at: numeric(row.created_at)
  };
}

class PostgresDatabase {
  constructor(pool, ownsPool = false) {
    this.pool = pool;
    this.ownsPool = ownsPool;
  }

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        mfa_secret TEXT,
        mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        last_totp_counter BIGINT NOT NULL DEFAULT -1,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS users_username_ci_unique ON users ((LOWER(username)));
      CREATE UNIQUE INDEX IF NOT EXISTS users_email_ci_unique ON users ((LOWER(email)));

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
        stage TEXT NOT NULL CHECK(stage IN ('anonymous', 'mfa_setup', 'mfa_verify', 'authenticated')),
        csrf_token TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS rate_limits (
        rate_key TEXT PRIMARY KEY,
        hits INTEGER NOT NULL,
        expires_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS rate_limits_expires_at_idx ON rate_limits(expires_at);

      CREATE TABLE IF NOT EXISTS user_progress (
        user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        payload JSONB NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `);
    await this.cleanupExpired();
  }

  async cleanupExpired(now = Date.now()) {
    await this.pool.query("DELETE FROM sessions WHERE expires_at <= $1", [now]);
    await this.pool.query("DELETE FROM rate_limits WHERE expires_at <= $1", [now]);
  }

  async createUser({ username, email, passwordHash, passwordSalt, now = Date.now() }) {
    const result = await this.pool.query(
      `INSERT INTO users (username, email, password_hash, password_salt, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING *`,
      [username, email, passwordHash, passwordSalt, now]
    );
    return normalizeUser(result.rows[0]);
  }

  async importUser(user) {
    const result = await this.pool.query(
      `INSERT INTO users (
         username, email, password_hash, password_salt, mfa_secret, mfa_enabled,
         last_totp_counter, failed_attempts, locked_until, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, NULL, $8, $9)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        user.username,
        user.email,
        user.password_hash,
        user.password_salt,
        user.mfa_secret || null,
        Boolean(user.mfa_enabled),
        Number(user.last_totp_counter ?? -1),
        Number(user.created_at || Date.now()),
        Number(user.updated_at || Date.now())
      ]
    );
    return result.rowCount === 1;
  }

  async getUserByIdentity(identity) {
    const result = await this.pool.query(
      "SELECT * FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1) LIMIT 1",
      [identity]
    );
    return normalizeUser(result.rows[0]);
  }

  async getUserById(id) {
    const result = await this.pool.query("SELECT * FROM users WHERE id = $1", [id]);
    return normalizeUser(result.rows[0]);
  }

  async clearFailedLogins(userId, now = Date.now()) {
    await this.pool.query(
      "UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = $1 WHERE id = $2",
      [now, userId]
    );
  }

  async recordFailedLogin(userId, maxAttempts, lockMs, now = Date.now()) {
    await this.pool.query(
      `UPDATE users
       SET failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
           locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN $1::BIGINT + $3::BIGINT ELSE NULL END,
           updated_at = $1
       WHERE id = $4`,
      [now, maxAttempts, lockMs, userId]
    );
  }

  async setMfaSecretIfMissing(userId, encryptedSecret, now = Date.now()) {
    await this.pool.query(
      "UPDATE users SET mfa_secret = COALESCE(mfa_secret, $1), updated_at = $2 WHERE id = $3",
      [encryptedSecret, now, userId]
    );
  }

  async activateMfa(userId, counter, now = Date.now()) {
    const result = await this.pool.query(
      `UPDATE users
       SET mfa_enabled = TRUE, last_totp_counter = $1, updated_at = $2
       WHERE id = $3 AND last_totp_counter < $1`,
      [counter, now, userId]
    );
    return result.rowCount === 1;
  }

  async updateTotpCounter(userId, counter, now = Date.now()) {
    const result = await this.pool.query(
      "UPDATE users SET last_totp_counter = $1, updated_at = $2 WHERE id = $3 AND last_totp_counter < $1",
      [counter, now, userId]
    );
    return result.rowCount === 1;
  }

  async createSession({ tokenHash, userId, stage, csrfToken, expiresAt, createdAt }) {
    await this.pool.query(
      `INSERT INTO sessions (token_hash, user_id, stage, csrf_token, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tokenHash, userId, stage, csrfToken, expiresAt, createdAt]
    );
  }

  async getSession(tokenHash, now = Date.now()) {
    const result = await this.pool.query(
      "SELECT * FROM sessions WHERE token_hash = $1 AND expires_at > $2",
      [tokenHash, now]
    );
    return normalizeSession(result.rows[0]);
  }

  async deleteSession(tokenHash) {
    await this.pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
  }

  async consumeRateLimit(rateKey, limit, windowMs, now = Date.now()) {
    const result = await this.pool.query(
      `INSERT INTO rate_limits (rate_key, hits, expires_at)
       VALUES ($1, 1, $2)
       ON CONFLICT (rate_key) DO UPDATE SET
         hits = CASE WHEN rate_limits.expires_at <= $3 THEN 1 ELSE rate_limits.hits + 1 END,
         expires_at = CASE WHEN rate_limits.expires_at <= $3 THEN $2 ELSE rate_limits.expires_at END
       RETURNING hits, expires_at`,
      [rateKey, now + windowMs, now]
    );
    const hits = Number(result.rows[0].hits);
    const expiresAt = Number(result.rows[0].expires_at);
    return { allowed: hits <= limit, remaining: Math.max(0, limit - hits), expiresAt };
  }

  async getProgress(userId) {
    const result = await this.pool.query("SELECT payload, updated_at FROM user_progress WHERE user_id = $1", [userId]);
    if (!result.rows[0]) return null;
    return { payload: result.rows[0].payload, updatedAt: Number(result.rows[0].updated_at) };
  }

  async saveProgress(userId, payload, now = Date.now()) {
    const result = await this.pool.query(
      `INSERT INTO user_progress (user_id, payload, updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (user_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at
       RETURNING updated_at`,
      [userId, JSON.stringify(payload), now]
    );
    return Number(result.rows[0].updated_at);
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}

async function initDatabase(databaseUrl = process.env.DATABASE_URL, options = {}) {
  if (!databaseUrl && !options.pool) throw new Error("DATABASE_URL es obligatoria para guardar usuarios y sesiones");
  const ownsPool = !options.pool;
  const pool = options.pool || new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.DATABASE_POOL_MAX) || 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000
  });
  if (ownsPool && process.env.VERCEL === "1") {
    const { attachDatabasePool } = require("@vercel/functions");
    attachDatabasePool(pool);
  }
  const database = new PostgresDatabase(pool, ownsPool);
  await database.migrate();
  return database;
}

module.exports = { PostgresDatabase, initDatabase };
