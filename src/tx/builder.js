'use strict';

const bitcoin = require('bitcoinjs-lib');
const { ravencoinMainnet } = require('../core/network');

const SATS_PER_RVN = 100000000n;
const LEGACY_P2PKH_INPUT_BYTES = 148;
const STANDARD_OUTPUT_BYTES = 34;
const TX_OVERHEAD_BYTES = 10;

class TxPlanError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'TxPlanError';
    this.hint = hint;
  }
}

function parseRvnAmountToSats(value) {
  const text = String(value || '').trim();
  if (!/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(text)) {
    throw new TxPlanError('amount must be a positive RVN value with up to 8 decimal places.');
  }

  const [wholePart, fractionalPart = ''] = text.split('.');
  const sats = BigInt(wholePart) * SATS_PER_RVN +
    BigInt(fractionalPart.padEnd(8, '0'));

  if (sats <= 0n) {
    throw new TxPlanError('amount must be greater than 0.');
  }

  return sats;
}

function parsePositiveInteger(value, name) {
  const text = String(value || '').trim();
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw new TxPlanError(`${name} must be a whole number.`);
  }

  const parsed = BigInt(text);
  if (parsed <= 0n) {
    throw new TxPlanError(`${name} must be greater than 0.`);
  }

  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TxPlanError(`${name} is too large.`);
  }

  return parsed;
}

function parseNonNegativeInteger(value, name) {
  const text = String(value || '').trim();
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw new TxPlanError(`${name} must be a non-negative whole number.`);
  }

  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new TxPlanError(`${name} is too large.`);
  }

  return parsed;
}

function validateRvnAddress(address) {
  if (typeof address !== 'string' || address.trim() === '') {
    throw new TxPlanError('destination address is required.');
  }

  let decoded;
  try {
    decoded = bitcoin.address.fromBase58Check(address.trim());
  } catch {
    throw new TxPlanError('destination address is not a valid Ravencoin mainnet P2PKH/P2SH address.');
  }

  if (decoded.version === ravencoinMainnet.pubKeyHash) {
    return {
      address: address.trim(),
      type: 'p2pkh',
    };
  }

  if (decoded.version === ravencoinMainnet.scriptHash) {
    return {
      address: address.trim(),
      type: 'p2sh',
    };
  }

  throw new TxPlanError('destination address is not a valid Ravencoin mainnet P2PKH/P2SH address.');
}

function estimateLegacyP2pkhTxBytes(inputCount, outputCount) {
  if (!Number.isSafeInteger(inputCount) || inputCount < 1) {
    throw new TxPlanError('transaction plan requires at least one input.');
  }

  if (!Number.isSafeInteger(outputCount) || outputCount < 1) {
    throw new TxPlanError('transaction plan requires at least one output.');
  }

  return TX_OVERHEAD_BYTES +
    inputCount * LEGACY_P2PKH_INPUT_BYTES +
    outputCount * STANDARD_OUTPUT_BYTES;
}

function normalizeUtxo(utxo) {
  if (!utxo || typeof utxo !== 'object') {
    throw new TxPlanError('explorer returned an invalid UTXO.');
  }

  if (typeof utxo.txid !== 'string' || utxo.txid.length === 0) {
    throw new TxPlanError('explorer returned a UTXO without txid.');
  }

  if (!Number.isSafeInteger(utxo.vout) || utxo.vout < 0) {
    throw new TxPlanError('explorer returned a UTXO with invalid vout.');
  }

  if (typeof utxo.valueSats !== 'bigint' || utxo.valueSats <= 0n) {
    throw new TxPlanError('explorer returned a UTXO with invalid value.');
  }

  return {
    txid: utxo.txid,
    vout: utxo.vout,
    valueSats: utxo.valueSats,
    confirmations: Number.isSafeInteger(utxo.confirmations) ? utxo.confirmations : 0,
    height: Number.isSafeInteger(utxo.height) ? utxo.height : null,
    coinbase: Boolean(utxo.coinbase),
    sourceChain: utxo.sourceChain || utxo.chain || null,
    sourceIndex: Number.isSafeInteger(utxo.sourceIndex)
      ? utxo.sourceIndex
      : (Number.isSafeInteger(utxo.index) ? utxo.index : null),
    sourcePath: utxo.sourcePath || utxo.path || null,
    sourceAddress: utxo.sourceAddress || utxo.address || null,
  };
}

function evaluateSelection(selectedUtxos, amountSats, feeRateSatsPerByte, dustSats) {
  const inputTotalSats = selectedUtxos.reduce((total, utxo) => total + utxo.valueSats, 0n);
  const withChangeBytes = estimateLegacyP2pkhTxBytes(selectedUtxos.length, 2);
  const withChangeFeeSats = BigInt(withChangeBytes) * feeRateSatsPerByte;
  const changeSats = inputTotalSats - amountSats - withChangeFeeSats;

  if (changeSats >= dustSats) {
    return {
      selectedUtxos,
      inputTotalSats,
      estimatedBytes: withChangeBytes,
      feeSats: withChangeFeeSats,
      changeSats,
      dustRemainderAddedToFeeSats: 0n,
      hasChangeOutput: true,
    };
  }

  const withoutChangeBytes = estimateLegacyP2pkhTxBytes(selectedUtxos.length, 1);
  const minimumNoChangeFeeSats = BigInt(withoutChangeBytes) * feeRateSatsPerByte;
  const noChangeRemainderSats = inputTotalSats - amountSats - minimumNoChangeFeeSats;

  if (noChangeRemainderSats >= 0n) {
    return {
      selectedUtxos,
      inputTotalSats,
      estimatedBytes: withoutChangeBytes,
      feeSats: inputTotalSats - amountSats,
      changeSats: 0n,
      dustRemainderAddedToFeeSats: noChangeRemainderSats,
      hasChangeOutput: false,
    };
  }

  return null;
}

function selectUtxosForAmount(utxos, amountSats, feeRateSatsPerByte, dustSats) {
  const candidates = utxos
    .map(normalizeUtxo)
    .sort((left, right) => {
      if (right.confirmations !== left.confirmations) {
        return right.confirmations - left.confirmations;
      }

      if (right.valueSats > left.valueSats) return 1;
      if (right.valueSats < left.valueSats) return -1;
      return 0;
    });

  const selected = [];
  let inputTotalSats = 0n;

  for (const utxo of candidates) {
    selected.push(utxo);
    inputTotalSats += utxo.valueSats;

    const withChangeBytes = estimateLegacyP2pkhTxBytes(selected.length, 2);
    const withChangeFeeSats = BigInt(withChangeBytes) * feeRateSatsPerByte;
    const changeSats = inputTotalSats - amountSats - withChangeFeeSats;

    if (changeSats >= dustSats) {
      return {
        selectedUtxos: selected,
        inputTotalSats,
        estimatedBytes: withChangeBytes,
        feeSats: withChangeFeeSats,
        changeSats,
        dustRemainderAddedToFeeSats: 0n,
        hasChangeOutput: true,
      };
    }

    const withoutChangeBytes = estimateLegacyP2pkhTxBytes(selected.length, 1);
    const minimumNoChangeFeeSats = BigInt(withoutChangeBytes) * feeRateSatsPerByte;
    const noChangeRemainderSats = inputTotalSats - amountSats - minimumNoChangeFeeSats;

    if (noChangeRemainderSats >= 0n) {
      return {
        selectedUtxos: selected,
        inputTotalSats,
        estimatedBytes: withoutChangeBytes,
        feeSats: inputTotalSats - amountSats,
        changeSats: 0n,
        dustRemainderAddedToFeeSats: noChangeRemainderSats,
        hasChangeOutput: false,
      };
    }
  }

  const availableSats = candidates.reduce((total, utxo) => total + utxo.valueSats, 0n);
  throw new TxPlanError('insufficient funds for amount plus estimated fee.', `Available from selected source address: ${availableSats.toString()} sats.`);
}

function selectWalletUtxosForAmount(utxos, amountSats, feeRateSatsPerByte, dustSats) {
  const candidates = utxos
    .map(normalizeUtxo)
    .filter(utxo => utxo.confirmations > 0);

  const singleCandidates = [...candidates].sort((left, right) => {
    if (left.valueSats < right.valueSats) return -1;
    if (left.valueSats > right.valueSats) return 1;
    return right.confirmations - left.confirmations;
  });

  for (const utxo of singleCandidates) {
    const selection = evaluateSelection([utxo], amountSats, feeRateSatsPerByte, dustSats);
    if (selection) {
      return selection;
    }
  }

  const selected = [];
  const largestFirst = [...candidates].sort((left, right) => {
    if (right.valueSats > left.valueSats) return 1;
    if (right.valueSats < left.valueSats) return -1;
    return right.confirmations - left.confirmations;
  });

  for (const utxo of largestFirst) {
    selected.push(utxo);
    const selection = evaluateSelection([...selected], amountSats, feeRateSatsPerByte, dustSats);
    if (selection) {
      return selection;
    }
  }

  const availableSats = candidates.reduce((total, utxo) => total + utxo.valueSats, 0n);
  throw new TxPlanError('insufficient funds for amount plus estimated fee.', `Available confirmed balance: ${availableSats.toString()} sats.`);
}

function buildDryRunSendPlan(options) {
  const destination = validateRvnAddress(options.destinationAddress);
  const amountSats = options.amountSats;
  const feeRateSatsPerByte = options.feeRateSatsPerByte;
  const dustSats = options.dustSats;

  if (typeof amountSats !== 'bigint' || amountSats <= 0n) {
    throw new TxPlanError('amount must be greater than 0.');
  }

  if (typeof feeRateSatsPerByte !== 'bigint' || feeRateSatsPerByte <= 0n) {
    throw new TxPlanError('fee rate must be greater than 0.');
  }

  if (typeof dustSats !== 'bigint' || dustSats < 0n) {
    throw new TxPlanError('dust threshold must be a non-negative integer.');
  }

  if (!options.sourceAddress || !options.changeAddress) {
    throw new TxPlanError('source and change addresses are required.');
  }

  const selection = selectUtxosForAmount(
    options.utxos || [],
    amountSats,
    feeRateSatsPerByte,
    dustSats,
  );

  const outputs = [
    {
      type: 'destination',
      address: destination.address,
      valueSats: amountSats,
    },
  ];

  if (selection.hasChangeOutput) {
    outputs.push({
      type: 'change',
      address: options.changeAddress,
      valueSats: selection.changeSats,
    });
  }

  return {
    dryRun: true,
    sourceChain: options.sourceChain,
    sourceIndex: options.sourceIndex,
    sourcePath: options.sourcePath,
    sourceAddress: options.sourceAddress,
    destinationAddress: destination.address,
    destinationType: destination.type,
    amountSats,
    selectedUtxos: selection.selectedUtxos,
    inputTotalSats: selection.inputTotalSats,
    feeRateSatsPerByte,
    estimatedBytes: selection.estimatedBytes,
    feeSats: selection.feeSats,
    changeChain: options.changeChain,
    changeIndex: options.changeIndex,
    changePath: options.changePath,
    changeAddress: options.changeAddress,
    changeSats: selection.changeSats,
    dustRemainderAddedToFeeSats: selection.dustRemainderAddedToFeeSats,
    outputs,
  };
}

function uniqueSourceAddresses(selectedUtxos) {
  const sources = new Map();

  for (const utxo of selectedUtxos) {
    const key = `${utxo.sourceChain || 'unknown'}:${utxo.sourceIndex ?? 'unknown'}:${utxo.sourceAddress || 'unknown'}`;
    if (!sources.has(key)) {
      sources.set(key, {
        chain: utxo.sourceChain,
        index: utxo.sourceIndex,
        path: utxo.sourcePath,
        address: utxo.sourceAddress,
      });
    }
  }

  return [...sources.values()];
}

function buildWalletSendPlan(options) {
  const destination = validateRvnAddress(options.destinationAddress);
  const amountSats = options.amountSats;
  const feeRateSatsPerByte = options.feeRateSatsPerByte;
  const dustSats = options.dustSats;

  if (typeof amountSats !== 'bigint' || amountSats <= 0n) {
    throw new TxPlanError('amount must be greater than 0.');
  }

  if (typeof feeRateSatsPerByte !== 'bigint' || feeRateSatsPerByte <= 0n) {
    throw new TxPlanError('fee rate must be greater than 0.');
  }

  if (typeof dustSats !== 'bigint' || dustSats < 0n) {
    throw new TxPlanError('dust threshold must be a non-negative integer.');
  }

  if (!options.changeAddress || !options.changePath) {
    throw new TxPlanError('change address and path are required.');
  }

  if (destination.address === options.changeAddress) {
    throw new TxPlanError('destination address matches the selected change address. Choose a different destination before signing.');
  }

  const selection = selectWalletUtxosForAmount(
    options.utxos || [],
    amountSats,
    feeRateSatsPerByte,
    dustSats,
  );

  const outputs = [
    {
      type: 'destination',
      address: destination.address,
      valueSats: amountSats,
    },
  ];

  if (selection.hasChangeOutput) {
    outputs.push({
      type: 'change',
      address: options.changeAddress,
      valueSats: selection.changeSats,
    });
  }

  const sourceAddresses = uniqueSourceAddresses(selection.selectedUtxos);

  return {
    dryRun: true,
    walletPlan: true,
    sourceChain: sourceAddresses.length === 1 ? sourceAddresses[0].chain : 'multiple',
    sourceIndex: sourceAddresses.length === 1 ? sourceAddresses[0].index : null,
    sourcePath: sourceAddresses.length === 1 ? sourceAddresses[0].path : null,
    sourceAddress: sourceAddresses.length === 1 ? sourceAddresses[0].address : null,
    sourceAddresses,
    destinationAddress: destination.address,
    destinationType: destination.type,
    amountSats,
    selectedUtxos: selection.selectedUtxos,
    inputTotalSats: selection.inputTotalSats,
    feeRateSatsPerByte,
    estimatedBytes: selection.estimatedBytes,
    feeSats: selection.feeSats,
    changeChain: options.changeChain,
    changeIndex: options.changeIndex,
    changePath: options.changePath,
    changeAddress: options.changeAddress,
    changeSats: selection.changeSats,
    dustRemainderAddedToFeeSats: selection.dustRemainderAddedToFeeSats,
    outputs,
  };
}

module.exports = {
  TxPlanError,
  buildDryRunSendPlan,
  buildWalletSendPlan,
  estimateLegacyP2pkhTxBytes,
  parseNonNegativeInteger,
  parsePositiveInteger,
  parseRvnAmountToSats,
  validateRvnAddress,
};
