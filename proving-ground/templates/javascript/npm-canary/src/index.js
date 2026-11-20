'use strict';

const canary = require('@pg/canary');
const semverLie = require('@pg/semver-lie');

// Uses @pg/semver-lie but never calls greet(), so the breaking rename in 1.2.1 is
// not exercised by any test. That is the point of semver-lie-uncaught: a known miss.
module.exports = {
  healthy: canary.ok === true,
  hasLib: typeof semverLie === 'object'
};
