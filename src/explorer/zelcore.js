'use strict';

const axios = require('axios');
const config = require('../config');

const SATS_PER_RVN = 100000000n;
const RAW_TX_REQUIRED_MESSAGE = 'Zelcore rawtx endpoint did not return valid previous raw transaction hex required for Ledger signing.';
const ZELCORE_BROADCAST_PATH = '/tx/send';

class ExplorerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ExplorerError';
    this.statusCode = options.statusCode || null;
    this.endpoint = options.endpoint || null;
    this.responseBody = options.responseBody || null;
    this.provider = options.provider || null;
    this.hint = options.hint || 'Check src/config/index.js and confirm the Zelcore explorer is online.';
  }
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function joinUrl(baseUrl, path) {
  return `${trimTrailingSlash(baseUrl)}/${path.replace(/^\/+/, '')}`;
}

function malformed(message) {
  return new ExplorerError(`Malformed explorer response: ${message}`, {
    hint: 'The Zelcore explorer returned data that does not match the expected format.',
  });
}

function extractExplorerErrorDetail(data) {
  if (!data) {
    return null;
  }

  if (typeof data === 'string') {
    return data.slice(0, 500);
  }

  if (typeof data === 'object') {
    for (const key of ['error', 'message', 'rawtx', 'txid']) {
      if (typeof data[key] === 'string' && data[key].length > 0) {
        return data[key].slice(0, 500);
      }
    }
  }

  return null;
}

function formatResponseBody(data) {
  if (data === undefined || data === null) {
    return null;
  }

  if (typeof data === 'string') {
    return data.slice(0, 1000);
  }

  try {
    return JSON.stringify(data).slice(0, 1000);
  } catch {
    return String(data).slice(0, 1000);
  }
}

function describeBroadcastProvider() {
  return {
    key: 'zelcore',
    label: 'Zelcore broadcast endpoint',
    endpoint: joinUrl(config.ravencoin.explorerBaseUrl, ZELCORE_BROADCAST_PATH),
  };
}

function parseSats(value, fieldName, options = {}) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw malformed(`${fieldName} must be a safe integer number in satoshis.`);
    }

    if (!options.allowNegative && value < 0) {
      throw malformed(`${fieldName} cannot be negative.`);
    }

    return BigInt(value);
  }

  if (typeof value !== 'string') {
    throw malformed(`${fieldName} must be a string or safe integer number in satoshis.`);
  }

  const text = value.trim();
  if (!/^-?\d+$/.test(text)) {
    throw malformed(`${fieldName} must be an integer in satoshis.`);
  }

  if (!options.allowNegative && text.startsWith('-')) {
    throw malformed(`${fieldName} cannot be negative.`);
  }

  return BigInt(text);
}

function parseRvnDecimalToSats(value, fieldName, options = {}) {
  const text = String(value).trim();
  if (!/^-?(0|[1-9]\d*)(\.\d{1,8})?$/.test(text)) {
    throw malformed(`${fieldName} must be an RVN decimal value with up to 8 decimal places.`);
  }

  if (!options.allowNegative && text.startsWith('-')) {
    throw malformed(`${fieldName} cannot be negative.`);
  }

  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [wholePart, fractionalPart = ''] = unsigned.split('.');
  const sats = BigInt(wholePart) * SATS_PER_RVN +
    BigInt(fractionalPart.padEnd(8, '0'));

  return negative ? -sats : sats;
}

function parseZelcoreSats(data, satField, decimalField, options = {}) {
  if (data[satField] !== undefined && data[satField] !== null && data[satField] !== '') {
    return parseSats(data[satField], satField, options);
  }

  if (data[decimalField] !== undefined && data[decimalField] !== null && data[decimalField] !== '') {
    return parseRvnDecimalToSats(data[decimalField], decimalField, options);
  }

  throw malformed(`Zelcore response must include ${satField} or ${decimalField}.`);
}

function parseOptionalZelcoreSats(data, satField, decimalField, fallback, options = {}) {
  if (data[satField] === undefined || data[satField] === null || data[satField] === '') {
    if (data[decimalField] === undefined || data[decimalField] === null || data[decimalField] === '') {
      return fallback;
    }
  }

  return parseZelcoreSats(data, satField, decimalField, options);
}

function parseNonNegativeInteger(value, fieldName, fallback) {
  if (value === undefined || value === null || value === '') {
    if (arguments.length >= 3) {
      return fallback;
    }

    throw malformed(`${fieldName} is required.`);
  }

  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw malformed(`${fieldName} must be a non-negative integer.`);
  }

  return number;
}

function parseOptionalNonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    return fallback;
  }

  return number;
}

function parseOptionalAddressCount(data, fields) {
  for (const field of fields) {
    if (data[field] !== undefined && data[field] !== null && data[field] !== '') {
      return parseOptionalNonNegativeInteger(data[field], null);
    }
  }

  return null;
}

function normalizeZelcoreTxPage(data) {
  if (!data || typeof data !== 'object') {
    throw malformed('Zelcore txs response must be an object.');
  }

  if (!Array.isArray(data.txs)) {
    throw malformed('Zelcore txs response must include txs array.');
  }

  return {
    txs: data.txs,
    pagesTotal: parseNonNegativeInteger(data.pagesTotal, 'pagesTotal', 1),
  };
}

function outputAddresses(vout) {
  const scriptPubKey = vout && vout.scriptPubKey;
  if (scriptPubKey === undefined || scriptPubKey === null) {
    return [];
  }

  if (!scriptPubKey || typeof scriptPubKey !== 'object') {
    throw malformed('vout.scriptPubKey must be an object when present.');
  }

  if (scriptPubKey.addresses !== undefined && scriptPubKey.addresses !== null) {
    if (!Array.isArray(scriptPubKey.addresses) ||
      !scriptPubKey.addresses.every(address => typeof address === 'string')) {
      throw malformed('vout.scriptPubKey.addresses must be an array of strings.');
    }

    return scriptPubKey.addresses;
  }

  if (scriptPubKey.address !== undefined && scriptPubKey.address !== null) {
    if (typeof scriptPubKey.address !== 'string') {
      throw malformed('vout.scriptPubKey.address must be a string.');
    }

    return [scriptPubKey.address];
  }

  return [];
}

function isUnspentZelcoreOutput(vout) {
  return vout.spentTxId === undefined ||
    vout.spentTxId === null ||
    vout.spentTxId === '';
}

function parseZelcoreVoutValue(vout) {
  if (vout.valueSat !== undefined && vout.valueSat !== null && vout.valueSat !== '') {
    return parseSats(vout.valueSat, 'vout.valueSat');
  }

  if (vout.valueSats !== undefined && vout.valueSats !== null && vout.valueSats !== '') {
    return parseSats(vout.valueSats, 'vout.valueSats');
  }

  if (vout.value !== undefined && vout.value !== null && vout.value !== '') {
    return parseRvnDecimalToSats(vout.value, 'vout.value');
  }

  throw malformed('Zelcore vout must include valueSat or value.');
}

function normalizeZelcoreUtxos(address, txs) {
  const seen = new Set();
  const utxos = [];

  for (const tx of txs) {
    if (!tx || typeof tx !== 'object') {
      throw malformed('Zelcore tx entry must be an object.');
    }

    if (typeof tx.txid !== 'string' || tx.txid.length === 0) {
      throw malformed('Zelcore tx entry must include txid.');
    }

    if (!Array.isArray(tx.vout)) {
      continue;
    }

    const confirmations = parseOptionalNonNegativeInteger(tx.confirmations, 0);
    const height = confirmations > 0
      ? parseOptionalNonNegativeInteger(tx.blockheight, null)
      : null;

    for (const vout of tx.vout) {
      if (!vout || typeof vout !== 'object') {
        throw malformed('Zelcore vout entry must be an object.');
      }

      if (!outputAddresses(vout).includes(address) || !isUnspentZelcoreOutput(vout)) {
        continue;
      }

      const voutIndex = parseNonNegativeInteger(vout.n, 'vout.n');
      const key = `${tx.txid}:${voutIndex}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      utxos.push({
        txid: tx.txid,
        vout: voutIndex,
        valueSats: parseZelcoreVoutValue(vout),
        height,
        confirmations,
        coinbase: Boolean(tx.isCoinBase || tx.coinbase),
      });
    }
  }

  return utxos;
}

function validateRawTxHex(rawTx, message = 'Raw transaction hex must be a non-empty even-length hex string.') {
  if (typeof rawTx !== 'string' || rawTx.length === 0 || rawTx.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(rawTx)) {
    throw new ExplorerError(message);
  }
}

class ZelcoreExplorer {
  constructor(options = {}) {
    this.baseUrl = trimTrailingSlash(options.baseUrl || config.ravencoin.explorerBaseUrl);
    this.timeoutMs = options.timeoutMs || 15000;
    this.addressCache = new Map();
    this.utxoCache = new Map();
    this.rawTxCache = new Map();
  }

  async requestJson(method, endpoint, data, options = {}) {
    const headers = {
      accept: 'application/json',
      ...(options.headers || {}),
    };

    if (method === 'post') {
      headers['content-type'] = 'application/json';
    }

    try {
      const response = await axios({
        method,
        url: endpoint,
        data,
        timeout: this.timeoutMs,
        headers,
      });

      return response.data;
    } catch (error) {
      const statusCode = error && error.response ? error.response.status : null;
      const responseData = error && error.response ? error.response.data : null;
      const detail = extractExplorerErrorDetail(responseData);
      const responseBody = formatResponseBody(responseData);
      const provider = options.provider || 'Zelcore explorer';
      const defaultHint = options.hint || 'Check src/config/index.js and confirm the Zelcore explorer is online.';
      let message = `${provider} unavailable: ${endpoint}`;

      if (statusCode) {
        message = detail
          ? `${provider} request failed with HTTP ${statusCode}: ${endpoint}: ${detail}`
          : `${provider} request failed with HTTP ${statusCode}: ${endpoint}`;
      }

      throw new ExplorerError(message, {
        statusCode,
        endpoint,
        responseBody,
        provider,
        hint: defaultHint,
      });
    }
  }

  requestExplorerJson(method, path, data, options = {}) {
    return this.requestJson(method, joinUrl(this.baseUrl, path), data, {
      provider: options.provider || 'Zelcore explorer',
      hint: options.hint || 'Check src/config/index.js and confirm the Zelcore explorer is online.',
    });
  }

  async getUtxos(address) {
    if (this.utxoCache.has(address)) {
      return this.utxoCache.get(address);
    }

    const promise = (async () => {
      const firstPage = normalizeZelcoreTxPage(await this.requestExplorerJson(
        'get',
        `/txs?address=${encodeURIComponent(address)}&pageNum=0`,
      ));
      const txs = [...firstPage.txs];

      for (let pageNum = 1; pageNum < firstPage.pagesTotal; pageNum += 1) {
        const page = normalizeZelcoreTxPage(await this.requestExplorerJson(
          'get',
          `/txs?address=${encodeURIComponent(address)}&pageNum=${pageNum}`,
        ));
        txs.push(...page.txs);
      }

      const utxos = normalizeZelcoreUtxos(address, txs);
      this.utxoCache.set(address, utxos);
      return utxos;
    })().catch(error => {
      this.utxoCache.delete(address);
      throw error;
    });

    this.utxoCache.set(address, promise);
    return promise;
  }

  async getAddressBalance(address) {
    if (this.addressCache.has(address)) {
      return this.addressCache.get(address);
    }

    const promise = this.requestExplorerJson(
      'get',
      `/addr/${encodeURIComponent(address)}/?noTxList=1`,
    )
      .then(data => {
        if (!data || typeof data !== 'object') {
          throw malformed('Zelcore address response must be an object.');
        }

        const balance = {
          confirmedSats: parseZelcoreSats(data, 'balanceSat', 'balance'),
          unconfirmedSats: parseOptionalZelcoreSats(
            data,
            'unconfirmedBalanceSat',
            'unconfirmedBalance',
            0n,
            { allowNegative: true },
          ),
          txAppearances: parseOptionalAddressCount(data, ['txApperances', 'txAppearances']),
          unconfirmedTxAppearances: parseOptionalAddressCount(data, [
            'unconfirmedTxApperances',
            'unconfirmedTxAppearances',
          ]),
        };

        this.addressCache.set(address, balance);
        return balance;
      })
      .catch(error => {
        this.addressCache.delete(address);
        throw error;
      });

    this.addressCache.set(address, promise);
    return promise;
  }

  async getRawTransaction(txid) {
    if (this.rawTxCache.has(txid)) {
      return this.rawTxCache.get(txid);
    }

    const promise = this.requestExplorerJson(
      'get',
      `/rawtx/${encodeURIComponent(txid)}`,
      null,
      {
        provider: 'Zelcore rawtx endpoint',
        hint: 'Previous raw transaction hex is required for Ledger signing.',
      },
    )
      .then(data => {
        if (!data || typeof data !== 'object' || typeof data.rawtx !== 'string') {
          throw new ExplorerError(RAW_TX_REQUIRED_MESSAGE);
        }

        validateRawTxHex(data.rawtx, RAW_TX_REQUIRED_MESSAGE);
        this.rawTxCache.set(txid, data.rawtx);
        return data.rawtx;
      })
      .catch(error => {
        this.rawTxCache.delete(txid);
        throw error;
      });

    this.rawTxCache.set(txid, promise);
    return promise;
  }

  async broadcastRawTx(rawTx) {
    validateRawTxHex(rawTx);
    const endpoint = joinUrl(this.baseUrl, ZELCORE_BROADCAST_PATH);

    const data = await this.requestJson('post', endpoint, {
      rawtx: rawTx,
    }, {
      provider: 'Zelcore broadcast endpoint',
      hint: 'The signed transaction was not accepted by Zelcore or the Ravencoin network.',
    });

    if (!data || typeof data !== 'object' || typeof data.txid !== 'string' || data.txid.length === 0) {
      throw malformed('Zelcore broadcast response must include txid string.');
    }

    return data.txid;
  }

  clearCache() {
    this.addressCache.clear();
    this.utxoCache.clear();
    this.rawTxCache.clear();
  }
}

function createExplorer(options = {}) {
  return new ZelcoreExplorer(options);
}

async function broadcastRawTx(rawTx, options = {}) {
  const explorer = options.explorer || createExplorer();
  return explorer.broadcastRawTx(rawTx);
}

module.exports = {
  ExplorerError,
  ZelcoreExplorer,
  broadcastRawTx,
  createExplorer,
  describeBroadcastProvider,
  formatResponseBody,
  normalizeZelcoreUtxos,
  parseRvnDecimalToSats,
  parseSats,
};
