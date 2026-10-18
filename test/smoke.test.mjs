import test from 'node:test';
import assert from 'node:assert/strict';

// Sanity check that `node --test test/` discovers and runs this file.
test('test harness runs', () => {
  assert.equal(1 + 1, 2);
});
