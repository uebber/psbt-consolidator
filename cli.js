#!/usr/bin/env node
// cli.js
import fs from 'fs/promises';
import path from 'path';
import logger from './logger.js';
import { makeRpcCall } from './rpcClient.js';
import {
    checkCoreVersion,
    checkWalletIsDescriptor,
    listSourceUtxos,
    listWalletUtxos,
    filterTargetUtxos,
    deriveOutputAddresses,
    estimateFeeRate,
    createRawTx,
    convertToPsbt,
    processPsbt,
    decodeRawTx // <--- FIX: Import decodeRawTx here
} from './bitcoinCoreUtils.js';
import { calculateOptimalFee } from './feeCalculator.js';
import { btcToSats, satsToBtcString, convertFeeRateToSatPerVb, SATS_PER_BTC, ceilToBigInt } from './utils.js'; // Import ceilToBigInt
import Decimal from 'decimal.js';


// --- Configuration Validation ---
function validateConfig(config) {
    if (!config) throw new Error("Configuration is missing.");
    if (!config.bitcoinCore?.rpcUrl) throw new Error("Missing bitcoinCore.rpcUrl in config.");
    if (typeof config.bitcoinCore.rpcUser !== 'string') logger.warn("bitcoinCore.rpcUser is not a string or missing.");
    if (typeof config.bitcoinCore.rpcPassword !== 'string') logger.warn("bitcoinCore.rpcPassword is not a string or missing.");
    if (!['mainnet', 'testnet', 'regtest'].includes(config.bitcoinCore.network)) throw new Error("Invalid bitcoinCore.network value.");
    if (!config.sourceContext?.operatingWalletName) throw new Error("Missing sourceContext.operatingWalletName.");
    if (!config.sourceContext?.sourceAddress) throw new Error("Missing sourceContext.sourceAddress.");
    if (!Array.isArray(config.targetDescriptors) || config.targetDescriptors.length === 0) throw new Error("targetDescriptors must be a non-empty array.");
    if (!Number.isInteger(config.feeTargetBlocks) || config.feeTargetBlocks <= 0) throw new Error("feeTargetBlocks must be a positive integer.");
    if (!config.outputPsbtFile) throw new Error("Missing outputPsbtFile path.");
    if (config.logLevel && !['trace', 'debug', 'info', 'warn', 'error'].includes(config.logLevel)) {
         logger.warn(`Invalid logLevel '${config.logLevel}', using default 'info'.`);
         config.logLevel = 'info'; // Default if invalid
    }

    // Validate descriptor format superficially (presence of #checksum and /*)
    for (const desc of config.targetDescriptors) {
        if (typeof desc !== 'string' || !desc.includes('#') || !desc.includes('/*')) {
            throw new Error(`Invalid target descriptor format: "${desc}". Must be a string including a checksum (#...) and wildcard derivation (/*).`);
        }
    }

    // Validate optional feeOptions
    if (config.feeOptions) {
        if (config.feeOptions.estimatedWitnessVBytesPerInput !== undefined) {
            if (!Number.isInteger(config.feeOptions.estimatedWitnessVBytesPerInput) || config.feeOptions.estimatedWitnessVBytesPerInput < 0) {
                throw new Error("Invalid feeOptions.estimatedWitnessVBytesPerInput: must be a non-negative integer.");
            }
        }
    }

    logger.debug("Configuration validated successfully.");
}


// --- Main Application Logic ---
async function runConsolidator(configFilePath) {
    let config;
    try {
        logger.info(`Loading configuration from: ${configFilePath}`);
        const configFileContent = await fs.readFile(configFilePath, 'utf-8');
        config = JSON.parse(configFileContent);
        validateConfig(config);
        logger.setLogLevel(config.logLevel || 'info'); // Set log level from config
        logger.debug("Configuration loaded:", config);

    } catch (error) {
        logger.error(`Failed to load or validate configuration: ${error.message}`);
        process.exit(1);
    }

    // --- Determine Witness VBytes Estimate ---
    // Use value from config if provided, otherwise use a default (as specified in feeCalculator)
    // This ensures consistency between cli.js summary and feeCalculator logic.
    const ESTIMATED_WITNESS_VBYTES_PER_INPUT = config.feeOptions?.estimatedWitnessVBytesPerInput ?? 28; // Default to 28 if not in config
    logger.info(`Using estimated witness size: ${ESTIMATED_WITNESS_VBYTES_PER_INPUT} vBytes/input for calculations and summary.`);
    // Add this resolved value back into the config object for easy passing to feeCalculator
    config.feeOptions = {
        ...config.feeOptions, // Keep other potential fee options
        estimatedWitnessVBytesPerInput: ESTIMATED_WITNESS_VBYTES_PER_INPUT
    };
    // --- End Witness VBytes Estimate ---

    try {
        // 1. Initial Checks
        logger.info("Performing initial Bitcoin Core checks...");
        await makeRpcCall(config, 'echo', ['Connection test successful!']); // Basic connectivity test
        await checkCoreVersion(config);
        await checkWalletIsDescriptor(config);
        logger.info("Bitcoin Core checks passed.");

        // 2. Discover Inputs
        logger.info("Discovering input UTXOs...");
        const sourceUtxos = await listSourceUtxos(config);
        const allWalletUtxos = await listWalletUtxos(config);
        const targetUtxos = filterTargetUtxos(allWalletUtxos, config.targetDescriptors);

        // Combine and deduplicate UTXOs
        const utxoMap = new Map(); // Use Map<txid:vout, utxoObject> for deduplication
        [...sourceUtxos, ...targetUtxos].forEach(utxo => {
            const key = `${utxo.txid}:${utxo.vout}`;
            if (!utxoMap.has(key)) {
                utxoMap.set(key, utxo);
            } else {
                 logger.trace(`Duplicate UTXO found and skipped: ${key}`);
            }
        });

        const finalInputs = Array.from(utxoMap.values());
        if (finalInputs.length === 0) {
            throw new Error("No spendable, confirmed UTXOs found for the source address or matching target descriptors.");
        }
        const numInputs = finalInputs.length; // Store NumInputs
        logger.info(`Found a total of ${numInputs} unique UTXOs to consolidate.`);
        logger.trace("Final unique input UTXOs:", finalInputs);


        const totalInputValue = finalInputs.reduce((sum, utxo) => sum + utxo.amount, 0n); // Sum using BigInt
        logger.info(`Total input value: ${totalInputValue} sats (${satsToBtcString(totalInputValue)} BTC)`);
        if (totalInputValue <= 0n) {
             throw new Error("Total value of discovered UTXOs is zero or negative.");
        }


        // 3. Derive Output Addresses
        logger.info("Deriving target output addresses...");
        // derivedAddresses: Map<targetDescriptorString, derivedAddressString>
        const derivedAddresses = await deriveOutputAddresses(config);
        if (derivedAddresses.size !== config.targetDescriptors.length) {
             throw new Error(`Internal Error: Mismatch - Expected ${config.targetDescriptors.length} derived addresses, but got ${derivedAddresses.size}.`);
        }
         logger.info(`Successfully derived ${derivedAddresses.size} output addresses.`);


        // 4. Determine Optimal Fee & Distribution
        logger.info("Calculating optimal fee and distribution...");
        const estimatedFeeRateBtcPerKvB = await estimateFeeRate(config);
        const feeRateSatPerVbyte = convertFeeRateToSatPerVb(estimatedFeeRateBtcPerKvB); // Returns Decimal, >= 1.0

        const inputsForTx = finalInputs.map(utxo => ({ txid: utxo.txid, vout: utxo.vout }));

        // Pass the main config object (including resolved feeOptions) to the fee calculator
        const { finalFee, amountPerOutput } = await calculateOptimalFee(
            config,             // Pass full config including feeOptions
            config,             // Duplicate argument for RPC client config source
            inputsForTx,
            derivedAddresses,   // The Map<descriptor, address>
            totalInputValue,    // BigInt
            feeRateSatPerVbyte  // Decimal
        );
        // finalFee and amountPerOutput are BigInt


        // 5. Construct Final PSBT
        logger.info("Constructing final transaction and PSBT...");
        // Prepare outputs object: { address: amountBTCString, ... }
        const outputsForTx = {};
        const amountBtcString = satsToBtcString(amountPerOutput);
        for (const address of derivedAddresses.values()) {
             outputsForTx[address] = amountBtcString;
        }

        logger.debug("Creating final raw transaction...", { inputsForTx, outputsForTx });
        const finalRawTxHex = await createRawTx(config, inputsForTx, outputsForTx); // Store this hex

        logger.debug("Converting final raw transaction to PSBT...");
        const initialPsbt = await convertToPsbt(config, finalRawTxHex);

        logger.info("Processing PSBT with wallet data (derivation paths)...");
        const finalPsbtBase64 = await processPsbt(config, initialPsbt);


        // 6. Output
        const outputFilePath = path.resolve(config.outputPsbtFile); // Resolve to absolute path
        logger.info(`Saving final PSBT to: ${outputFilePath}`);
        await fs.writeFile(outputFilePath, finalPsbtBase64, 'utf-8');

        // --- Display Summary ---
        console.log("\n--- PSBT Consolidation Summary ---");
        console.log(`Operating Wallet:  ${config.sourceContext.operatingWalletName}`);
        console.log(`Source Address:    ${config.sourceContext.sourceAddress}`);
        console.log(`Target Descriptors:${config.targetDescriptors.length > 0 ? '' : ' (None Specified)'}`);
        config.targetDescriptors.forEach((desc, i) => console.log(`  [${i+1}] ${desc} -> ${derivedAddresses.get(desc)}`));
        console.log(`------------------------------------`);
        console.log(`Inputs Found:      ${numInputs}`);
        console.log(`Total Input Value: ${totalInputValue} sats (${satsToBtcString(totalInputValue)} BTC)`);
        console.log(`------------------------------------`);
        console.log(`Outputs Created:   ${derivedAddresses.size}`);
        console.log(`Amount Per Output: ${amountPerOutput} sats (${satsToBtcString(amountPerOutput)} BTC)`);
        console.log(`Total Output Value:${amountPerOutput * BigInt(derivedAddresses.size)} sats`);
        console.log(`Final Fee:         ${finalFee} sats`);

        // --- Fee Breakdown Calculation for Summary ---
        let sizeBasedFeeDisplay = 'N/A';
        let remainderFeeDisplay = 'N/A';
        let estimatedVBytesDisplay = 'N/A';
        try {
            // Use the *final* rawTxHex created just before PSBT generation
            // Use the imported decodeRawTx function
            const decodedFinalTx = await decodeRawTx(config, finalRawTxHex);
            const finalBaseVBytes = decodedFinalTx.vsize;
            const finalEstimatedWitnessVBytes = numInputs * ESTIMATED_WITNESS_VBYTES_PER_INPUT;
            const finalEstimatedVBytes = finalBaseVBytes + finalEstimatedWitnessVBytes;
            estimatedVBytesDisplay = `${finalEstimatedVBytes} vBytes (Base: ${finalBaseVBytes}, Est. Witness: ${finalEstimatedWitnessVBytes})`;

            // Recalculate SizeBasedFee based on this final estimation
            const finalSizeBasedFeeDecimal = new Decimal(finalEstimatedVBytes).mul(feeRateSatPerVbyte);
            const finalSizeBasedFee = ceilToBigInt(finalSizeBasedFeeDecimal); // Use imported ceilToBigInt

            // Calculate remainder component based on the actual FinalFee paid
            const finalRemainderFee = finalFee - finalSizeBasedFee;

            sizeBasedFeeDisplay = `${finalSizeBasedFee} sats`;
            // Ensure remainder isn't displayed as negative if fee was slightly higher than calculation due to edge cases
            remainderFeeDisplay = `${finalRemainderFee >= 0n ? finalRemainderFee : 0n} sats`;

        } catch (decodeError) {
             // Log the error using the logger, respecting logLevel
             logger.warn(`Could not decode final transaction or calculate fee breakdown for summary: ${decodeError.message}`);
             // Keep display values as 'N/A'
        }
        console.log(`  Fee Rate Target: ~${feeRateSatPerVbyte.toFixed(2)} sat/vB`);
        console.log(`  Est. Final VSize: ${estimatedVBytesDisplay}`);
        console.log(`  Fee Size Comp.:  ${sizeBasedFeeDisplay}`);
        console.log(`  Fee Remainder:   ${remainderFeeDisplay}`);
        // --- End Fee Breakdown ---

        console.log(`------------------------------------`);
        console.log(`PSBT saved to:     ${outputFilePath}`);
        console.log(`------------------------------------`);
        console.log("\nNext Steps:");
        console.log(`1. Inspect the PSBT: bitcoin-cli -rpcwallet=${config.sourceContext.operatingWalletName} decodepsbt "$(cat ${outputFilePath})"`);
        console.log(`2. Sign the PSBT:    bitcoin-cli -rpcwallet=${config.sourceContext.operatingWalletName} walletprocesspsbt "$(cat ${outputFilePath})" true | jq -r .psbt > signed.psbt`);
        console.log(`3. Finalize & Send:  bitcoin-cli finalizepsbt "$(cat signed.psbt)" | jq -r .hex`);
        console.log(`                     bitcoin-cli sendrawtransaction <hex_from_above>`);
        console.log("\n--- Consolidation Complete ---");


    } catch (error) {
        logger.error(`\n--- Consolidation Failed ---`);
        logger.error(`Error: ${error.message}`);
        // Log stack trace only at trace level for cleaner error output
        logger.trace(error.stack);
        process.exit(1);
    }
}

// --- Script Execution ---
if (process.argv.length !== 3) {
    console.error("Usage: node cli.js <path_to_config.json>");
    process.exit(1);
}

const configFilePath = process.argv[2];
runConsolidator(configFilePath);
