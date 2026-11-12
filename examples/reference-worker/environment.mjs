export function removeOperatorCredential(env = process.env) {
  const hadCredential = Object.hasOwn(env, 'RAYA_CC_OPERATOR_TOKEN');
  delete env.RAYA_CC_OPERATOR_TOKEN;
  return hadCredential;
}
