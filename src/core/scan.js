'use strict';

const { createExplorer } = require('../explorer/zelcore');
const {
  listLedgerAddressRequests,
  listLedgerAddresses,
} = require('../ledger');

const SATS_PER_RVN = 100000000n;

function formatRvn(sats) {
  if (sats === null || sats === undefined) {
    return 'n/a';
  }

  const negative = sats < 0n;
  const absolute = negative ? -sats : sats;
  const whole = absolute / SATS_PER_RVN;
  const fraction = (absolute % SATS_PER_RVN).toString().padStart(8, '0');
  const trimmedFraction = fraction.replace(/0+$/, '');
  const value = trimmedFraction === '' ? whole.toString() : `${whole}.${trimmedFraction}`;

  return `${negative ? '-' : ''}${value} RVN`;
}

function sumUtxos(utxos, predicate) {
  return utxos
    .filter(predicate)
    .reduce((total, utxo) => total + utxo.valueSats, 0n);
}

async function readAddressBalance(explorer, address) {
  const utxos = await explorer.getUtxos(address);
  let balance = null;
  let balanceError = null;

  try {
    balance = await explorer.getAddressBalance(address);
  } catch (error) {
    balanceError = error;
  }

  const confirmedFromUtxos = sumUtxos(utxos, utxo => utxo.confirmations > 0);
  const unconfirmedFromUtxos = sumUtxos(utxos, utxo => utxo.confirmations <= 0);

  return {
    confirmedSats: balance ? balance.confirmedSats : confirmedFromUtxos,
    unconfirmedSats: balance && balance.unconfirmedSats !== null
      ? balance.unconfirmedSats
      : unconfirmedFromUtxos,
    utxos,
    utxoCount: utxos.length,
    txAppearances: balance ? balance.txAppearances : null,
    unconfirmedTxAppearances: balance ? balance.unconfirmedTxAppearances : null,
    balanceSource: balance ? 'address' : 'utxos',
    balanceError,
  };
}

async function readAddressUsage(explorer, address) {
  const balance = await explorer.getAddressBalance(address);

  return {
    confirmedSats: balance.confirmedSats,
    unconfirmedSats: balance.unconfirmedSats,
    utxos: [],
    utxoCount: 0,
    txAppearances: balance.txAppearances,
    unconfirmedTxAppearances: balance.unconfirmedTxAppearances,
    balanceSource: 'address',
    balanceError: null,
  };
}

function buildScanErrorResult(error) {
  return {
    error,
    expectedContext: null,
    hidDetected: false,
    hidDeviceCount: 0,
    app: null,
    warnings: [],
    scanResults: [],
    receivingConfirmedSats: 0n,
    changeConfirmedSats: 0n,
    grandTotalConfirmedSats: 0n,
    totalUtxoCount: 0,
    allMatch: false,
  };
}

async function resolveExplorer(options) {
  let explorer;
  try {
    explorer = options.explorer || createExplorer();
  } catch (error) {
    return {
      explorer: null,
      error,
    };
  }

  return {
    explorer,
    error: null,
  };
}

async function scanLedgerResultWithExplorer(ledgerResult, explorer) {
  const result = {
    expectedContext: ledgerResult.expectedContext,
    hidDetected: ledgerResult.hidDetected,
    hidDeviceCount: ledgerResult.hidDeviceCount,
    app: ledgerResult.app,
    warnings: ledgerResult.warnings,
    scanResults: [],
    receivingConfirmedSats: 0n,
    changeConfirmedSats: 0n,
    grandTotalConfirmedSats: 0n,
    totalUtxoCount: 0,
    allMatch: false,
    error: ledgerResult.error,
  };

  if (ledgerResult.error) {
    return result;
  }

  for (const addressItem of ledgerResult.addressResults) {
    const scanItem = {
      chain: addressItem.chain,
      index: addressItem.index,
      path: addressItem.path,
      rvnAddress: addressItem.rvnAddress,
      ledgerAddress: addressItem.ledgerAddress,
      matchesLedger: addressItem.matchesLedger,
      confirmedSats: null,
      unconfirmedSats: null,
      utxos: [],
      utxoCount: 0,
      txAppearances: null,
      ok: false,
      error: null,
    };

    if (!addressItem.ok) {
      scanItem.error = addressItem.error;
      result.scanResults.push(scanItem);
      continue;
    }

    if (!addressItem.matchesLedger) {
      scanItem.error = new Error('Local RVN address does not match Ledger-returned address.');
      result.scanResults.push(scanItem);
      continue;
    }

    try {
      const balance = await readAddressBalance(explorer, addressItem.rvnAddress);
      scanItem.confirmedSats = balance.confirmedSats;
      scanItem.unconfirmedSats = balance.unconfirmedSats;
      scanItem.utxos = balance.utxos;
      scanItem.utxoCount = balance.utxoCount;
      scanItem.txAppearances = balance.txAppearances;
      scanItem.unconfirmedTxAppearances = balance.unconfirmedTxAppearances;
      scanItem.balanceSource = balance.balanceSource;
      scanItem.balanceError = balance.balanceError;
      scanItem.ok = true;
    } catch (error) {
      scanItem.error = error;
    }

    result.scanResults.push(scanItem);
  }

  result.receivingConfirmedSats = result.scanResults
    .filter(item => item.ok && item.chain === 'receiving')
    .reduce((total, item) => total + item.confirmedSats, 0n);
  result.changeConfirmedSats = result.scanResults
    .filter(item => item.ok && item.chain === 'change')
    .reduce((total, item) => total + item.confirmedSats, 0n);
  result.grandTotalConfirmedSats = result.receivingConfirmedSats + result.changeConfirmedSats;
  result.totalUtxoCount = result.scanResults
    .filter(item => item.ok)
    .reduce((total, item) => total + item.utxoCount, 0);
  result.allMatch = result.scanResults.length > 0 &&
    result.scanResults.every(item => item.ok && item.matchesLedger);

  return result;
}

async function scanLedgerAddressRequests(options = {}) {
  const resolved = await resolveExplorer(options);
  if (resolved.error) {
    return buildScanErrorResult(resolved.error);
  }

  const ledgerResult = await listLedgerAddressRequests(options);
  return scanLedgerResultWithExplorer(ledgerResult, resolved.explorer);
}

async function scanLedgerAddresses(options = {}) {
  const resolved = await resolveExplorer(options);
  if (resolved.error) {
    return buildScanErrorResult(resolved.error);
  }

  const ledgerResult = await listLedgerAddresses(options);
  return scanLedgerResultWithExplorer(ledgerResult, resolved.explorer);
}

module.exports = {
  formatRvn,
  readAddressBalance,
  readAddressUsage,
  scanLedgerAddressRequests,
  scanLedgerAddresses,
};
