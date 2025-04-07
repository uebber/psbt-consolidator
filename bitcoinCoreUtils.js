// bitcoinCoreUtils.js
import logger from './logger.js';
import { makeRpcCall } from './rpcClient.js';
import { btcToSats } from './utils.js';

const MIN_CORE_VERSION = 240000; // Format used by getnetworkinfo (e.g., 240100)

// Verify Bitcoin Core version
async function checkCoreVersion(config) {
  logger.debug('Checking Bitcoin Core version...');
  const networkInfo = await makeRpcCall(config, 'getnetworkinfo');
  if (!networkInfo || typeof networkInfo.version !== 'number') {
      throw new Error('Could not retrieve valid version info from Bitcoin Core.');
  }
  // Ensure version is numerical representation (e.g., 240100 for 24.1)
  const coreVersionNum = typeof networkInfo.version === 'string'
                         ? parseInt(networkInfo.version.replace(/\./g, ''), 10) * 100 // Adjust based on actual format if needed
                         : networkInfo.version;

  if (coreVersionNum < MIN_CORE_VERSION) {
    throw new Error(`Bitcoin Core version ${networkInfo.version} (${coreVersionNum}) is too old. Required version >= ${MIN_CORE_VERSION} (e.g., 24.0.0).`);
  }
  logger.info(`Bitcoin Core version check passed (Version: ${networkInfo.version}).`);
}

// Verify the operating wallet is a descriptor wallet
async function checkWalletIsDescriptor(config) {
  const walletName = config.sourceContext.operatingWalletName;
  logger.debug(`Checking if wallet '${walletName}' is a descriptor wallet...`);
  try {
    const walletInfo = await makeRpcCall(config, 'getwalletinfo', [], walletName);
    if (!walletInfo || typeof walletInfo.descriptors !== 'boolean') {
        // Fallback check if 'descriptors' field isn't present (should be in v24+)
         logger.warn(`Could not definitively confirm descriptor status via 'descriptors' field in getwalletinfo for wallet '${walletName}'. Attempting functional check.`);
         // Attempt listdescriptors as a functional check
         try {
            await makeRpcCall(config, 'listdescriptors', [false], walletName);
            logger.info(`Wallet '${walletName}' responded to 'listdescriptors' command, assuming descriptor wallet.`);
         } catch (listDescError) {
             if (listDescError.message.includes('Method not found') || listDescError.message.includes('Method recognized')) {
                 throw new Error(`Wallet '${walletName}' does not support descriptor commands. It might not be a descriptor wallet.`);
             }
             // Re-throw other listdescriptors errors
             throw listDescError;
         }
    } else if (!walletInfo.descriptors) {
        throw new Error(`Wallet '${walletName}' is not a descriptor wallet (getwalletinfo reports descriptors: false). Descriptor wallet is required.`);
    } else {
        logger.info(`Wallet '${walletName}' confirmed as a descriptor wallet.`);
    }
  } catch (error) {
     if (error.message.includes("Requested wallet does not exist") || error.message.includes("Wallet not found")) {
        throw new Error(`Wallet '${config.sourceContext.operatingWalletName}' not found or not loaded in Bitcoin Core.`);
     }
      // Re-throw other errors (like connection errors, auth errors)
      throw new Error(`Failed to check wallet status for '${walletName}'. Ensure it exists, is loaded, and is a descriptor wallet. Original error: ${error.message}`);
  }
}

// List confirmed, spendable UTXOs for the sourceAddress
async function listSourceUtxos(config) {
  const { operatingWalletName, sourceAddress } = config.sourceContext;
  logger.debug(`Listing UTXOs for source address: ${sourceAddress} in wallet: ${operatingWalletName}`);

  const minConfirmations = 1; // Must be confirmed
  const utxos = await makeRpcCall(config, 'listunspent', [
    minConfirmations, // minconf
    9999999,        // maxconf
    [sourceAddress], // addresses array
    true,           // include_unsafe (true needed to get spendable flag reliably)
    { minimumAmount: 0.00000001 } // filter dust if desired
  ], operatingWalletName);

  // Filter further for 'spendable' and convert amount to BigInt sats
  const spendableUtxos = utxos
    .filter(utxo => utxo.spendable)
    .map(utxo => ({
      txid: utxo.txid,
      vout: utxo.vout,
      address: utxo.address,
      amount: btcToSats(utxo.amount), // Convert to BigInt sats immediately
      confirmations: utxo.confirmations,
      spendable: utxo.spendable,
      parent_descs: utxo.parent_descs || [], // Ensure parent_descs exists
    }));

  logger.info(`Found ${spendableUtxos.length} confirmed, spendable UTXOs for source address ${sourceAddress}.`);
  logger.trace('Source Address UTXOs:', spendableUtxos);
  return spendableUtxos;
}

// List all confirmed, spendable UTXOs in the wallet to check parent_descs
async function listWalletUtxos(config) {
    const { operatingWalletName } = config.sourceContext;
    logger.debug(`Listing all confirmed, spendable UTXOs in wallet: ${operatingWalletName} to check target descriptor derivation...`);

    const minConfirmations = 1; // Must be confirmed
    const utxos = await makeRpcCall(config, 'listunspent', [
        minConfirmations, // minconf
        9999999,        // maxconf
        [],             // addresses array - empty for all
        true,           // include_unsafe
        { minimumAmount: 0.00000001 }
    ], operatingWalletName);

    // Filter for spendable, ensure parent_descs, convert amount to BigInt sats
    const allSpendableUtxos = utxos
        .filter(utxo => utxo.spendable && Array.isArray(utxo.parent_descs)) // Ensure spendable and parent_descs is an array
        .map(utxo => ({
            txid: utxo.txid,
            vout: utxo.vout,
            address: utxo.address, // Keep for logging/debugging
            amount: btcToSats(utxo.amount),
            confirmations: utxo.confirmations,
            spendable: utxo.spendable,
            parent_descs: utxo.parent_descs,
        }));

    logger.debug(`Found ${allSpendableUtxos.length} total confirmed, spendable UTXOs in wallet ${operatingWalletName}.`);
    logger.trace('All Wallet UTXOs (candidates for target matching):', allSpendableUtxos);
    return allSpendableUtxos;
}


// Filter wallet UTXOs based on matching targetDescriptors in parent_descs
function filterTargetUtxos(walletUtxos, targetDescriptors) {
    logger.debug(`Filtering wallet UTXOs against ${targetDescriptors.length} target descriptors...`);
    const targetDescriptorSet = new Set(targetDescriptors); // Efficient lookup

    const matchedUtxos = walletUtxos.filter(utxo =>
        utxo.parent_descs.some(desc => targetDescriptorSet.has(desc))
    );

    logger.info(`Found ${matchedUtxos.length} UTXOs derived from target descriptors.`);
    logger.trace('Target Descriptor Matched UTXOs:', matchedUtxos);
    return matchedUtxos;
}


// Derive the next unused address for each target descriptor (CORRECTED - uses getdescriptorinfo)
async function deriveOutputAddresses(config) {
    const { operatingWalletName } = config.sourceContext;
    const { targetDescriptors } = config;
    logger.debug(`Deriving next addresses for ${targetDescriptors.length} target descriptors in wallet: ${operatingWalletName}`);

    // Fetch all descriptor info from the wallet
    const listResult = await makeRpcCall(config, 'listdescriptors', [false], operatingWalletName); // private=false

    if (!listResult || !Array.isArray(listResult.descriptors)) {
        throw new Error("Failed to list descriptors or received invalid format.");
    }

    const descriptorMap = new Map();
    listResult.descriptors.forEach(d => descriptorMap.set(d.desc, d));

    const derivedAddresses = new Map(); // Map<targetDescriptorString, derivedAddressString>

    for (const targetDesc of targetDescriptors) {
        logger.trace(`Processing target descriptor: ${targetDesc}`);
        const descInfoFromList = descriptorMap.get(targetDesc); // Get info listed in wallet

        if (!descInfoFromList) {
             const baseDesc = targetDesc.split('#')[0];
             const matchingBase = listResult.descriptors.find(d => d.desc.startsWith(baseDesc + '#'));
             if (matchingBase) {
                 throw new Error(`Target descriptor '${targetDesc}' not found exactly, but found '${matchingBase.desc}' in wallet '${operatingWalletName}'. Ensure checksums match or use the exact descriptor from listdescriptors.`);
             } else {
                throw new Error(`Target descriptor '${targetDesc}' not found in wallet '${operatingWalletName}'. Ensure it is imported and the string matches exactly.`);
             }
        }

        if (typeof descInfoFromList.next_index !== 'number') {
            throw new Error(`Could not find 'next_index' for target descriptor '${targetDesc}' in listdescriptors output. Is the range set correctly? Descriptor details: ${JSON.stringify(descInfoFromList)}`);
        }

        const nextIndex = descInfoFromList.next_index;
        logger.debug(`Found next_index ${nextIndex} for descriptor ${targetDesc}`);

        // --- CHECKSUM FIX V2: Use getdescriptorinfo ---

        // 1. Ensure the expected patterns exist before splitting/replacing
        if (!targetDesc.includes('/*')) {
            throw new Error(`Target descriptor '${targetDesc}' does not contain the expected '/*' wildcard pattern for derivation.`);
        }
        if (!targetDesc.includes('#')) {
             logger.warn(`Input target descriptor '${targetDesc}' seems to be missing a checksum ('#').`);
        }

        // 2. Get the descriptor part BEFORE the original checksum
        const descriptorBase = targetDesc.split('#')[0];

        // 3. Replace the wildcard /* with the specific /index
        const specificDescPath = descriptorBase.replace('/*', `/${nextIndex}`);
        logger.trace(`Constructed specific descriptor path (checksum-less): ${specificDescPath}`);

        // 4. Call getdescriptorinfo to get the descriptor WITH the correct checksum
        //    This command works at the node level, does not need wallet context here.
        let descriptorWithCorrectChecksum;
        try {
             logger.trace(`Calling getdescriptorinfo for: ${specificDescPath}`);
             const descInfoResult = await makeRpcCall(config, 'getdescriptorinfo', [specificDescPath]); // No wallet needed
             if (!descInfoResult || typeof descInfoResult.descriptor !== 'string') {
                 throw new Error(`getdescriptorinfo did not return expected descriptor string. Result: ${JSON.stringify(descInfoResult)}`);
             }
             descriptorWithCorrectChecksum = descInfoResult.descriptor;
             logger.debug(`getdescriptorinfo returned descriptor with checksum: ${descriptorWithCorrectChecksum}`);
        } catch (error) {
             logger.error(`getdescriptorinfo failed for path '${specificDescPath}': ${error.message}`);
             throw new Error(`Could not get descriptor info (and checksum) for path '${specificDescPath}'. Original error: ${error.message}`);
        }


        // 5. Call deriveaddresses using the descriptor WITH the correct checksum
        logger.trace(`Calling deriveaddresses with: ${descriptorWithCorrectChecksum}`);
        // This *does* need the wallet context
        const deriveResult = await makeRpcCall(config, 'deriveaddresses', [descriptorWithCorrectChecksum], operatingWalletName);
        // --- END OF FIX ---


        if (!deriveResult || !Array.isArray(deriveResult) || deriveResult.length !== 1 || typeof deriveResult[0] !== 'string') {
            throw new Error(`Failed to derive address for descriptor '${descriptorWithCorrectChecksum}'. Unexpected result from deriveaddresses: ${JSON.stringify(deriveResult)}`);
        }

        const derivedAddress = deriveResult[0];
        derivedAddresses.set(targetDesc, derivedAddress); // Store using original full descriptor string as key
        logger.info(`Derived address for ${targetDesc} (index ${nextIndex}): ${derivedAddress}`);
    }

    if (derivedAddresses.size !== targetDescriptors.length) {
        throw new Error(`Internal error: Mismatch in derived addresses count. Expected ${targetDescriptors.length}, got ${derivedAddresses.size}.`);
    }

    return derivedAddresses; // Map<targetDescriptorString, derivedAddressString>
}


// Estimate fee rate
async function estimateFeeRate(config) {
    const { feeTargetBlocks } = config;
    const estimateMode = 'CONSERVATIVE';
    logger.debug(`Estimating smart fee rate for target ${feeTargetBlocks} blocks (mode: ${estimateMode})...`);

    // Node-level command
    const result = await makeRpcCall(config, 'estimatesmartfee', [feeTargetBlocks, estimateMode]);

    if (result && Array.isArray(result.errors) && result.errors.length > 0) {
         logger.warn(`estimatesmartfee returned errors: ${result.errors.join(', ')}. Falling back to minimum feerate.`);
         return 0.00001000; // Min rate in BTC/kB = 1 sat/vB
    }
    if (!result || typeof result.feerate !== 'number' || result.feerate <= 0) {
        logger.warn(`estimatesmartfee returned invalid feerate or no feerate. Falling back to minimum. Result: ${JSON.stringify(result)}`);
        return 0.00001000;
    }

    logger.info(`Estimated feerate (BTC/kvB): ${result.feerate} (Blocks until confirmation: ${result.blocks ?? 'N/A'})`);
    return result.feerate; // Feerate in BTC per Kilo-vByte
}

// Create Raw Transaction (Helper)
async function createRawTx(config, inputs, outputsMap) {
    logger.trace('Attempting createrawtransaction with:', { inputs, outputsMap });
    // outputsMap is expected to be { address1: amountBTCString, address2: amountBTCString, ... }
    const result = await makeRpcCall(config, 'createrawtransaction', [inputs, outputsMap, 0, true]); // locktime=0, RBF=true
    if (typeof result !== 'string' || result.length === 0) {
        throw new Error(`createrawtransaction did not return a valid hex string. Inputs: ${JSON.stringify(inputs)}, Outputs: ${JSON.stringify(outputsMap)}`);
    }
    logger.trace('createrawtransaction successful, hex length:', result.length);
    return result; // Returns raw transaction hex
}

// Decode Raw Transaction (Helper)
async function decodeRawTx(config, rawTxHex) {
    logger.trace('Decoding raw transaction hex:', rawTxHex.substring(0, 60) + '...'); // Log prefix only
    // Node-level command
    const decoded = await makeRpcCall(config, 'decoderawtransaction', [rawTxHex]);
    if (!decoded || typeof decoded.vsize !== 'number') {
        if (decoded && typeof decoded.weight === 'number') {
             logger.trace('decoderawtransaction using weight. Weight:', decoded.weight);
             decoded.vsize = Math.ceil(decoded.weight / 4);
        } else if (decoded && typeof decoded.size === 'number') {
             logger.warn('decoderawtransaction missing vsize, using size as approximation. Size:', decoded.size);
             decoded.vsize = decoded.size;
        } else {
            throw new Error(`decoderawtransaction did not return a valid vsize, weight, or size. Result: ${JSON.stringify(decoded)}`);
        }
    }
    logger.trace('decoderawtransaction successful, VSize:', decoded.vsize);
    return decoded; // Returns decoded transaction object including vsize
}

// Convert Raw Transaction to PSBT (Helper)
async function convertToPsbt(config, rawTxHex) {
    logger.trace('Converting raw transaction to PSBT...');
    // Node-level command
    const psbt = await makeRpcCall(config, 'converttopsbt', [rawTxHex, false]); // permitsigdata=false
    if (typeof psbt !== 'string' || psbt.length === 0) {
        throw new Error("converttopsbt did not return a valid PSBT string.");
    }
    logger.trace('converttopsbt successful.');
    return psbt; // Returns Base64 encoded PSBT
}

// Process PSBT using walletprocesspsbt (Helper)
async function processPsbt(config, psbtBase64) {
    const { operatingWalletName } = config.sourceContext;
    logger.trace(`Processing PSBT with wallet ${operatingWalletName} (sign=false, bip32derivs=true)...`);
    // Wallet-level command
    const result = await makeRpcCall(config, 'walletprocesspsbt', [
        psbtBase64,
        false, // sign = false
        "ALL", // sighashtype
        true   // bip32derivs = true
    ], operatingWalletName);

    if (!result || typeof result.psbt !== 'string' || result.psbt.length === 0) {
        throw new Error(`walletprocesspsbt did not return a valid PSBT string in the result. Response: ${JSON.stringify(result)}`);
    }
    logger.info('walletprocesspsbt successful, added wallet data and derivation paths.');
    return result.psbt; // Returns the processed Base64 encoded PSBT
}


export {
  checkCoreVersion,
  checkWalletIsDescriptor,
  listSourceUtxos,
  listWalletUtxos,
  filterTargetUtxos,
  deriveOutputAddresses, // Corrected version exported
  estimateFeeRate,
  createRawTx,
  decodeRawTx,
  convertToPsbt,
  processPsbt
};
