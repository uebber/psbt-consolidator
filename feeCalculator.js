// feeCalculator.js
import logger from './logger.js';
import { createRawTx, decodeRawTx } from './bitcoinCoreUtils.js';
import { satsToBtcString, ceilToBigInt } from './utils.js';
import Decimal from 'decimal.js';

// Calculates the optimal fee based on the specification, iterating to find minimum
async function calculateOptimalFee(config, rpcClientConfig, inputs, derivedAddressesMap, totalInputValue /* BigInt */, feeRateSatPerVbyte /* Decimal */) {
    const numInputs = inputs.length;
    const estimatedWitnessVBytesPerInput = config.feeOptions?.estimatedWitnessVBytesPerInput ?? 28; // Get from config or default

    logger.info(`Starting optimal fee calculation.`);
    logger.info(`  Inputs: ${numInputs}, Outputs: ${derivedAddressesMap.size}`);
    logger.info(`  Total Input Value: ${totalInputValue} sats`);
    logger.info(`  Target Feerate: ${feeRateSatPerVbyte.toFixed()} sat/vB`);
    logger.info(`  Using estimated witness size: ${estimatedWitnessVBytesPerInput} vBytes/input`);

    const numTargets = BigInt(derivedAddressesMap.size);
    if (numTargets === 0n) {
        throw new Error("Cannot calculate fee with zero target outputs.");
    }
    if (totalInputValue <= 0n) {
        throw new Error("Total input value must be positive.");
    }

    let finalFee = -1n;
    let amountPerOutput = -1n;
    let lastCalculatedBaseVBytes = 0;
    let lastEstimatedWitnessVBytes = 0;
    let lastTotalEstimatedVBytes = 0;
    let lastSizeBasedFee = 0n;
    let lastRemainderSats = 0n;
    let lastRequiredFee = 0n;

    // Start with a minimal fee guess (1 satoshi)
    let currentFeeGuess = 1n;

    const MAX_FEE_ITERATIONS = 20; // Safety break
    let i = 0;
    for (i = 0; i < MAX_FEE_ITERATIONS; i++) {
        logger.debug(`Fee Iteration ${i + 1}: Trying Fee = ${currentFeeGuess} sats`);

        if (currentFeeGuess >= totalInputValue) {
            logger.warn(`Fee guess (${currentFeeGuess}) meets or exceeds total input value (${totalInputValue}). Cannot find valid fee.`);
            finalFee = -1n; // Mark as failed
            amountPerOutput = 0n;
            break;
        }

        // Calculate potential AmountPerOutput based on this fee guess
        const valueToDistribute = totalInputValue - currentFeeGuess;
        const currentAmountPerOutput = valueToDistribute / numTargets; // BigInt division floors automatically

        if (currentAmountPerOutput <= 0n) {
            logger.debug(` Fee Iteration ${i + 1}: Fee ${currentFeeGuess} results in ${currentAmountPerOutput} amount per output. Fee is too high.`);
             if(currentFeeGuess === lastRequiredFee && i > 0) {
                 logger.error(`Fee calculation stuck: Fee ${currentFeeGuess} results in non-positive output amount.`);
                 finalFee = -1n;
                 amountPerOutput = 0n;
                 break;
             }
             // This case usually means the required fee calculated previously already pushed it over the edge.
             // Likely insufficient funds. Let the loop exit and throw error below.
             logger.warn(`Fee ${currentFeeGuess} results in non-positive amount per output. Check total funds vs estimated minimum fee.`);
             finalFee = -1n;
             amountPerOutput = 0n;
             break; // Exit loop, error handled after loop.
        }

        // Construct the outputs object for createrawtransaction
        const outputs = {};
        const amountBtcString = satsToBtcString(currentAmountPerOutput);
        for (const address of derivedAddressesMap.values()) {
            outputs[address] = amountBtcString;
        }

        try {
            // 1. Determine Actual *Base* VBytes (unsigned tx)
            const rawTxHex = await createRawTx(rpcClientConfig, inputs, outputs);
            const decodedTx = await decodeRawTx(rpcClientConfig, rawTxHex);
            lastCalculatedBaseVBytes = decodedTx.vsize; // Size without witness data

            // 2. Estimate Witness VBytes and Total VBytes
            lastEstimatedWitnessVBytes = numInputs * estimatedWitnessVBytesPerInput;
            lastTotalEstimatedVBytes = lastCalculatedBaseVBytes + lastEstimatedWitnessVBytes;
            logger.debug(` Fee Iteration ${i + 1}: Base VBytes = ${lastCalculatedBaseVBytes}, Est. Witness VBytes = ${lastEstimatedWitnessVBytes}, Total Est. VBytes = ${lastTotalEstimatedVBytes}`);

            // 3. Calculate SizeBasedFee based on TOTAL estimated size
            const sizeBasedFeeDecimal = new Decimal(lastTotalEstimatedVBytes).mul(feeRateSatPerVbyte);
            lastSizeBasedFee = ceilToBigInt(sizeBasedFeeDecimal);
            logger.debug(` Fee Iteration ${i + 1}: SizeBasedFee = ${lastSizeBasedFee} sats (from ${sizeBasedFeeDecimal.toFixed()} based on ${lastTotalEstimatedVBytes} vBytes)`);

            // 4. Calculate RemainderSats = (TotalInputValue - currentFeeGuess) % NumTargets
            lastRemainderSats = valueToDistribute % numTargets;
            logger.debug(` Fee Iteration ${i + 1}: RemainderSats = ${lastRemainderSats} sats (for fee guess ${currentFeeGuess})`);

            // 5. Calculate the required fee for *this* iteration's size/remainder
            lastRequiredFee = lastSizeBasedFee + lastRemainderSats; // Store for potential next guess
            logger.debug(` Fee Iteration ${i + 1}: Required Fee (SizeBasedFee + Remainder) = ${lastRequiredFee} sats`);

            // --- FIX: Simplified Convergence Check ---
            if (currentFeeGuess >= lastRequiredFee) {
                // Condition met: Fee >= SizeBasedFee + RemainderSats
                // This currentFeeGuess is the lowest possible fee that satisfies the condition
                // because we have increased the fee iteratively towards this point.
                logger.info(`Fee condition met: currentFeeGuess (${currentFeeGuess}) >= requiredFee (${lastRequiredFee}). Optimal fee found.`);
                finalFee = currentFeeGuess;
                amountPerOutput = currentAmountPerOutput;
                break; // Exit loop, we found the minimum valid fee.
            }
            else { // currentFeeGuess < lastRequiredFee
                // Condition NOT met. The current fee guess is too low.
                // The *minimum* fee we need to try next is `lastRequiredFee`.
                logger.debug(`Fee condition NOT met: currentFeeGuess (${currentFeeGuess}) < requiredFee (${lastRequiredFee}). Increasing fee guess to required fee.`);
                currentFeeGuess = lastRequiredFee;
                // Loop will continue with this new, higher guess.
            }
            // --- End of FIX ---

        } catch (error) {
            logger.error(`Error during fee calculation iteration ${i + 1} (Fee Guess: ${currentFeeGuess}): ${error.message}`);
            throw new Error(`Failed during fee calculation iteration: ${error.message}`);
        }

        // Defensive check: Ensure fee doesn't become excessively large or negative accidentally
        if (currentFeeGuess < 0n) {
             logger.error(`Negative fee guess encountered (${currentFeeGuess}). Aborting calculation.`);
             finalFee = -1n;
             amountPerOutput = 0n;
             break;
        }

    } // End of iteration loop


    // Error Handling after loop
    if (finalFee <= 0n || amountPerOutput <= 0n) { // Check finalFee > 0 strictly
        logger.error("Failed to find a valid positive fee and distribution after iterations.", {
            totalInputValue,
            numTargets,
            lastFeeGuess: currentFeeGuess, // Show the last guess attempted
            lastBaseVBytes: lastCalculatedBaseVBytes,
            lastEstWitnessVBytes: lastEstimatedWitnessVBytes,
            lastTotalEstVBytes: lastTotalEstimatedVBytes,
            lastSizeBasedFee,
            lastRemainderSats,
            lastRequiredFee // Show the last calculated required fee
        });
         if (lastTotalEstimatedVBytes > 0 && lastRequiredFee >= totalInputValue) {
             throw new Error(`Insufficient funds: Total input (${totalInputValue} sats) is less than or equal to the minimum required fee (${lastRequiredFee} sats = size fee ${lastSizeBasedFee} + remainder ${lastRemainderSats}) calculated for Est. VBytes=${lastTotalEstimatedVBytes}.`);
         } else if (currentFeeGuess >= totalInputValue) {
              throw new Error(`Insufficient funds: Final fee guess (${currentFeeGuess} sats) reached or exceeded total input value (${totalInputValue} sats) during search.`);
         } else if (i >= MAX_FEE_ITERATIONS) { // Use >= to catch exact max iteration case
             throw new Error(`Failed to converge on an optimal fee within ${MAX_FEE_ITERATIONS} iterations. Check logs for details (oscillation likely). Last Guess: ${currentFeeGuess}, Last Required Fee: ${lastRequiredFee}.`);
         } else {
            // General error if loop exited unexpectedly (e.g., non-positive amount)
            throw new Error(`Failed to determine a valid fee/distribution. Last guess: ${currentFeeGuess}. Possible insufficient funds or calculation error.`);
        }
    }

    // --- Final Summary Logging ---
    // Recalculate required fee components based *exactly* on the chosen finalFee for accurate reporting
    const finalValueToDistribute = totalInputValue - finalFee;
    const finalRemainder = finalValueToDistribute % numTargets;
    // Size component can be inferred: finalFee - finalRemainder
    const finalSizeFeeComponent = finalFee - finalRemainder;


    logger.info(`Optimal Fee Calculation Complete:`);
    logger.info(`  Final Fee: ${finalFee} sats`);
    logger.info(`  Amount Per Output: ${amountPerOutput} sats`);
    logger.info(`  Number of Outputs: ${numTargets}`);
    logger.info(`  Total Output Value: ${amountPerOutput * numTargets} sats`);
    logger.info(`  Total Spent (Outputs + Fee): ${amountPerOutput * numTargets + finalFee} sats`);
    logger.info(`  Total Input Value: ${totalInputValue} sats`);
    logger.info(`  Fee Breakdown (derived from final fee):`);
    // Display the size fee component calculated in the final relevant iteration for context
    logger.info(`    Size Fee Component (Est): ${finalSizeFeeComponent} sats (Targeting ~${lastSizeBasedFee} sats for ~${lastTotalEstimatedVBytes} vBytes)`);
    logger.info(`    Remainder Fee Comp:     ${finalRemainder} sats (Absorbed remainder)`);
    logger.info(`  Transaction Est. VBytes: ${lastTotalEstimatedVBytes} (Base: ${lastCalculatedBaseVBytes}, Witness: ${lastEstimatedWitnessVBytes})`);


     // Final sanity check: TotalInputValue = (AmountPerOutput * NumTargets) + FinalFee
     const checkSum = (amountPerOutput * numTargets) + finalFee;
     if (checkSum !== totalInputValue) {
         logger.error(`FATAL: Balance equation mismatch! Input ${totalInputValue} != Output ${amountPerOutput*numTargets} + Fee ${finalFee} = ${checkSum}`);
         throw new Error("Internal error: Final balance equation does not hold.");
     }


    return {
        finalFee,       // BigInt
        amountPerOutput // BigInt
    };
}

export { calculateOptimalFee };
