# RavenSafe CLI Technical Docs

This document is the technical and advanced reference for RavenSafe CLI. Normal users should start with guided mode in [README.md](README.md).

## npm Usage

Run the published package without installing:

```sh
npx ravensafe-cli
```

Install globally:

```sh
npm install -g ravensafe-cli
ravensafe
```

The global install exposes both command names:

```sh
ravensafe
ravensafe-cli
```

Show command help:

```sh
ravensafe --help
ravensafe-cli --help
```

## Local Development Usage

Clone and run from source:

```sh
git clone https://github.com/ELHARAKA/RavenSafe-CLI.git
cd RavenSafe-CLI
npm install
node RavenSafe.js
```

Local help:

```sh
node RavenSafe.js --help
```

Run the safe syntax check:

```sh
npm run check
```

## Architecture

- `RavenSafe.js` is the public executable entry point.
- `cli.js` is a compatibility shim.
- `src/RavenSafe.js` wires guided mode and command-mode actions.
- `src/interactive/` contains the guided wallet UI and menu flow.
- `src/ledger/` handles Ledger transport, app checks, public-key requests, and address verification.
- `src/core/` contains scan, address, network, and session-cache helpers.
- `src/explorer/zelcore.js` adapts Zelcore explorer responses for balances, UTXOs, raw transactions, and broadcast.
- `src/tx/` contains transaction planning and Ledger signing support.
- `src/config/index.js` contains public runtime defaults and branding constants.
- `tools/probe-ledger.js` is a diagnostic public-key export probe.

## Folder Structure

```text
RavenSafe.js
cli.js
src/
  RavenSafe.js
  config/
  core/
  explorer/
  interactive/
  ledger/
  tx/
tools/
  probe-ledger.js
README.md
Docs.md
LICENSE
```

## Runtime Config

Runtime defaults live in `src/config/index.js`.

Current public defaults include:

```js
ravencoin: {
  explorerBaseUrl: 'https://explorer.rvn.zelcore.io/api',
  feeRateSatPerByte: 1000,
  dustSats: 546,
  defaultChangeIndex: 0,
  scan: {
    balanceReceivingMaxIndex: 50,
    balanceChangeMaxIndex: 20,
    receiveMaxIndex: 100
  }
}
```

Branding constants also live in `src/config/index.js`, including the RVN donation address and explorer link used by startup UI and Support / Donate.

## Ledger Derivation Paths

RavenSafe CLI uses Ravencoin coin type `175`.

Receiving addresses:

```text
m/44'/175'/0'/0/INDEX
```

Change addresses:

```text
m/44'/175'/0'/1/INDEX
```

The diagnostic probe reads these paths:

```text
m/44'/175'/0'/0/0
m/44'/175'/0'/0/1
m/44'/175'/0'/0/2
m/44'/175'/175'/0/0
```

For each path, the probe prints the derivation path, public key, chain code if returned by the Ledger, Ledger-returned address if available, and locally derived Ravencoin mainnet P2PKH address.

## Zelcore Explorer Adapter

The explorer backend is isolated in `src/explorer/zelcore.js`.

Expected Zelcore endpoints:

- `GET /addr/ADDRESS/?noTxList=1` for confirmed and unconfirmed balance.
- `GET /txs?address=ADDRESS&pageNum=PAGE` for transaction pages used to construct UTXOs.
- `GET /rawtx/TXID` for previous raw transaction hex required by Ledger signing.
- `POST /tx/send` for signed raw transaction broadcast with JSON body `{ "rawtx": "RAW_TX_HEX" }`.

Zelcore `/txs` returns transaction pages, so RavenSafe CLI constructs UTXOs by selecting unspent `vout` entries whose `scriptPubKey.addresses` contains the scanned address. Previous raw transaction hex is fetched from Zelcore `/rawtx/TXID` and is not reconstructed.

## Scan Ranges

Guided balance scan presets:

- Quick scan: receiving indexes `0-15`, change indexes `0-5`.
- Standard scan: receiving indexes `0-40`, change indexes `0-10`.
- Deep scan: receiving indexes `0-70`, change indexes `0-30`.
- Custom scan: accepts ranges such as `0-30`, `3-19`, or `100-150`.

Receive RVN searches receiving addresses and checks additional receiving indexes only when needed, up to the configured receive maximum.

Command-mode defaults:

- `addresses`: start index `0`, count `10`, max count `100`.
- `scan`: start index `0`, count `10`, max count `200`, default chain `receiving`.
- Normal app context is `ravencoin`.

## Guided Transaction Flow

Guided Send RVN:

1. Prompts for destination, amount, and fee choice.
2. Reuses the current session scan cache when available.
3. Checks the quick scan range if needed.
4. Selects suitable confirmed UTXOs.
5. Shows a human-readable summary with amount, destination, source, estimated fee, and change details.
6. Requires typing exactly `SIGN`.
7. Calls Ledger signing only after terminal confirmation.
8. Requires approval on the Ledger device.
9. Broadcasts automatically after successful guided signing.
10. Prints the TXID and explorer link on success.

If signing fails or the Ledger rejects the request, nothing is broadcast.

## Advanced Commands

Guided mode remains the primary path:

```sh
ravensafe
```

Use local source examples with `node RavenSafe.js`. With a global npm install, replace `node RavenSafe.js` with `ravensafe` or `ravensafe-cli`.

### Address Listing

List Ledger-derived receiving addresses:

```sh
node RavenSafe.js addresses --start 0 --count 10 --app ravencoin
```

Global equivalent:

```sh
ravensafe addresses --start 0 --count 10 --app ravencoin
```

Options:

- `--start NUMBER` defaults to `0`.
- `--count NUMBER` defaults to `10` and must be between `1` and `100`.
- `--app CONTEXT` defaults to `ravencoin`; supported contexts are `current`, `ravencoin`, and `bitcoin`.

The command prints index, derivation path, locally derived RVN address, Ledger-returned address, and match status.

### Balance Scan

Scan receiving addresses:

```sh
node RavenSafe.js scan --chain receiving --start 0 --count 10 --app ravencoin
```

Scan both receiving and change chains:

```sh
node RavenSafe.js scan --chain both --start 0 --count 3 --app ravencoin
```

Global equivalent:

```sh
ravensafe scan --chain both --start 0 --count 3 --app ravencoin
```

Options:

- `--start NUMBER` defaults to `0`.
- `--count NUMBER` defaults to `10` and must be between `1` and `200`.
- `--chain receiving|change|both` defaults to `receiving`.
- `--app CONTEXT` defaults to `ravencoin`.

The scan command reads public keys from the Ledger, derives RVN addresses locally, checks Ledger-returned address matches, fetches public balance and UTXO data, and prints totals. It does not sign, send, build transactions, or broadcast.

### Dry-Run Send Planner

Prepare a transaction plan from one Ledger-derived source address:

```sh
node RavenSafe.js send --from-chain receiving --from-index 0 --to DESTINATION_RVN_ADDRESS --amount AMOUNT_RVN
```

Global equivalent:

```sh
ravensafe send --from-chain receiving --from-index 0 --to DESTINATION_RVN_ADDRESS --amount AMOUNT_RVN
```

Options:

- `--from-chain receiving|change` defaults to `receiving`.
- `--from-index NUMBER` is required.
- `--to DESTINATION_RVN_ADDRESS` is required and must be a Ravencoin mainnet P2PKH or P2SH address.
- `--amount AMOUNT_RVN` is required and must be greater than `0`.
- `--fee-rate SATS_PER_BYTE` defaults to `config.ravencoin.feeRateSatPerByte`.
- `--change-chain receiving|change` defaults to `change`.
- `--change-index NUMBER` defaults to `config.ravencoin.defaultChangeIndex`.
- `--app CONTEXT` defaults to `ravencoin`.
- `--dry-run` is enabled by default.
- `--sign` asks for `SIGN` confirmation and calls Ledger signing after review.

Without `--sign`, the command prints a dry-run plan and does not sign or broadcast.

With `--sign`, the command signs only after exact terminal confirmation and Ledger approval. Command-mode signing prints the signed raw transaction and locally derived TXID, but does not broadcast.

### Manual Broadcast

Broadcast raw signed transaction hex directly:

```sh
node RavenSafe.js broadcast --rawtx RAW_TX_HEX
```

Or read raw hex from a local file:

```sh
node RavenSafe.js broadcast --file signed-tx.hex
```

Global equivalent:

```sh
ravensafe broadcast --rawtx RAW_TX_HEX
```

Rules:

- Exactly one of `--rawtx` or `--file` is required.
- The raw transaction must be non-empty even-length hex.
- The CLI decodes the transaction locally and prints TXID, estimated bytes, input count, and output count.
- The CLI prints an irreversible-broadcast warning.
- Broadcasting only happens after typing exactly `BROADCAST`.
- If confirmation is not exact, nothing is broadcast.

### Ledger Probe

Run the diagnostic probe from a local source checkout:

```sh
node tools/probe-ledger.js --app ravencoin
```

The probe reads public information only. It does not sign, send, or broadcast.

## Security Model

- The Ledger is the only signer.
- Recovery phrases and private keys are never requested.
- Addresses are derived locally from Ledger-returned public keys.
- Ledger-returned addresses are compared with locally derived RVN addresses.
- Balance and UTXO discovery use public explorer data.
- Signing requires explicit terminal confirmation and device approval.
- Guided-mode broadcast only follows successful guided signing.
- Command-mode broadcast requires exact `BROADCAST` confirmation.

## Troubleshooting

Ledger cannot be found:

- Confirm the Ledger is connected over USB.
- Unlock the Ledger.
- Close Ledger Live and other wallet software.
- Open the Ravencoin app on the Ledger.

Ledger app mismatch:

- Open the Ravencoin app and retry.
- Use `--app ravencoin` for normal RVN operations.
- Use `--app current` only for diagnostics.

Explorer errors:

- Check internet connectivity.
- Retry later if the public explorer is unavailable.
- Confirm the endpoint in `src/config/index.js`.

Insufficient funds:

- Run guided balance scan first.
- Try a broader scan range.
- Check whether funds are on a change address.
- Test with a smaller amount.

Signing rejected:

- Review the Ledger screen carefully.
- Rejecting on the device is safe; nothing is broadcast.
- Restart guided mode and retry only if the transaction details are correct.

## Developer Notes

- Keep guided mode as the primary user path.
- Keep advanced command behavior conservative.
- Do not couple informational screens to Ledger, scan, signing, send, or broadcast paths.
- Keep public defaults and branding constants centralized in `src/config/index.js`.
- For docs-only changes, use safe checks such as `npm run check` or `node RavenSafe.js --help`.
