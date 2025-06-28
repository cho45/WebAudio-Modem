/**
 * DSSS + DPSK Modem Implementation
 * Complete DPSK modulation with DSSS spreading and carrier processing
 */

import { mseq15Step, mseq31Step, mseq63Step, mseq127Step, mseq255Step, mseqOutput } from '../utils/msequence';

/**
 * DPSK modulation: bits to accumulated phases
 * @param bits Input bit array (0 or 1)
 * @param initialPhase Starting phase (default: 0)
 * @returns Absolute phase array for carrier modulation
 */
export function dpskModulate(bits: number[], initialPhase: number = 0): number[] {
  const phases: number[] = [];
  let currentPhase = initialPhase;
  
  for (const bit of bits) {
    phases.push(currentPhase);
    currentPhase += bit === 0 ? 0 : Math.PI; // 0→0, 1→π
  }
  
  return phases;
}

/**
 * DSSS spreading: bits to spread chips using M-sequence
 * @param bits Input bit array (0 or 1)
 * @param sequenceLength M-sequence length (15, 31, 63, 127, 255) - default: 31
 * @param seed LFSR seed (default: auto-select based on length)
 * @returns Spread chip array (+1/-1 values) as Int8Array
 */
export function dsssSpread(
  bits: number[], 
  sequenceLength: number = 31, 
  seed?: number
): Int8Array {
  // Auto-select seed if not provided
  const actualSeed = seed ?? getDefaultSeed(sequenceLength);
  
  // Generate M-sequence
  const mSequence = generateMSequence(sequenceLength, actualSeed);
  
  // Spread each bit with M-sequence
  const totalChips = bits.length * sequenceLength;
  const chips = new Int8Array(totalChips);
  
  let chipIndex = 0;
  for (const bit of bits) {
    const sign = bit === 0 ? 1 : -1; // Bit 0→+1, Bit 1→-1
    for (const chip of mSequence) {
      chips[chipIndex++] = sign * chip;
    }
  }
  
  return chips;
}

/**
 * Generate M-sequence of specified length
 * @param length Sequence length (15, 31, 63, 127, 255)
 * @param seed LFSR initial seed
 * @returns M-sequence as Int8Array (+1/-1 values)
 */
function generateMSequence(length: number, seed: number): Int8Array {
  const { stepFn, bits } = getMSequenceConfig(length);
  const sequence = new Int8Array(length);
  
  let register = seed;
  for (let i = 0; i < length; i++) {
    const bit = mseqOutput(register, bits);
    sequence[i] = bit === 0 ? -1 : 1;
    register = stepFn(register);
  }
  
  return sequence;
}

/**
 * Get M-sequence configuration for given length
 */
function getMSequenceConfig(length: number): { stepFn: (_reg: number) => number; bits: number } {
  switch (length) {
    case 15:
      return { stepFn: mseq15Step, bits: 4 };
    case 31:
      return { stepFn: mseq31Step, bits: 5 };
    case 63:
      return { stepFn: mseq63Step, bits: 6 };
    case 127:
      return { stepFn: mseq127Step, bits: 7 };
    case 255:
      return { stepFn: mseq255Step, bits: 8 };
    default:
      throw new Error(`Unsupported M-sequence length: ${length}. Supported: 15, 31, 63, 127, 255`);
  }
}

/**
 * Get default seed for M-sequence length
 */
function getDefaultSeed(length: number): number {
  switch (length) {
    case 15:
      return 0b1000;    // 4-bit non-zero
    case 31:
      return 0b10101;   // 5-bit non-zero (aec-plan.md specified)
    case 63:
      return 0b100001;  // 6-bit non-zero
    case 127:
      return 0b1000001; // 7-bit non-zero
    case 255:
      return 0b10000001; // 8-bit non-zero
    default:
      throw new Error(`No default seed for M-sequence length: ${length}`);
  }
}

/**
 * DSSS despreading: correlate chips with M-sequence to recover bits
 * @param chips Received chip array (+1/-1 or noisy values)
 * @param sequenceLength M-sequence length (must match spreading) - default: 31
 * @param seed LFSR seed (must match spreading seed)
 * @returns Despread bit array (0 or 1) and correlation values
 */
export function dsssDespread(
  chips: Int8Array | Float32Array | number[], 
  sequenceLength: number = 31, 
  seed?: number
): { bits: number[], correlations: number[] } {
  // Auto-select seed if not provided
  const actualSeed = seed ?? getDefaultSeed(sequenceLength);
  
  // Generate same M-sequence used for spreading
  const mSequence = generateMSequence(sequenceLength, actualSeed);
  
  const numBits = Math.floor(chips.length / sequenceLength);
  const bits: number[] = [];
  const correlations: number[] = [];
  
  for (let bitIndex = 0; bitIndex < numBits; bitIndex++) {
    const startIdx = bitIndex * sequenceLength;
    let correlation = 0;
    
    // Correlate chip segment with M-sequence
    for (let i = 0; i < sequenceLength; i++) {
      correlation += chips[startIdx + i] * mSequence[i];
    }
    
    correlations.push(correlation);
    
    // Convert correlation to bit: positive→0, negative→1
    bits.push(correlation > 0 ? 0 : 1);
  }
  
  return { bits, correlations };
}

/**
 * Quantize soft values to Int8Array range (-128 to +127)
 * @param softValues Array of floating-point LLR values
 * @param maxValue Maximum absolute value for scaling (default: 10.0)
 * @returns Quantized soft values as Int8Array
 */
export function quantizeSoftValues(softValues: number[], maxValue: number = 10.0): Int8Array {
  const quantized = new Int8Array(softValues.length);
  
  for (let i = 0; i < softValues.length; i++) {
    // Scale to [-1, 1] range
    const scaled = Math.max(-1.0, Math.min(1.0, softValues[i] / maxValue));
    
    // Quantize to int8 range [-128, +127]
    quantized[i] = Math.round(scaled * 127);
  }
  
  return quantized;
}

/**
 * DPSK demodulation: convert phase differences to soft values (LLR)
 * @param phases Received phase array in radians (Float32Array or number[])
 * @param esN0Db Es/N0 ratio in dB (default: 10dB)
 * @returns Quantized soft values as Int8Array (-128 to +127)
 */
export function dpskDemodulate(
  phases: Float32Array | number[], 
  esN0Db: number = 10.0
): Int8Array {
  const esN0Linear = Math.pow(10, esN0Db / 10); // Convert dB to linear
  const softValues: number[] = [];
  
  for (let i = 1; i < phases.length; i++) {
    // Calculate phase difference
    let phaseDiff = phases[i] - phases[i - 1];
    
    // Normalize to [-π, π]
    while (phaseDiff > Math.PI) phaseDiff -= 2 * Math.PI;
    while (phaseDiff < -Math.PI) phaseDiff += 2 * Math.PI;
    
    // LLR calculation using theoretical formula (aec-plan.md)
    // LLR = 4 * Es/N0 * cos(phase_diff) for DPSK
    // cos(0) = +1 (bit 0 likely), cos(π) = -1 (bit 1 likely)
    const llr = 4 * esN0Linear * Math.cos(phaseDiff);
    softValues.push(llr);
  }
  
  // Quantize to Int8Array with fixed scale to preserve Es/N0 effect
  // Use a fixed maximum value so that Es/N0 differences are preserved
  const fixedMaxValue = 40.0; // Corresponds to ~10dB Es/N0 * 4
  return quantizeSoftValues(softValues, fixedMaxValue);
}

/**
 * Modulate phases onto carrier frequency
 * @param phases Phase array in radians
 * @param samplesPerPhase Number of samples per phase symbol
 * @param sampleRate Sample rate (Hz)
 * @param carrierFreq Carrier frequency (Hz)
 * @param startSample Starting sample number for phase continuity
 * @returns Real signal samples
 */
export function modulateCarrier(
  phases: number[], 
  samplesPerPhase: number, 
  sampleRate: number, 
  carrierFreq: number, 
  startSample: number = 0
): Float32Array {
  const totalSamples = phases.length * samplesPerPhase;
  const samples = new Float32Array(totalSamples);
  
  const omega = 2 * Math.PI * carrierFreq / sampleRate;
  
  for (let i = 0; i < totalSamples; i++) {
    const phaseIndex = Math.floor(i / samplesPerPhase);
    const symbolPhase = phases[phaseIndex];
    const carrierPhase = omega * (startSample + i);
    
    samples[i] = Math.sin(carrierPhase + symbolPhase);
  }
  
  return samples;
}

/**
 * Demodulate carrier to extract phases
 * @param samples Real signal samples
 * @param samplesPerPhase Number of samples per phase symbol
 * @param sampleRate Sample rate (Hz)
 * @param carrierFreq Carrier frequency (Hz)
 * @param startSample Starting sample number for phase continuity
 * @returns Extracted phase array in radians
 */
export function demodulateCarrier(
  samples: Float32Array, 
  samplesPerPhase: number, 
  sampleRate: number, 
  carrierFreq: number, 
  startSample: number = 0
): number[] {
  const omega = 2 * Math.PI * carrierFreq / sampleRate;
  const numPhases = Math.floor(samples.length / samplesPerPhase);
  const phases: number[] = [];
  
  // Process each phase symbol separately
  for (let phaseIdx = 0; phaseIdx < numPhases; phaseIdx++) {
    const symbolStart = phaseIdx * samplesPerPhase;
    const symbolEnd = symbolStart + samplesPerPhase;
    
    // Integrate I and Q over the symbol period
    let I_sum = 0;
    let Q_sum = 0;
    
    for (let i = symbolStart; i < symbolEnd; i++) {
      const sampleIndex = startSample + i;
      const carrierPhase = omega * sampleIndex;
      
      I_sum += samples[i] * Math.cos(carrierPhase);
      Q_sum += samples[i] * Math.sin(carrierPhase);
    }
    
    // Average over symbol period
    const I_avg = I_sum / samplesPerPhase;
    const Q_avg = Q_sum / samplesPerPhase;
    
    // Extract phase (corrected order for proper quadrature)
    phases[phaseIdx] = Math.atan2(I_avg, Q_avg);
  }
  
  return phases;
}

/**
 * Check phase continuity for discontinuity detection (Step 2 requirement)
 * @param phases Phase array in radians
 * @param threshold Maximum allowed phase jump (default: π - 0.1)
 * @returns Object with continuity status and discontinuity locations
 */
export function checkPhaseContinuity(phases: number[], threshold: number = Math.PI - 0.1): {
  isContinuous: boolean;
  discontinuities: number[];
  maxJump: number;
} {
  const discontinuities: number[] = [];
  let maxJump = 0;
  
  for (let i = 1; i < phases.length; i++) {
    let phaseDiff = phases[i] - phases[i - 1];
    
    // Normalize to [-π, π] properly
    while (phaseDiff > Math.PI) phaseDiff -= 2 * Math.PI;
    while (phaseDiff < -Math.PI) phaseDiff += 2 * Math.PI;
    
    const jumpMagnitude = Math.abs(phaseDiff);
    maxJump = Math.max(maxJump, jumpMagnitude);
    
    if (jumpMagnitude > threshold) {
      discontinuities.push(i);
    }
  }
  
  return {
    isContinuous: discontinuities.length === 0,
    discontinuities,
    maxJump
  };
}

/**
 * Phase unwrapping for continuous phase recovery (Step 3 requirement)
 * @param wrappedPhases Wrapped phase array in [-π, π]
 * @returns Unwrapped continuous phase array
 */
export function phaseUnwrap(wrappedPhases: number[]): number[] {
  if (wrappedPhases.length === 0) return [];
  
  const unwrapped: number[] = [wrappedPhases[0]];
  
  for (let i = 1; i < wrappedPhases.length; i++) {
    let diff = wrappedPhases[i] - wrappedPhases[i - 1];
    
    // Unwrap by adding/subtracting 2π multiples
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    
    unwrapped[i] = unwrapped[i - 1] + diff;
  }
  
  return unwrapped;
}

/**
 * Calculate Bit Error Rate between two bit arrays (Step 3 requirement)
 * @param originalBits Original transmitted bits
 * @param receivedBits Received/recovered bits
 * @returns BER (0.0 to 1.0)
 */
export function calculateBER(originalBits: number[], receivedBits: number[]): number {
  if (originalBits.length !== receivedBits.length) {
    throw new Error('Bit arrays must have same length');
  }
  
  if (originalBits.length === 0) return 0;
  
  let errors = 0;
  for (let i = 0; i < originalBits.length; i++) {
    if (originalBits[i] !== receivedBits[i]) {
      errors++;
    }
  }
  
  return errors / originalBits.length;
}

/**
 * Add Additive White Gaussian Noise to signal (Step 3 requirement)
 * @param signal Input signal array
 * @param snrDb Signal-to-Noise Ratio in dB
 * @returns Noisy signal array
 */
export function addAWGN(signal: Float32Array, snrDb: number): Float32Array {
  const noisySignal = new Float32Array(signal.length);
  
  // Calculate signal power
  let signalPower = 0;
  for (let i = 0; i < signal.length; i++) {
    signalPower += signal[i] * signal[i];
  }
  signalPower /= signal.length;
  
  // Calculate noise power from SNR
  const snrLinear = Math.pow(10, snrDb / 10);
  const noisePower = signalPower / snrLinear;
  const noiseStd = Math.sqrt(noisePower);
  
  // Add Gaussian noise
  for (let i = 0; i < signal.length; i++) {
    const noise = generateGaussianNoise() * noiseStd;
    noisySignal[i] = signal[i] + noise;
  }
  
  return noisySignal;
}

/**
 * Generate Gaussian noise sample (Box-Muller method)
 */
function generateGaussianNoise(): number {
  // Box-Muller transform for Gaussian random numbers
  const u1 = Math.random();
  const u2 = Math.random();
  
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Find synchronization offset using DSSS correlation peak detection
 * Exploits DSSS processing gain to detect signals below noise level
 * @param receivedChips Received chip sequence 
 * @param referenceSequence Known M-sequence for correlation
 * @param maxOffset Maximum offset to search
 * @returns Object with best offset, correlation peak, and detection metrics
 */
export function findSyncOffset(
  receivedChips: Int8Array | Float32Array | number[], 
  referenceSequence: Int8Array, 
  maxOffset: number = 100
): {
  bestOffset: number;
  peakCorrelation: number;
  correlations: Float32Array;
  isFound: boolean;
  peakRatio: number;
} {
  // Convert input to Float32Array for consistent processing
  const received = receivedChips instanceof Float32Array ? receivedChips : 
                   new Float32Array(receivedChips);
  
  if (received.length < referenceSequence.length) {
    return {
      bestOffset: -1,
      peakCorrelation: 0,
      correlations: new Float32Array(0),
      isFound: false,
      peakRatio: 0
    };
  }
  
  const sequenceLength = referenceSequence.length;
  const searchLimit = Math.min(maxOffset, received.length - sequenceLength);
  const correlations = new Float32Array(searchLimit + 1);
  
  let bestOffset = 0;
  let peakCorrelation = 0;
  let maxAbsCorrelation = 0;
  
  // Compute correlation for each offset
  for (let offset = 0; offset <= searchLimit; offset++) {
    let correlation = 0;
    
    // Standard correlation sum
    for (let i = 0; i < sequenceLength; i++) {
      correlation += received[offset + i] * referenceSequence[i];
    }
    
    correlations[offset] = correlation;
    
    // Track best correlation (can be negative for inverted sequences)
    const absCorrelation = Math.abs(correlation);
    if (absCorrelation > maxAbsCorrelation) {
      maxAbsCorrelation = absCorrelation;
      peakCorrelation = correlation;
      bestOffset = offset;
    }
  }
  
  // DSSS peak detection: measure peak-to-average ratio
  // This exploits the processing gain - correlation peak stands out even in noise
  const peakRatio = calculatePeakRatio(correlations, bestOffset);
  
  // DSSS detection criterion based on statistical theory
  // Use adaptive thresholds: strict for pure noise rejection, relaxed for signal+noise detection
  // M31 processing gain = 10*log10(31) ≈ 14.9dB
  // For pure noise: use 3σ threshold for reliable rejection
  // For signal+noise: relax threshold if peak ratio is very high (indicating signal presence)
  const strictAbsCorrelation = 3 * Math.sqrt(sequenceLength); // 3σ = 16.7 for M31 (pure noise rejection)
  const relaxedAbsCorrelation = 2 * Math.sqrt(sequenceLength); // 2σ = 11.1 for M31 (signal+noise detection)
  const minPeakRatio = 2.0; // Theoretical minimum for signal vs noise detection
  const highPeakRatio = 4.0; // Very high peak ratio indicates strong signal
  
  // Adaptive threshold logic: 
  // - High peak ratio (>4.0) indicates strong signal → use relaxed threshold
  // - Low peak ratio indicates pure noise → use strict threshold
  const useRelaxedThreshold = peakRatio >= highPeakRatio;
  const requiredAbsCorrelation = useRelaxedThreshold ? relaxedAbsCorrelation : strictAbsCorrelation;
  
  const hasStrongCorrelation = Math.abs(peakCorrelation) >= requiredAbsCorrelation;
  const hasGoodPeakRatio = peakRatio >= minPeakRatio;
  
  const isFound = hasStrongCorrelation && hasGoodPeakRatio;
  
  return {
    bestOffset,
    peakCorrelation,
    correlations,
    isFound,
    peakRatio
  };
}

/**
 * Calculate peak-to-average ratio for DSSS correlation detection
 * This is the key metric that exploits DSSS processing gain
 * @param correlations Array of correlation values
 * @param peakIndex Index of the peak correlation
 * @returns Peak-to-average ratio
 */
function calculatePeakRatio(correlations: Float32Array, peakIndex: number): number {
  if (correlations.length <= 1) return 0;
  
  const peakValue = Math.abs(correlations[peakIndex]);
  
  // Calculate average of all correlations excluding the peak
  let sum = 0;
  let count = 0;
  
  for (let i = 0; i < correlations.length; i++) {
    if (i !== peakIndex) {
      sum += Math.abs(correlations[i]);
      count++;
    }
  }
  
  const average = count > 0 ? sum / count : 0;
  
  // Peak-to-average ratio (dimensionless)
  // In pure noise: ratio ≈ 1.0
  // With DSSS signal: ratio >> 1.0 due to processing gain
  return average > 0 ? peakValue / average : 0;
}

/**
 * Apply synchronization offset to align received data (Step 4 requirement)
 * @param receivedData Received data array (chips or samples)
 * @param offset Synchronization offset to apply
 * @returns Aligned data array starting from offset
 */
export function applySyncOffset<T>(receivedData: T[], offset: number): T[] {
  if (offset < 0 || offset >= receivedData.length) {
    return [];
  }
  
  return receivedData.slice(offset);
}

/**
 * Generate M-sequence reference for synchronization (helper function)
 * @param sequenceLength Sequence length (15, 31, 63, 127, 255) - default: 31
 * @param seed LFSR seed (optional, auto-selected if not provided)
 * @returns Reference M-sequence (+1/-1 values) as Int8Array
 */
export function generateSyncReference(
  sequenceLength: number = 31, 
  seed?: number
): Int8Array {
  const actualSeed = seed ?? getDefaultSeed(sequenceLength);
  return generateMSequence(sequenceLength, actualSeed);
}