'use strict';

const TransportNodeHid = require('@ledgerhq/hw-transport-node-hid').default;
const Btc = require('@ledgerhq/hw-app-btc').default;
const { getAppAndVersion } = require('@ledgerhq/hw-app-btc/lib/getAppAndVersion');
const { deriveRvnP2pkhAddress } = require('../core/address');

const PROBE_PATHS = Object.freeze([
  "m/44'/175'/0'/0/0",
  "m/44'/175'/0'/0/1",
  "m/44'/175'/0'/0/2",
  "m/44'/175'/175'/0/0",
]);

const EXPECTED_CONTEXTS = Object.freeze({
  current: {
    label: 'currently open Ledger app',
    purpose: 'auto-detected context',
  },
  ravencoin: {
    label: 'Ravencoin app',
    purpose: 'preferred/documented target',
  },
  bitcoin: {
    label: 'Bitcoin app',
    purpose: 'fallback/compatibility experiment',
  },
});

const ADDRESS_CHAINS = Object.freeze({
  receiving: {
    label: 'receiving',
    change: 0,
  },
  change: {
    label: 'change',
    change: 1,
  },
});

const ADDRESS_CHAIN_MODES = Object.freeze([
  'receiving',
  'change',
  'both',
]);

function statusCodeHex(statusCode) {
  if (typeof statusCode !== 'number') {
    return null;
  }

  return `0x${statusCode.toString(16).padStart(4, '0')}`;
}

function describeLedgerError(error) {
  const statusCode = statusCodeHex(error && error.statusCode);
  const message = error && error.message ? error.message : String(error);
  let hint = 'Close Ledger Live, unlock the Ledger, and open the Ravencoin app first.';

  if (message.includes('NoDevice') || message.includes('No Ledger device found')) {
    hint = 'Connect the Ledger over USB, unlock it, and close Ledger Live.';
  } else if (message.includes('cannot open device') || message.includes('Cannot open device')) {
    hint = 'Close Ledger Live or any wallet app that may already be using HID.';
  } else if (error && error.statusCode === 0x6985) {
    hint = 'The request was rejected on the Ledger device.';
  } else if (error && error.statusCode === 0x5515) {
    hint = 'Unlock the Ledger and open the Ravencoin app before retrying.';
  } else if (error && [0x6a82, 0x6d00, 0x6e00].includes(error.statusCode)) {
    hint = 'The open Ledger app did not support this public-key request; try the Ravencoin app first, then Bitcoin only as fallback.';
  }

  return {
    name: (error && error.name) || 'LedgerError',
    statusCode,
    message,
    hint,
  };
}

function classifyAppContext(appName) {
  const normalized = (appName || '').toLowerCase();

  if (normalized.includes('raven')) {
    return {
      key: 'ravencoin',
      label: 'Ravencoin app',
      purpose: 'preferred/documented target',
    };
  }

  if (normalized.includes('bitcoin')) {
    return {
      key: 'bitcoin',
      label: 'Bitcoin app',
      purpose: 'fallback/compatibility experiment',
    };
  }

  return {
    key: 'unknown',
    label: appName || 'unknown app',
    purpose: 'not a known RVN probe context',
  };
}

function buildContextWarnings(expectedContext, detectedContext) {
  const warnings = [];

  if (expectedContext === 'bitcoin') {
    warnings.push('Bitcoin app mode is a fallback diagnostic only. Ravencoin app remains the primary workflow.');
  }

  if (expectedContext === 'current' && detectedContext.key === 'bitcoin') {
    warnings.push('Bitcoin app is a fallback diagnostic context for this project, not the primary RVN workflow.');
  }

  if (expectedContext !== 'current' && detectedContext.key !== 'unknown' && detectedContext.key !== expectedContext) {
    warnings.push(`Expected ${EXPECTED_CONTEXTS[expectedContext].label}, but Ledger reports ${detectedContext.label}.`);
  }

  if (detectedContext.key === 'unknown') {
    warnings.push('Open the Ravencoin app first. Try the Bitcoin app only as a fallback diagnostic.');
  }

  return warnings;
}

function addressChainsForMode(mode = 'receiving') {
  if (mode === 'both') {
    return ['receiving', 'change'];
  }

  if (!ADDRESS_CHAINS[mode]) {
    throw new Error('chain must be one of: receiving, change, both');
  }

  return [mode];
}

function addressPathForIndex(index, chain = 'receiving') {
  if (!ADDRESS_CHAINS[chain]) {
    throw new Error('chain must be receiving or change');
  }

  return `m/44'/175'/0'/${ADDRESS_CHAINS[chain].change}/${index}`;
}

async function readPublicKeys(transport, paths = PROBE_PATHS) {
  const btc = new Btc({
    transport,
    currency: 'ravencoin',
  });

  const results = [];
  for (const path of paths) {
    try {
      const response = await btc.getWalletPublicKey(path, {
        format: 'legacy',
        verify: false,
      });

      const publicKey = response.publicKey;
      results.push({
        ok: true,
        path,
        publicKey,
        chainCode: response.chainCode || null,
        ledgerAddress: response.bitcoinAddress || null,
        rvnAddress: deriveRvnP2pkhAddress(publicKey),
      });
    } catch (error) {
      results.push({
        ok: false,
        path,
        error: describeLedgerError(error),
      });
    }
  }

  return results;
}

async function closeTransport(transport) {
  if (!transport) {
    return;
  }

  try {
    await transport.close();
  } catch {
    // The probe is already done; close failures should not hide the useful result.
  }
}

async function detectOpenApp(transport, result, expectedContext) {
  try {
    const appAndVersion = await getAppAndVersion(transport);
    const detectedContext = classifyAppContext(appAndVersion.name);
    result.app = {
      name: appAndVersion.name,
      version: appAndVersion.version,
      context: detectedContext,
    };
    result.warnings.push(...buildContextWarnings(expectedContext, detectedContext));
  } catch (error) {
    result.app = {
      error: describeLedgerError(error),
    };
  }
}

function buildNoDeviceError() {
  return {
    name: 'NoDevice',
    statusCode: null,
    message: 'No Ledger HID device detected.',
    hint: 'Connect the Ledger over USB, unlock it, close Ledger Live, and open the Ravencoin app.',
  };
}

async function probeLedger(options = {}) {
  const expectedContext = options.expectedContext || 'current';
  if (!EXPECTED_CONTEXTS[expectedContext]) {
    throw new Error(`Unknown Ledger app context: ${expectedContext}`);
  }

  const devicePaths = await TransportNodeHid.list();
  const result = {
    expectedContext: EXPECTED_CONTEXTS[expectedContext],
    hidDetected: devicePaths.length > 0,
    hidDeviceCount: devicePaths.length,
    app: null,
    warnings: [],
    publicKeyResults: [],
    publicKeyExportWorks: false,
    error: null,
  };

  if (devicePaths.length === 0) {
    result.error = buildNoDeviceError();
    return result;
  }

  let transport;
  try {
    transport = await TransportNodeHid.open(devicePaths[0]);

    await detectOpenApp(transport, result, expectedContext);
    result.publicKeyResults = await readPublicKeys(transport);
    result.publicKeyExportWorks = result.publicKeyResults.some(item => item.ok);
  } catch (error) {
    result.error = describeLedgerError(error);
  } finally {
    await closeTransport(transport);
  }

  return result;
}

async function listLedgerAddressRequests(options = {}) {
  const expectedContext = options.expectedContext || 'ravencoin';
  if (!EXPECTED_CONTEXTS[expectedContext]) {
    throw new Error(`Unknown Ledger app context: ${expectedContext}`);
  }

  const addressRequests = options.requests || [];
  if (!Array.isArray(addressRequests) || addressRequests.length === 0) {
    throw new Error('At least one Ledger address request is required.');
  }

  const devicePaths = await TransportNodeHid.list();
  const result = {
    expectedContext: EXPECTED_CONTEXTS[expectedContext],
    hidDetected: devicePaths.length > 0,
    hidDeviceCount: devicePaths.length,
    app: null,
    warnings: [],
    addressResults: [],
    allMatch: false,
    error: null,
  };

  if (devicePaths.length === 0) {
    result.error = buildNoDeviceError();
    return result;
  }

  let transport;
  try {
    transport = await TransportNodeHid.open(devicePaths[0]);

    await detectOpenApp(transport, result, expectedContext);

    const publicKeyResults = await readPublicKeys(
      transport,
      addressRequests.map(item => item.path),
    );

    result.addressResults = publicKeyResults.map((item, offset) => {
      const request = addressRequests[offset];
      if (!item.ok) {
        return {
          ok: false,
          role: request.role || null,
          chain: request.chain,
          index: request.index,
          path: request.path,
          rvnAddress: null,
          ledgerAddress: null,
          matchesLedger: false,
          error: item.error,
        };
      }

      return {
        ok: true,
        role: request.role || null,
        chain: request.chain,
        index: request.index,
        path: request.path,
        rvnAddress: item.rvnAddress,
        ledgerAddress: item.ledgerAddress,
        matchesLedger: item.rvnAddress === item.ledgerAddress,
      };
    });

    result.allMatch = result.addressResults.length > 0 &&
      result.addressResults.every(item => item.ok && item.matchesLedger);
  } catch (error) {
    result.error = describeLedgerError(error);
  } finally {
    await closeTransport(transport);
  }

  return result;
}

async function listLedgerAddresses(options = {}) {
  const start = options.start ?? 0;
  const count = options.count ?? 10;
  const chains = addressChainsForMode(options.chain || 'receiving');
  const requests = chains.flatMap(chain => {
    return Array.from({ length: count }, (_, offset) => {
      const index = start + offset;
      return {
        chain,
        index,
        path: addressPathForIndex(index, chain),
      };
    });
  });

  return listLedgerAddressRequests({
    ...options,
    requests,
  });
}

async function verifyLedgerAddressOnDevice(path, expectedAddress) {
  const devicePaths = await TransportNodeHid.list();
  if (devicePaths.length === 0) {
    throw buildNoDeviceError();
  }

  let transport;
  try {
    transport = await TransportNodeHid.open(devicePaths[0]);
    const btc = new Btc({
      transport,
      currency: 'ravencoin',
    });
    const response = await btc.getWalletPublicKey(path, {
      format: 'legacy',
      verify: true,
    });
    const rvnAddress = deriveRvnP2pkhAddress(response.publicKey);

    return {
      path,
      rvnAddress,
      ledgerAddress: response.bitcoinAddress || null,
      matchesExpected: rvnAddress === expectedAddress,
      matchesLedger: rvnAddress === response.bitcoinAddress,
    };
  } catch (error) {
    throw describeLedgerError(error);
  } finally {
    await closeTransport(transport);
  }
}

module.exports = {
  ADDRESS_CHAINS,
  ADDRESS_CHAIN_MODES,
  EXPECTED_CONTEXTS,
  PROBE_PATHS,
  addressChainsForMode,
  addressPathForIndex,
  classifyAppContext,
  describeLedgerError,
  listLedgerAddressRequests,
  listLedgerAddresses,
  probeLedger,
  verifyLedgerAddressOnDevice,
};
