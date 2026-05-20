'use strict';

const bitcoin = require('bitcoinjs-lib');
const secp256k1 = require('tiny-secp256k1');
const { ravencoinMainnet } = require('./network');

function normalizePublicKey(publicKeyHex) {
  if (typeof publicKeyHex !== 'string' || publicKeyHex.trim() === '') {
    throw new Error('Expected a hex-encoded public key from Ledger');
  }

  const normalized = publicKeyHex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error('Ledger returned a public key that is not valid hex');
  }

  const publicKey = Buffer.from(normalized, 'hex');
  if (!secp256k1.isPoint(publicKey)) {
    throw new Error('Ledger returned an invalid secp256k1 public key');
  }

  return publicKey;
}

function compressPublicKey(publicKey) {
  if (!Buffer.isBuffer(publicKey)) {
    throw new Error('Expected a public key buffer');
  }

  if (!secp256k1.isPoint(publicKey)) {
    throw new Error('Ledger returned an invalid secp256k1 public key');
  }

  if (publicKey.length === 33 && (publicKey[0] === 0x02 || publicKey[0] === 0x03)) {
    return publicKey;
  }

  if (publicKey.length === 65 && publicKey[0] === 0x04) {
    const x = publicKey.subarray(1, 33);
    const y = publicKey.subarray(33, 65);
    const prefix = (y[31] & 1) === 0 ? 0x02 : 0x03;

    return Buffer.concat([Buffer.from([prefix]), x]);
  }

  throw new Error('Ledger returned a public key with an unsupported encoding');
}

function deriveRvnP2pkhAddress(publicKeyHex) {
  const publicKey = compressPublicKey(normalizePublicKey(publicKeyHex));
  const payment = bitcoin.payments.p2pkh({
    pubkey: publicKey,
    network: ravencoinMainnet,
  });

  if (!payment.address) {
    throw new Error('Could not derive a Ravencoin P2PKH address');
  }

  return payment.address;
}

module.exports = {
  compressPublicKey,
  deriveRvnP2pkhAddress,
  normalizePublicKey,
};
