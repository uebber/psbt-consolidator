

**Final Specification: PSBT Consolidator CLI (v1.1)**

**1. Overview**

This document specifies the requirements for a Node.js Command Line Interface (CLI) application. The application's sole purpose is to generate a Partially Signed Bitcoin Transaction (PSBT) that consolidates funds from multiple sources within a Bitcoin Core wallet and distributes the net value evenly across multiple defined outputs.

The generated PSBT represents a transaction designed to precisely achieve the following:

*   Gather all available, confirmed UTXOs associated with a single specified `sourceAddress`.
*   Gather all available, confirmed UTXOs that are derived from one of the specified `targetDescriptors`, identified by matching against the `parent_descs` field provided directly by Bitcoin Core's `listunspent` command output.
*   Combine the total value from all gathered UTXOs.
*   Determine the next unused address for each `targetDescriptor` by querying Bitcoin Core using `listdescriptors`, `getdescriptorinfo`, and `deriveaddresses`.
*   Create exactly one new output UTXO for each `targetDescriptor`, directed to its pre-derived next unused address.
*   Deduct a transaction fee from the combined input value before distribution.
*   Distribute the remaining value perfectly evenly (in satoshis) across all target outputs.
*   Ensure the transaction fee is the absolute minimum possible integer value (in satoshis) that reliably meets the target confirmation goal (`feeTargetBlocks`) and absorbs any indivisible remainder from the even distribution, while adhering to a minimum network feerate, accounting for the estimated size of the final signed transaction including witness data.

The application MUST achieve this outcome by exclusively interacting with a running Bitcoin Core instance (version 24.0 or higher) via its JSON-RPC interface, leveraging Core's validated logic, internal state, and specific commands for accuracy, robustness, and performance.

**2. Core Objective: Generate Optimal Consolidation PSBT**

The application MUST produce a single, valid PSBT (Base64 encoded) representing a Bitcoin transaction adhering precisely to the following outcome requirements:

*   **Input Consolidation:** The transaction MUST spend:
    *   Every confirmed (>= 1 confirmation), spendable UTXO associated with the `sourceAddress` that is tracked by the `operatingWalletName` wallet in Bitcoin Core. This is determined using `listunspent` filtered by the `sourceAddress`.
    *   Every confirmed (>= 1 confirmation), spendable UTXO tracked by the `operatingWalletName` wallet whose `parent_descs` array (provided in the `listunspent` command output) contains at least one entry that exactly matches one of the `targetDescriptors` specified in the configuration file. UTXOs lacking a matching `parent_descs` entry MUST be excluded.
*   **Output Distribution:**
    *   The transaction MUST contain exactly N outputs, where N is the number of `targetDescriptors` provided.
    *   Each output MUST correspond to one unique `targetDescriptor`.
    *   Each output's scriptPubKey MUST correspond to the specific address derived by:
        1.  Querying Bitcoin Core's `listdescriptors` command (to find the `next_index` for the descriptor).
        2.  Constructing the specific derived descriptor path *without* a checksum (e.g., replacing `/*` with `/next_index`).
        3.  Calling `getdescriptorinfo` with the checksum-less path to obtain the full descriptor string *with the correct checksum*.
        4.  Calling `deriveaddresses` using the checksummed descriptor string from the previous step.
        This derivation MUST occur before constructing the transaction.
    *   The value (in integer satoshis) of each of the N outputs MUST be identical (`AmountPerOutput`).
*   **Value Conservation & Fee Optimization:**
    *   Let `TotalInputValue` be the sum of satoshis from all input UTXOs (integer `BigInt`).
    *   Let `FinalFee` be the total transaction fee in satoshis (integer `BigInt`).
    *   Let `NumTargets` be the number of `targetDescriptors` (integer).
    *   Let `NumInputs` be the number of input UTXOs being spent (integer).
    *   The fundamental balance equation MUST hold true: `TotalInputValue = (AmountPerOutput * NumTargets) + FinalFee`.
    *   The `FinalFee` MUST be the smallest possible positive integer (in satoshis) that simultaneously satisfies all conditions below:
        *   The resulting `AmountPerOutput = floor((TotalInputValue - FinalFee) / NumTargets)` must be calculable (i.e., `TotalInputValue >= FinalFee`) and positive (`AmountPerOutput > 0`).
        *   Let `BaseVBytes` be the virtual size (integer) of the transaction *excluding witness data*, determined accurately by using `decoderawtransaction` on a temporary raw transaction created via `createrawtransaction` (using the gathered inputs and `NumTargets` outputs each having the value `AmountPerOutput`, using the pre-derived addresses).
        *   Let `EstimatedWitnessVBytesPerInput` be a reasonable estimate of the vsize contribution per input from its witness data (e.g., 28 vBytes for P2WPKH, potentially configurable or based on analysis).
        *   Let `EstimatedFinalVBytes = BaseVBytes + (NumInputs * EstimatedWitnessVBytesPerInput)`. This represents the estimated virtual size of the *final, signed* transaction.
        *   Let `FeerateBTCperKvB` be the floating-point feerate obtained from Bitcoin Core's `estimatesmartfee` for `feeTargetBlocks` using `CONSERVATIVE` mode.
        *   Convert this feerate to satoshis per virtual byte (`FeerateSatPerVbyte`) using high-precision arithmetic (float or decimal library). `FeerateSatPerVbyte = (FeerateBTCperKvB / 1000) * 100_000_000`. Apply a floor: use a minimum value of 1.0 sat/vB if the calculated rate is lower. Store this intermediate rate with maximum possible precision.
        *   Calculate the size-based fee component: `SizeBasedFee = ceil(EstimatedFinalVBytes * FeerateSatPerVbyte)`. This calculation MUST use the high-precision `FeerateSatPerVbyte` (with the 1 sat/vB floor applied) and the integer `EstimatedFinalVBytes`, with the final result rounded up to the nearest whole satoshi (integer ceiling `BigInt`).
        *   Calculate the indivisible remainder from distribution: `RemainderSats = (TotalInputValue - FinalFee) % NumTargets` (integer `BigInt`).
        *   The core fee condition: The chosen `FinalFee` MUST satisfy `FinalFee >= SizeBasedFee + RemainderSats`.
        *   The implementation logic (e.g., iterative search) must ensure it finds the *absolute minimum* integer `FinalFee` satisfying all these conditions.
*   **No Change:**
    *   The transaction MUST NOT contain a change output.

**3. Bitcoin Core Interaction Philosophy and Mandates**

*   **Goal:** Utilize Bitcoin Core's capabilities for critical wallet operations (UTXO management, fee estimation, transaction finalization, address derivation) to maximize correctness, security, and performance, while minimizing the application's complexity and potential for error. Avoid redundant or potentially inaccurate logic reimplementation.
*   **Exclusive RPC:** All communication with Bitcoin Core MUST use its JSON-RPC interface, targeting the specific wallet context defined by `operatingWalletName` where applicable, or the node context for node-level commands.
*   **State Reliance (Pre-conditions):** The application MUST operate under these strict assumptions about the Bitcoin Core environment:
    *   Bitcoin Core version 24.0 or higher is running.
    *   The Bitcoin Core node is fully synchronized with the target network.
    *   The wallet specified by `operatingWalletName` is loaded and accessible via RPC.
    *   The wallet specified by `operatingWalletName` MUST be a descriptor wallet.
    *   The `sourceAddress` is already being watched or is part of an imported descriptor within the `operatingWalletName` wallet.
    *   All `targetDescriptors` are already imported and are being tracked (i.e., have a range and `next_index` available via `listdescriptors`) within the same `operatingWalletName` wallet.
*   **Mandatory Command Usage (Rationale):** The application MUST use the following commands for their specific purposes:
    *   `listunspent`:
        *   To query Core's database directly for confirmed, spendable UTXOs associated with the `sourceAddress`.
        *   To query Core's database for all UTXOs within the wallet to obtain candidate UTXOs along with their `parent_descs` field for filtering against `targetDescriptors`.
    *   `listdescriptors`: To query the state of known descriptors, specifically finding the `desc` string and `next_index` for each configured `targetDescriptor`.
    *   `getdescriptorinfo`: To obtain the correctly checksummed descriptor string for a *specific* derivation path (e.g., `.../0/123#checksum`) before deriving the address.
    *   `deriveaddresses`: To derive the specific Bitcoin address string from a correctly checksummed descriptor string representing a single derivation path.
    *   `estimatesmartfee`: To obtain the recommended feerate for the desired confirmation target (`feeTargetBlocks`, `CONSERVATIVE`).
    *   `createrawtransaction`: To assemble the basic *unsigned* transaction structure using the gathered inputs and the explicitly derived output addresses.
    *   `decoderawtransaction`: To determine the precise *base* virtual size (`vsize`, excluding witness data) of the candidate unsigned transaction. This base size is a component used for *estimating* the final transaction size needed for fee calculation.
    *   `converttopsbt`: To convert the raw transaction hex from `createrawtransaction` into the required PSBT format.
    *   `walletprocesspsbt`: Crucially, used with `sign=false`, `bip32derivs=true` on the PSBT. Purpose: To allow Core to populate input witness/script data placeholders, validate against wallet state, and embed BIP32 derivation information for inputs and outputs.
*   **Prohibited Actions:** The application MUST NOT perform: manual UTXO scanning, manual address derivation (using `deriveaddresses` based on Core state is permitted), manual checksum calculation, descriptor range scanning beyond required lookups, importing keys/addresses/descriptors, creating/loading wallets, or using deprecated scanning commands.

**4. Input and Configuration**

*   Configuration Source: Parameters MUST be provided via a single JSON file specified as a CLI argument.
*   JSON Configuration Parameters:
    ```json
    {
      "bitcoinCore": {
        "rpcUrl": "http://127.0.0.1:8332",
        "rpcUser": "your_rpc_user",
        "rpcPassword": "your_rpc_password",
        "network": "mainnet" | "testnet" | "regtest"
      },
      "sourceContext": {
        "operatingWalletName": "my_consolidating_wallet",
        "sourceAddress": "bc1q..."
      },
      "targetDescriptors": [
        "wpkh(tpub.../84'/0'/0'/0/*)#checksum1",
        "tr(tpub.../84'/0'/1'/0/*)#checksum2"
        // Each MUST be imported and tracked in 'operatingWalletName'
      ],
      "feeTargetBlocks": 50,
      "outputPsbtFile": "./consolidated_distribution.psbt",
      "logLevel": "info" | "debug" | "trace",
      // Optional configuration for witness size estimation
      "feeOptions": {
         "estimatedWitnessVBytesPerInput": 28 // Default if omitted. Adjust for non-P2WPKH inputs if needed.
      }
    }
    ```

**5. Processing Logic Summary (Focus on What)**

1.  **Initialize:** Validate the configuration (including optional `feeOptions`). Verify Bitcoin Core version >= 24.0 and descriptor wallet status via RPC. Establish and test RPC connection.
2.  **Discover Inputs:**
    *   Execute `listunspent` filtered by `sourceAddress` to gather its confirmed, spendable UTXOs. Store these.
    *   Execute `listunspent` with no filters to get all potentially relevant UTXOs.
    *   Iterate through the UTXOs from step 2, filter based on confirmations, spendable, and matching `parent_descs` against `targetDescriptors`. Add unique, matching UTXOs.
    *   Combine and deduplicate all found UTXOs. Store the final list of inputs and count `NumInputs`. Calculate `TotalInputValue`. Halt if no UTXOs or zero value.
3.  **Derive Output Addresses:**
    *   Call `listdescriptors` (`private: false`).
    *   Create a map: `Map<targetDescriptorString, derivedAddressString>`.
    *   For each `targetDescriptor`:
        *   Find the corresponding entry in `listdescriptors`. Halt if not found.
        *   Extract `next_index`. Halt if missing.
        *   Construct the specific derived descriptor path *without* checksum (e.g., replace `/*` with `/next_index`).
        *   Call `getdescriptorinfo` with this path to get the descriptor string *with the correct checksum*. Halt on error.
        *   Call `deriveaddresses` using the checksummed descriptor string. Halt on error.
        *   Extract the single address returned. Store it in the map.
4.  **Determine Optimal Fee & Distribution:**
    *   Retrieve the target feerate using `estimatesmartfee` and convert it to `FeerateSatPerVbyte` (sat/vB, high precision, >= 1.0).
    *   Implement logic (e.g., iterative search) to find the *minimum* positive integer `FinalFee` (`BigInt`). This involves repeatedly:
        *   Guessing a `FinalFee`.
        *   Calculating `AmountPerOutput = floor((TotalInputValue - FinalFee) / NumTargets)`. Ensure it's positive.
        *   Creating a temporary raw transaction hex using `createrawtransaction` with the current inputs and outputs (derived addresses with `AmountPerOutput`).
        *   Calculating `BaseVBytes` using `decoderawtransaction` on the temporary hex.
        *   Retrieving `EstimatedWitnessVBytesPerInput` from config (or default).
        *   Calculating `EstimatedFinalVBytes = BaseVBytes + (NumInputs * EstimatedWitnessVBytesPerInput)`.
        *   Calculating `SizeBasedFee = ceil(EstimatedFinalVBytes * FeerateSatPerVbyte)`.
        *   Calculating `RemainderSats = (TotalInputValue - FinalFee) % NumTargets`.
        *   Checking if the guessed `FinalFee >= SizeBasedFee + RemainderSats`.
        *   Adjusting the guess (typically setting the next guess to `SizeBasedFee + RemainderSats`) and repeating until the condition is met exactly or the minimum fee stabilizes.
    *   Calculate the definitive final `AmountPerOutput`.
    *   Halt with error if no valid fee/distribution can be found (e.g., insufficient funds, convergence failure).
5.  **Construct Final PSBT:**
    *   Use `createrawtransaction` with all gathered input UTXOs and the final `AmountPerOutput` assigned to each pre-derived output address.
    *   Convert the resulting raw hex to PSBT format via `converttopsbt`.
    *   Execute `walletprocesspsbt` (`sign=false`, `bip32derivs=true`) allowing Bitcoin Core to add necessary wallet data. Store the resulting Base64 PSBT string. Handle errors.
6.  **Output:** Save the final Base64 PSBT string to the `outputPsbtFile`. Display a clear summary: path, wallet, source, total input value, final fee (and breakdown if possible based on final estimated size/remainder), amount per output, number of inputs/outputs, targets/addresses, and instructions.

**6. Implementation Requirements**

*   **Technology:** Node.js (version >= 18.x recommended). Use `fetch` or RPC library. **MUST use `BigInt` for all satoshi values.** Use `Number` (float) carefully or a high-precision library (`Decimal.js`) for feerate conversions.
*   **Units:** Internal logic uses `BigInt` satoshis. Convert only for RPC calls requiring decimal BTC. Handle feerate conversions precisely with the 1 sat/vB floor.
*   **Logging:** Implement `info`/`debug`/`trace` levels controlled by `logLevel` config. Mask credentials.
*   **Error Handling:** Comprehensive, specific error handling for config, RPC, Core commands, insufficient funds, fee determination failure, derivation failure, file system errors, unmet preconditions. Clear feedback, non-zero exit code on failure.
*   **Witness Estimation:** Use the configured or default `estimatedWitnessVBytesPerInput` in fee calculations.

**7. Exclusions**

*   No signing.
*   No broadcasting.
*   No dust limit checks (assumed handled externally or by Core).
*   No wallet lifecycle management.
*   No importing keys/addresses/descriptors.
*   No GUI.
