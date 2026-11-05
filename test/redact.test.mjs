import assert from 'node:assert/strict';
import test from 'node:test';
import { redactFields, redactText } from '../src/redact.mjs';

// Synthetic values only. Each has the shape of a real credential but no value.
const FAKE = {
  openai: `sk-${'0'.repeat(40)}`,
  stripe: `sk_test_${'0'.repeat(32)}`,
  github: `ghp_${'0'.repeat(36)}`,
  aws: `AKIA${'0'.repeat(16)}`,
  google: `AIza${'0'.repeat(35)}`,
  webhook: `whsec_${'0'.repeat(24)}`,
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0In0', 'c2lnbmF0dXJlMDAwMDAw'].join('.'),
  pem: '-----BEGIN PRIVATE KEY-----\nMIIFakeKeyMaterial\n-----END PRIVATE KEY-----',
  bearer: 'Bearer abcdefghijklmnop',
};

test('provider keys and tokens are redacted', () => {
  for (const [kind, secret] of [
    ['key', FAKE.openai],
    ['key', FAKE.stripe],
    ['key', FAKE.github],
    ['key', FAKE.aws],
    ['key', FAKE.google],
    ['key', FAKE.webhook],
    ['jwt', FAKE.jwt],
    ['token', FAKE.bearer],
  ]) {
    const result = redactText(`use ${secret} now`);
    assert.equal(result.text.includes(secret), false, `${kind} secret should be gone`);
    assert.ok(result.hits.some((hit) => hit.kind === kind), `${kind} should be counted`);
  }
});

test('a private-key block is replaced as one value', () => {
  const result = redactText(`before\n${FAKE.pem}\nafter`);
  assert.equal(result.text.includes('BEGIN PRIVATE KEY'), false);
  assert.equal(result.text.includes('MIIFakeKeyMaterial'), false);
  assert.match(result.text, /before\n\[redacted:key\]\nafter/);
  assert.deepEqual(result.hits, [{ kind: 'key', count: 1 }]);
});

test('an assignment keeps the key name and drops the value', () => {
  const result = redactText(`OPENAI_API_KEY=${FAKE.openai}`);
  assert.equal(result.text, 'OPENAI_API_KEY=[redacted:secret]');
  assert.equal(result.text.includes(FAKE.openai), false);
  assert.ok(result.hits.some((hit) => hit.kind === 'key'));
  assert.ok(result.hits.some((hit) => hit.kind === 'secret'));

  const lower = redactText('my_password="hunter2 with spaces"');
  assert.equal(lower.text, 'my_password=[redacted:secret]');
});

test('a secret in a URL query is redacted without losing the other params', () => {
  const result = redactText('https://api.test/v1/call?token=abc123&limit=5');
  assert.equal(result.text, 'https://api.test/v1/call?token=[redacted:secret]&limit=5');
  assert.equal(result.text.includes('abc123'), false);
});

test('an authorization header does not leave a bearer value behind', () => {
  const result = redactText(`curl -H "Authorization: Bearer ${'a'.repeat(24)}" https://api.test`);
  assert.equal(result.text.includes('a'.repeat(24)), false);
  assert.match(result.text, /Authorization=\[redacted:secret\] \[redacted:token\]/);
});

test('benign identifiers and words that contain secret-like names stay', () => {
  for (const value of [
    'git checkout 0123456789abcdef0123456789abcdef01234567',
    '550e8400-e29b-41d4-a716-446655440000',
    'the token is rotated',
    'path/to/token/file',
    'password policy updated',
    'https://api.test/v1/call?page=2&limit=10',
    `deadbeef${'0'.repeat(56)}`,
  ]) {
    const result = redactText(value);
    assert.equal(result.text, value);
    assert.deepEqual(result.hits, []);
  }
});

test('redaction is idempotent', () => {
  const inputs = [
    FAKE.openai,
    FAKE.stripe,
    FAKE.github,
    FAKE.aws,
    FAKE.google,
    FAKE.webhook,
    FAKE.jwt,
    FAKE.pem,
    `OPENAI_API_KEY=${FAKE.openai}`,
    `https://api.test/v1?token=${'x'.repeat(12)}&limit=5`,
    `Authorization: ${FAKE.bearer}`,
  ];
  for (const input of inputs) {
    const first = redactText(input);
    const second = redactText(first.text);
    assert.equal(second.text, first.text, `second pass changed ${input}`);
  }
});

test('a corpus of mixed secrets leaves no raw value in the detail text', () => {
  const corpus = Object.values(FAKE).join('\n');
  const result = redactText(corpus);
  for (const secret of Object.values(FAKE)) {
    assert.equal(result.text.includes(secret), false, `raw value survived: ${secret.slice(0, 8)}`);
  }
  const total = result.hits.reduce((sum, hit) => sum + hit.count, 0);
  assert.ok(total >= 8, `expected at least 8 redactions, got ${total}`);
});

test('a long line with a secret at the end is still redacted', () => {
  const result = redactText(`${'x'.repeat(10_000)} ${FAKE.openai}`);
  assert.equal(result.text.includes(FAKE.openai), false);
  assert.equal(result.text.length > 10_000, true);
});

test('an empty string and text without secrets are unchanged', () => {
  assert.deepEqual(redactText(''), { text: '', hits: [] });
});

test('redactFields walks only scalar fields and records the field name', () => {
  const result = redactFields({
    command: `curl -H "Authorization: ${FAKE.bearer}" https://api.test`,
    cwd: '/tmp',
    offset: 10,
    dry: true,
    note: null,
  });
  assert.equal(result.fields.cwd, '/tmp');
  assert.equal(result.fields.offset, 10);
  assert.equal(result.fields.dry, true);
  assert.equal(result.fields.note, null);
  assert.equal(result.fields.command.includes('abcdefghijklmnop'), false);
  assert.ok(result.redactions.some((redaction) => redaction.field === 'command'));
  assert.ok(result.redactions.every((redaction) => redaction.field === 'command'));
});

test('invalid input is refused instead of silently captured', () => {
  assert.throws(() => redactText(42), /requires a string/);
  assert.throws(() => redactFields(null), /fields must be an object/);
  assert.throws(() => redactFields({ nested: { a: 1 } }), /must be a string, number, boolean or null/);
});

test('connection-string and URL userinfo passwords are redacted', () => {
  const secrets = ['Zq7PgPass1', 'Zq7MySql2', 'Zq7Mongo3', 'Zq7Redis4', 'Zq7Amqp5'];
  const urls = [
    `postgres://app:${secrets[0]}@db.internal:5432/app`,
    `mysql://root:${secrets[1]}@127.0.0.1:3306/app`,
    `mongodb+srv://admin:${secrets[2]}@cluster0.example.net/prod`,
    `redis://:${secrets[3]}@cache.internal:6379/0`,
    `amqp://guest:${secrets[4]}@broker.internal:5672/%2f`,
  ];
  for (let index = 0; index < urls.length; index += 1) {
    const result = redactText(`run ${urls[index]} now`);
    assert.equal(result.text.includes(secrets[index]), false, urls[index]);
    assert.match(result.text, /:\/\/[^/\s]*\[redacted:secret\]@/);
    assert.ok(result.hits.some((hit) => hit.kind === 'secret'));
  }
  const curlUser = ['deploy', 'Zq7' + 'CurlPass'].join(':');
  const curl = redactText(`curl -u ${curlUser} https://api.test`);
  assert.equal(curl.text.includes('Zq7' + 'CurlPass'), false);
});

test('basic, digest and cookie headers drop the credential', () => {
  const basicToken = Buffer.from(['user', 'Zq7' + 'BasicPass'].join(':')).toString('base64');
  const basic = redactText(`curl -H "Authorization: Basic ${basicToken}" https://api.test`);
  assert.equal(basic.text.includes(basicToken), false);
  const digest = redactText('Authorization: Digest username=app, response=deadbeefcafe');
  assert.equal(digest.text.includes('deadbeefcafe'), false);
  const cookie = redactText('curl -H "Cookie: session=Zq7SessionValue" https://api.test');
  assert.equal(cookie.text.includes('Zq7SessionValue'), false);
  const setCookie = redactText('Set-Cookie: sid=Zq7SetCookie; Path=/');
  assert.equal(setCookie.text.includes('Zq7SetCookie'), false);
});

test('space-separated flags are redacted', () => {
  for (const command of ['tool --password Zq7FlagPass', 'deploy --token Zq7FlagToken', 'svc --api-key Zq7FlagApiKey', 'tool --secret Zq7FlagSecret']) {
    const result = redactText(command);
    assert.equal(result.text.includes('Zq7'), false, command);
  }
});

test('quoted JSON keys are redacted', () => {
  for (const body of ['{"api_key":"Zq7JsonApiKey"}', '{"password": "Zq7JsonPass"}', '{"token": "Zq7JsonToken"}']) {
    const result = redactText(body);
    assert.equal(result.text.includes('Zq7'), false, body);
    assert.ok(result.hits.some((hit) => hit.kind === 'secret'));
  }
});

test('provider credential shapes are redacted', () => {
  const values = [
    `github_pat_11${'A'.repeat(22)}`,
    `glpat-${'B'.repeat(24)}`,
    `hf_${'C'.repeat(24)}`,
    `pypi-${'D'.repeat(24)}`,
    `npm_${'E'.repeat(24)}`,
    `xoxb-${'F'.repeat(20)}`,
    `AC${'a'.repeat(32)}`,
    `SK${'b'.repeat(32)}`,
    `SG.${'c'.repeat(16)}.${'d'.repeat(16)}`,
    `https://hooks.slack.com/services/T00000000/B00000000/${'X'.repeat(24)}`,
  ];
  for (const value of values) {
    const result = redactText(`use ${value} now`);
    assert.equal(result.text.includes(value), false, value);
  }
});

test('_KEY env names and DSNs are redacted', () => {
  for (const line of [
    'AWS_SECRET_ACCESS_KEY=Zq7AwsSecret',
    'SECRET_KEY=Zq7SecretKey',
    'ENCRYPTION_KEY=' + 'Zq7' + 'EncryptionKey',
    'ACCESS_KEY=Zq7AccessKey',
    'secret_access_key: Zq7YamlAccessKey',
    'SENTRY_DSN=https://Zq7DsnKey@sentry.io/42',
    'aws configure set aws_secret_access_key Zq7AwsConfigureKey',
  ]) {
    const result = redactText(line);
    assert.equal(result.text.includes('Zq7'), false, line);
  }
});

test('a private-key block without an end marker is still redacted', () => {
  const result = redactText(`before\n-----BEGIN PRIVATE KEY-----\n${'MIIFake'.repeat(2000)}\nafter`);
  assert.equal(result.text.includes('MIIFake'), false);
  assert.match(result.text, /\[redacted:key\]/);
});

test('a long field is scanned within a bounded prefix', () => {
  const result = redactFields({ command: `sk-${'a'.repeat(40)} ${'x'.repeat(1_000_000)}` });
  assert.equal(result.fields.command.includes('a'.repeat(40)), false);
  assert.ok(result.fields.command.length <= 8192);
});

test('informative values are not wholesale redacted', () => {
  for (const text of [
    'authorization: none',
    'signature: sha256:abcdef',
    'token_count: 5',
    'passwordless: true',
    'git checkout 0123456789abcdef0123456789abcdef01234567',
  ]) {
    const result = redactText(text);
    assert.equal(result.text, text, text);
  }
});
