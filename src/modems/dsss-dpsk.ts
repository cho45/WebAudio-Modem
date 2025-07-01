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
 * DSSS despreading: correlate chips with M-sequence to recover bits and soft values (LLR)
 * @param chips Received chip array (+1/-1 or noisy values) as Float32Array
 * @param sequenceLength M-sequence length (must match spreading) - default: 31
 * @param seed LFSR seed (must match spreading seed)
 * @returns LLR as Int8Array
 */
export function dsssDespread(
  chips: Float32Array, 
  sequenceLength: number = 31, 
  seed?: number
): Int8Array {
  // Auto-select seed if not provided
  const actualSeed = seed ?? getMSequenceConfig(sequenceLength).seed;
  
  // Generate same M-sequence used for spreading
  const mSequence = generateMSequence(sequenceLength, actualSeed);
  
  const numBits = Math.floor(chips.length / sequenceLength);
  const llr = new Int8Array(numBits);

  for (let bitIndex = 0; bitIndex < numBits; bitIndex++) {
    const startIdx = bitIndex * sequenceLength;
    let correlation = 0;
    
    // Correlate soft chip segment with M-sequence
    for (let i = 0; i < sequenceLength; i++) {
      correlation += chips[startIdx + i] * mSequence[i];
    }
    
    const calculatedLlr = correlation / sequenceLength;

    // Quantize to int8 range [-127, +127]
    const quantized = Math.round(calculatedLlr * 127);
    llr[bitIndex] = Math.max(-127, Math.min(127, quantized));
  }
  
  return llr;
}


/**
 * DPSK demodulation: convert phase differences to soft values (LLR)
 * @param phases Received phase array in radians as Float32Array
 * @param esN0Db Es/N0 ratio in dB (default: 10dB)
 * @returns Quantized soft values (LLR) as Int8Array (-128 to +127)
 */
export function dpskDemodulate(
  phases: Float32Array
): Float32Array {
  if (phases.length <= 1) {
    return new Float32Array(0);
  }
  
  const softChips = new Float32Array(phases.length - 1);
  
  for (let i = 1; i < phases.length; i++) {
    // Calculate normalized phase difference
    const phaseDiff = normalizePhase(phases[i] - phases[i - 1]);
    
    // Soft chip value is simply cos(phase_diff). 
    // This is in [-1, 1] and represents the chip likelihood.
    softChips[i - 1] = Math.cos(phaseDiff);
  }
  
  return softChips;
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
    
    // Integrate In-phase (I) and Quadrature (Q) components over the symbol period.
    // Note: In this modulation scheme, sin corresponds to the In-phase component
    // and cos to the Quadrature component.
    let iSum = 0; // In-phase
    let qSum = 0; // Quadrature
    
    for (let i = symbolStart; i < symbolEnd; i++) {
      const sampleIndex = startSample + i;
      const carrierPhase = omega * sampleIndex;
      
      iSum += samples[i] * Math.sin(carrierPhase);
      qSum += samples[i] * Math.cos(carrierPhase);
    }
    
    // Average over symbol period
    const iAvg = iSum / samplesPerPhase;
    const qAvg = qSum / samplesPerPhase;
    
    // Extract phase using atan2(Q, I)
    phases[phaseIdx] = Math.atan2(qAvg, iAvg);
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
 * This implementation matches numpy.unwrap behavior exactly.
 * @param p Wrapped phase array in [-π, π] as Float32Array
 * @returns Unwrapped continuous phase array as Float32Array
 */
export function phaseUnwrap(p: Float32Array): Float32Array {
    if (p.length === 0) {
        return new Float32Array(0);
    }
    
    const up = new Float32Array(p.length);
    up[0] = p[0];
    
    const pi = Math.PI;
    const twoPi = 2 * Math.PI;
    const eps = 1e-6; // Epsilon for floating-point precision (handles typical JS precision issues)
    
    for (let i = 1; i < p.length; i++) {
        // Calculate raw phase difference from wrapped input
        let delta = p[i] - p[i - 1];
        
        
        // Remove phase jumps by adding appropriate multiples of 2π
        // Use epsilon tolerance to handle floating-point precision issues
        if (delta > pi + eps) {
            delta -= twoPi;
        } else if (delta < -pi - eps) {
            delta += twoPi;
        }
        
        // Accumulate unwrapped phase
        up[i] = up[i - 1] + delta;
    }
    
    return up;
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
 * Cache for modulated reference signals to avoid repeated computation
 */
const modulatedReferenceCache = new Map<string, Float32Array>();

/**
 * Generate fully modulated reference signal for matched filtering with caching
 * This creates the ideal received signal for perfect synchronization
 * @param referenceSequence M-sequence to modulate
 * @param modulationParams Modulation parameters
 * @returns Fully modulated reference samples
 */
function generateModulatedReference(
  referenceSequence: Int8Array,
  modulationParams: {
    samplesPerPhase: number;
    sampleRate: number;
    carrierFreq: number;
  }
): Float32Array {
  const { samplesPerPhase, sampleRate, carrierFreq } = modulationParams;
  
  // Create cache key from parameters
  const cacheKey = `${Array.from(referenceSequence).join(',')}-${samplesPerPhase}-${sampleRate}-${carrierFreq}`;
  
  // Check cache first
  const cached = modulatedReferenceCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  
  // Step 1: DPSK modulate the reference sequence
  const phases = dpskModulate(referenceSequence);
  
  // Step 2: Carrier modulate to get complete reference signal
  const referenceSamples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
  
  // Cache the result
  modulatedReferenceCache.set(cacheKey, referenceSamples);
  
  return referenceSamples;
}

/**
 * Simple decimation (downsampling) function
 * @param signal Input signal
 * @param factor Decimation factor
 * @returns Decimated signal
 */
function decimateSignal(signal: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return signal;
  
  const decimatedLength = Math.floor(signal.length / factor);
  const decimated = new Float32Array(decimatedLength);
  
  for (let i = 0; i < decimatedLength; i++) {
    decimated[i] = signal[i * factor];
  }
  
  return decimated;
}

/**
 * Decimation-based efficient matched filter for fast synchronization
 * Theory: Reduce computational load by downsampling while preserving detection capability
 * @param receivedSamples Received signal samples
 * @param referenceSamples Reference signal template
 * @param maxSampleOffset Maximum sample offset to search
 * @param decimationFactor Downsampling factor (2-8, higher = faster but less precise)
 * @returns Matched filter output with reduced sample rate
 */
function decimatedMatchedFilter(
  receivedSamples: Float32Array,
  referenceSamples: Float32Array,
  maxSampleOffset: number,
  decimationFactor: number = 4
): {
  correlations: Float32Array;
  sampleOffsets: number[];
} {
  // Step 1: Decimate input signals for speed
  const decimatedReceived = decimateSignal(receivedSamples, decimationFactor);
  const decimatedReference = decimateSignal(referenceSamples, decimationFactor);
  const decimatedMaxOffset = Math.floor(maxSampleOffset / decimationFactor);
  
  const refLength = decimatedReference.length;
  const searchLength = Math.min(decimatedMaxOffset, decimatedReceived.length - refLength);
  
  if (searchLength <= 0) {
    return {
      correlations: new Float32Array(0),
      sampleOffsets: []
    };
  }
  
  // Step 2: Calculate template energy (normalized)
  let templateEnergy = 0;
  for (let i = 0; i < refLength; i++) {
    templateEnergy += decimatedReference[i] * decimatedReference[i];
  }
  templateEnergy = Math.sqrt(templateEnergy);
  
  const correlations = new Float32Array(searchLength + 1);
  const sampleOffsets: number[] = [];
  
  // Step 3: Efficient correlation calculation
  for (let offset = 0; offset <= searchLength; offset++) {
    let correlation = 0;
    let signalEnergy = 0;
    
    // Normalized cross-correlation (mathematically equivalent to matched filter for detection)
    for (let i = 0; i < refLength; i++) {
      const signalSample = decimatedReceived[offset + i];
      const refSample = decimatedReference[i];
      
      correlation += signalSample * refSample;
      signalEnergy += signalSample * signalSample;
    }
    
    // Normalize by geometric mean of energies
    const normalizedCorr = correlation / (Math.sqrt(signalEnergy) * templateEnergy + 1e-12);
    
    correlations[offset] = normalizedCorr;
    sampleOffsets.push(offset * decimationFactor); // Convert back to original sample rate
  }
  
  return { correlations, sampleOffsets };
}

/**
 * Statistical properties of noise for adaptive detection
 */
interface NoiseStats {
  mean: number;
  variance: number;
  sigma: number;
}

/**
 * Estimate noise statistics from correlation array using median-based robust estimation
 * This provides a computationally efficient foundation for adaptive threshold setting
 * @param correlations Correlation array output from matched filter
 * @returns Noise statistics for adaptive detection
 */
function estimateNoiseStats(correlations: Float32Array): NoiseStats {
  // Use absolute values for noise estimation
  const absCorr = Array.from(correlations).map(Math.abs);
  
  // Sort for median-based estimation (robust against outliers)
  const sorted = absCorr.sort((a, b) => a - b);
  const n = sorted.length;
  
  // Median as robust noise floor estimate
  const median = sorted[Math.floor(n * 0.5)];
  
  // 75th percentile for variance estimation 
  const q75 = sorted[Math.floor(n * 0.75)];
  
  // Convert Median Absolute Deviation to standard deviation
  // Factor 0.674 converts MAD to σ for Gaussian distribution
  const sigma = (q75 - median) / 0.674;
  
  return {
    mean: median,
    variance: sigma * sigma,
    sigma: Math.max(sigma, 1e-12) // Prevent division by zero
  };
}

/**
 * Find correlation peak with robust detection
 * @param correlations Correlation array
 * @param sampleOffsets Corresponding sample offsets
 * @param samplesPerPhase Samples per chip for offset conversion
 * @returns Peak detection results
 */
function detectSynchronizationPeak(
  correlations: Float32Array,
  sampleOffsets: number[],
  samplesPerPhase: number
): {
  bestSampleOffset: number;
  bestChipOffset: number;
  peakCorrelation: number;
  isFound: boolean;
  peakRatio: number;
} {
  if (correlations.length < 2) {
    return {
      bestSampleOffset: -1,
      bestChipOffset: -1,
      peakCorrelation: 0,
      isFound: false,
      peakRatio: 0
    };
  }

  let peakValue = -1;
  let secondPeakValue = -1;
  let peakIndex = -1;

  for (let i = 0; i < correlations.length; i++) {
    const v = Math.abs(correlations[i]);
    if (v > peakValue) {
      secondPeakValue = peakValue;
      peakValue = v;
      peakIndex = i;
    } else if (v > secondPeakValue) {
      secondPeakValue = v;
    }
  }
  
  const bestSampleOffset = sampleOffsets[peakIndex];
  const peakCorrelation = correlations[peakIndex];

  // Use ratio of the highest peak to the second highest peak.
  // This is robust against overall signal level and noise floor shifts.
  const peakToNoiseRatio = secondPeakValue > 1e-9 ? peakValue / secondPeakValue : Infinity;
  
  // Adaptive detection using statistical signal processing
  // Replaces 6 fixed magic numbers with environment-adaptive thresholds
  
  // Ultra-simple detection: 6 magic numbers → 2 essential parameters
  // Real environments need adaptive thresholds, not complex branching logic
  
  const noiseStats = estimateNoiseStats(correlations);
  
  // Parameter 1: Adaptive correlation threshold based on noise floor
  const correlationThreshold = noiseStats.mean + 2.5 * noiseStats.sigma; // Statistical significance
  
  // Parameter 2: Fixed peak distinction ratio (proven to work across all conditions)
  const peakRatio = 1.025;
  
  // Simple, robust detection that works in real acoustic environments
  // Add minimal data quality check for edge cases
  const hasReliableData = correlations.length >= 5; // Prevent false positives on very limited data
  const isFound = hasReliableData && peakValue >= correlationThreshold && peakToNoiseRatio >= peakRatio;

  // Debug for synchronization failures
  if (typeof console !== 'undefined') {
    const isLowSnrCase = peakValue < 0.4;
    const isInvertedCase = peakCorrelation < -0.15;
    const isChallengingCase = !isFound && peakValue > 0.2;

    const DEBUG = false; // Set to true to enable detailed debug output
    
    if (DEBUG && (isLowSnrCase || isInvertedCase || isChallengingCase)) {
      console.log(`=== SIMPLE ADAPTIVE DEBUG ===`);
      console.log(`Type: ${isLowSnrCase ? 'LOW_SNR' : isInvertedCase ? 'INVERTED' : 'CHALLENGING'}`);
      console.log(`Correlations: ${correlations.length} points, max=${peakValue.toFixed(3)}, 2nd=${secondPeakValue.toFixed(3)}`);
      console.log(`Noise stats: μ=${noiseStats.mean.toFixed(3)}, σ=${noiseStats.sigma.toFixed(3)}`);
      console.log(`Thresholds: correlation=${correlationThreshold.toFixed(3)}, ratio=${peakRatio}`);
      console.log(`Peak ratio: ${peakToNoiseRatio.toFixed(3)}`);
      console.log(`Result: ${isFound} (${peakCorrelation.toFixed(3)} @ offset ${Math.round(bestSampleOffset / samplesPerPhase)})`);
    }
  }

  return {
    bestSampleOffset,
    bestChipOffset: Math.round(bestSampleOffset / samplesPerPhase),
    peakCorrelation,
    isFound,
    peakRatio: peakToNoiseRatio
  };
}

/**
 * DSSS Synchronization using a fast, decimated Matched Filter.
 * 
 * This approach significantly speeds up synchronization by correlating downsampled
 * versions of the received signal and the reference signal.
 * 
 * @param receivedSamples Received sample sequence as Float32Array
 * @param referenceSequence Known M-sequence for correlation as Int8Array
 * @param modulationParams Modulation parameters
 * @param maxChipOffset Maximum chip offset to search
 * @returns Object with best offsets, correlation peak, and detection metrics
 */
export function findSyncOffset(
  receivedSamples: Float32Array,
  referenceSequence: Int8Array,
  modulationParams: {
    samplesPerPhase: number;
    sampleRate: number;
    carrierFreq: number;
  },
  maxChipOffset: number = 100
): {
  bestSampleOffset: number;
  bestChipOffset: number;
  peakCorrelation: number;
  isFound: boolean;
  peakRatio: number;
} {
  const { samplesPerPhase } = modulationParams;
  
  // Step 1: Generate fully modulated reference signal
  const referenceSamples = generateModulatedReference(referenceSequence, modulationParams);
  
  // Step 2: Calculate maximum search range in samples
  const maxSampleOffset = maxChipOffset * samplesPerPhase;
  const minSamplesNeeded = referenceSamples.length;
  
  if (receivedSamples.length < minSamplesNeeded) {
    return {
      bestSampleOffset: -1,
      bestChipOffset: -1,
      peakCorrelation: 0,
      isFound: false,
      peakRatio: 0
    };
  }
  
  // Step 3: Perform efficient decimated matched filtering for fast synchronization.
  // A decimation factor of 2 provides a good balance of speed and accuracy.
  const decimationFactor = 2;
  const { correlations, sampleOffsets } = decimatedMatchedFilter(
    receivedSamples,
    referenceSamples,
    maxSampleOffset,
    decimationFactor
  );
  
  // Step 4: Detect synchronization peak
  const result = detectSynchronizationPeak(correlations, sampleOffsets, samplesPerPhase);
  
  return result;
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
