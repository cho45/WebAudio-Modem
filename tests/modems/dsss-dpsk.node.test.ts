import { describe, test, expect } from 'vitest';
import { 
  dpskModulate,
  dsssSpread,
  dsssDespread,
  dpskDemodulate,
  modulateCarrier, 
  demodulateCarrier,
  checkPhaseContinuity,
  phaseUnwrap,
  calculateBER,
  addAWGN,
  findSyncOffset,
  applySyncOffset,
  generateSyncReference
} from '../../src/modems/dsss-dpsk';

describe('DPSK Modulation', () => {
  const TOLERANCE = 0.01; // Phase tolerance in radians

  test('should perform complete DPSK modulation', () => {
    const bits = [0, 1, 0, 1];
    const phases = dpskModulate(bits);
    
    expect(phases.length).toBe(4);
    expect(phases[0]).toBeCloseTo(0, 5); // initial phase
    expect(phases[1]).toBeCloseTo(0, 5); // 0 + 0
    expect(phases[2]).toBeCloseTo(Math.PI, 5); // 0 + π
    expect(phases[3]).toBeCloseTo(Math.PI, 5); // π + 0
  });

  test('should work with custom initial phase', () => {
    const bits = [1, 0];
    const initialPhase = Math.PI / 4;
    const phases = dpskModulate(bits, initialPhase);
    
    expect(phases[0]).toBeCloseTo(Math.PI / 4, 5);
    expect(phases[1]).toBeCloseTo(Math.PI / 4 + Math.PI, 5); // π/4 + π
  });

  test('should handle alternating pattern correctly', () => {
    const bits = [1, 1, 1, 1];
    const phases = dpskModulate(bits);
    
    expect(phases[0]).toBeCloseTo(0, 5);
    expect(phases[1]).toBeCloseTo(Math.PI, 5);
    expect(phases[2]).toBeCloseTo(2 * Math.PI, 5);
    expect(phases[3]).toBeCloseTo(3 * Math.PI, 5);
  });

  test('should handle empty array', () => {
    const bits: number[] = [];
    const phases = dpskModulate(bits);
    
    expect(phases).toEqual([]);
  });
});

describe('DSSS Spreading', () => {
  test('should generate correct spread chip length', () => {
    const bits = [0, 1, 0, 1];
    const chips = dsssSpread(bits);
    
    expect(chips.length).toBe(bits.length * 31); // 31-chip M-sequence (default)
  });

  test('should produce +1/-1 chips only', () => {
    const bits = [0, 1];
    const chips = dsssSpread(bits);
    
    for (const chip of chips) {
      expect(chip === 1 || chip === -1).toBe(true);
    }
  });

  test('should spread bit 0 as positive sequence', () => {
    const bits = [0];
    const chips = dsssSpread(bits);
    
    expect(chips.length).toBe(31);
    // First chip should be positive (bit 0 → +1, first M31 chip is +1)
    expect(chips[0]).toBe(1);
  });

  test('should spread bit 1 as negative sequence', () => {
    const bits = [1];
    const chips = dsssSpread(bits);
    
    expect(chips.length).toBe(31);
    // First chip should be negative (bit 1 → -1, first M31 chip is +1, so -1*1=-1)
    expect(chips[0]).toBe(-1);
  });

  test('should use consistent M31 sequence across calls', () => {
    const bits1 = [0];
    const bits2 = [0];
    const chips1 = dsssSpread(bits1);
    const chips2 = dsssSpread(bits2);
    
    expect(chips1).toEqual(chips2);
  });

  test('should handle different M-sequence lengths', () => {
    const bits = [0];
    const chips15 = dsssSpread(bits, 15);
    const chips31 = dsssSpread(bits, 31);
    
    expect(chips15.length).toBe(15);
    expect(chips31.length).toBe(31);
    expect(chips15).not.toEqual(chips31); // Different lengths should produce different sequences
  });

  test('should handle different seeds', () => {
    const bits = [0];
    const chips1 = dsssSpread(bits, 31, 0b10101);
    const chips2 = dsssSpread(bits, 31, 0b01010);
    
    expect(chips1.length).toBe(31);
    expect(chips2.length).toBe(31);
    expect(chips1).not.toEqual(chips2); // Different seeds should produce different sequences
  });

  test('should handle empty array', () => {
    const bits: number[] = [];
    const chips = dsssSpread(bits);
    
    expect(chips.length).toBe(0);
    expect(chips).toBeInstanceOf(Int8Array);
  });
});

describe('DSSS Despreading', () => {
  test('should recover original bits perfectly', () => {
    const originalBits = [0, 1, 0, 1];
    const chips = dsssSpread(originalBits);
    const { bits, correlations } = dsssDespread(chips);
    
    expect(bits).toEqual(originalBits);
    expect(correlations.length).toBe(originalBits.length);
    
    // Check correlation magnitudes (should be ±31 for perfect correlation with M31)
    for (const correlation of correlations) {
      expect(Math.abs(correlation)).toBe(31);
    }
  });

  test('should handle single bit', () => {
    const originalBits = [1];
    const chips = dsssSpread(originalBits);
    const { bits, correlations } = dsssDespread(chips);
    
    expect(bits).toEqual(originalBits);
    expect(correlations.length).toBe(1);
    expect(correlations[0]).toBe(-31); // Bit 1 → negative correlation
  });

  test('should work with different seeds', () => {
    const originalBits = [0, 1];
    const seed = 0b01010;
    
    const chips = dsssSpread(originalBits, 31, seed);
    const { bits } = dsssDespread(chips, 31, seed);
    
    expect(bits).toEqual(originalBits);
  });

  test('should handle noisy chips', () => {
    const originalBits = [0, 1, 0];
    const chips = dsssSpread(originalBits);
    
    // Add small amount of noise
    const noisyChips = chips.map(chip => chip + (Math.random() - 0.5) * 0.2);
    
    const { bits } = dsssDespread(noisyChips);
    expect(bits).toEqual(originalBits);
  });

  test('should handle partial chip arrays', () => {
    const originalBits = [0, 1, 0];
    const chips = dsssSpread(originalBits);
    
    // Take only first 2 complete symbols (62 chips for M31)
    const partialChips = chips.slice(0, 62);
    const { bits } = dsssDespread(partialChips);
    
    expect(bits).toEqual([0, 1]);
  });

  test('should handle empty chip array', () => {
    const chips: number[] = [];
    const { bits, correlations } = dsssDespread(chips);
    
    expect(bits).toEqual([]);
    expect(correlations).toEqual([]);
  });
});

describe('DPSK Demodulation', () => {
  test('should generate correct soft values for phase differences', () => {
    // Create phases with known phase differences
    const phases = [0, 0, Math.PI, Math.PI, 0]; // Phase diffs: 0, π, 0, -π
    const softValues = dpskDemodulate(phases);
    
    expect(softValues.length).toBe(4);
    
    // Phase diff 0 → positive LLR (bit 0 more likely)
    expect(softValues[0]).toBeGreaterThan(0);
    
    // Phase diff π → negative LLR (bit 1 more likely)
    expect(softValues[1]).toBeLessThan(0);
    
    // Phase diff 0 → positive LLR (bit 0 more likely)
    expect(softValues[2]).toBeGreaterThan(0);
    
    // Phase diff -π → negative LLR (bit 1 more likely)
    expect(softValues[3]).toBeLessThan(0);
  });

  test('should handle phase wraparound correctly', () => {
    const phases = [0, 2 * Math.PI]; // Should be equivalent to [0, 0]
    const softValues = dpskDemodulate(phases);
    
    expect(softValues.length).toBe(1);
    expect(softValues[0]).toBeGreaterThan(0); // Should indicate bit 0
  });

  test('should scale with noise variance', () => {
    const phases = [0, Math.PI / 4]; // Phase diff = π/4 (intermediate value)
    
    const softValues1 = dpskDemodulate(phases, 15.0); // Higher Es/N0
    const softValues2 = dpskDemodulate(phases, 8.0);  // Lower Es/N0
    
    // Higher noise (lower Es/N0) should reduce LLR magnitude
    expect(Math.abs(softValues2[0])).toBeLessThan(Math.abs(softValues1[0]));
  });

  test('should handle single phase', () => {
    const phases = [Math.PI / 4];
    const softValues = dpskDemodulate(phases);
    
    expect(softValues.length).toBe(0);
  });

  test('should handle intermediate phase differences', () => {
    const phases = [0, Math.PI / 2]; // Phase diff = π/2 (ambiguous)
    const softValues = dpskDemodulate(phases);
    
    expect(softValues.length).toBe(1);
    // π/2 is between 0 and π, should have smaller magnitude LLR
    expect(Math.abs(softValues[0])).toBeLessThan(10); // Less confident
  });
});

describe('Complete DSSS-DPSK Pipeline', () => {
  test('should recover original bits through complete pipeline', () => {
    const originalBits = [0, 1, 0, 1];
    
    // Forward path: bits → DSSS chips → carrier modulation
    const chips = dsssSpread(originalBits);
    
    // Convert chips to phases for carrier modulation
    const chipPhases = chips.map(chip => chip > 0 ? 0 : Math.PI);
    
    const samplesPerPhase = 100;
    const sampleRate = 48000;
    const carrierFreq = 10000;
    
    const modulated = modulateCarrier(chipPhases, samplesPerPhase, sampleRate, carrierFreq);
    
    // Reverse path: carrier demodulation → DSSS despreading → DPSK demodulation
    const demodulatedPhases = demodulateCarrier(modulated, samplesPerPhase, sampleRate, carrierFreq);
    
    // Convert phases back to chips
    const recoveredChips = demodulatedPhases.map(phase => {
      let normalizedPhase = phase;
      while (normalizedPhase > Math.PI) normalizedPhase -= 2 * Math.PI;
      while (normalizedPhase < -Math.PI) normalizedPhase += 2 * Math.PI;
      return Math.abs(normalizedPhase) < Math.PI / 2 ? 1 : -1;
    });
    
    const { bits: recoveredBits } = dsssDespread(recoveredChips);
    
    expect(recoveredBits).toEqual(originalBits);
  });

  test('should work with different bit patterns', () => {
    const testPatterns = [
      [0],
      [1],
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [0, 1, 0, 1, 0, 1],
      [1, 0, 1, 0, 1, 0]
    ];

    for (const originalBits of testPatterns) {
      const chips = dsssSpread(originalBits);
      const { bits: recoveredBits } = dsssDespread(chips);
      
      expect(recoveredBits).toEqual(originalBits);
    }
  });
});

describe('Step 2: Phase Continuity Analysis', () => {
  test('should detect continuous phases correctly', () => {
    const continuousPhases = [0, 0.1, 0.2, 0.3, 0.4];
    const result = checkPhaseContinuity(continuousPhases);
    
    expect(result.isContinuous).toBe(true);
    expect(result.discontinuities).toEqual([]);
    expect(result.maxJump).toBeCloseTo(0.1, 5);
  });

  test('should detect phase discontinuities', () => {
    const discontinuousPhases = [0, 0.1, 4.0, 0.3]; // Large jump: 0.1 → 4.0 (should wrap and detect discontinuity)
    const result = checkPhaseContinuity(discontinuousPhases, 2.0); // Use looser threshold
    
    expect(result.isContinuous).toBe(false);
    expect(result.discontinuities).toContain(2);
    expect(result.maxJump).toBeGreaterThan(2.0);
  });

  test('should handle DPSK modulated phases correctly', () => {
    const bits = [0, 1, 0, 1];
    const phases = dpskModulate(bits);
    const result = checkPhaseContinuity(phases);
    
    // DPSK should have π jumps which are expected
    expect(result.discontinuities.length).toBeGreaterThan(0);
    expect(result.maxJump).toBeCloseTo(Math.PI, 2);
  });

  test('should handle custom threshold', () => {
    const phases = [0, 1.5, 3.0]; // 1.5 radian jumps
    const result1 = checkPhaseContinuity(phases, 1.0); // Strict threshold
    const result2 = checkPhaseContinuity(phases, 2.0); // Loose threshold
    
    expect(result1.isContinuous).toBe(false);
    expect(result2.isContinuous).toBe(true);
  });
});

describe('Step 3: Advanced Demodulation Functions', () => {
  describe('phaseUnwrap', () => {
    test('should unwrap wrapped phases correctly', () => {
      const wrappedPhases = [0, Math.PI, -Math.PI, 0, Math.PI];
      const unwrapped = phaseUnwrap(wrappedPhases);
      
      expect(unwrapped[0]).toBeCloseTo(0, 5);
      expect(unwrapped[1]).toBeCloseTo(Math.PI, 5);
      expect(unwrapped[2]).toBeCloseTo(Math.PI, 5); // Should not jump to -π
      expect(unwrapped[3]).toBeCloseTo(2 * Math.PI, 5);
      expect(unwrapped[4]).toBeCloseTo(3 * Math.PI, 5);
    });

    test('should handle continuous phase arrays', () => {
      const continuousPhases = [0, 0.5, 1.0, 1.5, 2.0];
      const unwrapped = phaseUnwrap(continuousPhases);
      
      expect(unwrapped).toEqual(continuousPhases);
    });

    test('should handle empty array', () => {
      const unwrapped = phaseUnwrap([]);
      expect(unwrapped).toEqual([]);
    });
  });

  describe('calculateBER', () => {
    test('should calculate BER correctly for perfect match', () => {
      const original = [0, 1, 0, 1, 0, 1];
      const received = [0, 1, 0, 1, 0, 1];
      const ber = calculateBER(original, received);
      
      expect(ber).toBe(0);
    });

    test('should calculate BER correctly with errors', () => {
      const original = [0, 1, 0, 1, 0, 1];
      const received = [1, 1, 0, 0, 0, 1]; // 2 errors out of 6 bits
      const ber = calculateBER(original, received);
      
      expect(ber).toBeCloseTo(2/6, 5);
    });

    test('should handle all errors', () => {
      const original = [0, 0, 0, 0];
      const received = [1, 1, 1, 1];
      const ber = calculateBER(original, received);
      
      expect(ber).toBe(1.0);
    });

    test('should throw error for mismatched lengths', () => {
      const original = [0, 1, 0];
      const received = [0, 1];
      
      expect(() => calculateBER(original, received)).toThrow();
    });

    test('should handle empty arrays', () => {
      const ber = calculateBER([], []);
      expect(ber).toBe(0);
    });
  });

  describe('addAWGN', () => {
    test('should add noise to signal', () => {
      const cleanSignal = new Float32Array([1, 0, -1, 0, 1]);
      const noisySignal = addAWGN(cleanSignal, 10); // 10 dB SNR
      
      expect(noisySignal.length).toBe(cleanSignal.length);
      
      // Signal should be different (noisy) but similar magnitude
      let isDifferent = false;
      for (let i = 0; i < cleanSignal.length; i++) {
        if (Math.abs(noisySignal[i] - cleanSignal[i]) > 0.001) {
          isDifferent = true;
          break;
        }
      }
      expect(isDifferent).toBe(true);
      
      // Average power should be reasonable
      let noisyPower = 0;
      for (let i = 0; i < noisySignal.length; i++) {
        noisyPower += noisySignal[i] * noisySignal[i];
      }
      noisyPower /= noisySignal.length;
      expect(noisyPower).toBeGreaterThan(0.2); // More lenient for statistical variation
      expect(noisyPower).toBeLessThan(5.0);
    });

    test('should produce different noise for multiple calls', () => {
      const signal = new Float32Array([1, 1, 1, 1]);
      const noisy1 = addAWGN(signal, 5);
      const noisy2 = addAWGN(signal, 5);
      
      // Should be different due to random noise
      let isDifferent = false;
      for (let i = 0; i < signal.length; i++) {
        if (Math.abs(noisy1[i] - noisy2[i]) > 0.001) {
          isDifferent = true;
          break;
        }
      }
      expect(isDifferent).toBe(true);
    });
  });

  describe('Loopback Tests with BER=0 requirement', () => {
    test('should achieve BER=0 in noiseless loopback', () => {
      const originalBits = [0, 1, 0, 1, 1, 0, 1, 0];
      
      // Full DPSK+DSSS pipeline
      const chips = dsssSpread(originalBits);
      const chipPhases = chips.map(chip => chip > 0 ? 0 : Math.PI);
      
      const samplesPerPhase = 200;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      
      const modulated = modulateCarrier(chipPhases, samplesPerPhase, sampleRate, carrierFreq);
      const demodulatedPhases = demodulateCarrier(modulated, samplesPerPhase, sampleRate, carrierFreq);
      
      // Convert back to chips
      const recoveredChips = demodulatedPhases.map(phase => {
        let normalizedPhase = phase;
        while (normalizedPhase > Math.PI) normalizedPhase -= 2 * Math.PI;
        while (normalizedPhase < -Math.PI) normalizedPhase += 2 * Math.PI;
        return Math.abs(normalizedPhase) < Math.PI / 2 ? 1 : -1;
      });
      
      const { bits: recoveredBits } = dsssDespread(recoveredChips);
      const ber = calculateBER(originalBits, recoveredBits);
      
      expect(ber).toBe(0); // Step 3 requirement: BER=0 in noiseless case
    });

    test('should handle noisy conditions gracefully', () => {
      const originalBits = [0, 1, 0, 1];
      
      const chips = dsssSpread(originalBits);
      const chipPhases = chips.map(chip => chip > 0 ? 0 : Math.PI);
      
      const samplesPerPhase = 200;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      
      const modulated = modulateCarrier(chipPhases, samplesPerPhase, sampleRate, carrierFreq);
      const noisySignal = addAWGN(modulated, 15); // 15 dB SNR
      const demodulatedPhases = demodulateCarrier(noisySignal, samplesPerPhase, sampleRate, carrierFreq);
      
      // Convert back to chips
      const recoveredChips = demodulatedPhases.map(phase => {
        let normalizedPhase = phase;
        while (normalizedPhase > Math.PI) normalizedPhase -= 2 * Math.PI;
        while (normalizedPhase < -Math.PI) normalizedPhase += 2 * Math.PI;
        return Math.abs(normalizedPhase) < Math.PI / 2 ? 1 : -1;
      });
      
      const { bits: recoveredBits } = dsssDespread(recoveredChips);
      const ber = calculateBER(originalBits, recoveredBits);
      
      // Should still have low BER with 15 dB SNR and DSSS processing gain
      expect(ber).toBeLessThan(0.5);
    });
  });
});

describe('Step 4: Synchronization Functions', () => {
  describe('generateSyncReference', () => {
    test('should generate consistent M31 sequence', () => {
      const ref1 = generateSyncReference();
      const ref2 = generateSyncReference();
      
      expect(ref1).toEqual(ref2);
      expect(ref1.length).toBe(31);
      
      // Should contain only +1/-1 values
      for (const value of ref1) {
        expect(value === 1 || value === -1).toBe(true);
      }
    });

    test('should generate different sequences for different lengths', () => {
      const ref15 = generateSyncReference(15);
      const ref31 = generateSyncReference(31);
      
      expect(ref15).not.toEqual(ref31);
      expect(ref15.length).toBe(15);
      expect(ref31.length).toBe(31);
    });

    test('should generate different sequences for different seeds', () => {
      const ref1 = generateSyncReference(31, 0b10101);
      const ref2 = generateSyncReference(31, 0b01010);
      
      expect(ref1).not.toEqual(ref2);
      expect(ref1.length).toBe(31);
      expect(ref2.length).toBe(31);
    });
  });

  describe('findSyncOffset', () => {
    test('should find perfect synchronization at offset 0', () => {
      const reference = generateSyncReference();
      const received = Array.from(reference).concat([0, 0, 0]); // Add some padding
      
      const result = findSyncOffset(received, reference, 10);
      
      expect(result.bestOffset).toBe(0);
      expect(result.isFound).toBe(true);
      expect(Math.abs(result.peakCorrelation)).toBe(31); // Perfect correlation = sequence length
      expect(result.peakRatio).toBeGreaterThan(2.0); // Theoretical minimum for perfect signal
    });

    test('should find synchronization with offset', () => {
      const reference = generateSyncReference();
      const offset = 5;
      const received = new Array(offset).fill(0).concat(Array.from(reference)).concat([0, 0, 0]);
      
      const result = findSyncOffset(received, reference, 20);
      
      expect(result.bestOffset).toBe(offset);
      expect(result.isFound).toBe(true);
      expect(Math.abs(result.peakCorrelation)).toBe(31); // Perfect correlation
      expect(result.peakRatio).toBeGreaterThan(2.0); // Theoretical minimum
    });

    test('should handle inverted sequences', () => {
      const reference = generateSyncReference();
      const invertedReceived = Array.from(reference.map(x => -x)).concat([0, 0, 0]);
      
      const result = findSyncOffset(invertedReceived, reference, 10);
      
      expect(result.bestOffset).toBe(0);
      expect(result.isFound).toBe(true);
      expect(result.peakCorrelation).toBe(-31); // Perfect negative correlation for inverted sequence
      expect(result.peakRatio).toBeGreaterThan(2.0); // Theoretical minimum
    });

    test('should fail to find sync in random noise', () => {
      const reference = generateSyncReference();
      
      // Use Gaussian noise with controlled variance
      const noiseSignal = new Float32Array(50);
      for (let i = 0; i < noiseSignal.length; i++) {
        noiseSignal[i] = (Math.random() - 0.5) * 2; // Controlled noise, std ≈ 0.58
      }
      
      const result = findSyncOffset(noiseSignal, reference, 35);
      
      expect(result.isFound).toBe(false);
      // Pure noise should be rejected by adaptive threshold (will use strict 3σ threshold)
      expect(Math.abs(result.peakCorrelation)).toBeLessThan(16.7); // Below 3σ threshold for pure noise
    });

    test('should handle noisy synchronization', () => {
      const reference = generateSyncReference();
      const offset = 3;
      
      // Create clean signal with reference sequence at offset
      const cleanSignal = new Float32Array(
        new Array(offset).fill(0).concat(Array.from(reference)).concat([0, 0, 0])
      );
      
      // Add proper AWGN with 5dB SNR using the existing addAWGN function
      // DSSS should still detect due to processing gain (~15dB for M31)
      const snr = 5; // 5dB SNR - moderate noise level
      const noisySignal = addAWGN(cleanSignal, snr);
      
      const result = findSyncOffset(noisySignal, reference, 15);
      
      expect(result.bestOffset).toBe(offset);
      expect(result.isFound).toBe(true);
      expect(result.peakRatio).toBeGreaterThan(2.0); // DSSS processing gain enables detection
      expect(Math.abs(result.peakCorrelation)).toBeGreaterThan(11.1); // Should pass with adaptive threshold for signal+noise
    });
  });

  describe('applySyncOffset', () => {
    test('should apply offset correctly', () => {
      const data = [1, 2, 3, 4, 5, 6, 7, 8];
      const offset = 3;
      const aligned = applySyncOffset(data, offset);
      
      expect(aligned).toEqual([4, 5, 6, 7, 8]);
    });

    test('should handle zero offset', () => {
      const data = [1, 2, 3, 4];
      const aligned = applySyncOffset(data, 0);
      
      expect(aligned).toEqual(data);
    });

    test('should handle out-of-bounds offset', () => {
      const data = [1, 2, 3];
      const aligned1 = applySyncOffset(data, 10);
      const aligned2 = applySyncOffset(data, -1);
      
      expect(aligned1).toEqual([]);
      expect(aligned2).toEqual([]);
    });

    test('should work with different data types', () => {
      const stringData = ['a', 'b', 'c', 'd'];
      const aligned = applySyncOffset(stringData, 1);
      
      expect(aligned).toEqual(['b', 'c', 'd']);
    });
  });

  describe('Integrated Synchronization Tests', () => {
    test('should achieve automatic synchronization from arbitrary offset', () => {
      const originalBits = [0, 1, 0, 1, 1, 0];
      const chips = dsssSpread(originalBits);
      
      // Add random offset
      const offset = 7;
      const padding: number[] = Array.from({length: offset}, () => Math.random() > 0.5 ? 1 : -1);
      const receivedChips = padding.concat(Array.from(chips));
      
      // Find synchronization
      const reference = generateSyncReference();
      const syncResult = findSyncOffset(receivedChips, reference, 20);
      
      expect(syncResult.isFound).toBe(true);
      
      // Apply offset and despread
      const alignedChips = applySyncOffset(receivedChips, syncResult.bestOffset);
      const { bits: recoveredBits } = dsssDespread(alignedChips);
      
      // Should recover original bits
      expect(recoveredBits.slice(0, originalBits.length)).toEqual(originalBits);
    });

    test('should handle multiple synchronization attempts', () => {
      const reference = generateSyncReference();
      const testOffsets = [0, 5, 10, 15];
      
      for (const targetOffset of testOffsets) {
        const padding = new Array(targetOffset).fill(0);
        const received = padding.concat(Array.from(reference)).concat([0, 0, 0]);
        
        const result = findSyncOffset(received, reference, 25);
        
        expect(result.bestOffset).toBe(targetOffset);
        expect(result.isFound).toBe(true);
      }
    });
  });
});

describe('DSSS-DPSK Carrier Modulation', () => {
  const TOLERANCE = 0.01; // Phase tolerance in radians

  describe('modulateCarrier', () => {
    test('should generate correct signal length', () => {
      const phases = [0, Math.PI, 0, Math.PI];
      const samplesPerPhase = 100;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      
      const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      
      expect(samples.length).toBe(phases.length * samplesPerPhase);
    });

    test('should generate sinusoidal signal', () => {
      const phases = [0]; // Single phase
      const samplesPerPhase = 100;
      const sampleRate = 48000;
      const carrierFreq = 1000; // Low frequency for easy verification
      
      const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      
      // Check that samples are within [-1, 1] range
      for (const sample of samples) {
        expect(Math.abs(sample)).toBeLessThanOrEqual(1.0);
      }
    });

    test('should apply phase offset correctly', () => {
      const samplesPerPhase = 100;
      const sampleRate = 48000;
      const carrierFreq = 1000;
      
      // Compare 0 phase vs π phase
      const samples0 = modulateCarrier([0], samplesPerPhase, sampleRate, carrierFreq);
      const samplesPI = modulateCarrier([Math.PI], samplesPerPhase, sampleRate, carrierFreq);
      
      // Signals should be 180° out of phase (opposite signs)
      for (let i = 0; i < Math.min(50, samplesPerPhase); i++) {
        expect(samples0[i]).toBeCloseTo(-samplesPI[i], 3);
      }
    });
  });

  describe('demodulateCarrier', () => {
    test('should extract correct single phase', () => {
      const testPhase = Math.PI / 4;
      const phases = [testPhase];
      const samplesPerPhase = 200;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      
      const modulated = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      const demodulated = demodulateCarrier(modulated, samplesPerPhase, sampleRate, carrierFreq);
      
      expect(demodulated.length).toBe(1);
      expect(Math.abs(demodulated[0] - testPhase)).toBeLessThan(TOLERANCE);
    });

    test('should handle phase discontinuities', () => {
      const phases = [0, Math.PI, 0, Math.PI];
      const samplesPerPhase = 200;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      
      const modulated = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      const demodulated = demodulateCarrier(modulated, samplesPerPhase, sampleRate, carrierFreq);
      
      expect(demodulated.length).toBe(phases.length);
      // Check each phase is recovered correctly
      for (let i = 0; i < phases.length; i++) {
        let phaseDiff = demodulated[i] - phases[i];
        while (phaseDiff > Math.PI) phaseDiff -= 2 * Math.PI;
        while (phaseDiff < -Math.PI) phaseDiff += 2 * Math.PI;
        expect(Math.abs(phaseDiff)).toBeLessThan(TOLERANCE);
      }
    });
  });

  describe('Loopback Tests', () => {
    test('should recover original phases with high accuracy', () => {
      const testPhases = [0, Math.PI/2, Math.PI, -Math.PI/2];
      const samplesPerPhase = 240; // Multiple of carrier periods for clean demod
      const sampleRate = 48000;
      const carrierFreq = 10000;
      
      const modulated = modulateCarrier(testPhases, samplesPerPhase, sampleRate, carrierFreq);
      const demodulated = demodulateCarrier(modulated, samplesPerPhase, sampleRate, carrierFreq);
      
      expect(demodulated.length).toBe(testPhases.length);
      
      for (let i = 0; i < testPhases.length; i++) {
        // Normalize phase difference to [-π, π]
        let phaseDiff = demodulated[i] - testPhases[i];
        while (phaseDiff > Math.PI) phaseDiff -= 2 * Math.PI;
        while (phaseDiff < -Math.PI) phaseDiff += 2 * Math.PI;
        
        expect(Math.abs(phaseDiff)).toBeLessThan(TOLERANCE);
      }
    });

    test('should handle different carrier frequencies', () => {
      const testPhases = [0, Math.PI];
      const samplesPerPhase = 240;
      const sampleRate = 48000;
      const carrierFreqs = [1000, 5000, 10000, 15000];
      
      for (const carrierFreq of carrierFreqs) {
        const modulated = modulateCarrier(testPhases, samplesPerPhase, sampleRate, carrierFreq);
        const demodulated = demodulateCarrier(modulated, samplesPerPhase, sampleRate, carrierFreq);
        
        expect(demodulated.length).toBe(testPhases.length);
        
        for (let i = 0; i < testPhases.length; i++) {
          let phaseDiff = demodulated[i] - testPhases[i];
          while (phaseDiff > Math.PI) phaseDiff -= 2 * Math.PI;
          while (phaseDiff < -Math.PI) phaseDiff += 2 * Math.PI;
          
          expect(Math.abs(phaseDiff)).toBeLessThan(TOLERANCE);
        }
      }
    });

    test('should maintain carrier phase continuity between calls', () => {
      const samplesPerPhase = 240;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      
      // First call
      const samples1 = modulateCarrier([0], samplesPerPhase, sampleRate, carrierFreq, 0);
      
      // Second call with continuous phase
      const samples2 = modulateCarrier([0], samplesPerPhase, sampleRate, carrierFreq, samplesPerPhase);
      
      // Combined signal should have smooth phase transition
      const combined = new Float32Array(samples1.length + samples2.length);
      combined.set(samples1, 0);
      combined.set(samples2, samples1.length);
      
      // Check phase continuity at transition point
      const omega = 2 * Math.PI * carrierFreq / sampleRate;
      
      // Last sample of first block
      const lastSample1 = samples1[samples1.length - 1];
      const expectedLastPhase = omega * (samplesPerPhase - 1);
      expect(lastSample1).toBeCloseTo(Math.sin(expectedLastPhase), 3);
      
      // First sample of second block
      const firstSample2 = samples2[0];
      const expectedFirstPhase = omega * samplesPerPhase;
      expect(firstSample2).toBeCloseTo(Math.sin(expectedFirstPhase), 3);
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty phase array', () => {
      const phases: number[] = [];
      const samplesPerPhase = 100;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      
      const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      expect(samples.length).toBe(0);
    });

    test('should handle single phase', () => {
      const phases = [Math.PI/3];
      const samplesPerPhase = 240;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      
      const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      expect(samples.length).toBe(samplesPerPhase);
      
      const demodulated = demodulateCarrier(samples, samplesPerPhase, sampleRate, carrierFreq);
      expect(demodulated.length).toBe(1);
      
      let phaseDiff = demodulated[0] - phases[0];
      while (phaseDiff > Math.PI) phaseDiff -= 2 * Math.PI;
      while (phaseDiff < -Math.PI) phaseDiff += 2 * Math.PI;
      expect(Math.abs(phaseDiff)).toBeLessThan(TOLERANCE);
    });

    test('should handle boundary phase values', () => {
      const boundaryPhases = [0, Math.PI, -Math.PI];
      const samplesPerPhase = 240;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      
      for (const phase of boundaryPhases) {
        const modulated = modulateCarrier([phase], samplesPerPhase, sampleRate, carrierFreq);
        const demodulated = demodulateCarrier(modulated, samplesPerPhase, sampleRate, carrierFreq);
        
        expect(demodulated.length).toBe(1);
        
        let normalizedInput = phase;
        while (normalizedInput > Math.PI) normalizedInput -= 2 * Math.PI;
        while (normalizedInput < -Math.PI) normalizedInput += 2 * Math.PI;
        
        let phaseDiff = demodulated[0] - normalizedInput;
        while (phaseDiff > Math.PI) phaseDiff -= 2 * Math.PI;
        while (phaseDiff < -Math.PI) phaseDiff += 2 * Math.PI;
        
        expect(Math.abs(phaseDiff)).toBeLessThan(TOLERANCE);
      }
    });
  });
});
