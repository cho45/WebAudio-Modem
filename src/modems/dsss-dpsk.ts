/**
 * DSSS + DPSK Modem Implementation
 * Complete DPSK modulation with DSSS spreading and carrier processing
 */

import { mseq15Step, mseqOutput } from '../utils/msequence';

/**
 * Convert bits to DPSK phase differences
 * @param bits Input bit array (0 or 1)
 * @returns Phase differences in radians (0 for bit 0, π for bit 1)
 */
export function bitsToPhaseDifferences(bits: number[]): number[] {
  return bits.map(bit => bit === 0 ? 0 : Math.PI);
}

/**
 * Accumulate phase differences to absolute phases with continuity
 * @param phaseDifferences Phase difference array in radians
 * @param initialPhase Starting phase (default: 0)
 * @returns Absolute phase array in radians
 */
export function accumulatePhases(phaseDifferences: number[], initialPhase: number = 0): number[] {
  const phases: number[] = [];
  let currentPhase = initialPhase;
  
  for (const phaseDiff of phaseDifferences) {
    phases.push(currentPhase);
    currentPhase += phaseDiff;
  }
  
  return phases;
}

/**
 * Complete DPSK modulation: bits to phases with phase accumulator
 * @param bits Input bit array (0 or 1)
 * @param initialPhase Starting phase (default: 0)
 * @returns Absolute phase array for carrier modulation
 */
export function dpskModulate(bits: number[], initialPhase: number = 0): number[] {
  const phaseDifferences = bitsToPhaseDifferences(bits);
  return accumulatePhases(phaseDifferences, initialPhase);
}

/**
 * Generate M15 sequence (15-chip pseudo-random sequence)
 * @param seed LFSR initial state (default: 0b1000, non-zero required)
 * @returns 15-element M-sequence array (+1/-1 values)
 */
export function generateM15Sequence(seed: number = 0b1000): number[] {
  const sequence: number[] = [];
  let register = seed;
  
  for (let i = 0; i < 15; i++) {
    const bit = mseqOutput(register, 4);
    sequence.push(bit === 0 ? -1 : 1); // Convert 0/1 to -1/+1
    register = mseq15Step(register);
  }
  
  return sequence;
}

/**
 * Spread bits using DSSS with M15 sequence
 * @param bits Input bit array (0 or 1) 
 * @param mSequence M15 sequence (+1/-1 values, length 15)
 * @returns Spread chip array (+1/-1 values)
 */
export function dsssSpread(bits: number[], mSequence: number[]): number[] {
  const chips: number[] = [];
  
  for (const bit of bits) {
    const sign = bit === 0 ? 1 : -1; // Bit 0 → +1, Bit 1 → -1
    
    for (const chip of mSequence) {
      chips.push(sign * chip);
    }
  }
  
  return chips;
}

/**
 * Complete DSSS spreading with default M15 sequence
 * @param bits Input bit array (0 or 1)
 * @param seed M15 LFSR seed (default: 0b1000)
 * @returns Spread chip array (+1/-1 values)
 */
export function dsssSpreadWithM15(bits: number[], seed: number = 0b1000): number[] {
  const mSequence = generateM15Sequence(seed);
  return dsssSpread(bits, mSequence);
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

