/**
 * DSSS + DPSK Modem Implementation
 * Complete DPSK modulation with DSSS spreading and carrier processing
 * 
 * 型分離ルール:
 * - ビット: 2値データ (0/1) → Uint8Array  
 * - ソフトビット: 確信度付きビット (-127≈0確実, +127≈1確実) → Int8Array
 * - チップ: 拡散符号 (+1/-1) → Int8Array
 * - サンプル: アナログ信号のデジタル表現 → Float32Array
 */

import { mseq15Step, mseq31Step, mseq63Step, mseq127Step, mseq255Step, mseqOutput } from '../utils/msequence';

/**
 * Normalize phase to [-π, π] range
 */
function normalizePhase(phase: number): number {
  // Math.PI = π, 2*Math.PI = 2π
  // ((phase + π) % 2π + 2π) % 2π - π で [-π, π) に正規化
  const twoPi = 2 * Math.PI;
  return ((phase + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
}

/**
 * DPSK modulation: chips (+1/-1) to accumulated phases
 * @param chips Input chip array (+1/-1) as Int8Array
 * @param initialPhase Starting phase (default: 0)
 * @returns Absolute phase array for carrier modulation as Float32Array
 */
export function dpskModulate(chips: Int8Array, initialPhase: number = 0): Float32Array {
  const phases = new Float32Array(chips.length);
  let currentPhase = initialPhase;
  for (let i = 0; i < chips.length; i++) {
    phases[i] = currentPhase;
    currentPhase += chips[i] > 0 ? 0 : Math.PI; // +1→0, -1→π
  }
  return phases;
}

/**
 * DSSS spreading: bits to spread chips using M-sequence
 * @param bits Input bit array (0 or 1) as Uint8Array
 * @param sequenceLength M-sequence length (15, 31, 63, 127, 255) - default: 31
 * @param seed LFSR seed (default: auto-select based on length)
 * @returns Spread chip array (+1/-1 values) as Int8Array
 */
export function dsssSpread(
  bits: Uint8Array, 
  sequenceLength: number = 31, 
  seed?: number
): Int8Array {
  // Auto-select seed if not provided
  const actualSeed = seed ?? getMSequenceConfig(sequenceLength).seed;
  
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
 * M-sequence configuration table
 */
const MSEQ_CONFIG = {
  15:  { stepFn: mseq15Step,  bits: 4, seed: 0b1000 },
  31:  { stepFn: mseq31Step,  bits: 5, seed: 0b10101 },
  63:  { stepFn: mseq63Step,  bits: 6, seed: 0b100001 },
  127: { stepFn: mseq127Step, bits: 7, seed: 0b1000001 },
  255: { stepFn: mseq255Step, bits: 8, seed: 0b10000001 }
} as const;

/**
 * Get M-sequence configuration for given length
 */
function getMSequenceConfig(length: number) {
  const config = MSEQ_CONFIG[length as keyof typeof MSEQ_CONFIG];
  if (!config) {
    throw new Error(`Unsupported M-sequence length: ${length}. Supported: ${Object.keys(MSEQ_CONFIG).join(', ')}`);
  }
  return config;
}

/**
 * DSSS despreading: correlate chips with M-sequence to recover bits
 * @param chips Received chip array (+1/-1 or noisy values) as Float32Array
 * @param sequenceLength M-sequence length (must match spreading) - default: 31
 * @param seed LFSR seed (must match spreading seed)
 * @returns Despread bit array (0 or 1) as Uint8Array and correlation values as Float32Array
 */
export function dsssDespread(
  chips: Float32Array, 
  sequenceLength: number = 31, 
  seed?: number
): { bits: Uint8Array, correlations: Float32Array } {
  // Auto-select seed if not provided
  const actualSeed = seed ?? getMSequenceConfig(sequenceLength).seed;
  
  // Generate same M-sequence used for spreading
  const mSequence = generateMSequence(sequenceLength, actualSeed);
  
  const numBits = Math.floor(chips.length / sequenceLength);
  const bits = new Uint8Array(numBits);
  const correlations = new Float32Array(numBits);
  
  for (let bitIndex = 0; bitIndex < numBits; bitIndex++) {
    const startIdx = bitIndex * sequenceLength;
    let correlation = 0;
    
    // Correlate chip segment with M-sequence
    for (let i = 0; i < sequenceLength; i++) {
      correlation += chips[startIdx + i] * mSequence[i];
    }
    
    correlations[bitIndex] = correlation;
    
    // Convert correlation to bit: positive→0, negative→1
    bits[bitIndex] = correlation > 0 ? 0 : 1;
  }
  
  return { bits, correlations };
}


/**
 * DPSK demodulation: convert phase differences to soft values (LLR)
 * @param phases Received phase array in radians as Float32Array
 * @param esN0Db Es/N0 ratio in dB (default: 10dB)
 * @returns Quantized soft values (LLR) as Int8Array (-128 to +127)
 */
export function dpskDemodulate(
  phases: Float32Array, 
  esN0Db: number = 10.0
): Int8Array {
  const esN0Linear = Math.pow(10, esN0Db / 10); // Convert dB to linear
  const softValues = new Int8Array(phases.length - 1);
  
  // Fixed scale to preserve Es/N0 effect (corresponds to ~10dB Es/N0 * 4)
  const fixedMaxValue = esN0Linear * 2;
  
  for (let i = 1; i < phases.length; i++) {
    // Calculate normalized phase difference
    const phaseDiff = normalizePhase(phases[i] - phases[i - 1]);
    
    // LLR calculation using theoretical formula (aec-plan.md)
    // LLR = 2 * Es/N0 * cos(phase_diff) for DPSK
    // cos(0) = +1 (bit 0 likely), cos(π) = -1 (bit 1 likely)
    const llr = 2 * esN0Linear * Math.cos(phaseDiff);
    
    // Scale to [-1, 1] range and quantize to int8 range [-128, +127]
    const scaled = Math.max(-1.0, Math.min(1.0, llr / fixedMaxValue));
    softValues[i - 1] = Math.round(scaled * 127);
  }
  
  return softValues;
}

/**
 * Modulate phases onto carrier frequency
 * @param phases Phase array in radians as Float32Array
 * @param samplesPerPhase Number of samples per phase symbol
 * @param sampleRate Sample rate (Hz)
 * @param carrierFreq Carrier frequency (Hz)
 * @param startSample Starting sample number for phase continuity
 * @returns Real signal samples as Float32Array
 */
export function modulateCarrier(
  phases: Float32Array, 
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
 * @param samples Real signal samples as Float32Array
 * @param samplesPerPhase Number of samples per phase symbol
 * @param sampleRate Sample rate (Hz)
 * @param carrierFreq Carrier frequency (Hz)
 * @param startSample Starting sample number for phase continuity
 * @returns Extracted phase array in radians as Float32Array
 */
export function demodulateCarrier(
  samples: Float32Array, 
  samplesPerPhase: number, 
  sampleRate: number, 
  carrierFreq: number, 
  startSample: number = 0
): Float32Array {
  const omega = 2 * Math.PI * carrierFreq / sampleRate;
  const numPhases = Math.floor(samples.length / samplesPerPhase);
  const phases = new Float32Array(numPhases);
  
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
    
    // Extract phase (corrected order for proper quadrature in this implementation)
    phases[phaseIdx] = Math.atan2(I_avg, Q_avg);
  }
  
  return phases;
}

/**
 * Check phase continuity for discontinuity detection (Step 2 requirement)
 * @param phases Phase array in radians as Float32Array
 * @param threshold Maximum allowed phase jump (default: π - 0.1)
 * @returns Object with continuity status and discontinuity locations
 */
export function checkPhaseContinuity(phases: Float32Array, threshold: number = Math.PI - 0.1): {
  isContinuous: boolean;
  discontinuities: number[];
  maxJump: number;
} {
  const discontinuities: number[] = [];
  let maxJump = 0;
  
  for (let i = 1; i < phases.length; i++) {
    const phaseDiff = normalizePhase(phases[i] - phases[i - 1]);
    
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
 * >>> import numpy as np
 * >>> np.unwrap([0, np.pi, -np.pi, 0, np.pi])
 *  array([0.        , 3.14159265, 3.14159265, 6.28318531, 9.42477796])
 * @param wrappedPhases Wrapped phase array in [-π, π] as Float32Array
 * @returns Unwrapped continuous phase array as Float32Array
 */
export function phaseUnwrap(wrappedPhases: Float32Array): Float32Array {
  if (wrappedPhases.length === 0) return wrappedPhases;
  const unwrapped = new Float32Array(wrappedPhases.length);
  unwrapped[0] = wrappedPhases[0];
  const twoPi = 2 * Math.PI;
  for (let i = 1; i < wrappedPhases.length; i++) {
    let delta = wrappedPhases[i] - wrappedPhases[i - 1];
    delta = ((delta + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
    if (Math.abs(delta + Math.PI) < 1e-6) {
      delta = Math.PI;
    }
    unwrapped[i] = unwrapped[i - 1] + delta;
  }
  return unwrapped;
}

/**
 * Calculate Bit Error Rate between two bit arrays (Step 3 requirement)
 * @param originalBits Original transmitted bits as Uint8Array
 * @param receivedBits Received/recovered bits as Uint8Array
 * @returns BER (0.0 to 1.0)
 */
export function calculateBER(originalBits: Uint8Array, receivedBits: Uint8Array): number {
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
 * @param signal Input signal array as Float32Array
 * @param snrDb Signal-to-Noise Ratio in dB
 * @returns Noisy signal array as Float32Array
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
 * Exploits M-sequence autocorrelation properties for signal detection
 * @param receivedChips Received chip sequence as Float32Array
 * @param referenceSequence Known M-sequence for correlation as Int8Array
 * @param maxOffset Maximum offset to search
 * @returns Object with best offset, correlation peak, and detection metrics
 */
export function findSyncOffset(
  receivedChips: Float32Array,
  referenceSequence: Int8Array, 
  maxOffset: number = 100
): {
  bestOffset: number;
  peakCorrelation: number;
  correlations: Float32Array;
  isFound: boolean;
  peakRatio: number;
} {
  if (receivedChips.length < referenceSequence.length) {
    return {
      bestOffset: -1,
      peakCorrelation: 0,
      correlations: new Float32Array(0),
      isFound: false,
      peakRatio: 0
    };
  }
  
  const sequenceLength = referenceSequence.length;
  const searchLimit = Math.min(maxOffset, receivedChips.length - sequenceLength);
  const correlations = new Float32Array(searchLimit + 1);
  
  let bestOffset = 0;
  let peakCorrelation = 0;
  
  // Compute raw correlation for each offset
  for (let offset = 0; offset <= searchLimit; offset++) {
    let correlation = 0;
    
    // Calculate raw cross-correlation
    for (let i = 0; i < sequenceLength; i++) {
      correlation += receivedChips[offset + i] * referenceSequence[i];
    }
    
    correlations[offset] = correlation;
    
    // Track peak absolute correlation
    if (Math.abs(correlation) > Math.abs(peakCorrelation)) {
      peakCorrelation = correlation;
      bestOffset = offset;
    }
  }
  
  // M-sequence theoretical autocorrelation values:
  // - Perfect alignment: ±N (±31 for M31)
  // - 1-chip misalignment: -1
  // - Processing gain: N (31 for M31)
  //
  // Detection threshold: approximately 50% of perfect correlation
  // This allows for some noise while maintaining processing gain
  const theoreticalPeak = sequenceLength; // ±31 for M31
  const detectionThreshold = theoreticalPeak * 0.5; // 15.5 for M31
  
  const isFound = Math.abs(peakCorrelation) >= detectionThreshold;
  
  // Calculate peak-to-average ratio for compatibility
  let sumAbs = 0;
  let count = 0;
  for (let i = 0; i <= searchLimit; i++) {
    if (i !== bestOffset) {
      sumAbs += Math.abs(correlations[i]);
      count++;
    }
  }
  const averageCorrelation = count > 0 ? sumAbs / count : 0;
  const peakRatio = averageCorrelation > 0 ? Math.abs(peakCorrelation) / averageCorrelation : 0;
  
  return {
    bestOffset,
    peakCorrelation,
    correlations,
    isFound,
    peakRatio
  };
}


/**
 * Apply synchronization offset to align received data (Step 4 requirement)
 * @param receivedData Received data array (chips or samples) as Float32Array
 * @param offset Synchronization offset to apply
 * @returns Aligned data array starting from offset as Float32Array
 */
export function applySyncOffset(receivedData: Float32Array, offset: number): Float32Array {
  if (offset < 0 || offset >= receivedData.length) {
    return new Float32Array(0);
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
  const actualSeed = seed ?? getMSequenceConfig(sequenceLength).seed;
  return generateMSequence(sequenceLength, actualSeed);
}
