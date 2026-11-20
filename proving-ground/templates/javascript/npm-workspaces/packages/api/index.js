'use strict';

const core = require('@pgw/core');

module.exports = {
  doubleAll: (values) => values.map((value) => core.doubled(value))
};
