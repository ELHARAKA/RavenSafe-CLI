'use strict';

function cacheKey(chain, index) {
  return `${chain}:${index}`;
}

function cloneUtxos(utxos) {
  if (!Array.isArray(utxos)) {
    return [];
  }

  return utxos.map(utxo => ({
    ...utxo,
  }));
}

function normalizeSats(value) {
  return typeof value === 'bigint' ? value : 0n;
}

class SessionAddressCache {
  constructor() {
    this.addresses = new Map();
  }

  get size() {
    return this.addresses.size;
  }

  hasAny() {
    return this.addresses.size > 0;
  }

  clear() {
    this.addresses.clear();
  }

  key(chain, index) {
    return cacheKey(chain, index);
  }

  get(chain, index) {
    return this.addresses.get(this.key(chain, index)) || null;
  }

  set(item) {
    const address = item.rvnAddress || item.address;
    const utxos = cloneUtxos(item.utxos);
    const entry = {
      chain: item.chain,
      index: item.index,
      path: item.path,
      address,
      rvnAddress: address,
      ledgerAddress: item.ledgerAddress || null,
      matchesLedger: item.matchesLedger !== false,
      confirmedSats: normalizeSats(item.confirmedSats),
      unconfirmedSats: normalizeSats(item.unconfirmedSats),
      utxos,
      utxoCount: Number.isSafeInteger(item.utxoCount) ? item.utxoCount : utxos.length,
      txAppearances: Number.isSafeInteger(item.txAppearances) ? item.txAppearances : null,
      unconfirmedTxAppearances: Number.isSafeInteger(item.unconfirmedTxAppearances)
        ? item.unconfirmedTxAppearances
        : null,
      balanceSource: item.balanceSource || null,
      balanceError: item.balanceError || null,
      ok: item.ok !== false,
      error: item.error || null,
      refreshedAt: Date.now(),
    };

    this.addresses.set(this.key(entry.chain, entry.index), entry);
    return entry;
  }

  upsertScanItem(item) {
    if (!item || !item.ok || !item.matchesLedger || !item.rvnAddress) {
      return null;
    }

    return this.set(item);
  }

  updateBalance(chain, index, balance) {
    const existing = this.get(chain, index);
    if (!existing) {
      throw new Error(`Cannot refresh uncached address ${chain}:${index}.`);
    }

    return this.set({
      ...existing,
      confirmedSats: balance.confirmedSats,
      unconfirmedSats: balance.unconfirmedSats,
      utxos: balance.utxos,
      utxoCount: balance.utxoCount,
      txAppearances: balance.txAppearances,
      unconfirmedTxAppearances: balance.unconfirmedTxAppearances,
      balanceSource: balance.balanceSource,
      balanceError: balance.balanceError,
      ok: true,
      error: null,
    });
  }

  updateUsage(chain, index, balance) {
    const existing = this.get(chain, index);
    if (!existing) {
      throw new Error(`Cannot refresh uncached address ${chain}:${index}.`);
    }

    return this.set({
      ...existing,
      confirmedSats: balance.confirmedSats,
      unconfirmedSats: balance.unconfirmedSats,
      txAppearances: balance.txAppearances,
      unconfirmedTxAppearances: balance.unconfirmedTxAppearances,
      balanceSource: balance.balanceSource,
      balanceError: balance.balanceError,
      ok: true,
      error: null,
    });
  }

  values() {
    return [...this.addresses.values()];
  }

  toScanItem(entry) {
    return {
      chain: entry.chain,
      index: entry.index,
      path: entry.path,
      rvnAddress: entry.address,
      ledgerAddress: entry.ledgerAddress,
      matchesLedger: entry.matchesLedger,
      confirmedSats: entry.confirmedSats,
      unconfirmedSats: entry.unconfirmedSats,
      utxos: cloneUtxos(entry.utxos),
      utxoCount: entry.utxoCount,
      txAppearances: entry.txAppearances,
      unconfirmedTxAppearances: entry.unconfirmedTxAppearances,
      balanceSource: entry.balanceSource,
      balanceError: entry.balanceError,
      ok: entry.ok,
      error: entry.error,
    };
  }
}

function createSessionCache() {
  return new SessionAddressCache();
}

module.exports = {
  SessionAddressCache,
  cacheKey,
  createSessionCache,
};
