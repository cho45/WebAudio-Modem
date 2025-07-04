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

import { mseq15Step, mseq31Step, mseq63Step, mseq127Step, mseq255Step, mseqOutput } from '../../utils/msequence';

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
 * DSSS despreading: correlate chips with M-sequence to compute Log-Likelihood Ratios (LLR)
 * @param chips Received chip array (+1/-1 or noisy values) as Float32Array
 * @param sequenceLength M-sequence length (must match spreading) - default: 31
 * @param seed LFSR seed (must match spreading seed)
 * @param noiseVariance Estimated noise variance - if not provided, estimated from signal
 * @returns True LLR as Int8Array: LLR = ln(P(correlation|bit=0)/P(correlation|bit=1))
 */
export function dsssDespread(
  chips: Float32Array, 
  sequenceLength: number = 31, 
  seed?: number,
  noiseVariance?: number
): Int8Array {
  // Auto-select seed if not provided
  const actualSeed = seed ?? getMSequenceConfig(sequenceLength).seed;
  
  // Generate same M-sequence used for spreading
  const mSequence = generateMSequence(sequenceLength, actualSeed);
  
  const numBits = Math.floor(chips.length / sequenceLength);
  const llr = new Int8Array(numBits);

  // Estimate noise variance if not provided
  let estimatedNoiseVar = noiseVariance;
  if (!estimatedNoiseVar) {
    // Check if we have perfect noiseless chips (all values exactly +1 or -1)
    // const isPerfectSignal = Array.from(chips).every(chip => Math.abs(Math.abs(chip) - 1.0) < 1e-6); // 常にfalseになるようにコメントアウト
    
    // if (isPerfectSignal) {
    //   estimatedNoiseVar = 0.01;
    // } else {
      const sortedMagnitudes = Array.from(chips).map(Math.abs).sort((a, b) => a - b);
      const medianMagnitude = sortedMagnitudes[Math.floor(sortedMagnitudes.length / 2)];
      console.log(`[DsssDpskDemodulator] dsssDespread: medianMagnitude=${medianMagnitude}`);
      estimatedNoiseVar = Math.pow(medianMagnitude / 0.674, 2);
      estimatedNoiseVar = Math.max(estimatedNoiseVar, 1.0); // Prevent division by zero, adjusted for noisy signals
    // }
  }

  for (let bitIndex = 0; bitIndex < numBits; bitIndex++) {
    const startIdx = bitIndex * sequenceLength;
    let correlation = 0;
    
    // Correlate soft chip segment with M-sequence
    for (let i = 0; i < sequenceLength; i++) {
      correlation += chips[startIdx + i] * mSequence[i];
    }
    
    // True Log-Likelihood Ratio for DSSS correlation under AWGN
    // Assuming: 
    // - bit=0: correlation ~ N(+A*L, σ²*L) where A=signal amplitude, L=sequence length
    // - bit=1: correlation ~ N(-A*L, σ²*L)  
    // LLR = ln(P(correlation|bit=0)/P(correlation|bit=1))
    //     = (correlation * 2*A*L) / (σ²*L) = (2*A/σ²) * correlation
    // For unit amplitude (A=1): LLR = (2/σ²) * correlation
    const trueLLR = (2.0 / estimatedNoiseVar) * correlation;

    // Quantize to int8 range [-127, +127] with theoretical scaling
    // For perfect correlation (correlation = sequenceLength), we want LLR = ±127
    // trueLLR = (2/σ²) * correlation, so scaling = 127 / max_expected_LLR
    const maxExpectedCorrelation = sequenceLength;
    const maxExpectedLLR = (2.0 / estimatedNoiseVar) * maxExpectedCorrelation;
    const dynamicScaleFactor = 127.0 / Math.abs(maxExpectedLLR);
    
    const scaledLLR = trueLLR * dynamicScaleFactor;
    llr[bitIndex] = Math.max(-127, Math.min(127, Math.round(scaledLLR)));
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
  
  console.log(`[DsssDpskDemodulator] dpskDemodulate: softChips (first 10) = ${softChips.slice(0, 10).join(', ')}`); // ここにログを追加
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

  // Debug: Log input parameters
  console.log(`[MatchedFilter DEBUG] Input: received=${receivedSamples.length}, reference=${referenceSamples.length}, maxOffset=${maxSampleOffset}, decimation=${decimationFactor}`);

  // Step 1: Decimate input signals for speed
  const decimatedReceived = decimateSignal(receivedSamples, decimationFactor);
  const decimatedReference = decimateSignal(referenceSamples, decimationFactor);
  const decimatedMaxOffset = Math.floor(maxSampleOffset / decimationFactor);
  
  const refLength = decimatedReference.length;
  const searchLength = Math.min(decimatedMaxOffset, decimatedReceived.length - refLength);
  
  console.log(`[MatchedFilter DEBUG] Decimated: received=${decimatedReceived.length}, reference=${decimatedReference.length}, maxOffset=${decimatedMaxOffset}`);
  console.log(`[MatchedFilter DEBUG] Search: refLength=${refLength}, searchLength=${searchLength}`);
  
  if (searchLength <= 0) {
    console.log(`[MatchedFilter DEBUG] SearchLength <= 0, returning empty result`);
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
 * DSSS synchronization detection with externally configurable detection thresholds
 * @param correlations Normalized correlation array from matched filter
 * @param sampleOffsets Corresponding sample offsets  
 * @param samplesPerPhase Samples per chip for offset conversion
 * @param thresholds Detection parameters (must be externally provided - no magic numbers)
 * @returns Peak detection results
 */
function detectSynchronizationPeak(
  correlations: Float32Array,
  sampleOffsets: number[],
  samplesPerPhase: number,
  thresholds: {
    correlationThreshold: number;    // Minimum correlation for detection (externally specified)
    peakToNoiseRatio: number;       // Minimum peak-to-noise ratio (externally specified)
  }
): {
  bestSampleOffset: number;
  bestChipOffset: number;
  peakCorrelation: number;
  isFound: boolean;
  peakRatio: number;
} {
  // Use externally provided thresholds - no internal defaults or magic numbers
  const correlationThreshold = thresholds.correlationThreshold;
  const peakToNoiseRatioThreshold = thresholds.peakToNoiseRatio;

  if (correlations.length < 2) {
    return {
      bestSampleOffset: -1,
      bestChipOffset: -1,
      peakCorrelation: 0,
      isFound: false,
      peakRatio: 0
    };
  }

  // Find peak correlation
  let peakValue = -1;
  let peakIndex = -1;
  
  for (let i = 0; i < correlations.length; i++) {
    const v = Math.abs(correlations[i]);
    if (v > peakValue) {
      peakValue = v;
      peakIndex = i;
    }
  }
  
  const bestSampleOffset = sampleOffsets[peakIndex];
  const peakCorrelation = correlations[peakIndex];

  // Simple noise floor estimation from median
  const sortedCorrelations = Array.from(correlations).map(Math.abs).sort((a, b) => a - b);
  const medianCorrelation = sortedCorrelations[Math.floor(sortedCorrelations.length / 2)];
  const noiseFloor = Math.max(medianCorrelation, 1e-6); // Prevent division by zero
  
  const peakToNoiseRatio = peakValue / noiseFloor;
  
  // Simple two-criteria detection
  const meetsCorrelationThreshold = peakValue >= correlationThreshold;
  const meetsNoiseRatioThreshold = peakToNoiseRatio >= peakToNoiseRatioThreshold;
  
  const isFound = meetsCorrelationThreshold && meetsNoiseRatioThreshold;

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
  maxChipOffset: number,
  detectionThresholds: {
    correlationThreshold: number;
    peakToNoiseRatio: number;
  }
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
  
  console.log(`[FindSync DEBUG] Input: received=${receivedSamples.length}, reference=${referenceSamples.length}, maxChipOffset=${maxChipOffset}`);
  console.log(`[FindSync DEBUG] Calculated: maxSampleOffset=${maxSampleOffset}, minSamplesNeeded=${minSamplesNeeded}`);
  
  if (receivedSamples.length < minSamplesNeeded) {
    console.log(`[FindSync DEBUG] Insufficient samples: ${receivedSamples.length} < ${minSamplesNeeded}`);
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
  
  // Step 4: Detect synchronization peak using externally provided thresholds
  const result = detectSynchronizationPeak(correlations, sampleOffsets, samplesPerPhase, detectionThresholds);
  
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
