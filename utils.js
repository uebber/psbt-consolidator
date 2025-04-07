// utils.js
import Decimal from 'decimal.js';

// Set precision for Decimal.js if needed, though default might be sufficient
Decimal.set({ precision: 30 }); // Example precision

const SATS_PER_BTC = 100_000_000n; // Use BigInt

// Converts BTC (string or number) to Satoshis (BigInt)
function btcToSats(btcAmount) {
  if (btcAmount === null || btcAmount === undefined) {
    throw new Error("Cannot convert null or undefined BTC amount to satoshis.");
  }
  // Use Decimal for intermediate calculation to handle floating point precision
  const decimalAmount = new Decimal(btcAmount.toString());
  const satoshisDecimal = decimalAmount.mul(SATS_PER_BTC.toString());
  // Ensure we round *down* (floor) to avoid creating satoshis
  return BigInt(satoshisDecimal.floor().toFixed());
}

// Converts Satoshis (BigInt) to BTC (string) for RPC calls that require it
function satsToBtcString(satsAmount) {
    if (typeof satsAmount !== 'bigint') {
        throw new Error("Input must be a BigInt.");
    }
    // Use Decimal for accurate division
    const decimalSats = new Decimal(satsAmount.toString());
    const decimalBtc = decimalSats.div(SATS_PER_BTC.toString());
    // Format to 8 decimal places, which is standard for BTC amounts in RPC
    return decimalBtc.toFixed(8);
}


// Converts feerate from BTC/kvB (float) to Satoshis/vByte (Decimal)
// Applies the minimum 1.0 sat/vB floor.
function convertFeeRateToSatPerVb(feeRateBtcPerKvB) {
  if (feeRateBtcPerKvB === null || feeRateBtcPerKvB === undefined || feeRateBtcPerKvB <= 0) {
    // Bitcoin Core might return 0 or negative if unable to estimate; use floor.
    // Also handles cases where the input might be invalid.
    return new Decimal(1.0);
  }
  const rate = new Decimal(feeRateBtcPerKvB.toString());
  // rate (BTC/kvB) * 100_000_000 (sat/BTC) / 1000 (vB/kvB)
  const rateSatPerVb = rate.mul(SATS_PER_BTC.toString()).div(1000);

  // Apply floor of 1.0 sat/vB
  if (rateSatPerVb.lessThan(1.0)) {
    return new Decimal(1.0);
  }
  return rateSatPerVb; // Return as Decimal for precision
}

// Calculates Ceil(value) and returns as BigInt
function ceilToBigInt(value) {
    if (value instanceof Decimal) {
        return BigInt(value.ceil().toFixed());
    }
    // Assume standard number if not Decimal
    return BigInt(Math.ceil(value));
}


export { btcToSats, satsToBtcString, convertFeeRateToSatPerVb, ceilToBigInt, SATS_PER_BTC };
