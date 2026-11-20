'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const core = require('../index.js');

test('core doubles via @pg/fresh', () => {
  assert.equal(core.doubled(21), 42);
});
