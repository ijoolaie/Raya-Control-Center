import test from 'node:test';
import assert from 'node:assert/strict';
import { removeOperatorCredential } from '../examples/reference-worker/environment.mjs';

test('reference worker environment removes inherited Operator credential without altering participant credentials', () => {
  const env = {
    RAYA_CC_OPERATOR_TOKEN: 'operator-secret-must-not-reach-worker-code',
    RAYA_CC_PARTICIPANT_TOKEN: 'participant-token-remains-available',
    RAYA_CC_URL: 'http://127.0.0.1:4317/control/v1'
  };

  assert.equal(removeOperatorCredential(env), true);
  assert.equal(Object.hasOwn(env, 'RAYA_CC_OPERATOR_TOKEN'), false);
  assert.equal(env.RAYA_CC_PARTICIPANT_TOKEN, 'participant-token-remains-available');
  assert.equal(env.RAYA_CC_URL, 'http://127.0.0.1:4317/control/v1');
  assert.equal(removeOperatorCredential(env), false);
});
