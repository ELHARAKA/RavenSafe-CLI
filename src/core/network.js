'use strict';

const ravencoinMainnet = Object.freeze({
  messagePrefix: '\x16Raven Signed Message:\n',
  bech32: 'rc',
  pubKeyHash: 60,
  scriptHash: 122,
  wif: 128,
});

module.exports = {
  ravencoinMainnet,
};
