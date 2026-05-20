'use strict';

const readline = require('readline/promises');
const config = require('../config');
const ui = require('./ui');
const {
  broadcastRawTx,
  createExplorer,
} = require('../explorer/zelcore');
const {
  addressPathForIndex,
  listLedgerAddressRequests,
  verifyLedgerAddressOnDevice,
} = require('../ledger');
const {
  formatRvn,
  readAddressBalance,
  readAddressUsage,
  scanLedgerAddressRequests,
} = require('../core/scan');
const { createSessionCache } = require('../core/session-cache');
const { signDryRunPlan } = require('../tx/signer');
const {
  buildWalletSendPlan,
  parsePositiveInteger,
  parseRvnAmountToSats,
  validateRvnAddress,
} = require('../tx/builder');

class UserCancelledError extends Error {
  constructor() {
    super('Cancelled by user. Nothing was signed or broadcast.');
    this.name = 'UserCancelledError';
  }
}

const MAX_CUSTOM_RANGE_SIZE = 200;
const SCAN_PRESETS = Object.freeze({
  quick: {
    label: 'Quick scan',
    description: 'first 20 addresses',
    receiving: { start: 0, end: 15 },
    change: { start: 0, end: 5 },
  },
  standard: {
    label: 'Standard scan',
    description: 'first 50 addresses',
    receiving: { start: 0, end: 40 },
    change: { start: 0, end: 10 },
  },
  deep: {
    label: 'Deep scan',
    description: 'first 100 addresses',
    receiving: { start: 0, end: 70 },
    change: { start: 0, end: 30 },
  },
});

const RAVENCOIN_CONTEXT = Object.freeze({
  label: 'Ravencoin app',
  purpose: 'preferred/documented target',
});
const EXPLORER_TX_BASE_URL = 'https://explorer.rvn.zelcore.io/tx';

function errorLines(error) {
  const lines = [`Error: ${error.message || String(error)}`];
  if (error.statusCode) {
    lines.push(`Status: ${error.statusCode}`);
  }
  if (error.endpoint) {
    lines.push(`Endpoint: ${error.endpoint}`);
  }
  if (error.responseBody) {
    lines.push(`Response body: ${error.responseBody}`);
  }
  if (error.hint) {
    lines.push(`Hint: ${error.hint}`);
  }

  return lines;
}

function printError(error, write = console.log) {
  const lines = errorLines(error);
  if (write === console.log) {
    ui.errorBox('Error', lines);
    return;
  }

  for (const line of lines) {
    write(line);
  }
}

function buildIndexRangeRequests(chain, startIndex, endIndex) {
  return Array.from({ length: endIndex - startIndex + 1 }, (_, offset) => {
    const index = startIndex + offset;
    return {
      role: `${chain}:${index}`,
      chain,
      index,
      path: addressPathForIndex(index, chain),
    };
  });
}

function scanPlanRequests(scanPlan) {
  return [
    ...buildIndexRangeRequests('receiving', scanPlan.receiving.start, scanPlan.receiving.end),
    ...buildIndexRangeRequests('change', scanPlan.change.start, scanPlan.change.end),
  ];
}

function quickScanRequests() {
  return scanPlanRequests(SCAN_PRESETS.quick);
}

function singleAddressRequest(chain, index) {
  return {
    role: `${chain}:${index}`,
    chain,
    index,
    path: addressPathForIndex(index, chain),
  };
}

function balanceScanRequests(scanPlan = SCAN_PRESETS.quick) {
  return scanPlanRequests(scanPlan);
}

function assertRavencoinApp(scanResult) {
  if (scanResult.error) {
    throw scanResult.error;
  }

  const detected = scanResult.app && scanResult.app.context;
  if (!detected) {
    throw new Error('Could not confirm that the Ledger Ravencoin app is open. Open the Ravencoin app and try again.');
  }

  if (detected && detected.key !== 'ravencoin') {
    throw new Error(`Open the Ledger Ravencoin app before continuing. Detected: ${detected.label}.`);
  }
}

function fundedRows(scanResults) {
  return scanResults.filter(item => {
    return item.ok && (item.confirmedSats > 0n || item.unconfirmedSats > 0n || item.utxoCount > 0);
  });
}

function printFundedAddresses(scanResult) {
  const funded = fundedRows(scanResult.scanResults);

  if (funded.length === 0) {
    ui.infoBox('Funded Addresses', [
      'No funded addresses were found in this scan range.',
      'Try a larger scan size if you expect funds on later indexes.',
    ]);
  } else {
    const lines = [];
    funded.forEach((item, index) => {
      if (index > 0) {
        lines.push('');
      }

      lines.push(`${ui.style.bold(`${item.chain} #${item.index}`)}  ${formatRvn(item.confirmedSats)} confirmed  ${formatRvn(item.unconfirmedSats)} unconfirmed`);
      lines.push(`${item.utxoCount} UTXO${item.utxoCount === 1 ? '' : 's'}  ${ui.style.dim(item.rvnAddress)}`);
    });

    ui.printBox(lines, {
      title: 'Funded Addresses',
      color: 'green',
      width: 84,
    });
  }

  console.log('');
  ui.keyValueBox('Balance Summary', [
    { label: 'Receiving confirmed', value: formatRvn(scanResult.receivingConfirmedSats) },
    { label: 'Change confirmed', value: formatRvn(scanResult.changeConfirmedSats) },
    { label: 'Grand total', value: formatRvn(scanResult.grandTotalConfirmedSats) },
    { label: 'Total UTXOs', value: String(scanResult.totalUtxoCount) },
  ], {
    color: 'cyan',
  });
}

function summarizeScanResults(scanResults) {
  const okResults = scanResults.filter(item => item.ok);
  const receivingConfirmedSats = okResults
    .filter(item => item.chain === 'receiving')
    .reduce((total, item) => total + item.confirmedSats, 0n);
  const changeConfirmedSats = okResults
    .filter(item => item.chain === 'change')
    .reduce((total, item) => total + item.confirmedSats, 0n);

  return {
    expectedContext: RAVENCOIN_CONTEXT,
    hidDetected: true,
    hidDeviceCount: null,
    app: null,
    warnings: [],
    scanResults,
    receivingConfirmedSats,
    changeConfirmedSats,
    grandTotalConfirmedSats: receivingConfirmedSats + changeConfirmedSats,
    totalUtxoCount: okResults.reduce((total, item) => total + item.utxoCount, 0),
    allMatch: scanResults.length > 0 &&
      scanResults.every(item => item.ok && item.matchesLedger),
    error: null,
  };
}

async function refreshCachedEntry(explorer, sessionCache, entry) {
  const balance = await readAddressBalance(explorer, entry.address);
  return sessionCache.updateBalance(entry.chain, entry.index, balance);
}

async function refreshCachedEntries(explorer, sessionCache, entries) {
  for (const entry of entries) {
    await refreshCachedEntry(explorer, sessionCache, entry);
  }
}

async function scanAddressRequestsWithCache(options) {
  const {
    explorer,
    sessionCache,
    requests,
    refreshCached = true,
  } = options;
  const cachedBefore = [];
  const missingRequests = [];

  for (const request of requests) {
    const cached = sessionCache.get(request.chain, request.index);
    if (cached && cached.ok && cached.matchesLedger) {
      cachedBefore.push(cached);
    } else {
      missingRequests.push(request);
    }
  }

  const failedScans = new Map();
  if (missingRequests.length > 0) {
    const scanResult = await scanLedgerAddressRequests({
      expectedContext: 'ravencoin',
      requests: missingRequests,
      explorer,
    });
    assertRavencoinApp(scanResult);

    for (const item of scanResult.scanResults) {
      if (!sessionCache.upsertScanItem(item)) {
        failedScans.set(sessionCache.key(item.chain, item.index), item);
      }
    }
  }

  if (refreshCached) {
    await refreshCachedEntries(explorer, sessionCache, cachedBefore);
  }

  const scanResults = requests.map(request => {
    const cached = sessionCache.get(request.chain, request.index);
    if (cached && cached.ok && cached.matchesLedger) {
      return sessionCache.toScanItem(cached);
    }

    return failedScans.get(sessionCache.key(request.chain, request.index)) || {
      chain: request.chain,
      index: request.index,
      path: request.path,
      rvnAddress: null,
      ledgerAddress: null,
      matchesLedger: false,
      confirmedSats: 0n,
      unconfirmedSats: 0n,
      utxos: [],
      utxoCount: 0,
      txAppearances: null,
      unconfirmedTxAppearances: null,
      ok: false,
      error: new Error('Address was not available in the session cache.'),
    };
  });

  return summarizeScanResults(scanResults);
}

async function scanWalletBalances(explorer, sessionCache, scanPlan) {
  return scanAddressRequestsWithCache({
    explorer,
    sessionCache,
    requests: balanceScanRequests(scanPlan),
  });
}

function isUnusedReceiveAddress(item) {
  if (!item.ok || !item.matchesLedger) {
    return false;
  }

  const hasBalance = item.confirmedSats !== 0n || item.unconfirmedSats !== 0n;
  const hasAddressUsage = Number.isSafeInteger(item.txAppearances);

  if (hasAddressUsage) {
    const hasConfirmedUse = Number.isSafeInteger(item.txAppearances) && item.txAppearances > 0;
    const hasUnconfirmedUse = Number.isSafeInteger(item.unconfirmedTxAppearances) &&
      item.unconfirmedTxAppearances > 0;

    return !hasBalance && !hasConfirmedUse && !hasUnconfirmedUse;
  }

  if (hasBalance || item.utxoCount !== 0) {
    return false;
  }

  return item.txAppearances === null || item.txAppearances === 0;
}

async function refreshCachedReceiveUsage(explorer, sessionCache, entry) {
  const usage = await readAddressUsage(explorer, entry.address);
  return sessionCache.updateUsage(entry.chain, entry.index, usage);
}

async function deriveReceiveAddressUsage(explorer, sessionCache, index) {
  const request = singleAddressRequest('receiving', index);
  const ledgerResult = await listLedgerAddressRequests({
    expectedContext: 'ravencoin',
    requests: [request],
  });
  assertRavencoinApp(ledgerResult);

  const item = ledgerResult.addressResults[0];
  if (!item || !item.ok) {
    throw item && item.error
      ? item.error
      : new Error(`Could not derive receiving address ${index}.`);
  }

  if (!item.matchesLedger) {
    throw new Error('Locally derived receive address does not match Ledger-returned address.');
  }

  const usage = await readAddressUsage(explorer, item.rvnAddress);
  return sessionCache.set({
    ...item,
    confirmedSats: usage.confirmedSats,
    unconfirmedSats: usage.unconfirmedSats,
    utxos: [],
    utxoCount: 0,
    txAppearances: usage.txAppearances,
    unconfirmedTxAppearances: usage.unconfirmedTxAppearances,
    balanceSource: usage.balanceSource,
    balanceError: usage.balanceError,
  });
}

async function ensureReceiveAddressUsage(explorer, sessionCache, index) {
  const cached = sessionCache.get('receiving', index);
  if (cached && cached.ok && cached.matchesLedger) {
    return refreshCachedReceiveUsage(explorer, sessionCache, cached);
  }

  return deriveReceiveAddressUsage(explorer, sessionCache, index);
}

function hasAddressUsageFields(item) {
  return Number.isSafeInteger(item.txAppearances);
}

async function ensureReceiveAddressForUnusedCheck(explorer, sessionCache, index) {
  const usageItem = await ensureReceiveAddressUsage(explorer, sessionCache, index);
  if (hasAddressUsageFields(usageItem)) {
    return usageItem;
  }

  const result = await scanAddressRequestsWithCache({
    explorer,
    sessionCache,
    requests: [singleAddressRequest('receiving', index)],
  });
  const item = result.scanResults[0];
  if (!item || !item.ok || !item.matchesLedger) {
    throw item && item.error
      ? item.error
      : new Error(`Could not check receiving address ${index}.`);
  }

  return sessionCache.get('receiving', index) || item;
}

function collectSpendableUtxosFromCache(sessionCache) {
  const spendable = [];

  for (const item of sessionCache.values()) {
    if (!item.ok || !item.matchesLedger || item.utxoCount === 0) {
      continue;
    }

    for (const utxo of item.utxos) {
      if (utxo.confirmations <= 0) {
        continue;
      }

      spendable.push({
        ...utxo,
        sourceChain: item.chain,
        sourceIndex: item.index,
        sourcePath: item.path,
        sourceAddress: item.address,
      });
    }
  }

  return spendable;
}

function findChangeAddress(sessionCache) {
  const changeIndex = config.ravencoin.defaultChangeIndex;
  const item = sessionCache.get('change', changeIndex);

  if (!item || !item.ok || !item.matchesLedger) {
    throw new Error(`Could not derive verified change address at change index ${changeIndex}.`);
  }

  return item;
}

async function ask(rl, prompt) {
  const answer = await rl.question(prompt);
  if (!process.stdout.isTTY) {
    console.log('');
  }

  const text = answer.trim();
  if (text.toLowerCase() === 'cancel') {
    throw new UserCancelledError();
  }

  return text;
}

function parseScanRange(value, label) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d+)-(\d+)$/);
  if (!match) {
    throw new Error(`${label} range must look like 0-30.`);
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new Error(`${label} range is too large.`);
  }

  if (end < start) {
    throw new Error(`${label} range must start before it ends.`);
  }

  if (end - start + 1 > MAX_CUSTOM_RANGE_SIZE) {
    throw new Error(`${label} range can include at most ${MAX_CUSTOM_RANGE_SIZE} addresses.`);
  }

  return { start, end };
}

async function askCustomScanRange(rl, label) {
  while (true) {
    const answer = await ask(rl, ui.prompt(`${label} index range`, '(example 0-30)'));
    try {
      return parseScanRange(answer, label);
    } catch (error) {
      ui.warning(error.message);
    }
  }
}

async function askScanPlan(rl) {
  ui.section('Scan Wallet Balances', 'Reads public keys and public blockchain data only.');
  ui.menu('Scan Size', [
    { value: 1, label: SCAN_PRESETS.quick.label, description: `${SCAN_PRESETS.quick.description}, recommended` },
    { value: 2, label: SCAN_PRESETS.standard.label, description: SCAN_PRESETS.standard.description },
    { value: 3, label: SCAN_PRESETS.deep.label, description: SCAN_PRESETS.deep.description },
    { value: 4, label: 'Custom scan', description: 'choose receiving and change ranges' },
  ]);

  while (true) {
    const answer = await ask(rl, ui.prompt('Choose scan size', '[1]'));
    if (answer === '' || answer === '1') {
      return SCAN_PRESETS.quick;
    }

    if (answer === '2') {
      return SCAN_PRESETS.standard;
    }

    if (answer === '3') {
      return SCAN_PRESETS.deep;
    }

    if (answer === '4') {
      return {
        label: 'Custom scan',
        description: 'custom ranges',
        receiving: await askCustomScanRange(rl, 'Receiving'),
        change: await askCustomScanRange(rl, 'Change'),
      };
    }

    ui.warning('Choose 1, 2, 3, or 4.');
  }
}

async function askDestination(rl) {
  while (true) {
    const answer = await ask(rl, ui.prompt('Destination RVN address', '(or cancel)'));
    try {
      return validateRvnAddress(answer).address;
    } catch (error) {
      printError(error);
    }
  }
}

async function askAmount(rl) {
  while (true) {
    const answer = await ask(rl, ui.prompt('Amount to send in RVN', '(or cancel)'));
    try {
      return parseRvnAmountToSats(answer);
    } catch (error) {
      printError(error);
    }
  }
}

async function askFeeRate(rl) {
  const recommended = config.ravencoin.feeRateSatPerByte;

  console.log('');
  ui.menu('Fee Option', [
    { value: 1, label: 'Recommended', description: `safe default, ${recommended} sat/byte` },
    { value: 2, label: 'Custom fee rate', description: 'enter sat/byte manually' },
  ]);

  while (true) {
    const answer = await ask(rl, ui.prompt('Choose fee option', '[1]'));
    if (answer === '' || answer === '1') {
      return BigInt(recommended);
    }

    if (answer === '2') {
      while (true) {
        const custom = await ask(rl, ui.prompt('Custom fee rate in sat/byte'));
        try {
          return parsePositiveInteger(custom, 'fee rate');
        } catch (error) {
          printError(error);
        }
      }
    }

    ui.warning('Choose 1 or 2.');
  }
}

function printTransactionSummary(plan) {
  const sourceLabel = plan.sourceAddresses.length === 1
    ? plan.sourceAddresses[0].address
    : `multiple wallet addresses (${plan.sourceAddresses.length})`;

  const entries = [
    { label: 'Amount', value: formatRvn(plan.amountSats) },
    { label: 'Destination', value: plan.destinationAddress },
    { label: 'Source', value: sourceLabel },
    { label: 'Estimated fee', value: formatRvn(plan.feeSats) },
  ];

  if (plan.changeSats > 0n) {
    entries.push({ label: 'Change', value: `${formatRvn(plan.changeSats)} to ${plan.changeAddress}` });
  }

  console.log('');
  ui.keyValueBox('Transaction Summary', entries, {
    color: 'yellow',
    width: 84,
  });
  ui.warningBox('Ledger Approval Required', [
    'Review the amount and destination on the Ledger screen before approving.',
    'Typing SIGN only starts device signing. The Ledger still must approve it.',
  ]);
}

function scanPlanLabel(scanPlan) {
  return `receiving ${scanPlan.receiving.start}-${scanPlan.receiving.end}, change ${scanPlan.change.start}-${scanPlan.change.end}`;
}

function hasRequestCoverage(sessionCache, requests) {
  return requests.every(request => {
    const cached = sessionCache.get(request.chain, request.index);
    return cached && cached.ok && cached.matchesLedger;
  });
}

async function ensureAddressCached(explorer, sessionCache, chain, index) {
  const cached = sessionCache.get(chain, index);
  if (cached && cached.ok && cached.matchesLedger) {
    await refreshCachedEntry(explorer, sessionCache, cached);
    return sessionCache.get(chain, index);
  }

  const result = await scanAddressRequestsWithCache({
    explorer,
    sessionCache,
    requests: [singleAddressRequest(chain, index)],
    refreshCached: false,
  });
  const item = result.scanResults[0];
  if (!item || !item.ok || !item.matchesLedger) {
    throw item && item.error
      ? item.error
      : new Error(`Could not derive ${chain} address ${index}.`);
  }

  return sessionCache.get(chain, index);
}

async function refreshAllCachedBalances(explorer, sessionCache) {
  await refreshCachedEntries(explorer, sessionCache, sessionCache.values());
}

function buildSendPlanFromCache(sessionCache, options) {
  const changeAddress = findChangeAddress(sessionCache);
  const spendableUtxos = collectSpendableUtxosFromCache(sessionCache);

  return buildWalletSendPlan({
    destinationAddress: options.destinationAddress,
    amountSats: options.amountSats,
    utxos: spendableUtxos,
    feeRateSatsPerByte: options.feeRateSatsPerByte,
    dustSats: BigInt(config.ravencoin.dustSats),
    changeChain: changeAddress.chain,
    changeIndex: changeAddress.index,
    changePath: changeAddress.path,
    changeAddress: changeAddress.address,
  });
}

function isInsufficientFundsError(error) {
  return Boolean(error && error.message && error.message.includes('insufficient funds'));
}

async function ensureQuickScanCoverage(explorer, sessionCache) {
  await scanAddressRequestsWithCache({
    explorer,
    sessionCache,
    requests: quickScanRequests(),
  });
}

async function buildSendPlanWithCache(explorer, sessionCache, options) {
  const onStatus = options.onStatus || ui.info;

  if (!sessionCache.hasAny()) {
    onStatus('Checking wallet funds...');
    await ensureQuickScanCoverage(explorer, sessionCache);
  } else {
    onStatus('Refreshing wallet funds...');
    await refreshAllCachedBalances(explorer, sessionCache);
  }

  await ensureAddressCached(explorer, sessionCache, 'change', config.ravencoin.defaultChangeIndex);

  try {
    return buildSendPlanFromCache(sessionCache, options);
  } catch (error) {
    if (!isInsufficientFundsError(error) || hasRequestCoverage(sessionCache, quickScanRequests())) {
      if (isInsufficientFundsError(error) && !error.hint) {
        error.hint = 'Run Scan wallet balances with a larger scan size if funds are on later addresses.';
      }
      throw error;
    }
  }

  onStatus('Checking the quick wallet range...');
  await ensureQuickScanCoverage(explorer, sessionCache);
  try {
    return buildSendPlanFromCache(sessionCache, options);
  } catch (error) {
    if (isInsufficientFundsError(error) && !error.hint) {
      error.hint = 'Run Scan wallet balances with a larger scan size if funds are on later addresses.';
    }
    throw error;
  }
}

function printSendFailure(heading, error, fallbackNextStep) {
  const lines = [error && error.message ? error.message : String(error)];
  if (error && error.hint) {
    lines.push(`Next step: ${error.hint}`);
  }
  if (fallbackNextStep && !(error && error.hint)) {
    lines.push(`Next step: ${fallbackNextStep}`);
  }

  console.log('');
  ui.errorBox(heading, lines);
}

function invalidateSessionAfterBroadcast(sessionCache, explorer) {
  sessionCache.clear();
  if (explorer && typeof explorer.clearCache === 'function') {
    explorer.clearCache();
  }
}

function printBroadcastSuccess(txid) {
  const explorerUrl = `${EXPLORER_TX_BASE_URL}/${txid}`;

  console.log('');
  ui.successBox('Success', [
    'Status: Broadcast accepted',
    `TXID: ${txid}`,
  ]);
  console.log('');
  console.log(ui.style.bold('Explorer:'));
  console.log(explorerUrl);
}

async function handleScanBalances(rl, sessionCache) {
  const scanPlan = await askScanPlan(rl);
  const explorer = createExplorer();
  console.log('');
  ui.info(`Range: ${scanPlanLabel(scanPlan)}`);
  const result = await ui.withSpinner('Checking wallet balances...', () => {
    return scanWalletBalances(explorer, sessionCache, scanPlan);
  });
  printFundedAddresses(result);
}

async function handleSendRvn(rl, sessionCache) {
  ui.section('Send RVN', 'Guided send flow with explicit Ledger approval.');
  ui.info('Type cancel at any prompt to stop before signing.');
  console.log('');

  const amountSats = await askAmount(rl);
  const destinationAddress = await askDestination(rl);
  const feeRateSatsPerByte = await askFeeRate(rl);
  const explorer = createExplorer();
  let plan;

  try {
    console.log('');
    plan = await buildSendPlanWithCache(explorer, sessionCache, {
      destinationAddress,
      amountSats,
      feeRateSatsPerByte,
      onStatus: ui.info,
    });
  } catch (error) {
    printSendFailure(
      'Send failed. Nothing was signed or broadcast.',
      error,
      'Check the Ledger connection and try again.',
    );
    return;
  }

  printTransactionSummary(plan);
  console.log('');
  const signAnswer = await ask(rl, ui.prompt('Type SIGN to sign on the Ledger', '(Enter cancels)'));
  if (signAnswer !== 'SIGN') {
    ui.warningBox('Signing Cancelled', [
      'Nothing was signed or broadcast.',
    ]);
    return;
  }

  let signed;
  try {
    signed = await signDryRunPlan(plan, {
      explorer,
    });
  } catch (error) {
    printSendFailure(
      'Signing failed. Nothing was broadcast.',
      error,
      'Check the Ledger screen and try again.',
    );
    return;
  }

  try {
    const broadcastTxid = await broadcastRawTx(signed.signedRawTx, {
      explorer,
    });
    invalidateSessionAfterBroadcast(sessionCache, explorer);
    printBroadcastSuccess(broadcastTxid);
  } catch (error) {
    printSendFailure(
      'Broadcast failed. No successful broadcast confirmation was received.',
      error,
      'Check the explorer link later or try sending again when the explorer is available.',
    );
  }
}

async function findUnusedReceiveAddress(explorer, sessionCache) {
  for (let index = 0; index <= config.ravencoin.scan.receiveMaxIndex; index += 1) {
    const current = await ensureReceiveAddressForUnusedCheck(explorer, sessionCache, index);
    if (current && isUnusedReceiveAddress(current)) {
      return current;
    }
  }

  return null;
}

async function handleReceiveRvn(rl, sessionCache) {
  ui.section('Receive RVN', 'Finds the first unused receiving address.');

  const explorer = createExplorer();
  const receiveAddress = await ui.withSpinner('Finding an unused receiving address...', () => {
    return findUnusedReceiveAddress(explorer, sessionCache);
  });

  if (!receiveAddress) {
    ui.warningBox('No Address Found', [
      `No unused receiving address was found in indexes 0-${config.ravencoin.scan.receiveMaxIndex}.`,
    ]);
    return;
  }

  console.log('');
  ui.keyValueBox('Unused Receiving Address', [
    { label: 'Address', value: receiveAddress.address },
    { label: 'Index', value: String(receiveAddress.index) },
  ], {
    color: 'green',
  });

  const verify = await ask(rl, ui.prompt('Verify on the Ledger device?', '[y/N]'));
  if (!['y', 'yes'].includes(verify.toLowerCase())) {
    return;
  }

  const result = await verifyLedgerAddressOnDevice(receiveAddress.path, receiveAddress.address);
  if (!result.matchesExpected || !result.matchesLedger) {
    throw new Error('Ledger on-device verification did not match the locally derived receive address.');
  }

  ui.success('Ledger verification matched this RVN receiving address.');
}

function printSafetyNotes() {
  console.log('');
  ui.infoBox('Help / Safety Notes', [
    `${ui.symbols.bullet} Keep the Ledger unlocked with the Ravencoin app open.`,
    `${ui.symbols.bullet} Never enter your recovery phrase anywhere.`,
    `${ui.symbols.bullet} Verify transaction details on the Ledger before approving.`,
    `${ui.symbols.bullet} Use the explorer link after a successful broadcast.`,
    `${ui.symbols.bullet} Advanced commands remain available through node RavenSafe.js --help.`,
  ]);
}

function printSupportDonate() {
  const rvnDonation = config.branding.donations.rvn;

  console.log('');
  ui.printBox([
    'Thank you for supporting RavenSafe CLI.',
    '',
    `RVN donation address: ${rvnDonation.address}`,
    `Explorer: ${rvnDonation.explorerUrl}`,
  ], {
    title: 'Support / Donate',
    color: 'blue',
    width: 92,
  });
}

function printMenu() {
  console.log('');
  ui.menu('RavenSafe CLI', [
    { value: 1, label: 'Scan wallet balances' },
    { value: 2, label: 'Send RVN' },
    { value: 3, label: 'Receive RVN' },
    { value: 4, label: 'Help / safety notes' },
    { value: 5, label: 'Support / Donate' },
    { value: 6, label: 'Exit' },
  ], 'Ledger signs. Your seed never leaves the device.');
}

async function handleMenuChoice(rl, sessionCache, choice) {
  if (choice === '1') {
    await handleScanBalances(rl, sessionCache);
    return false;
  }

  if (choice === '2') {
    await handleSendRvn(rl, sessionCache);
    return false;
  }

  if (choice === '3') {
    await handleReceiveRvn(rl, sessionCache);
    return false;
  }

  if (choice === '4') {
    printSafetyNotes();
    return false;
  }

  if (choice === '5') {
    printSupportDonate();
    return false;
  }

  if (choice === '6') {
    ui.success('Session closed.');
    return true;
  }

  ui.warning('Choose 1, 2, 3, 4, 5, or 6.');
  return false;
}

async function runInteractiveCli() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const sessionCache = createSessionCache();

  try {
    await ui.showStartup();

    while (true) {
      try {
        printMenu();
        const choice = await ask(rl, ui.prompt('Choose an option'));
        const shouldExit = await handleMenuChoice(rl, sessionCache, choice);
        if (shouldExit) {
          return;
        }
      } catch (error) {
        if (error instanceof UserCancelledError) {
          ui.warningBox('Cancelled', [
            error.message,
          ]);
          return;
        }

        printError(error);
      }
    }
  } finally {
    sessionCache.clear();
    rl.close();
  }
}

module.exports = {
  balanceScanRequests,
  buildIndexRangeRequests,
  invalidateSessionAfterBroadcast,
  printBroadcastSuccess,
  runInteractiveCli,
};
