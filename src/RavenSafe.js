#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const fs = require('fs/promises');
const bitcoin = require('bitcoinjs-lib');
const readline = require('readline/promises');
const config = require('./config');
const {
  ADDRESS_CHAIN_MODES,
  ADDRESS_CHAINS,
  EXPECTED_CONTEXTS,
  addressPathForIndex,
  listLedgerAddressRequests,
  listLedgerAddresses,
} = require('./ledger');
const {
  broadcastRawTx,
  createExplorer,
  describeBroadcastProvider,
} = require('./explorer/zelcore');
const { formatRvn, scanLedgerAddresses } = require('./core/scan');
const { signDryRunPlan } = require('./tx/signer');
const {
  buildDryRunSendPlan,
  parseNonNegativeInteger,
  parsePositiveInteger,
  parseRvnAmountToSats,
  validateRvnAddress,
} = require('./tx/builder');

function printError(error, write = console.error) {
  write(`Error: ${error.message}`);
  if (error.statusCode) {
    write(`Status: ${error.statusCode}`);
  }
  if (error.endpoint) {
    write(`Endpoint: ${error.endpoint}`);
  }
  if (error.responseBody) {
    write(`Response body: ${error.responseBody}`);
  }
  if (error.hint) {
    write(`Hint: ${error.hint}`);
  }
}

function parseWholeNumber(value, name) {
  const text = String(value);
  if (text.startsWith('-')) {
    throw new Error(`${name} must be >= 0`);
  }

  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw new Error(`${name} must be a whole number`);
  }

  return Number(text);
}

function parseLedgerRangeOptions(options, maxCount) {
  const start = parseWholeNumber(options.start, 'start');
  const count = parseWholeNumber(options.count, 'count');

  if (start < 0) {
    throw new Error('start must be >= 0');
  }

  if (count < 1 || count > maxCount) {
    throw new Error(`count must be between 1 and ${maxCount}`);
  }

  if (!EXPECTED_CONTEXTS[options.app]) {
    throw new Error('app must be one of: current, ravencoin, bitcoin');
  }

  return {
    start,
    count,
    expectedContext: options.app,
  };
}

function parseAddressOptions(options) {
  return parseLedgerRangeOptions(options, 100);
}

function parseScanOptions(options) {
  const parsed = parseLedgerRangeOptions(options, 200);
  if (!ADDRESS_CHAIN_MODES.includes(options.chain)) {
    throw new Error('chain must be one of: receiving, change, both');
  }

  return {
    ...parsed,
    chain: options.chain,
  };
}

function parseSingleAddressChain(value, name) {
  if (!ADDRESS_CHAINS[value]) {
    throw new Error(`${name} must be one of: receiving, change`);
  }

  return value;
}

function parseSendOptions(options) {
  if (!EXPECTED_CONTEXTS[options.app]) {
    throw new Error('app must be one of: current, ravencoin, bitcoin');
  }

  const fromChain = parseSingleAddressChain(options.fromChain, 'from-chain');
  const changeChain = parseSingleAddressChain(options.changeChain, 'change-chain');
  const fromIndex = parseWholeNumber(options.fromIndex, 'from-index');
  const changeIndexDefault = String(config.ravencoin.defaultChangeIndex);
  const changeIndex = parseWholeNumber(options.changeIndex ?? changeIndexDefault, 'change-index');
  const feeRateDefault = String(config.ravencoin.feeRateSatPerByte);
  const dustDefault = String(config.ravencoin.dustSats);

  const destination = validateRvnAddress(options.to).address;
  const amountSats = parseRvnAmountToSats(options.amount);
  const feeRateSatsPerByte = parsePositiveInteger(options.feeRate ?? feeRateDefault, 'fee-rate');
  const dustSats = BigInt(parseNonNegativeInteger(dustDefault, 'config.ravencoin.dustSats'));

  return {
    expectedContext: options.app,
    fromChain,
    fromIndex,
    destination,
    amountSats,
    feeRateSatsPerByte,
    dustSats,
    changeChain,
    changeIndex,
    sign: Boolean(options.sign),
  };
}

function parseBroadcastOptions(options) {
  const hasRawTx = options.rawtx !== undefined && options.rawtx !== null;
  const hasFile = options.file !== undefined && options.file !== null;

  if (hasRawTx && hasFile) {
    throw new Error('use either --rawtx or --file, not both');
  }

  if (!hasRawTx && !hasFile) {
    throw new Error('either --rawtx or --file is required');
  }

  return {
    rawtx: hasRawTx ? String(options.rawtx) : null,
    file: hasFile ? String(options.file) : null,
  };
}

function normalizeRawTx(rawTx) {
  const text = String(rawTx || '').trim();

  if (text.length === 0) {
    throw new Error('rawtx must be a non-empty hex string');
  }

  if (text.length % 2 !== 0) {
    throw new Error('rawtx must be even-length hex');
  }

  if (!/^[0-9a-fA-F]+$/.test(text)) {
    throw new Error('rawtx must contain only hex characters');
  }

  return text.toLowerCase();
}

async function loadBroadcastRawTx(options) {
  if (options.rawtx !== null) {
    return normalizeRawTx(options.rawtx);
  }

  let contents;
  try {
    contents = await fs.readFile(options.file, 'utf8');
  } catch (error) {
    throw new Error(`could not read raw transaction file: ${error.message}`);
  }

  return normalizeRawTx(contents);
}

function inspectRawTransaction(rawTx) {
  const bytes = Buffer.byteLength(rawTx, 'hex');

  try {
    const transaction = bitcoin.Transaction.fromHex(rawTx);
    return {
      txid: transaction.getId(),
      bytes,
      inputCount: transaction.ins.length,
      outputCount: transaction.outs.length,
    };
  } catch (error) {
    throw new Error(`rawtx is hex but could not be decoded as a transaction: ${error.message}`);
  }
}

function formatTable(rows, columns) {
  const widths = columns.map(column => {
    return Math.max(
      column.label.length,
      ...rows.map(row => String(row[column.key]).length),
    );
  });

  const line = columns
    .map((column, index) => column.label.padEnd(widths[index]))
    .join('  ');
  const divider = widths.map(width => '-'.repeat(width)).join('  ');
  const body = rows.map(row => {
    return columns
      .map((column, index) => String(row[column.key]).padEnd(widths[index]))
      .join('  ');
  });

  return [line, divider, ...body].join('\n');
}

function printAddressResult(result) {
  console.log('RVN Ledger address listing');
  console.log('Reads public keys only. Does not sign, send, or broadcast.');
  console.log('');
  console.log(`Test context: ${result.expectedContext.label} (${result.expectedContext.purpose})`);
  console.log(`HID detected: ${result.hidDetected ? 'yes' : 'no'}`);
  console.log(`HID device count: ${result.hidDeviceCount}`);

  if (result.app && result.app.name) {
    console.log(`Open Ledger app: ${result.app.name} ${result.app.version}`);
    console.log(`Detected context: ${result.app.context.label} (${result.app.context.purpose})`);
  } else if (result.app && result.app.error) {
    console.log('Open Ledger app: could not detect');
    printError(result.app.error, console.log);
  }

  for (const warning of result.warnings) {
    console.log(`Warning: ${warning}`);
  }

  if (result.error) {
    console.log('');
    printError(result.error, console.log);
    return;
  }

  const rows = result.addressResults.map(item => ({
    index: item.index,
    path: item.path,
    rvnAddress: item.rvnAddress || '-',
    ledgerAddress: item.ledgerAddress || '-',
    match: item.ok ? (item.matchesLedger ? 'yes' : 'no') : 'error',
  }));

  console.log('');
  console.log(formatTable(rows, [
    { key: 'index', label: 'index' },
    { key: 'path', label: 'derivation path' },
    { key: 'rvnAddress', label: 'RVN address' },
    { key: 'ledgerAddress', label: 'Ledger-returned address' },
    { key: 'match', label: 'match' },
  ]));

  const failedRows = result.addressResults.filter(item => !item.ok);
  for (const item of failedRows) {
    console.log('');
    console.log(`Path ${item.path} failed:`);
    printError(item.error, console.log);
  }
}

function printScanResult(result) {
  console.log('RVN Ledger balance scan');
  console.log('Reads public keys and public blockchain data only. Does not sign, send, or broadcast.');
  console.log('');

  if (!result.expectedContext) {
    printError(result.error, console.log);
    return;
  }

  console.log(`Test context: ${result.expectedContext.label} (${result.expectedContext.purpose})`);
  console.log(`HID detected: ${result.hidDetected ? 'yes' : 'no'}`);
  console.log(`HID device count: ${result.hidDeviceCount}`);

  if (result.app && result.app.name) {
    console.log(`Open Ledger app: ${result.app.name} ${result.app.version}`);
    console.log(`Detected context: ${result.app.context.label} (${result.app.context.purpose})`);
  } else if (result.app && result.app.error) {
    console.log('Open Ledger app: could not detect');
    printError(result.app.error, console.log);
  }

  for (const warning of result.warnings) {
    console.log(`Warning: ${warning}`);
  }

  if (result.error) {
    console.log('');
    printError(result.error, console.log);
    return;
  }

  const rows = result.scanResults.map(item => ({
    chain: item.chain || '-',
    index: item.index,
    path: item.path,
    rvnAddress: item.rvnAddress || '-',
    confirmed: item.ok ? formatRvn(item.confirmedSats) : '-',
    unconfirmed: item.ok ? formatRvn(item.unconfirmedSats) : '-',
    utxos: item.ok ? item.utxoCount : '-',
    match: item.matchesLedger ? 'yes' : 'no',
  }));

  console.log('');
  console.log(formatTable(rows, [
    { key: 'chain', label: 'chain' },
    { key: 'index', label: 'index' },
    { key: 'path', label: 'derivation path' },
    { key: 'rvnAddress', label: 'RVN address' },
    { key: 'confirmed', label: 'confirmed balance' },
    { key: 'unconfirmed', label: 'unconfirmed balance' },
    { key: 'utxos', label: 'UTXOs' },
    { key: 'match', label: 'match' },
  ]));

  const failedRows = result.scanResults.filter(item => !item.ok);
  for (const item of failedRows) {
    console.log('');
    console.log(`Path ${item.path} failed:`);
    printError(item.error, console.log);
  }

  console.log('');
  console.log(`Receiving confirmed total: ${formatRvn(result.receivingConfirmedSats)}`);
  console.log(`Change confirmed total: ${formatRvn(result.changeConfirmedSats)}`);
  console.log(`Grand total confirmed: ${formatRvn(result.grandTotalConfirmedSats)}`);
  console.log(`Total UTXOs: ${result.totalUtxoCount}`);
}

async function createDryRunSendPlan(options) {
  let explorer;
  try {
    explorer = createExplorer();
  } catch (error) {
    return {
      ledgerResult: null,
      plan: null,
      error,
    };
  }

  const requests = [
    {
      role: 'source',
      chain: options.fromChain,
      index: options.fromIndex,
      path: addressPathForIndex(options.fromIndex, options.fromChain),
    },
    {
      role: 'change',
      chain: options.changeChain,
      index: options.changeIndex,
      path: addressPathForIndex(options.changeIndex, options.changeChain),
    },
  ];

  const ledgerResult = await listLedgerAddressRequests({
    expectedContext: options.expectedContext,
    requests,
  });

  const result = {
    ledgerResult,
    plan: null,
    error: ledgerResult.error,
  };

  if (ledgerResult.error) {
    return result;
  }

  const sourceAddress = ledgerResult.addressResults.find(item => item.role === 'source');
  const changeAddress = ledgerResult.addressResults.find(item => item.role === 'change');

  if (!sourceAddress || !sourceAddress.ok) {
    result.error = sourceAddress && sourceAddress.error
      ? sourceAddress.error
      : new Error('Could not derive source address from Ledger.');
    return result;
  }

  if (!sourceAddress.matchesLedger) {
    result.error = new Error('Source address mismatch: locally derived RVN address does not match Ledger-returned address.');
    return result;
  }

  if (!changeAddress || !changeAddress.ok) {
    result.error = changeAddress && changeAddress.error
      ? changeAddress.error
      : new Error('Could not derive change address from Ledger.');
    return result;
  }

  if (!changeAddress.matchesLedger) {
    result.error = new Error('Change address mismatch: locally derived RVN address does not match Ledger-returned address.');
    return result;
  }

  try {
    const utxos = await explorer.getUtxos(sourceAddress.rvnAddress);
    result.plan = buildDryRunSendPlan({
      sourceChain: sourceAddress.chain,
      sourceIndex: sourceAddress.index,
      sourcePath: sourceAddress.path,
      sourceAddress: sourceAddress.rvnAddress,
      destinationAddress: options.destination,
      amountSats: options.amountSats,
      utxos,
      feeRateSatsPerByte: options.feeRateSatsPerByte,
      dustSats: options.dustSats,
      changeChain: changeAddress.chain,
      changeIndex: changeAddress.index,
      changePath: changeAddress.path,
      changeAddress: changeAddress.rvnAddress,
    });
  } catch (error) {
    result.error = error;
  }

  return result;
}

function printSendPlanResult(result, options = {}) {
  const signingRequested = options.signingRequested || false;
  console.log('RVN Ledger send planner');
  if (signingRequested) {
    console.log('SIGNING REQUESTED');
    console.log('No transaction has been signed yet. Nothing will be broadcast.');
  } else {
    console.log('DRY RUN ONLY');
    console.log('No transaction was signed or broadcast.');
  }
  console.log('');

  const ledgerResult = result.ledgerResult;
  if (ledgerResult) {
    console.log(`Test context: ${ledgerResult.expectedContext.label} (${ledgerResult.expectedContext.purpose})`);
    console.log(`HID detected: ${ledgerResult.hidDetected ? 'yes' : 'no'}`);
    console.log(`HID device count: ${ledgerResult.hidDeviceCount}`);

    if (ledgerResult.app && ledgerResult.app.name) {
      console.log(`Open Ledger app: ${ledgerResult.app.name} ${ledgerResult.app.version}`);
      console.log(`Detected context: ${ledgerResult.app.context.label} (${ledgerResult.app.context.purpose})`);
    } else if (ledgerResult.app && ledgerResult.app.error) {
      console.log('Open Ledger app: could not detect');
      printError(ledgerResult.app.error, console.log);
    }

    for (const warning of ledgerResult.warnings) {
      console.log(`Warning: ${warning}`);
    }
  }

  if (result.error) {
    console.log('');
    printError(result.error, console.log);
    return;
  }

  const plan = result.plan;
  console.log('');
  console.log(`Source chain: ${plan.sourceChain}`);
  console.log(`Source index: ${plan.sourceIndex}`);
  console.log(`Source path: ${plan.sourcePath}`);
  console.log(`Source address: ${plan.sourceAddress}`);
  console.log(`Destination address: ${plan.destinationAddress}`);
  console.log(`Amount: ${formatRvn(plan.amountSats)}`);

  console.log('');
  console.log('Selected UTXOs:');
  console.log(formatTable(plan.selectedUtxos.map(utxo => ({
    txid: utxo.txid,
    vout: utxo.vout,
    value: formatRvn(utxo.valueSats),
    confirmations: utxo.confirmations,
  })), [
    { key: 'txid', label: 'txid' },
    { key: 'vout', label: 'vout' },
    { key: 'value', label: 'value' },
    { key: 'confirmations', label: 'confirmations' },
  ]));

  console.log('');
  console.log(`Fee rate: ${plan.feeRateSatsPerByte.toString()} sat/byte`);
  console.log(`Estimated tx bytes: ${plan.estimatedBytes}`);
  console.log(`Estimated fee: ${formatRvn(plan.feeSats)}`);
  if (plan.dustRemainderAddedToFeeSats > 0n) {
    console.log(`Dust/remainder added to fee: ${formatRvn(plan.dustRemainderAddedToFeeSats)}`);
  }

  console.log('');
  console.log(`Change chain: ${plan.changeChain}`);
  console.log(`Change index: ${plan.changeIndex}`);
  console.log(`Change path: ${plan.changePath}`);
  console.log(`Change address: ${plan.changeAddress}`);
  console.log(`Change amount: ${formatRvn(plan.changeSats)}`);

  console.log('');
  console.log('Final outputs:');
  console.log(formatTable(plan.outputs.map(output => ({
    type: output.type,
    address: output.address,
    value: formatRvn(output.valueSats),
  })), [
    { key: 'type', label: 'type' },
    { key: 'address', label: 'address' },
    { key: 'value', label: 'value' },
  ]));

  console.log('');
  if (signingRequested) {
    console.log('No transaction has been signed yet. Nothing will be broadcast.');
  } else {
    console.log('No transaction was signed or broadcast.');
  }
}

async function confirmLedgerSigning() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question('Type SIGN to call Ledger signing: ');
    return answer === 'SIGN';
  } finally {
    rl.close();
  }
}

async function confirmBroadcast() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question('Type BROADCAST to send this transaction to the Ravencoin network: ');
    return answer === 'BROADCAST';
  } finally {
    rl.close();
  }
}

function printSignedTransaction(result) {
  console.log('');
  console.log('Signed raw transaction hex:');
  console.log(result.signedRawTx);
  console.log('');
  console.log(`TXID: ${result.txid}`);
  console.log('');
  console.log('Signed transaction generated. Nothing was broadcast.');
}

function printBroadcastPreview(rawTx, inspection, provider) {
  console.log('RVN manual broadcast');
  console.log('WARNING: broadcasting is irreversible once the Ravencoin network accepts the transaction.');
  console.log('');
  console.log(`Broadcast provider: ${provider.label}`);
  if (provider.endpoint) {
    console.log(`Broadcast endpoint: ${provider.endpoint}`);
  }
  console.log(`TXID: ${inspection.txid}`);
  console.log(`Estimated bytes: ${inspection.bytes}`);
  console.log(`Inputs: ${inspection.inputCount}`);
  console.log(`Outputs: ${inspection.outputCount}`);
  console.log('');
  console.log('No transaction has been broadcast yet.');
  console.log(`Raw transaction hex length: ${rawTx.length}`);
  console.log('');
}

async function main() {
  if (process.argv.length === 2) {
    const { runInteractiveCli } = require('./interactive');
    await runInteractiveCli();
    return;
  }

  const program = new Command();

  program
    .name('RavenSafe')
    .description('RavenSafe CLI. Run without a command to launch the guided wallet flow.');

  program
    .command('addresses')
    .description('List Ledger-derived RVN receive addresses')
    .option('--start <number>', 'first address index', '0')
    .option('--count <number>', 'number of addresses to list, 1 through 100', '10')
    .option('--app <context>', 'expected Ledger app context: current, ravencoin, or bitcoin', 'ravencoin')
    .action(async options => {
      let parsed;
      try {
        parsed = parseAddressOptions(options);
      } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exitCode = 1;
        return;
      }

      const result = await listLedgerAddresses(parsed);
      printAddressResult(result);
      process.exitCode = result.allMatch ? 0 : 2;
    });

  program
    .command('send')
    .description('Advanced: prepare a dry-run RVN send plan; with --sign, sign only and do not broadcast.')
    .option('--from-chain <receiving|change>', 'source address chain', 'receiving')
    .requiredOption('--from-index <number>', 'source address index')
    .requiredOption('--to <RVN_ADDRESS>', 'destination RVN address')
    .requiredOption('--amount <RVN_AMOUNT>', 'amount to send in RVN')
    .option('--fee-rate <sat_per_byte>', 'fee rate in sat/byte; defaults to config.ravencoin.feeRateSatPerByte')
    .option('--change-chain <receiving|change>', 'change address chain', 'change')
    .option('--change-index <number>', 'change address index; defaults to config.ravencoin.defaultChangeIndex')
    .option('--app <context>', 'expected Ledger app context: current, ravencoin, or bitcoin', 'ravencoin')
    .option('--dry-run', 'dry-run only; no signing or broadcasting', true)
    .option('--sign', 'after showing the summary, ask for SIGN and call Ledger signing')
    .action(async options => {
      let parsed;
      try {
        parsed = parseSendOptions(options);
      } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exitCode = 1;
        return;
      }

      const result = await createDryRunSendPlan(parsed);
      printSendPlanResult(result, {
        signingRequested: parsed.sign && Boolean(result.plan),
      });

      if (!result.plan) {
        process.exitCode = 2;
        return;
      }

      if (!parsed.sign) {
        process.exitCode = 0;
        return;
      }

      const confirmed = await confirmLedgerSigning();
      if (!confirmed) {
        console.log('Signing aborted. Nothing was signed or broadcast.');
        process.exitCode = 1;
        return;
      }

      try {
        const signed = await signDryRunPlan(result.plan);
        printSignedTransaction(signed);
        process.exitCode = 0;
      } catch (error) {
        console.log('');
        printError(error, console.log);
        console.log('Nothing was broadcast.');
        process.exitCode = 2;
      }
    });

  program
    .command('broadcast')
    .description('Advanced: manually broadcast a signed raw RVN transaction after BROADCAST confirmation.')
    .option('--rawtx <SIGNED_RAW_TX_HEX>', 'signed raw transaction hex')
    .option('--file <path>', 'file containing signed raw transaction hex')
    .action(async options => {
      let parsed;
      let rawTx;
      let inspection;
      const provider = describeBroadcastProvider();
      try {
        parsed = parseBroadcastOptions(options);
        rawTx = await loadBroadcastRawTx(parsed);
        inspection = inspectRawTransaction(rawTx);
      } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exitCode = 1;
        return;
      }

      printBroadcastPreview(rawTx, inspection, provider);

      const confirmed = await confirmBroadcast();
      if (!confirmed) {
        console.log('Broadcast aborted. Nothing was broadcast.');
        process.exitCode = 1;
        return;
      }

      try {
        const txid = await broadcastRawTx(rawTx);
        console.log('');
        console.log(`Broadcast provider: ${provider.label}`);
        console.log(`Broadcast TXID: ${txid}`);
      } catch (error) {
        console.log('');
        printError(error, console.log);
        console.log('Broadcast failed.');
        process.exitCode = 2;
      }
    });

  program
    .command('scan')
    .description('Scan Ledger-derived RVN addresses for balances')
    .option('--start <number>', 'first address index', '0')
    .option('--count <number>', 'number of addresses to scan per selected chain, 1 through 200', '10')
    .option('--chain <chain>', 'address chain to scan: receiving, change, or both', 'receiving')
    .option('--app <context>', 'expected Ledger app context: current, ravencoin, or bitcoin', 'ravencoin')
    .action(async options => {
      let parsed;
      try {
        parsed = parseScanOptions(options);
      } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exitCode = 1;
        return;
      }

      const result = await scanLedgerAddresses(parsed);
      printScanResult(result);
      process.exitCode = result.allMatch ? 0 : 2;
    });

  await program.parseAsync(process.argv);
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
