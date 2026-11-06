import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const timestamp = () => new Date().toISOString();

export function bootstrapOperatorToken(db, suppliedToken = process.env.RAYA_CC_OPERATOR_TOKEN) {
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'operator_token_hash'").get();

  if (existing) {
    if (typeof suppliedToken !== 'string' || suppliedToken.length < 32) {
      throw new Error('RAYA_CC_OPERATOR_TOKEN must be set to the existing operator token before starting this initialized Control Center.');
    }
    const candidate = Buffer.from(hash(suppliedToken), 'hex');
    const expected = Buffer.from(existing.value, 'hex');
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      throw new Error('RAYA_CC_OPERATOR_TOKEN does not match the initialized operator credential.');
    }
    return { token: suppliedToken, created: false };
  }

  if (suppliedToken !== undefined && (typeof suppliedToken !== 'string' || suppliedToken.length < 32)) {
    throw new Error('RAYA_CC_OPERATOR_TOKEN must contain at least 32 characters when provided.');
  }
  const token = typeof suppliedToken === 'string'
    ? suppliedToken
    : randomBytes(32).toString('base64url');
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('operator_token_hash', ?, ?)")
    .run(hash(token), timestamp());
  return { token, created: true };
}

export function rotateOperatorToken(db) {
  const token = randomBytes(32).toString('base64url');
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('operator_token_hash', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(hash(token), timestamp());
  return token;
}
