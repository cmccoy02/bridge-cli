'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const service = require('../src/index.js');

// Deliberately weak: asserts the service loads, but never calls the renamed export.
test('service is healthy', () => {
  assert.equal(service.healthy, true);
  assert.equal(service.hasLib, true);
});
