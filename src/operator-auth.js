import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const timestamp = () => new Date().toISOString();
const isValidOperatorToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,1024}(?![\s\S])/.test(value);

export function bootstrapOperatorToken(db, suppliedToken = process.env.RAYA_CC_OPERATOR_TOKEN) {
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'operator_token_hash'").get();

  if (existing) {
    if (!isValidOperatorToken(suppliedToken)) {
      throw new Error('RAYA_CC_OPERATOR_TOKEN must be the existing operator token using only letters, digits, underscore, or hyphen (at least 32 characters).');
    }
    const candidate = Buffer.from(hash(suppliedToken), 'hex');
    const expected = Buffer.from(existing.value, 'hex');
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      throw new Error('RAYA_CC_OPERATOR_TOKEN does not match the initialized operator credential.');
    }
    return { token: suppliedToken, created: false };
  }

  if (suppliedToken !== undefined && !isValidOperatorToken(suppliedToken)) {
    throw new Error('RAYA_CC_OPERATOR_TOKEN must contain at least 32 characters and use only letters, digits, underscore, or hyphen.');
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
