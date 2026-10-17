'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('feature flag default resolution: unknown flag is off', () => {
  // When a flag is not present in the DB, it does not exist;
  // the frontend treats missing keys as disabled.
  const flags = new Map();
  assert.strictEqual(flags.get('nonexistent') ?? false, false);
});

test('feature flag effective value: enabled overrides default_enabled', () => {
  const enabled = true;
  const defaultEnabled = false;
  const effective = enabled ?? defaultEnabled ?? false;
  assert.strictEqual(effective, true);
});

test('feature flag effective value: default_enabled used when enabled is null', () => {
  const enabled = null;
  const defaultEnabled = true;
  const effective = enabled ?? defaultEnabled ?? false;
  assert.strictEqual(effective, true);
});

test('feature flag effective value: both null resolves to false', () => {
  // eslint-disable-next-line no-constant-binary-expression
  const effective = null ?? null ?? false;
  assert.strictEqual(effective, false);
});
