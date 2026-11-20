'use strict';

const fresh = require('@pg/fresh');

module.exports = {
  doubled: (n) => fresh.double(n)
};
