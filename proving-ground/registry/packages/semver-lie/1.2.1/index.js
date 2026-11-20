'use strict';

// Breaking: greet() is gone, renamed to salutation() in a patch release.
function salutation(name) {
  return `Hello, ${name}!`;
}

module.exports = { salutation };
