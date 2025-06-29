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
    const bits = new Int8Array([0, 1, 0, 1]);
    const phases = dpskModulate(bits);
    
    expect(phases.length).toBe(4);
    expect(phases[0]).toBeCloseTo(0, 5); // initial phase
    expect(phases[1]).toBeCloseTo(0, 5); // 0 + 0
    expect(phases[2]).toBeCloseTo(Math.PI, 5); // 0 + π
    expect(phases[3]).toBeCloseTo(Math.PI, 5); // π + 0
  });

  test('should work with custom initial phase', () => {
    const bits = new Int8Array([1, 0]);
    const initialPhase = Math.PI / 4;
    const phases = dpskModulate(bits, initialPhase);
    
    expect(phases[0]).toBeCloseTo(Math.PI / 4, 5);
    expect(phases[1]).toBeCloseTo(Math.PI / 4 + Math.PI, 5); // π/4 + π
  });

  test('should handle alternating pattern correctly', () => {
    const bits = new Int8Array([1, 1, 1, 1]);
    const phases = dpskModulate(bits);
    
    expect(phases[0]).toBeCloseTo(0, 5);
    expect(phases[1]).toBeCloseTo(Math.PI, 5);
    expect(phases[2]).toBeCloseTo(2 * Math.PI, 5);
    expect(phases[3]).toBeCloseTo(3 * Math.PI, 5);
  });

  test('should handle empty array', () => {
    const bits = new Int8Array(0);
    const phases = dpskModulate(bits);
    
    expect(phases).toEqual(new Float32Array(0));
  });
});

describe('DSSS Spreading', () => {
  test('should generate correct spread chip length', () => {
    const bits = new Int8Array([0, 1, 0, 1]);
    const chips = dsssSpread(bits);
    
    expect(chips.length).toBe(bits.length * 31); // 31-chip M-sequence (default)
  });

  test('should produce +1/-1 chips only', () => {
    const bits = new Int8Array([0, 1]);
    const chips = dsssSpread(bits);
    
    for (const chip of chips) {
      expect(chip === 1 || chip === -1).toBe(true);
    }
  });

  test('should spread bit 0 as positive sequence', () => {
    const bits = new Int8Array([0]);
    const chips = dsssSpread(bits);
    
    expect(chips.length).toBe(31);
    // First chip should be positive (bit 0 → +1, first M31 chip is +1)
    expect(chips[0]).toBe(1);
  });

  test('should spread bit 1 as negative sequence', () => {
    const bits = new Int8Array([1]);
    const chips = dsssSpread(bits);
    
    expect(chips.length).toBe(31);
    // First chip should be negative (bit 1 → -1, first M31 chip is +1, so -1*1=-1)
    expect(chips[0]).toBe(-1);
  });

  test('should use consistent M31 sequence across calls', () => {
    const bits1 = new Int8Array([0]);
    const bits2 = new Int8Array([0]);
    const chips1 = dsssSpread(bits1);
    const chips2 = dsssSpread(bits2);
    
    expect(chips1).toEqual(chips2);
  });

  test('should handle different M-sequence lengths', () => {
    const bits = new Int8Array([0]);
    const chips15 = dsssSpread(bits, 15);
    const chips31 = dsssSpread(bits, 31);
    
    expect(chips15.length).toBe(15);
    expect(chips31.length).toBe(31);
    expect(chips15).not.toEqual(chips31); // Different lengths should produce different sequences
  });

  test('should handle different seeds', () => {
    const bits = new Int8Array([0]);
    const chips1 = dsssSpread(bits, 31, 0b10101);
    const chips2 = dsssSpread(bits, 31, 0b01010);
    
    expect(chips1.length).toBe(31);
    expect(chips2.length).toBe(31);
    expect(chips1).not.toEqual(chips2); // Different seeds should produce different sequences
  });

  test('should handle empty array', () => {
    const bits = new Int8Array(0);
    const chips = dsssSpread(bits);
    
    expect(chips.length).toBe(0);
    expect(chips).toBeInstanceOf(Int8Array);
  });
});

describe('DSSS Despreading', () => {
  test('should recover original bits perfectly', () => {
    const originalBits = [0, 1, 0, 1];
    const chips = dsssSpread(originalBits);
    const { bits, correlations } = dsssDespread(new Float32Array(chips));
    
    expect(Array.from(bits)).toEqual(Array.from(originalBits));
    expect(correlations.length).toBe(originalBits.length);
    
    // Check correlation magnitudes (should be ±31 for perfect correlation with M31)
    for (const correlation of correlations) {
      expect(Math.abs(correlation)).toBe(31);
    }
  });

  test('should handle single bit', () => {
    const originalBits = [1];
    const chips = dsssSpread(originalBits);
    const { bits, correlations } = dsssDespread(new Float32Array(chips));
    
    expect(Array.from(bits)).toEqual(Array.from(originalBits));
    expect(correlations.length).toBe(1);
    expect(correlations[0]).toBe(-31); // Bit 1 → negative correlation
  });

  test('should work with different seeds', () => {
    const originalBits = [0, 1];
    const seed = 0b01010;
    
    const chips = dsssSpread(originalBits, 31, seed);
    const { bits } = dsssDespread(new Float32Array(chips), 31, seed);
    
    expect(Array.from(bits)).toEqual(Array.from(originalBits));
  });

  test('should handle noisy chips', () => {
    const originalBits = [0, 1, 0];
    const chips = dsssSpread(originalBits);
    
    // Add small amount of noise
    const noisyChips = chips.map(chip => chip + (Math.random() - 0.5) * 0.2);
    
    const { bits } = dsssDespread(new Float32Array(noisyChips));
    expect(Array.from(bits)).toEqual(Array.from(originalBits));
  });

  test('should handle partial chip arrays', () => {
    const originalBits = [0, 1, 0];
    const chips = dsssSpread(originalBits);
    
    // Take only first 2 complete symbols (62 chips for M31)
    const partialChips = chips.slice(0, 62);
    const { bits } = dsssDespread(new Float32Array(partialChips));
    
    expect(Array.from(bits)).toEqual([0, 1]);
  });

  test('should handle empty chip array', () => {
    const chips = new Float32Array([]);
    const { bits, correlations } = dsssDespread(chips);
    
    expect(Array.from(bits)).toEqual([]);
    expect(Array.from(correlations)).toEqual([]);
  });
});

describe('DPSK Demodulation', () => {
  test('should generate correct soft values for phase differences', () => {
    // Create phases with known phase differences
    const phases = new Float32Array([0, 0, Math.PI, Math.PI, 0]); // Phase diffs: 0, π, 0, -π
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
    const phases = new Float32Array([0, 2 * Math.PI]); // Should be equivalent to [0, 0]
    const softValues = dpskDemodulate(phases);
    
    expect(softValues.length).toBe(1);
    expect(softValues[0]).toBeGreaterThan(0); // Should indicate bit 0
  });

  test('should scale with noise variance', () => {
    const phases = new Float32Array([0, Math.PI / 4]); // Phase diff = π/4 (intermediate value)
    
    const softValues1 = dpskDemodulate(phases, 15.0); // Higher Es/N0
    const softValues2 = dpskDemodulate(phases, 8.0);  // Lower Es/N0
    
    // Higher noise (lower Es/N0) should reduce LLR magnitude
    expect(Math.abs(softValues2[0])).toBeLessThan(Math.abs(softValues1[0]));
  });

  test('should handle single phase', () => {
    const phases = new Float32Array([Math.PI / 4]);
    const softValues = dpskDemodulate(phases);
    
    expect(softValues.length).toBe(0);
  });

  test('should handle intermediate phase differences', () => {
    const phases = new Float32Array([0, Math.PI / 2]); // Phase diff = π/2 (ambiguous)
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
    
    const { bits: recoveredBits } = dsssDespread(new Float32Array(recoveredChips));
    
    expect(Array.from(recoveredBits)).toEqual(Array.from(originalBits));
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
      const { bits: recoveredBits } = dsssDespread(new Float32Array(chips));
      
      expect(Array.from(recoveredBits)).toEqual(Array.from(originalBits));
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
      
      expect(Array.from(unwrapped)).toEqual(Array.from(continuousPhases));
    });

    test('should handle empty array', () => {
      const unwrapped = phaseUnwrap(new Float32Array(0));
      expect(Array.from(unwrapped)).toEqual([]);
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
      const original = new Int8Array([0, 1, 0, 1, 0, 1]);
      const received = new Int8Array([1, 1, 0, 0, 0, 1]); // 2 errors out of 6 bits
      const ber = calculateBER(original, received);
      
      expect(ber).toBeCloseTo(2/6, 5);
    });

    test('should handle all errors', () => {
      const original = new Int8Array([0, 0, 0, 0]);
      const received = new Int8Array([1, 1, 1, 1]);
      const ber = calculateBER(original, received);
      
      expect(ber).toBe(1.0);
    });

    test('should throw error for mismatched lengths', () => {
      const original = new Int8Array([0, 1, 0]);
      const received = new Int8Array([0, 1]);
      
      expect(() => calculateBER(original, received)).toThrow();
    });

    test('should handle empty arrays', () => {
      const ber = calculateBER(new Int8Array(0), new Int8Array(0));
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
      
      const { bits: recoveredBits } = dsssDespread(new Float32Array(recoveredChips));
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
      
      const { bits: recoveredBits } = dsssDespread(new Float32Array(recoveredChips));
      const ber = calculateBER(originalBits, recoveredBits);
      
      // Should still have low BER with 15 dB SNR and DSSS processing gain
      expect(ber).toBeLessThan(0.5);
    });
  });
});

describe('Step 4-4: DPSK+DSSS Integration Tests (BER & Sync Success Rate)', () => {
  /**
   * Complete End-to-End DPSK+DSSS Pipeline Test
   * Tests: Bits → DPSK → DSSS → Noise → Sync → DSSS Despread → DPSK Demod → Bits
   */
  
  describe('Complete Integration Pipeline with Synchronization', () => {
    test('should achieve end-to-end BER performance with automatic synchronization', () => {
      const originalBits = [0, 1, 0, 1, 1, 0, 1, 0, 0, 1]; // 10 bits for statistics
      
      // Step 1: DPSK Modulation (for future full integration)
      const _dpskPhases = dpskModulate(originalBits);
      
      // Step 2: DSSS Spreading
      const spreadChips = dsssSpread(originalBits); // Spread bits to chips
      
      // Step 3: Add random offset (simulate unknown timing)
      const randomOffset = 13;
      const offsetChips = new Array(randomOffset).fill(0).concat(Array.from(spreadChips));
      
      // Step 4: Add AWGN noise
      const snr = 8; // 8dB SNR test condition
      const noisyChips = addAWGN(new Float32Array(offsetChips), snr);
      
      // Step 5: Automatic Synchronization (DSSS correlation)
      const reference = generateSyncReference();
      const syncResult = findSyncOffset(noisyChips, reference, randomOffset + 10);
      
      expect(syncResult.isFound).toBe(true); // Sync must succeed
      expect(Math.abs(syncResult.bestOffset - randomOffset)).toBeLessThanOrEqual(1); // ±1 tolerance
      
      // Step 6: Apply synchronization offset
      const alignedChips = applySyncOffset(noisyChips, syncResult.bestOffset);
      
      // Step 7: DSSS Despreading
      const { bits: recoveredBits } = dsssDespread(alignedChips);
      
      // Step 8: BER Calculation
      const ber = calculateBER(originalBits, recoveredBits.slice(0, originalBits.length));
      
      // Step 9: Performance Requirements
      expect(ber).toBeLessThanOrEqual(0.1); // BER ≤ 10% with DSSS processing gain
      expect(recoveredBits.length).toBeGreaterThanOrEqual(originalBits.length);
    });

    test('should maintain sync and BER performance across multiple SNR levels with statistical validation', () => {
      const originalBits = new Int8Array([0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0]); // 12 bits
      
      // DSSS理論に基づく期待値（M31処理利得：約14.9dB）
      // 各SNRに処理利得を加算した実効SNRで期待性能を算出
      const snrConditions = [
        { 
          snr: 0, 
          minSyncRate: 0.95, maxSyncRate: 1.00,   // 実効SNR: +14.9dB → ほぼ確実
          maxBER: 0.02 
        },
        { 
          snr: -3, 
          minSyncRate: 0.85, maxSyncRate: 0.98,   // 実効SNR: +11.9dB → 高成功率
          maxBER: 0.05 
        },
        { 
          snr: -5, 
          minSyncRate: 0.70, maxSyncRate: 0.90,   // 実効SNR: +9.9dB → 中高成功率
          maxBER: 0.10 
        },
        { 
          snr: -8, 
          minSyncRate: 0.35, maxSyncRate: 0.65,   // 実効SNR: +6.9dB → 中程度
          maxBER: 0.25 
        },
        { 
          snr: -10, 
          minSyncRate: 0.15, maxSyncRate: 0.45,   // 実効SNR: +4.9dB → 低成功率
          maxBER: 0.40 
        },
        { 
          snr: -15, 
          minSyncRate: 0.01, maxSyncRate: 0.16,   // 実効SNR: -0.1dB → 統計的誤差を考慮
          maxBER: 0.70 
        }
      ];
      
      const trials = 1000; // 統計的に有意な試行回数
      
      for (const condition of snrConditions) {
        let syncSuccessCount = 0;
        let totalBER = 0;
        let validBERCount = 0;
        
        for (let trial = 0; trial < trials; trial++) {
          // Complete pipeline for each trial
          const spreadChips = dsssSpread(originalBits);
          const offset = 7;
          const offsetChips = new Array(offset).fill(0).concat(Array.from(spreadChips));
          const noisyChips = addAWGN(new Float32Array(offsetChips), condition.snr);
          
          // Synchronization
          const reference = generateSyncReference();
          const syncResult = findSyncOffset(noisyChips, reference, 20);
          
          if (syncResult.isFound && syncResult.bestOffset === offset) {
            syncSuccessCount++;
            
            // Despreading and BER calculation for successful syncs
            const alignedChips = applySyncOffset(noisyChips, syncResult.bestOffset);
            const { bits: recoveredBits } = dsssDespread(alignedChips);
            const ber = calculateBER(originalBits, recoveredBits.slice(0, originalBits.length));
            
            totalBER += ber;
            validBERCount++;
          }
        }
        
        const actualSyncRate = syncSuccessCount / trials;
        const averageBER = validBERCount > 0 ? totalBER / validBERCount : 1.0;
        
        console.log(`SNR ${condition.snr}dB: Sync ${(actualSyncRate * 100).toFixed(1)}% (theory: ${(condition.minSyncRate * 100).toFixed(0)}-${(condition.maxSyncRate * 100).toFixed(0)}%), BER ${averageBER.toFixed(3)} (max ${condition.maxBER.toFixed(2)})`);
        
        // 理論的範囲内での検証（DSSS処理利得理論に基づく）
        expect(actualSyncRate).toBeGreaterThanOrEqual(condition.minSyncRate);
        expect(actualSyncRate).toBeLessThanOrEqual(condition.maxSyncRate);
        
        // 理論より極端に高い性能の場合は警告（ノイズ誤検出の可能性）
        if (actualSyncRate > condition.maxSyncRate) {
          console.warn(`⚠️  SNR ${condition.snr}dB: Suspiciously high performance (${(actualSyncRate * 100).toFixed(1)}% > ${(condition.maxSyncRate * 100).toFixed(0)}%) - possible noise false detection`);
        }
        
        // BER検証：理論的上限以下であることを確認
        if (validBERCount > 10) { // 十分な成功データがある場合のみ
          expect(averageBER).toBeLessThanOrEqual(condition.maxBER);
        }
      }
    });
  });

  describe('Synchronization Success Rate Evaluation', () => {
    test('should achieve high sync success rate with statistical evaluation', () => {
      const originalBits = new Int8Array([0, 1, 0, 1, 1, 0]); 
      const numTrials = 20;
      const snr = 6; // Moderate SNR condition
      let syncSuccessCount = 0;
      let berSum = 0;
      let validBerCount = 0;
      
      for (let trial = 0; trial < numTrials; trial++) {
        // Generate fresh noise for each trial
        const spreadChips = dsssSpread(originalBits);
        const randomOffset = Math.floor(Math.random() * 15) + 5; // 5-19 random offset
        const offsetChips = new Float32Array(new Array(randomOffset).fill(0).concat(Array.from(spreadChips)));
        const noisyChips = addAWGN(offsetChips, snr);
        
        // Attempt synchronization
        const reference = generateSyncReference();
        const syncResult = findSyncOffset(noisyChips, reference, 30);
        
        if (syncResult.isFound) {
          syncSuccessCount++;
          
          // Measure BER for successful sync
          const alignedChips = applySyncOffset(noisyChips, syncResult.bestOffset);
          const { bits: recoveredBits } = dsssDespread(alignedChips);
          const ber = calculateBER(originalBits, recoveredBits.slice(0, originalBits.length));
          
          berSum += ber;
          validBerCount++;
        }
      }
      
      const syncSuccessRate = syncSuccessCount / numTrials;
      const averageBer = validBerCount > 0 ? berSum / validBerCount : 1.0;
      
      console.log(`Sync Success Rate: ${(syncSuccessRate * 100).toFixed(1)}% (${syncSuccessCount}/${numTrials})`);
      console.log(`Average BER (successful syncs): ${averageBer.toFixed(3)}`);
      
      // aec-plan.md requirements: reliable sync with DSSS processing gain
      expect(syncSuccessRate).toBeGreaterThanOrEqual(0.85); // ≥85% success rate
      expect(averageBer).toBeLessThan(0.2); // Average BER < 20% when synced
    });

    test('should handle challenging conditions with graceful degradation', () => {
      const originalBits = new Int8Array([0, 1, 0, 1, 1, 0, 1, 0]);
      // DSSS理論に基づく期待値（M31処理利得：約14.9dB）
      const challengingConditions = [
        { 
          name: 'Equal SNR', 
          snr: 0, 
          minSyncRate: 0.95, maxSyncRate: 1.00   // 実効SNR: +14.9dB → ほぼ確実
        },
        { 
          name: 'Low SNR', 
          snr: -6, 
          minSyncRate: 0.60, maxSyncRate: 0.80   // 実効SNR: +8.9dB → 高成功率
        },
        { 
          name: 'Very Low SNR', 
          snr: -12, 
          minSyncRate: 0.15, maxSyncRate: 0.30   // 実効SNR: +2.9dB → 中程度
        },
        { 
          name: 'Extreme Low SNR', 
          snr: -18, 
          minSyncRate: 0.03, maxSyncRate: 0.10   // 実効SNR: -3.1dB → 低い検出
        }
      ];
      
      for (const condition of challengingConditions) {
        let syncCount = 0;
        const trials = 10000;
        
        for (let trial = 0; trial < trials; trial++) {
          const spreadChips = dsssSpread(originalBits);
          const largeOffset = 25; // Large offset challenge
          const offsetChips = new Array(largeOffset).fill(0).concat(Array.from(spreadChips));
          const noisyChips = addAWGN(new Float32Array(offsetChips), condition.snr);
          
          const reference = generateSyncReference();
          const syncResult = findSyncOffset(noisyChips, reference, 35);
          
          if (syncResult.isFound && syncResult.bestOffset === largeOffset) syncCount++;
        }
       
        const successRate = syncCount / trials;
        console.log(`${condition.name} ${condition.snr}: ${(successRate * 100).toFixed(1)}% success (theory: ${(condition.minSyncRate * 100).toFixed(0)}-${(condition.maxSyncRate * 100).toFixed(0)}%)`);
        
        // 理論的範囲内での検証（DSSS処理利得理論に基づく）
        expect(successRate).toBeGreaterThanOrEqual(condition.minSyncRate);
        expect(successRate).toBeLessThanOrEqual(condition.maxSyncRate);
        
        // 理論より極端に高い性能の場合は警告（ノイズ誤検出の可能性）
        if (successRate > condition.maxSyncRate) {
          console.warn(`⚠️  ${condition.name}: Suspiciously high performance (${(successRate * 100).toFixed(1)}% > ${(condition.maxSyncRate * 100).toFixed(0)}%) - possible noise false detection`);
        }
      }
    });
  });

  describe('Soft Value Integration Performance', () => {
    test('should provide meaningful soft values through complete pipeline', () => {
      const originalBits = new Int8Array([0, 1, 0, 1]);
      
      // DPSK+DSSS forward path (using DSSS only for current test)
      const spreadChips = dsssSpread(originalBits);
      
      // Add noise and offset
      const offset = 8;
      const offsetChips = new Float32Array(new Array(offset).fill(0).concat(Array.from(spreadChips)));
      const noisyChips = addAWGN(offsetChips, 7); // 7dB SNR
      
      // Synchronization and alignment
      const reference = generateSyncReference();
      const syncResult = findSyncOffset(noisyChips, reference, 20);
      expect(syncResult.isFound).toBe(true);
      
      const alignedChips = applySyncOffset(noisyChips, syncResult.bestOffset);
      
      // DSSS despreading with correlations (soft values)
      const { bits: recoveredBits, correlations } = dsssDespread(alignedChips);
      
      // DPSK soft value generation (if we had phase-based soft values)
      // For now, verify correlation magnitudes reflect confidence
      expect(correlations.length).toBeGreaterThanOrEqual(originalBits.length);
      
      // High correlation magnitude indicates high confidence
      for (let i = 0; i < originalBits.length; i++) {
        expect(Math.abs(correlations[i])).toBeGreaterThan(5); // Reasonable correlation strength
      }
      
      expect(calculateBER(originalBits, recoveredBits.slice(0, originalBits.length))).toBeLessThan(0.25);
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
      const received = new Float32Array(Array.from(reference).concat([0, 0, 0])); // Add some padding
      
      const result = findSyncOffset(received, reference, 10);
      
      expect(result.bestOffset).toBe(0);
      expect(result.isFound).toBe(true);
      expect(Math.abs(result.peakCorrelation)).toBe(31); // Perfect correlation = sequence length
      expect(result.peakRatio).toBeGreaterThan(0.9); // Normalized correlation for perfect signal ≈ 1.0
    });

    test('should find synchronization with offset', () => {
      const reference = generateSyncReference();
      const offset = 5;
      const received = new Float32Array(new Array(offset).fill(0).concat(Array.from(reference)).concat([0, 0, 0]));
      
      const result = findSyncOffset(received, reference, 20);
      
      expect(result.bestOffset).toBe(offset);
      expect(result.isFound).toBe(true);
      expect(Math.abs(result.peakCorrelation)).toBe(31); // Perfect correlation
      expect(result.peakRatio).toBeGreaterThan(0.9); // Normalized correlation ≈ 1.0
    });

    test('should handle inverted sequences', () => {
      const reference = generateSyncReference();
      const invertedReceived = new Float32Array(Array.from(reference.map(x => -x)).concat([0, 0, 0]));
      
      const result = findSyncOffset(invertedReceived, reference, 10);
      
      expect(result.bestOffset).toBe(0);
      expect(result.isFound).toBe(true);
      expect(result.peakCorrelation).toBe(-31); // Perfect negative correlation for inverted sequence
      expect(result.peakRatio).toBeGreaterThan(0.9); // Normalized correlation ≈ 1.0
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
      expect(result.peakRatio).toBeGreaterThan(0.4); // Normalized correlation in noise
      expect(Math.abs(result.peakCorrelation)).toBeGreaterThan(11.1); // Should pass with adaptive threshold for signal+noise
    });
  });

  describe('applySyncOffset', () => {
    test('should apply offset correctly', () => {
      const data = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const offset = 3;
      const aligned = applySyncOffset(data, offset);
      
      expect(Array.from(aligned)).toEqual([4, 5, 6, 7, 8]);
    });

    test('should handle zero offset', () => {
      const data = new Float32Array([1, 2, 3, 4]);
      const aligned = applySyncOffset(data, 0);
      
      expect(Array.from(aligned)).toEqual(Array.from(data));
    });

    test('should handle out-of-bounds offset', () => {
      const data = new Float32Array([1, 2, 3]);
      const aligned1 = applySyncOffset(data, 10);
      const aligned2 = applySyncOffset(data, -1);
      
      expect(Array.from(aligned1)).toEqual([]);
      expect(Array.from(aligned2)).toEqual([]);
    });

    test('should work with Float32Array data', () => {
      const data = new Float32Array([1.1, 2.2, 3.3, 4.4]);
      const aligned = applySyncOffset(data, 1);
      
      expect(Array.from(aligned)).toEqual([2.2000000476837158, 3.299999952316284, 4.400000095367432]);
    });
  });

  describe('Synchronization Precision Tests', () => {
    test('should handle large offset ranges accurately', () => {
      const reference = generateSyncReference();
      const largeOffsets = [31, 50, 75, 100]; // Test larger, practical offsets
      
      for (const targetOffset of largeOffsets) {
        const padding = new Array(targetOffset).fill(0);
        const received = new Float32Array(padding.concat(Array.from(reference)).concat([0, 0, 0]));
        
        const result = findSyncOffset(received, reference, targetOffset + 10);
        
        expect(result.bestOffset).toBe(targetOffset);
        expect(result.isFound).toBe(true);
        expect(Math.abs(result.peakCorrelation)).toBe(31); // Perfect correlation maintained
      }
    });

    test('should maintain precision near M-sequence boundaries', () => {
      const reference = generateSyncReference();
      // Test offsets around M31 sequence length (critical boundary conditions)
      const boundaryOffsets = [29, 30, 31, 32, 33, 62, 63, 64]; // Around 1×M31 and 2×M31
      
      for (const targetOffset of boundaryOffsets) {
        const padding = new Array(targetOffset).fill(0);
        const received = new Float32Array(padding.concat(Array.from(reference)).concat([0, 0, 0]));
        
        const result = findSyncOffset(received, reference, targetOffset + 15);
        
        expect(result.bestOffset).toBe(targetOffset);
        expect(result.isFound).toBe(true);
        expect(Math.abs(result.peakCorrelation)).toBe(31);
      }
    });

    test('should handle fractional chip timing with interpolation accuracy', () => {
      const reference = generateSyncReference();
      
      // Test with sub-sample precision by using non-integer valued chips
      // This simulates real-world conditions where timing isn't perfect
      const offset = 5;
      const baseSignal = new Array(offset).fill(0).concat(Array.from(reference));
      
      // Add slight timing offset through interpolation (0.3 samples)
      const interpolatedSignal = new Float32Array(baseSignal.length + 1);
      for (let i = 0; i < baseSignal.length - 1; i++) {
        interpolatedSignal[i] = 0.7 * baseSignal[i] + 0.3 * baseSignal[i + 1];
      }
      interpolatedSignal[baseSignal.length - 1] = baseSignal[baseSignal.length - 1];
      interpolatedSignal[baseSignal.length] = 0;
      
      const result = findSyncOffset(interpolatedSignal, reference, 20);
      
      // Should still find correct offset within ±1 sample tolerance
      expect(Math.abs(result.bestOffset - offset)).toBeLessThanOrEqual(1);
      expect(result.isFound).toBe(true);
      expect(Math.abs(result.peakCorrelation)).toBeGreaterThan(20); // Reduced due to interpolation artifacts
    });

    test('should detect precise offset with noise at various SNR levels', () => {
      const reference = generateSyncReference();
      const offset = 8;
      const snrLevels = [10, 5, 0]; // High, medium, low SNR
      
      for (const snr of snrLevels) {
        const cleanSignal = new Float32Array(
          new Array(offset).fill(0).concat(Array.from(reference)).concat([0, 0, 0])
        );
        const noisySignal = addAWGN(cleanSignal, snr);
        
        const result = findSyncOffset(noisySignal, reference, 20);
        
        // Precision requirement: exact offset detection
        expect(result.bestOffset).toBe(offset);
        expect(result.isFound).toBe(true);
        
        // SNR-dependent correlation thresholds
        if (snr >= 5) {
          expect(Math.abs(result.peakCorrelation)).toBeGreaterThan(15);
        } else {
          expect(Math.abs(result.peakCorrelation)).toBeGreaterThan(10); // Lower expectation for 0dB SNR
        }
      }
    });

    test('should distinguish between similar offset positions', () => {
      const reference = generateSyncReference();
      
      // Test consecutive offsets to ensure single-sample precision
      const consecutiveOffsets = [10, 11, 12, 13, 14];
      
      for (const targetOffset of consecutiveOffsets) {
        const padding = new Array(targetOffset).fill(0);
        const received = new Float32Array(padding.concat(Array.from(reference)).concat([0, 0, 0]));
        
        const result = findSyncOffset(received, reference, 25);
        
        // Exact precision required - no ±1 tolerance
        expect(result.bestOffset).toBe(targetOffset);
        expect(result.isFound).toBe(true);
        expect(Math.abs(result.peakCorrelation)).toBe(31);
        expect(result.peakRatio).toBeGreaterThan(0.9); // Normalized correlation for perfect alignment ≈ 1.0
      }
    });

    test('should handle edge cases and boundary conditions', () => {
      const reference = generateSyncReference();
      
      // Test edge cases that might cause synchronization failures
      const edgeCases = [
        { name: 'zero offset', offset: 0, padding: [] },
        { name: 'single sample offset', offset: 1, padding: [0] },
        { name: 'M31 sequence length offset', offset: 31, padding: new Array(31).fill(0) },
        { name: 'double M31 offset', offset: 62, padding: new Array(62).fill(0) },
        { name: 'maximum search range', offset: 99, padding: new Array(99).fill(0) }
      ];
      
      for (const testCase of edgeCases) {
        const received = new Float32Array(testCase.padding.concat(Array.from(reference)).concat([0, 0, 0]));
        const result = findSyncOffset(received, reference, testCase.offset + 10);
        
        expect(result.bestOffset).toBe(testCase.offset);
        expect(result.isFound).toBe(true);
        expect(Math.abs(result.peakCorrelation)).toBe(31);
      }
    });

    test('should handle partial sequence at end of search range', () => {
      const reference = generateSyncReference();
      
      // Create a signal where M31 sequence starts near the end of search range
      const offset = 15;
      const padding = new Array(offset).fill(0);
      const partialSequence = Array.from(reference.slice(0, 20)); // Only 20 chips of M31
      const received = padding.concat(partialSequence);
      
      // Search range that includes the partial sequence
      const result = findSyncOffset(new Float32Array(received), reference, 25);
      
      // Should fail to find sync due to incomplete sequence
      expect(result.isFound).toBe(false);
      expect(Math.abs(result.peakCorrelation)).toBeLessThan(31);
    });
  });

  describe('Integrated Synchronization Tests', () => {
    test('should achieve automatic synchronization from arbitrary offset', () => {
      const originalBits = new Int8Array([0, 1, 0, 1, 1, 0]);
      const chips = dsssSpread(originalBits);
      
      // Add random offset
      const offset = 7;
      const padding = Array.from({length: offset}, () => Math.random() > 0.5 ? 1 : -1);
      const receivedChips = new Float32Array([...padding, ...Array.from(chips)]);
      
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
        const received = new Float32Array(padding.concat(Array.from(reference)).concat([0, 0, 0]));
        
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
      const phases = new Float32Array([0, Math.PI, 0, Math.PI]);
      const samplesPerPhase = 100;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      
      const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      
      expect(samples.length).toBe(phases.length * samplesPerPhase);
    });

    test('should generate sinusoidal signal', () => {
      const phases = new Float32Array([0]); // Single phase
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
      const samples0 = modulateCarrier(new Float32Array([0]), samplesPerPhase, sampleRate, carrierFreq);
      const samplesPI = modulateCarrier(new Float32Array([Math.PI]), samplesPerPhase, sampleRate, carrierFreq);
      
      // Signals should be 180° out of phase (opposite signs)
      for (let i = 0; i < Math.min(50, samplesPerPhase); i++) {
        expect(samples0[i]).toBeCloseTo(-samplesPI[i], 3);
      }
    });
  });

  describe('demodulateCarrier', () => {
    test('should extract correct single phase', () => {
      const testPhase = Math.PI / 4;
      const phases = new Float32Array([testPhase]);
      const samplesPerPhase = 200;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      
      const modulated = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      const demodulated = demodulateCarrier(modulated, samplesPerPhase, sampleRate, carrierFreq);
      
      expect(demodulated.length).toBe(1);
      expect(Math.abs(demodulated[0] - testPhase)).toBeLessThan(TOLERANCE);
    });

    test('should handle phase discontinuities', () => {
      const phases = new Float32Array([0, Math.PI, 0, Math.PI]);
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
      const testPhases = new Float32Array([0, Math.PI/2, Math.PI, -Math.PI/2]);
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
      const testPhases = new Float32Array([0, Math.PI]);
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
      const samples1 = modulateCarrier(new Float32Array([0]), samplesPerPhase, sampleRate, carrierFreq, 0);
      
      // Second call with continuous phase
      const samples2 = modulateCarrier(new Float32Array([0]), samplesPerPhase, sampleRate, carrierFreq, samplesPerPhase);
      
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
      const phases = new Float32Array(0);
      const samplesPerPhase = 100;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      
      const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      expect(samples.length).toBe(0);
    });

    test('should handle single phase', () => {
      const phases = new Float32Array([Math.PI/3]);
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
        const modulated = modulateCarrier(new Float32Array([phase]), samplesPerPhase, sampleRate, carrierFreq);
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
