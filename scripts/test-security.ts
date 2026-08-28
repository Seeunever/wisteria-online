import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSameOrigin, externalRequestOrigin } from '../lib/security.ts';

function proxiedRequest(headers: Record<string, string>) {
  return new Request('http://localhost:3210/api/auth/enter', {
    method: 'POST',
    headers: {
      host: '47.81.210.196',
      'x-forwarded-proto': 'https',
      ...headers,
    },
  });
}

test('external origin follows the proxy host and protocol', () => {
  assert.equal(externalRequestOrigin(proxiedRequest({})), 'https://47.81.210.196');
});

test('same-origin POST accepts an explicit matching Origin', () => {
  assert.equal(
    assertSameOrigin(proxiedRequest({ origin: 'https://47.81.210.196' })),
    'https://47.81.210.196',
  );
});

test('same-origin document form may fall back to browser fetch metadata', () => {
  assert.equal(
    assertSameOrigin(proxiedRequest({
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
    })),
    'https://47.81.210.196',
  );
  assert.equal(
    assertSameOrigin(proxiedRequest({
      origin: 'null',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
    })),
    'https://47.81.210.196',
  );
});

test('cross-origin and headerless POSTs remain rejected', () => {
  assert.throws(
    () => assertSameOrigin(proxiedRequest({
      origin: 'https://example.test',
      'sec-fetch-site': 'same-origin',
    })),
    /INVALID_ORIGIN/,
  );
  assert.throws(
    () => assertSameOrigin(proxiedRequest({ origin: 'http://47.81.210.196' })),
    /INVALID_ORIGIN/,
  );
  assert.throws(
    () => assertSameOrigin(proxiedRequest({ 'sec-fetch-site': 'cross-site' })),
    /INVALID_ORIGIN/,
  );
  assert.throws(
    () => assertSameOrigin(proxiedRequest({
      origin: 'null',
      'sec-fetch-site': 'cross-site',
    })),
    /INVALID_ORIGIN/,
  );
  assert.throws(() => assertSameOrigin(proxiedRequest({})), /INVALID_ORIGIN/);
});

test('ambiguous or invalid proxy protocols remain rejected', () => {
  assert.throws(
    () => externalRequestOrigin(proxiedRequest({ 'x-forwarded-proto': 'https,http' })),
    /INVALID_ORIGIN/,
  );
  assert.throws(
    () => externalRequestOrigin(proxiedRequest({ 'x-forwarded-proto': 'javascript' })),
    /INVALID_ORIGIN/,
  );
  const missingHost = new Request('http://localhost:3210/api/auth/enter', {
    method: 'POST',
    headers: { 'x-forwarded-proto': 'https' },
  });
  assert.throws(() => externalRequestOrigin(missingHost), /INVALID_ORIGIN/);
});
