import assert from 'node:assert/strict';
import test from 'node:test';

import { hello } from '../src/index';

test('hello greets by name', () => {
  assert.equal(hello('world'), 'Hello, world!');
});
