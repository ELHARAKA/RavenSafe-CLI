# RavenSafe CLI

![RavenSafe CLI brand identity](assets/ravensafe-cli-brand.png)

RavenSafe CLI is a guided Ravencoin wallet helper for Ledger devices. It helps you scan balances, receive RVN, send RVN, sign on the Ledger, and broadcast through a focused terminal workflow without exposing your recovery phrase.

## Why This Exists

RavenSafe CLI was built after practical issues sending RVN with Electrum-RVN while using a Ledger device. Electrum-RVN is an important community project, but its GitHub repository is now archived and read-only, so some users may need a simpler working path for Ledger-based RVN operations.

This project is not a replacement for every wallet use case. It is a focused Ledger/RVN helper for users who want a guided flow for scanning, receiving, sending, signing, and broadcasting RVN.

Reference: <https://github.com/Electrum-RVN-SIG/electrum-ravencoin/>

## Core Safety Promise

- RavenSafe CLI never asks for your Ledger recovery phrase.
- RavenSafe CLI never imports private keys.
- The Ledger remains the signer.
- Sending requires explicit confirmation in the terminal and approval on the Ledger.
- Always verify the destination address and amount on the Ledger screen.
- Use at your own risk.
- Test with a small amount first.

## Features

- Guided wallet menu for normal use.
- Balance scanning for Ledger-derived RVN addresses.
- Receive-address discovery using receiving addresses only.
- Optional on-device verification for receive addresses.
- Guided RVN sending with a clear summary before signing.
- Automatic broadcast after a successful guided send.
- Help and safety notes inside the CLI.
- Informational Support / Donate screen.

## Requirements

- Node.js
- A Ledger device with the Ravencoin app installed
- USB access to the Ledger
- Internet access for public Ravencoin explorer lookups and broadcasts

Before using guided mode:

1. Close Ledger Live.
2. Connect and unlock the Ledger.
3. Open the Ravencoin app on the Ledger.

## Quick Start

Install dependencies once:

```sh
npm install
```

Start the guided CLI:

```sh
node RavenSafe.js
```

## Guided Usage

The normal workflow starts with:

```sh
node RavenSafe.js
```

The guided menu provides:

```text
1. Scan wallet balances
2. Send RVN
3. Receive RVN
4. Help / safety notes
5. Support / Donate
6. Exit
```

### 1. Scan Wallet Balances

Checks Ledger-derived receiving and change addresses, reads public blockchain data, and shows balances and UTXO counts. This does not sign, send, or broadcast anything.

### 2. Send RVN

Guides you through destination, amount, fee choice, transaction review, Ledger signing, and broadcast. Nothing is signed until you type `SIGN`, and the Ledger must still approve the transaction.

### 3. Receive RVN

Finds an unused receiving address and displays it. You can optionally verify the address on the Ledger screen.

### 4. Help / Safety Notes

Shows reminders for safe Ledger use, including keeping the Ravencoin app open and verifying transaction details before approval.

### 5. Support / Donate

Shows the RVN donation address and explorer link. This option is informational only and does not trigger Ledger access, scanning, signing, sending, or broadcasting.

## Safety Notes

- Never type your recovery phrase into any computer, website, terminal, wallet, or support chat.
- Confirm the Ledger screen matches the amount and destination you intended.
- Start with a small test send before moving larger balances.
- Treat broadcast as final once confirmed by the network.
- Keep Ledger Live and other wallet apps closed while RavenSafe CLI is using the Ledger.

## Limitations

- RavenSafe CLI is intentionally focused on Ledger-backed RVN wallet operations.
- It expects standard Ledger-derived Ravencoin addresses.
- It depends on the configured public explorer being reachable.
- It is a command-line tool, not a full graphical wallet.
- It does not manage recovery phrases, private keys, staking, assets, or exchange features.

## Support / Donate

RVN donations are optional:

```text
RYW4QozWJtmSipDAzXVJk2nyxRbY1fppbv
```

Explorer:

```text
https://explorer.rvn.zelcore.io/address/RYW4QozWJtmSipDAzXVJk2nyxRbY1fppbv
```

## Advanced Commands

Guided mode is the recommended path:

```sh
node RavenSafe.js
```

Advanced commands still exist for users who need command-mode address listing, scanning, dry-run send planning, signing, manual broadcast, or Ledger probing:

```sh
node RavenSafe.js --help
```

For technical details, command examples, derivation paths, explorer endpoints, transaction flow, and troubleshooting, see [Docs.md](Docs.md).
