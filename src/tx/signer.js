'use strict';

const bitcoin = require('bitcoinjs-lib');
const TransportNodeHid = require('@ledgerhq/hw-transport-node-hid').default;
const Btc = require('@ledgerhq/hw-app-btc').default;
const { createExplorer } = require('../explorer/zelcore');
const { describeLedgerError } = require('../ledger');
const { ravencoinMainnet } = require('../core/network');

const SIGHASH_ALL = 1;

class SigningError extends Error {
  constructor(message, hint, options = {}) {
    super(message);
    this.name = 'SigningError';
    this.hint = hint;
    this.statusCode = options.statusCode || null;
    this.endpoint = options.endpoint || null;
    this.responseBody = options.responseBody || null;
  }
}

function writeVarInt(number) {
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new SigningError('Cannot encode invalid varint.');
  }

  if (number < 0xfd) {
    return Buffer.from([number]);
  }

  if (number <= 0xffff) {
    const buffer = Buffer.alloc(3);
    buffer[0] = 0xfd;
    buffer.writeUInt16LE(number, 1);
    return buffer;
  }

  if (number <= 0xffffffff) {
    const buffer = Buffer.alloc(5);
    buffer[0] = 0xfe;
    buffer.writeUInt32LE(number, 1);
    return buffer;
  }

  throw new SigningError('Varint is too large.');
}

function writeUInt64LE(value) {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new SigningError('Cannot encode invalid satoshi value.');
  }

  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value, 0);
  return buffer;
}

function serializeOutputs(outputs) {
  const chunks = [writeVarInt(outputs.length)];

  for (const output of outputs) {
    const script = Buffer.from(bitcoin.address.toOutputScript(output.address, ravencoinMainnet));
    chunks.push(writeUInt64LE(output.valueSats));
    chunks.push(writeVarInt(script.length));
    chunks.push(script);
  }

  return Buffer.concat(chunks).toString('hex');
}

function validatePreviousTransaction(rawTxHex, utxo) {
  let tx;
  try {
    tx = bitcoin.Transaction.fromHex(rawTxHex);
  } catch (error) {
    throw new SigningError(`Could not parse previous transaction ${utxo.txid}: ${error.message}`);
  }

  if (tx.getId() !== utxo.txid) {
    throw new SigningError(`Explorer raw transaction txid mismatch for ${utxo.txid}.`);
  }

  const prevout = tx.outs[utxo.vout];
  if (!prevout) {
    throw new SigningError(`Previous transaction ${utxo.txid} does not contain vout ${utxo.vout}.`);
  }

  if (prevout.value !== utxo.valueSats) {
    throw new SigningError(`Previous transaction ${utxo.txid}:${utxo.vout} value does not match explorer UTXO value.`);
  }
}

function signingPathForUtxo(utxo, plan) {
  const path = utxo.sourcePath || utxo.path || plan.sourcePath;
  if (!path) {
    throw new SigningError(`Selected UTXO ${utxo.txid}:${utxo.vout} is missing a Ledger derivation path.`);
  }

  return path;
}

async function closeTransport(transport) {
  if (!transport) {
    return;
  }

  try {
    await transport.close();
  } catch {
    // Signing already succeeded or failed; close errors should not hide that result.
  }
}

async function openLedgerTransport() {
  const devicePaths = await TransportNodeHid.list();
  if (devicePaths.length === 0) {
    throw new SigningError(
      'No Ledger HID device detected.',
      'Connect the Ledger over USB, unlock it, close Ledger Live, and open the Ravencoin app.',
    );
  }

  return TransportNodeHid.open(devicePaths[0]);
}

async function signDryRunPlan(plan, options = {}) {
  const explorer = options.explorer || createExplorer();
  const rawTransactions = [];

  for (const utxo of plan.selectedUtxos) {
    let rawTxHex;
    try {
      rawTxHex = await explorer.getRawTransaction(utxo.txid);
    } catch (error) {
      const hint = error.hint
        ? `${error.message} ${error.hint}`
        : error.message;
      throw new SigningError(
        `Could not fetch raw previous transaction for ${utxo.txid}.`,
        hint,
        {
          statusCode: error.statusCode,
          endpoint: error.endpoint,
          responseBody: error.responseBody,
        },
      );
    }

    validatePreviousTransaction(rawTxHex, utxo);
    rawTransactions.push(rawTxHex);
  }

  const outputScriptHex = serializeOutputs(plan.outputs);
  let transport;

  try {
    transport = await openLedgerTransport();
    const btc = new Btc({
      transport,
      currency: 'ravencoin',
    });

    const inputs = rawTransactions.map((rawTxHex, index) => {
      const splitTx = btc.splitTransaction(rawTxHex, false, false);
      return [splitTx, plan.selectedUtxos[index].vout, null, undefined];
    });
    const associatedKeysets = plan.selectedUtxos.map(utxo => signingPathForUtxo(utxo, plan));
    const signedRawTx = await btc.createPaymentTransaction({
      inputs,
      associatedKeysets,
      changePath: plan.changeSats > 0n ? plan.changePath : undefined,
      outputScriptHex,
      lockTime: 0,
      sigHashType: SIGHASH_ALL,
      segwit: false,
      additionals: [],
      useTrustedInputForSegwit: false,
    });
    const txid = bitcoin.Transaction.fromHex(signedRawTx).getId();

    return {
      signedRawTx,
      txid,
    };
  } catch (error) {
    const ledgerError = describeLedgerError(error);
    if (error instanceof SigningError) {
      throw error;
    }

    const message = ledgerError.statusCode
      ? `${ledgerError.message} (${ledgerError.statusCode})`
      : ledgerError.message;
    throw new SigningError(message, ledgerError.hint);
  } finally {
    await closeTransport(transport);
  }
}

module.exports = {
  SigningError,
  serializeOutputs,
  signDryRunPlan,
};
