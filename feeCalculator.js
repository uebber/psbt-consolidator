// feeCalculator.js
import logger from './logger.js';
import { createRawTx, decodeRawTx } from './bitcoinCoreUtils.js';
import { satsToBtcString, ceilToBigInt } from './utils.js';
import Decimal from 'decimal.js';

// --- Configuration ---
// Estimated vBytes added per input by witness data (signature + pubkey)
// P2WPKH is typically ~108-110 weight units -> ceil(110 / 4) = 28 vBytes
// P2TR uses Schnorr sigs, potentially slightly different, but 28 is a reasonable starting point.
// Adjust if you consistently use different input types (e.g., larger multisig).
const ESTIMATED_WITNESS_VBYTES_PER_INPUT = 28;
// --- End Configuration ---


// Calculates the optimal fee based on the specification
async function calculateOptimalFee(config, rpcClientConfig, inputs, derivedAddressesMap, totalInputValue /* BigInt */, feeRateSatPerVbyte /* Decimal */) {
    const numInputs = inputs.length;
    logger.info(`Starting optimal fee calculation.`);
    logger.info(`  Inputs: ${numInputs}, Outputs: ${derivedAddressesMap.size}`);
    logger.info(`  Total Input Value: ${totalInputValue} sats`);
    logger.info(`  Target Feerate: ${feeRateSatPerVbyte.toFixed()} sat/vB`);
    logger.info(`  Using estimated witness size: ${ESTIMATED_WITNESS_VBYTES_PER_INPUT} vBytes/input`);


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

    // --- Revised Fee Iteration Logic ---
    // Start with a minimal fee guess (e.g., 1 sat or based on minimal size)
    // Minimal size: ~11 base + 2*31 out + 5*41 non-witness-in = ~278 base, + 5*28 witness = ~140 witness => ~418 total. Fee ~418 sats @ 1 sat/vB
    // Let's start guess slightly lower to ensure the loop works upwards correctly.
    let currentFeeGuess = 1n; // Start with 1 satoshi

    const MAX_FEE_ITERATIONS = 20; // Safety break
    for (let i = 0; i < MAX_FEE_ITERATIONS; i++) {
        logger.debug(`Fee Iteration ${i + 1}: Trying Fee = ${currentFeeGuess} sats`);

        if (currentFeeGuess >= totalInputValue) {
            logger.warn(`Fee guess (${currentFeeGuess}) exceeds total input value (${totalInputValue}). Cannot find valid fee.`);
            // Set last calculated values for potential error message below
             finalFee = -1n;
             amountPerOutput = 0n;
            break;
        }

        // Calculate potential AmountPerOutput based on this fee guess
        const valueToDistribute = totalInputValue - currentFeeGuess;
        const currentAmountPerOutput = valueToDistribute / numTargets; // BigInt division floors automatically

        if (currentAmountPerOutput <= 0n) {
            logger.debug(` Fee Iteration ${i + 1}: Fee ${currentFeeGuess} results in ${currentAmountPerOutput} amount per output. Fee is too high relative to input value.`);
            // This fee is too high. We need to increase the fee guess minimally just in case
            // the *previous* guess was only invalid due to remainder, but this usually means insufficient funds.
            // If the loop started low, it should naturally increase. If it somehow jumped too high,
            // this prevents getting stuck. A better approach might be needed if oscillations occur.
            currentFeeGuess += 1n; // Increment and try again
            finalFee = -1n; // Ensure failure state if loop exits here
            amountPerOutput = 0n;
            continue;
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
            lastEstimatedWitnessVBytes = numInputs * ESTIMATED_WITNESS_VBYTES_PER_INPUT;
            lastTotalEstimatedVBytes = lastCalculatedBaseVBytes + lastEstimatedWitnessVBytes;
            logger.debug(` Fee Iteration ${i + 1}: Base VBytes = ${lastCalculatedBaseVBytes}, Est. Witness VBytes = ${lastEstimatedWitnessVBytes}, Total Est. VBytes = ${lastTotalEstimatedVBytes}`);


            // 3. Calculate SizeBasedFee based on TOTAL estimated size
            const sizeBasedFeeDecimal = new Decimal(lastTotalEstimatedVBytes).mul(feeRateSatPerVbyte);
            lastSizeBasedFee = ceilToBigInt(sizeBasedFeeDecimal);
            logger.debug(` Fee Iteration ${i + 1}: SizeBasedFee = ${lastSizeBasedFee} sats (from ${sizeBasedFeeDecimal.toFixed()} pre-ceil based on ${lastTotalEstimatedVBytes} vBytes)`);

            // 4. Calculate RemainderSats = (TotalInputValue - currentFeeGuess) % NumTargets
            lastRemainderSats = valueToDistribute % numTargets;
            logger.debug(` Fee Iteration ${i + 1}: RemainderSats = ${lastRemainderSats} sats (for fee guess ${currentFeeGuess})`);

            // 5. Calculate the required fee for *this* iteration's size/remainder
            const requiredFee = lastSizeBasedFee + lastRemainderSats;
            logger.debug(` Fee Iteration ${i + 1}: Required Fee (SizeBasedFee + Remainder) = ${requiredFee} sats`);


            // 6. Convergence Check:
            if (currentFeeGuess === requiredFee) {
                // Perfect match! This is our optimal fee.
                logger.info(`Fee converged: currentFeeGuess (${currentFeeGuess}) == requiredFee (${requiredFee}). Optimal fee found.`);
                finalFee = currentFeeGuess;
                amountPerOutput = currentAmountPerOutput;
                break; // Exit loop
            } else if (currentFeeGuess > requiredFee) {
                // Our guess is higher than needed for *this* size/remainder.
                // This *could* be the minimum if decreasing the fee changes the remainder unfavorably.
                // However, it's more likely the actual minimum is `requiredFee` or slightly higher.
                // Let's try the `requiredFee` directly in the next iteration. If THAT requiredFee matches ITSELF, we are done.
                 logger.debug(`Fee condition met (Guess ${currentFeeGuess} > Required ${requiredFee}), but potentially too high. Trying Required Fee next.`);
                 // Store this as a *potential* answer in case the next iteration fails? Less complex: just set next guess.
                 // finalFee = currentFeeGuess; // Tentative
                 // amountPerOutput = currentAmountPerOutput; // Tentative
                 currentFeeGuess = requiredFee; // Try the calculated required fee next iteration
            }
            else { // currentFeeGuess < requiredFee
                // Condition NOT met. The current fee guess is too low.
                // The *minimum* fee we need to try next is `requiredFee`.
                logger.debug(`Fee condition NOT met: currentFeeGuess (${currentFeeGuess}) < requiredFee (${requiredFee}). Increasing fee guess to required fee.`);
                currentFeeGuess = requiredFee;
                // Loop will continue with this new, higher guess.
            }

        } catch (error) {
            logger.error(`Error during fee calculation iteration ${i + 1} (Fee Guess: ${currentFeeGuess}): ${error.message}`);
            throw new Error(`Failed during fee calculation iteration: ${error.message}`);
        }

        // Check if fee increased beyond total input value after adjustment
        if (currentFeeGuess >= totalInputValue) {
             logger.warn(`Next fee guess (${currentFeeGuess}) meets or exceeds total input value (${totalInputValue}). Stopping search.`);
             finalFee = -1n; // Indicate failure
             amountPerOutput = 0n;
             break;
        }

    } // End of iteration loop


    if (finalFee === -1n || amountPerOutput <= 0n) {
        logger.error("Failed to find a valid fee and distribution after iterations.", {
            totalInputValue,
            numTargets,
            lastFeeGuess: currentFeeGuess,
            lastBaseVBytes: lastCalculatedBaseVBytes,
            lastEstWitnessVBytes: lastEstimatedWitnessVBytes,
            lastTotalEstVBytes: lastTotalEstimatedVBytes,
            lastSizeBasedFee,
            lastRemainderSats
        });
        if (lastTotalEstimatedVBytes > 0 && (lastSizeBasedFee + lastRemainderSats) >= totalInputValue) {
             throw new Error(`Insufficient funds: Total input (${totalInputValue} sats) is less than the minimum required fee (${lastSizeBasedFee + lastRemainderSats} sats = size fee ${lastSizeBasedFee} + remainder ${lastRemainderSats}) calculated for Est. VBytes=${lastTotalEstimatedVBytes}.`);
        } else if (currentFeeGuess >= totalInputValue) {
             throw new Error(`Insufficient funds: Could not find a fee below the total input value (${totalInputValue} sats) that satisfies distribution requirements.`);
        }
         else if (i === MAX_FEE_ITERATIONS) {
             throw new Error(`Failed to converge on an optimal fee within ${MAX_FEE_ITERATIONS} iterations. Check logs for details. Last guess: ${currentFeeGuess}. Last Required: ${lastSizeBasedFee + lastRemainderSats}.`);
         }
         else {
            throw new Error("Failed to determine a valid fee/distribution. Possible insufficient funds or calculation error.");
        }
    }

    // --- Final Summary Logging ---
    const finalCalculatedFee = lastSizeBasedFee + lastRemainderSats; // Fee based on the *final* iteration's size/remainder
    logger.info(`Optimal Fee Calculation Complete:`);
    logger.info(`  Final Fee: ${finalFee} sats`);
    logger.info(`  Amount Per Output: ${amountPerOutput} sats`);
    logger.info(`  Number of Outputs: ${numTargets}`);
    logger.info(`  Total Output Value: ${amountPerOutput * numTargets} sats`);
    logger.info(`  Total Spent (Outputs + Fee): ${amountPerOutput * numTargets + finalFee} sats`);
    logger.info(`  Total Input Value: ${totalInputValue} sats`);
    logger.info(`  Fee Breakdown (based on final state):`);
    logger.info(`    Size Fee Component: ${lastSizeBasedFee} sats (for ~${lastTotalEstimatedVBytes} vBytes @ ${feeRateSatPerVbyte.toFixed(2)} sat/vB)`);
    logger.info(`    Remainder Fee Comp: ${lastRemainderSats} sats (to absorb distribution remainder)`);
    // Note: finalFee might be slightly different from lastSizeBasedFee + lastRemainderSats if the last step involved `currentFeeGuess > requiredFee`
    // logger.info(`    (Check: Size + Remainder = ${finalCalculatedFee})`);
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
