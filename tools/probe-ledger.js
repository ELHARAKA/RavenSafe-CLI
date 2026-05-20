#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const { EXPECTED_CONTEXTS, PROBE_PATHS, probeLedger } = require('../src/ledger');

function printError(error) {
  console.log(`Error: ${error.message}`);
  if (error.statusCode) {
    console.log(`Status: ${error.statusCode}`);
  }
  console.log(`Hint: ${error.hint}`);
}

function printProbeResult(result) {
  console.log('RVN Ledger public-key probe');
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
    printError(result.app.error);
  }

  for (const warning of result.warnings) {
    console.log(`Warning: ${warning}`);
  }

  if (result.error) {
    console.log('');
    printError(result.error);
    return;
  }

  console.log(`Public-key export works: ${result.publicKeyExportWorks ? 'yes' : 'no'}`);
  console.log('');
  console.log('Allowed derivation paths:');
  for (const path of PROBE_PATHS) {
    console.log(`- ${path}`);
  }

  for (const item of result.publicKeyResults) {
    console.log('');
    console.log(`Path: ${item.path}`);

    if (!item.ok) {
      printError(item.error);
      continue;
    }

    console.log(`Public key: ${item.publicKey}`);
    console.log(`Chain code: ${item.chainCode || 'not returned'}`);
    console.log(`Ledger-returned address: ${item.ledgerAddress || 'not returned'}`);
    console.log(`Derived RVN P2PKH address: ${item.rvnAddress}`);
  }
}

async function main() {
  const program = new Command();
  program
    .name('probe-ledger')
    .description('RVN Ledger public-key export probe')
    .option('--app <context>', 'expected Ledger app context: current, ravencoin, or bitcoin', 'current')
    .parse(process.argv);

  const options = program.opts();
  if (!EXPECTED_CONTEXTS[options.app]) {
    console.error(`Unknown app context "${options.app}". Use current, ravencoin, or bitcoin.`);
    process.exitCode = 1;
    return;
  }

  const result = await probeLedger({
    expectedContext: options.app,
  });

  printProbeResult(result);
  process.exitCode = result.publicKeyExportWorks ? 0 : 2;
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
