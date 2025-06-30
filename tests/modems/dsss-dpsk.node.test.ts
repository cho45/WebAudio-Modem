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

// Helper to convert LLR to bits based on the corrected logic (positive LLR = bit 0)
const llrToBits = (llr: Int8Array): number[] => Array.from(llr).map(i => (i >= 0 ? 0 : 1));

describe('DPSK Modulation', () => {
  test('should perform complete DPSK modulation', () => {
    const chips = new Int8Array([1, -1, 1, -1]);
    const phases = dpskModulate(chips);
    
    expect(phases.length).toBe(4);
    expect(phases[0]).toBeCloseTo(0, 5); // initial phase
    expect(phases[1]).toBeCloseTo(0, 5); // 0 + 0
    expect(phases[2]).toBeCloseTo(Math.PI, 5); // 0 + π
    expect(phases[3]).toBeCloseTo(Math.PI, 5); // π + 0
  });

  test('should work with custom initial phase', () => {
    const chips = new Int8Array([-1, 1]);
    const initialPhase = Math.PI / 4;
    const phases = dpskModulate(chips, initialPhase);
    
    expect(phases[0]).toBeCloseTo(Math.PI / 4, 5);
    expect(phases[1]).toBeCloseTo(Math.PI / 4 + Math.PI, 5); // π/4 + π
  });

  test('should handle alternating pattern correctly', () => {
    const chips = new Int8Array([-1, -1, -1, -1]);
    const phases = dpskModulate(chips);
    
    expect(phases[0]).toBeCloseTo(0, 5);
    expect(phases[1]).toBeCloseTo(Math.PI, 5);
    expect(phases[2]).toBeCloseTo(2 * Math.PI, 5);
    expect(phases[3]).toBeCloseTo(3 * Math.PI, 5);
  });

  test('should handle empty array', () => {
    const chips = new Int8Array(0);
    const phases = dpskModulate(chips);
    
    expect(phases).toEqual(new Float32Array(0));
  });
});

describe('DSSS Spreading', () => {
  test('should generate correct spread chip length', () => {
    const bits = new Uint8Array([0, 1, 0, 1]);
    const chips = dsssSpread(bits);
    
    expect(chips.length).toBe(bits.length * 31); // 31-chip M-sequence (default)
  });

  test('should produce +1/-1 chips only', () => {
    const bits = new Uint8Array([0, 1]);
    const chips = dsssSpread(bits);
    
    for (const chip of chips) {
      expect(chip === 1 || chip === -1).toBe(true);
    }
  });

  test('should spread bit 0 as positive sequence', () => {
    const bits = new Uint8Array([0]);
    const chips = dsssSpread(bits);
    
    expect(chips.length).toBe(31);
    // First chip should be positive (bit 0 → +1, first M31 chip is +1)
    expect(chips[0]).toBe(1);
  });

  test('should spread bit 1 as negative sequence', () => {
    const bits = new Uint8Array([1]);
    const chips = dsssSpread(bits);
    
    expect(chips.length).toBe(31);
    // First chip should be negative (bit 1 → -1, first M31 chip is +1, so -1*1=-1)
    expect(chips[0]).toBe(-1);
  });

  test('should use consistent M31 sequence across calls', () => {
    const bits1 = new Uint8Array([0]);
    const bits2 = new Uint8Array([0]);
    const chips1 = dsssSpread(bits1);
    const chips2 = dsssSpread(bits2);
    
    expect(chips1).toEqual(chips2);
  });

  test('should handle different M-sequence lengths', () => {
    const bits = new Uint8Array([0]);
    const chips15 = dsssSpread(bits, 15);
    const chips31 = dsssSpread(bits, 31);
    
    expect(chips15.length).toBe(15);
    expect(chips31.length).toBe(31);
    expect(chips15).not.toEqual(chips31); // Different lengths should produce different sequences
  });

  test('should handle different seeds', () => {
    const bits = new Uint8Array([0]);
    const chips1 = dsssSpread(bits, 31, 0b10101);
    const chips2 = dsssSpread(bits, 31, 0b01010);
    
    expect(chips1.length).toBe(31);
    expect(chips2.length).toBe(31);
    expect(chips1).not.toEqual(chips2); // Different seeds should produce different sequences
  });

  test('should handle empty array', () => {
    const bits = new Uint8Array(0);
    const chips = dsssSpread(bits);
    
    expect(chips.length).toBe(0);
    expect(chips).toBeInstanceOf(Int8Array);
  });
});

describe('DSSS Despreading', () => {
  test('should recover original bits perfectly', () => {
    const originalBits = new Uint8Array([0, 1, 0, 1]);
    const chips = dsssSpread(originalBits);
    const llr = dsssDespread(new Float32Array(chips));
    
    expect(llrToBits(llr)).toEqual(Array.from(originalBits));
    for (let i = 0; i < originalBits.length; i++) {
      if (originalBits[i] === 0) {
        expect(llr[i]).toBe(127);
      } else {
        expect(llr[i]).toBe(-127);
      }
    }
  });

  test('should handle single bit', () => {
    const originalBits = new Uint8Array([0]);
    const chips = dsssSpread(originalBits);
    const llr = dsssDespread(new Float32Array(chips));

    expect(llr.length).toBe(1);
    expect(llr[0]).toBe(127);
  });

  test('should work with different seeds', () => {
    const originalBits = new Uint8Array([0, 1]);
    const seed = 0b01010;
    
    const chips = dsssSpread(originalBits, 31, seed);
    const llr = dsssDespread(new Float32Array(chips), 31, seed);
    expect(llrToBits(llr)).toEqual(Array.from(originalBits));
  });

  test('should handle noisy chips', () => {
    const originalBits = new Uint8Array([0, 1, 0]);
    const chips = dsssSpread(originalBits);
    
    // Add small amount of noise
    const noisyChips = chips.map(chip => chip + (Math.random() - 0.5) * 0.2);
    
    const llr = dsssDespread(new Float32Array(noisyChips));
    expect(llrToBits(llr)).toEqual(Array.from(originalBits));
  });

  test('should handle partial chip arrays', () => {
    const originalBits = new Uint8Array([0, 1, 0]);
    const chips = dsssSpread(originalBits);
    
    // Take only first 2 complete symbols (62 chips for M31)
    const partialChips = chips.slice(0, 62);
    const llr = dsssDespread(new Float32Array(partialChips));

    expect(llrToBits(llr)).toEqual([0, 1]);
  });

  test('should handle empty chip array', () => {
    const chips = new Float32Array([]);
    const llr = dsssDespread(chips);
    expect(llr.length).toBe(0);
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

  test('should reduce average soft value magnitude when noise is added (statistical)', () => {
    const phases = new Float32Array([0, Math.PI / 4]);
    const softValuesClean = dpskDemodulate(phases, 10.0);
    const cleanAbs = Math.abs(softValuesClean[0]);
  
    let noisySum = 0;
    const trials = 100;
    for (let i = 0; i < trials; i++) {
      const noisyPhases = addAWGN(phases, 6);
      const softValuesNoisy = dpskDemodulate(noisyPhases, 10.0);
      noisySum += Math.abs(softValuesNoisy[0]);
    }
    const noisyAvg = noisySum / trials;
  
    // 平均的にノイズありの方が信頼度（絶対値）が下がることを期待
    expect(noisyAvg).toBeLessThan(cleanAbs);
  });
});

describe('Complete DSSS-DPSK Pipeline', () => {
  test('should recover original bits through complete pipeline', () => {
    const originalBits = new Uint8Array([0, 1, 0, 1]);
    
    // Forward path: bits → DSSS chips → carrier modulation
    const chips = dsssSpread(originalBits);
    
    // This test uses a simplified, non-DPSK pipeline for basic carrier validation.
    const chipPhases = new Float32Array(chips).map(chip => chip > 0 ? 0 : Math.PI);

    const samplesPerPhase = 100;
    const sampleRate = 48000;
    const carrierFreq = 10000;
    
    const modulated = modulateCarrier(chipPhases, samplesPerPhase, sampleRate, carrierFreq);
    
    // Reverse path: carrier demodulation → DSSS despreading
    const demodulatedPhases = demodulateCarrier(modulated, samplesPerPhase, sampleRate, carrierFreq);
    
    // Convert phases back to chips (hard decision)
    const recoveredChips = demodulatedPhases.map(phase => {
      return Math.cos(phase) > 0 ? 1 : -1;
    });
    
    const llr = dsssDespread(new Float32Array(recoveredChips));

    expect(llrToBits(llr)).toEqual(Array.from(originalBits));
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
      const chips = dsssSpread(new Uint8Array(originalBits));
      const llr = dsssDespread(new Float32Array(chips));

      expect(llrToBits(llr)).toEqual(Array.from(originalBits));
    }
  });
});

describe('Step 2: Phase Continuity Analysis', () => {
  test('should detect continuous phases correctly', () => {
    const continuousPhases = new Float32Array([0, 0.1, 0.2, 0.3, 0.4]);
    const result = checkPhaseContinuity(continuousPhases);
    
    expect(result.isContinuous).toBe(true);
    expect(result.discontinuities).toEqual([]);
    expect(result.maxJump).toBeCloseTo(0.1, 5);
  });

  test('should detect phase discontinuities', () => {
    const discontinuousPhases = new Float32Array([0, 0.1, 4.0, 0.3]); // Large jump: 0.1 → 4.0 (should wrap and detect discontinuity)
    const result = checkPhaseContinuity(discontinuousPhases, 2.0); // Use looser threshold
    
    expect(result.isContinuous).toBe(false);
    expect(result.discontinuities).toContain(2);
    expect(result.maxJump).toBeGreaterThan(2.0);
  });

  test('should handle DPSK modulated phases correctly', () => {
    const chips = new Int8Array([1, -1, 1, -1]); // Changed to proper chip values
    const phases = dpskModulate(chips);
    const result = checkPhaseContinuity(phases);
    
    // DPSK should have π jumps which are expected
    expect(result.discontinuities.length).toBeGreaterThan(0);
    expect(result.maxJump).toBeCloseTo(Math.PI, 2);
  });

  test('should handle custom threshold', () => {
    const phases = new Float32Array([0, 1.5, 3.0]); // 1.5 radian jumps
    const result1 = checkPhaseContinuity(phases, 1.0); // Strict threshold
    const result2 = checkPhaseContinuity(phases, 2.0); // Loose threshold
    
    expect(result1.isContinuous).toBe(false);
    expect(result2.isContinuous).toBe(true);
  });
});

describe('Step 3: Advanced Demodulation Functions', () => {
  describe('phaseUnwrap', () => {
    test('should unwrap phases correctly', () => {
      const wrapped = new Float32Array([0, Math.PI, -Math.PI, 0, Math.PI]);
      const unwrapped = phaseUnwrap(wrapped);
      const expected = [0, Math.PI, Math.PI, 2 * Math.PI, 3 * Math.PI];
      
      console.log('wrapped:', Array.from(wrapped));
      console.log('unwrapped:', Array.from(unwrapped));
      console.log('expected:', expected);
      
      // Proper sign-sensitive floating-point comparison
      for (let i = 0; i < expected.length; i++) {
        expect(unwrapped[i]).toBeCloseTo(expected[i], 4); // Check exact value with sign
      }
    });

    test('should handle continuous phase arrays', () => {
      const continuousPhases = new Float32Array([0, 0.5, 1.0, 1.5, 2.0]);
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
      const original = new Uint8Array([0, 1, 0, 1, 0, 1]);
      const received = new Uint8Array([0, 1, 0, 1, 0, 1]);
      const ber = calculateBER(original, received);
      
      expect(ber).toBe(0);
    });

    test('should calculate BER correctly with errors', () => {
      const original = new Uint8Array([0, 1, 0, 1, 0, 1]);
      const received = new Uint8Array([1, 1, 0, 0, 0, 1]); // 2 errors out of 6 bits
      const ber = calculateBER(original, received);
      
      expect(ber).toBeCloseTo(2/6, 5);
    });

    test('should handle all errors', () => {
      const original = new Uint8Array([0, 0, 0, 0]);
      const received = new Uint8Array([1, 1, 1, 1]);
      const ber = calculateBER(original, received);
      
      expect(ber).toBe(1.0);
    });

    test('should throw error for mismatched lengths', () => {
      const original = new Uint8Array([0, 1, 0]);
      const received = new Uint8Array([0, 1]);
      
      expect(() => calculateBER(original, received)).toThrow();
    });

    test('should handle empty arrays', () => {
      const ber = calculateBER(new Uint8Array(0), new Uint8Array(0));
      expect(ber).toBe(0);
    });
  });

  describe('addAWGN', () => {
    test('should add noise to signal', () => {
      const cleanSignal = new Float32Array([1, 0, -1, 0, 1]);
      const noisySignal = addAWGN(cleanSignal, 10); // 10 dB SNR
      
      expect(noisySignal.length).toBe(cleanSignal.length);
      
      let isDifferent = false;
      for (let i = 0; i < cleanSignal.length; i++) {
        if (Math.abs(noisySignal[i] - cleanSignal[i]) > 0.001) {
          isDifferent = true;
          break;
        }
      }
      expect(isDifferent).toBe(true);
      
      let noisyPower = 0;
      for (let i = 0; i < noisySignal.length; i++) {
        noisyPower += noisySignal[i] * noisySignal[i];
      }
      noisyPower /= noisySignal.length;
      expect(noisyPower).toBeGreaterThan(0.2);
      expect(noisyPower).toBeLessThan(5.0);
    });

    test('should produce different noise for multiple calls', () => {
      const signal = new Float32Array([1, 1, 1, 1]);
      const noisy1 = addAWGN(signal, 5);
      const noisy2 = addAWGN(signal, 5);
      
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
      const originalBits = new Uint8Array([0, 1, 0, 1, 1, 0, 1, 0]);
      
      const spreadChips = dsssSpread(originalBits);
      const phases = dpskModulate(spreadChips);
      
      const samplesPerPhase = 200;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      
      const modulated = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      const demodulatedPhases = demodulateCarrier(modulated, samplesPerPhase, sampleRate, carrierFreq);
      
      const recoveredChips = dpskDemodulate(demodulatedPhases);
      const llr = dsssDespread(new Float32Array(recoveredChips));
      
      // Compare the recovered bits with the original bits, accounting for the 1-bit loss from DPSK.
      const bitsToCompare = llr.length;
      const ber = calculateBER(originalBits.slice(0, bitsToCompare), new Uint8Array(llrToBits(llr)));
      
      expect(ber).toBe(0);
    });

    test('should handle noisy conditions gracefully', () => {
      const originalBits = new Uint8Array([0, 1, 0, 1]);
      
      const spreadChips = dsssSpread(originalBits);
      const phases = dpskModulate(spreadChips);
      
      const samplesPerPhase = 200;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      
      const modulated = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      const noisySignal = addAWGN(modulated, 15); // 15 dB SNR
      const demodulatedPhases = demodulateCarrier(noisySignal, samplesPerPhase, sampleRate, carrierFreq);
      
      const recoveredChips = dpskDemodulate(demodulatedPhases);
      const llr = dsssDespread(new Float32Array(recoveredChips));

      const bitsToCompare = llr.length;
      const ber = calculateBER(originalBits.slice(0, bitsToCompare), new Uint8Array(llrToBits(llr)));

      expect(ber).toBeLessThan(0.5);
    });
  });
});

describe('Step 4-4: DPSK+DSSS Integration Tests (BER & Sync Success Rate)', () => {
  describe('Complete Integration Pipeline with Synchronization', () => {
    test('should achieve end-to-end BER performance with automatic synchronization', () => {
      const originalBits = new Uint8Array([0, 1, 0, 1, 1, 0, 1, 0, 0, 1]);
      
      const spreadChips = dsssSpread(originalBits);
      const phases = dpskModulate(spreadChips);
      
      const samplesPerPhase = 240;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      
      const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      
      const chipOffset = 13;
      const sampleOffset = chipOffset * samplesPerPhase;
      const offsetSamples = new Array(sampleOffset).fill(0).concat(Array.from(samples));
      
      const snr = 8;
      const noisySamples = addAWGN(new Float32Array(offsetSamples), snr);
      
      const reference = generateSyncReference();
      const syncResult = findSyncOffset(
        noisySamples, 
        reference,
        { samplesPerPhase, sampleRate, carrierFreq },
        chipOffset + 10
      );
      
      console.log(`=== END-TO-END SYNC DEBUG ===`);
      console.log(`Data: ${originalBits.length} bits, ${spreadChips.length} chips, ${samples.length} samples`);
      console.log(`Offset: ${chipOffset} chips = ${sampleOffset} samples`);
      console.log(`Signal: ${offsetSamples.length} total samples, SNR=${snr}dB`);
      console.log(`Sync Result: isFound=${syncResult.isFound}, bestChipOffset=${syncResult.bestChipOffset}, peakCorr=${syncResult.peakCorrelation.toFixed(3)}, peakRatio=${syncResult.peakRatio.toFixed(3)}`);
      console.log(`Expected: chipOffset=${chipOffset}, tolerance=±1`);
      
      expect(syncResult.isFound).toBe(true);
      expect(Math.abs(syncResult.bestChipOffset - chipOffset)).toBeLessThanOrEqual(1);
      
      const alignedSamples = noisySamples.slice(syncResult.bestSampleOffset);
      const demodPhases = demodulateCarrier(alignedSamples, samplesPerPhase, sampleRate, carrierFreq);
      const recoveredChips = dpskDemodulate(demodPhases);
      
      const llr = dsssDespread(new Float32Array(recoveredChips));
      
      const bitsToCompare = Math.min(originalBits.length, llr.length);
      const originalBitsSlice = originalBits.slice(0, bitsToCompare);
      const recoveredBitsArray = llrToBits(llr.slice(0, bitsToCompare));
      
      const ber = calculateBER(originalBitsSlice, new Uint8Array(recoveredBitsArray));

      expect(ber).toBeLessThanOrEqual(0.1);
      expect(llr.length).toBeGreaterThanOrEqual(originalBits.length - 1);
    });

    test('should maintain sync and BER performance across multiple SNR levels with statistical validation', { timeout: 60000 }, () => {
      const originalBits = new Uint8Array([0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0]);

      const snrConditions = [
        { snr: 0, minSyncRate: 0.40, maxBER: 0.05 },
        { snr: -3, minSyncRate: 0.25, maxBER: 0.10 },
        { snr: -5, minSyncRate: 0.15, maxBER: 0.20 },
        { snr: -8, minSyncRate: 0.05, maxBER: 0.35 },
        { snr: -10, minSyncRate: 0.02, maxBER: 0.50 },
      ];
      
      const trials = 50;  // Reduced for performance while maintaining statistical validity
      
      for (const condition of snrConditions) {
        let syncSuccessCount = 0;
        let totalBER = 0;
        let validBERCount = 0;
        
        for (let trial = 0; trial < trials; trial++) {
          const spreadChips = dsssSpread(originalBits);
          const phases = dpskModulate(spreadChips);
          
          const samplesPerPhase = 240;
          const sampleRate = 48000;
          const carrierFreq = 10000;
          
          const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
          
          const chipOffset = 7;
          const sampleOffset = chipOffset * samplesPerPhase;
          const offsetSamples = new Array(sampleOffset).fill(0).concat(Array.from(samples));
          
          const noisySamples = addAWGN(new Float32Array(offsetSamples), condition.snr);
          
          const reference = generateSyncReference();
          const syncResult = findSyncOffset(
            noisySamples, 
            reference,
            { samplesPerPhase, sampleRate, carrierFreq },
            20
          );
          
          if (syncResult.isFound && Math.abs(syncResult.bestChipOffset - chipOffset) <= 1) {
            syncSuccessCount++;
            
            const alignedSamples = noisySamples.slice(syncResult.bestSampleOffset);
            const demodPhases = demodulateCarrier(alignedSamples, samplesPerPhase, sampleRate, carrierFreq);
            const recoveredChips = dpskDemodulate(demodPhases);
            const llr = dsssDespread(new Float32Array(recoveredChips));
            
            const bitsToCompare = Math.min(originalBits.length, llr.length);
            const originalBitsSlice = originalBits.slice(0, bitsToCompare);
            const recoveredBitsArray = llrToBits(llr.slice(0, bitsToCompare));
            
            const ber = calculateBER(originalBitsSlice, new Uint8Array(recoveredBitsArray));

            totalBER += ber;
            validBERCount++;
          }
        }
        
        const actualSyncRate = syncSuccessCount / trials;
        const averageBER = validBERCount > 0 ? totalBER / validBERCount : 1.0;
        
        console.log(`SNR ${condition.snr}dB: Sync ${(actualSyncRate * 100).toFixed(1)}%, BER ${averageBER.toFixed(3)}`);
        
        expect(actualSyncRate).toBeGreaterThanOrEqual(condition.minSyncRate);
        
        if (validBERCount > 10) {
          expect(averageBER).toBeLessThanOrEqual(condition.maxBER);
        }
      }
    });
  });

  describe('Synchronization Success Rate Evaluation', () => {
    test('should achieve high sync success rate with statistical evaluation', { timeout: 20000 }, () => {
      const originalBits = new Uint8Array([0, 1, 0, 1, 1, 0]); 
      const numTrials = 50;
      const snr = 6;
      let syncSuccessCount = 0;
      let berSum = 0;
      let validBerCount = 0;
      
      for (let trial = 0; trial < numTrials; trial++) {
        const spreadChips = dsssSpread(originalBits);
        const phases = dpskModulate(spreadChips);
        
        const samplesPerPhase = 240;
        const sampleRate = 48000;
        const carrierFreq = 10000;
        const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
        
        const randomChipOffset = Math.floor(Math.random() * 15) + 5;
        const sampleOffset = randomChipOffset * samplesPerPhase;
        const offsetSamples = new Array(sampleOffset).fill(0).concat(Array.from(samples));
        
        const noisySamples = addAWGN(new Float32Array(offsetSamples), snr);
        
        const reference = generateSyncReference();
        const syncResult = findSyncOffset(noisySamples, reference, { samplesPerPhase, sampleRate, carrierFreq }, 30);
        
        if (syncResult.isFound && Math.abs(syncResult.bestChipOffset - randomChipOffset) <= 1) {
          syncSuccessCount++;
          
          const alignedSamples = noisySamples.slice(syncResult.bestSampleOffset);
          const demodPhases = demodulateCarrier(alignedSamples, samplesPerPhase, sampleRate, carrierFreq);
          const recoveredChips = dpskDemodulate(demodPhases);
          
          const llr = dsssDespread(new Float32Array(recoveredChips));
          const bitsToCompare = Math.min(originalBits.length, llr.length);
          const ber = calculateBER(originalBits.slice(0, bitsToCompare), new Uint8Array(llrToBits(llr.slice(0, bitsToCompare))));

          berSum += ber;
          validBerCount++;
        }
      }
      
      const syncSuccessRate = syncSuccessCount / numTrials;
      const averageBer = validBerCount > 0 ? berSum / validBerCount : 1.0;
      
      console.log(`Sync Success Rate: ${(syncSuccessRate * 100).toFixed(1)}% (${syncSuccessCount}/${numTrials})`);
      console.log(`Average BER (successful syncs): ${averageBer.toFixed(3)}`);
      
      expect(syncSuccessRate).toBeGreaterThanOrEqual(0.85);
      expect(averageBer).toBeLessThan(0.2);
    });

    test('should handle challenging conditions with graceful degradation', { timeout: 60000 }, () => {
      const originalBits = new Uint8Array([0, 1, 0, 1, 1, 0, 1, 0]);
      const challengingConditions = [
        { name: 'Equal SNR', snr: 0, minSyncRate: 0.90 },
        { name: 'Low SNR', snr: -6, minSyncRate: 0.50 },
        { name: 'Very Low SNR', snr: -12, minSyncRate: 0.15 },
        { name: 'Extreme Low SNR', snr: -18, minSyncRate: 0.00 }, // Expect 0% success at -18dB
      ];
      
      for (const condition of challengingConditions) {
        let syncCount = 0;
        const trials = 50;  // Reduced for performance while maintaining statistical validity
        
        for (let trial = 0; trial < trials; trial++) {
          const spreadChips = dsssSpread(originalBits);
          const phases = dpskModulate(spreadChips);
          
          const samplesPerPhase = 240;
          const sampleRate = 48000;
          const carrierFreq = 10000;
          const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
          
          const largeChipOffset = 25;
          const sampleOffset = largeChipOffset * samplesPerPhase;
          const offsetSamples = new Array(sampleOffset).fill(0).concat(Array.from(samples));
          
          const noisySamples = addAWGN(new Float32Array(offsetSamples), condition.snr);
          
          const reference = generateSyncReference();
          const syncResult = findSyncOffset(noisySamples, reference, { samplesPerPhase, sampleRate, carrierFreq }, 50); // Increased search range for better detection
          
          // Debug for challenging conditions test failures  
          if (condition.snr === -12 && trial < 3) {
            console.log(`=== CHALLENGING CONDITIONS DEBUG (${condition.name}, trial ${trial}) ===`);
            console.log(`SNR: ${condition.snr}dB, Expected sync rate: ${condition.minSyncRate}`);
            console.log(`Expected chip offset: ${largeChipOffset}`);
            console.log(`Actual chip offset: ${syncResult.bestChipOffset}`);
            console.log(`Offset difference: ${Math.abs(syncResult.bestChipOffset - largeChipOffset)}`);
            console.log(`Is found: ${syncResult.isFound}`);
            console.log(`Peak correlation: ${syncResult.peakCorrelation.toFixed(3)}`);
            console.log(`Peak ratio: ${syncResult.peakRatio.toFixed(3)}`);
            console.log(`Sample offset: ${syncResult.bestSampleOffset} / ${sampleOffset} expected`);
            console.log(`Success condition: ${syncResult.isFound && Math.abs(syncResult.bestChipOffset - largeChipOffset) <= 1}`);
          }
          
          if (syncResult.isFound && Math.abs(syncResult.bestChipOffset - largeChipOffset) <= 1) syncCount++;
        }
       
        const successRate = syncCount / trials;
        console.log(`${condition.name} ${condition.snr}: ${(successRate * 100).toFixed(1)}% success`);
        
        expect(successRate).toBeGreaterThanOrEqual(condition.minSyncRate);
        expect(successRate).toBeLessThanOrEqual(1.0); // Max rate is always 100%
      }
    });
  });

  describe('Soft Value Integration Performance', () => {
    test('should provide meaningful soft values through complete pipeline', () => {
      const originalBits = new Uint8Array([0, 1, 0, 1]);
      
      const spreadChips = dsssSpread(originalBits);
      const phases = dpskModulate(spreadChips);
      
      const samplesPerPhase = 240;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      
      const chipOffset = 8;
      const sampleOffset = chipOffset * samplesPerPhase;
      const offsetSamples = new Array(sampleOffset).fill(0).concat(Array.from(samples));
      
      const noisySamples = addAWGN(new Float32Array(offsetSamples), 7);
      
      const reference = generateSyncReference();
      const syncResult = findSyncOffset(noisySamples, reference, { samplesPerPhase, sampleRate, carrierFreq }, 20);
      expect(syncResult.isFound).toBe(true);
      
      const alignedSamples = noisySamples.slice(syncResult.bestSampleOffset);
      const demodPhases = demodulateCarrier(alignedSamples, samplesPerPhase, sampleRate, carrierFreq);
      const recoveredChips = dpskDemodulate(demodPhases);
      
      const llr = dsssDespread(new Float32Array(recoveredChips));

      expect(llr.length).toBeGreaterThanOrEqual(originalBits.length - 1);
      
      for (let i = 0; i < llr.length; i++) {
        expect(Math.abs(llr[i])).toBeGreaterThan(5);
      }

      const bitsToCompare = Math.min(originalBits.length, llr.length);
      expect(calculateBER(originalBits.slice(0, bitsToCompare), new Uint8Array(llrToBits(llr.slice(0, bitsToCompare))))).toBeLessThan(0.25);
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
      const originalBits = new Uint8Array([0, 1, 0, 1, 1]);
      const reference = generateSyncReference();
      
      const spreadChips = dsssSpread(originalBits);
      const phases = dpskModulate(spreadChips);
      
      const samplesPerPhase = 240;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      
      const noisySamples = addAWGN(samples, 20);
      
      const result = findSyncOffset(noisySamples, reference, { samplesPerPhase, sampleRate, carrierFreq }, 10);
      
      console.log(`DEBUG Basic Sync: isFound=${result.isFound}, peakCorr=${result.peakCorrelation.toFixed(3)}, peakRatio=${result.peakRatio.toFixed(3)}, bestChipOffset=${result.bestChipOffset}`);
      
      expect(result.bestChipOffset).toBe(0);
      expect(result.isFound).toBe(true);
      expect(Math.abs(result.peakCorrelation)).toBeGreaterThan(0.8);
    });

    test('should find synchronization with offset', () => {
      const reference = generateSyncReference();
      const originalBits = new Uint8Array([0]);
      
      const spreadChips = dsssSpread(originalBits);
      const phases = dpskModulate(spreadChips);
      
      const samplesPerPhase = 240;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      
      const chipOffset = 5;
      const sampleOffset = chipOffset * samplesPerPhase;
      const offsetSamples = new Array(sampleOffset).fill(0).concat(Array.from(samples)).concat(new Array(720).fill(0));
      
      const noisySamples = addAWGN(new Float32Array(offsetSamples), 20);
      
      const result = findSyncOffset(noisySamples, reference, { samplesPerPhase, sampleRate, carrierFreq }, 20);
      
      expect(result.bestChipOffset).toBe(chipOffset);
      expect(result.isFound).toBe(true);
      expect(Math.abs(result.peakCorrelation)).toBeGreaterThan(0.7);
    });

    test('should handle inverted sequences', () => {
      // Use multiple inverted bits for longer signal and better correlation
      const originalBits = new Uint8Array([1, 1, 1]); // 3 bits = 93 chips for better correlation
      const reference = generateSyncReference();
      
      const spreadChips = dsssSpread(originalBits);
      const phases = dpskModulate(spreadChips);
      
      const samplesPerPhase = 240;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      
      const noisySamples = addAWGN(samples, 15); // Higher SNR for reliable inverted detection
      
      const result = findSyncOffset(noisySamples, reference, { samplesPerPhase, sampleRate, carrierFreq }, 15); // Increased search range
      
      // Debug for inverted sequence test failure
      console.log(`=== INVERTED SEQUENCE DEBUG ===`);
      console.log(`Original bits: [${Array.from(originalBits).join(',')}]`);
      console.log(`Spread chips length: ${spreadChips.length}`);
      console.log(`DPSK phases length: ${phases.length}`);
      console.log(`Carrier samples length: ${samples.length}`);
      console.log(`Noisy samples length: ${noisySamples.length}, SNR: 15dB`);
      console.log(`Reference sequence length: ${reference.length}`);
      console.log(`Search range: 15 chips`);
      console.log(`Expected: negative correlation < -0.3, isFound = true`);
      console.log(`Actual result: isFound=${result.isFound}, correlation=${result.peakCorrelation.toFixed(3)}`);
      console.log(`Peak ratio: ${result.peakRatio.toFixed(3)}, chip offset: ${result.bestChipOffset}`);
      
      // Verify detection succeeds for inverted sequences
      expect(result.isFound).toBe(true); // Must detect inverted sequences at reasonable SNR
      expect(result.peakCorrelation).toBeLessThan(-0.3); // Significant negative correlation required
      expect(result.bestChipOffset).toBeGreaterThanOrEqual(0); // Valid chip offset
    });

    test('should fail to find sync in random noise', () => {
      const reference = generateSyncReference();
      
      const noiseSignal = new Float32Array(5000);
      for (let i = 0; i < noiseSignal.length; i++) {
        noiseSignal[i] = (Math.random() - 0.5) * 2;
      }
      
      const result = findSyncOffset(noiseSignal, reference, { samplesPerPhase: 240, sampleRate: 48000, carrierFreq: 10000 }, 35);
      
      expect(result.isFound).toBe(false);
    });

    test('should handle noisy synchronization', () => {
      const originalBits = new Uint8Array([0, 1, 0, 1, 1]);
      const reference = generateSyncReference();
      
      const spreadChips = dsssSpread(originalBits);
      const phases = dpskModulate(spreadChips);
      
      const samplesPerPhase = 240;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      
      const chipOffset = 3;
      const sampleOffset = chipOffset * samplesPerPhase;
      const offsetPadding = new Array(sampleOffset).fill(0);
      const offsetSamples = new Float32Array(offsetPadding.concat(Array.from(samples)));
      const noisySamples = addAWGN(offsetSamples, 8);
      
      const result = findSyncOffset(noisySamples, reference, { samplesPerPhase, sampleRate, carrierFreq }, 15);
      
      expect(result.bestChipOffset).toBe(chipOffset);
      expect(result.isFound).toBe(true);
      expect(Math.abs(result.peakCorrelation)).toBeGreaterThan(0.5);
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
      const largeOffsets = [31, 50, 75, 100];
      
      for (const targetOffset of largeOffsets) {
        const originalBits = new Uint8Array([0]);
        
        const spreadChips = dsssSpread(originalBits);
        const phases = dpskModulate(spreadChips);
        
        const samplesPerPhase = 240;
        const sampleRate = 48000;
        const carrierFreq = 10000;
        const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
        
        const sampleOffset = targetOffset * samplesPerPhase;
        const offsetSamples = new Array(sampleOffset).fill(0).concat(Array.from(samples)).concat(new Array(720).fill(0));
        
        const noisySamples = addAWGN(new Float32Array(offsetSamples), 25);
        
        const result = findSyncOffset(noisySamples, reference, { samplesPerPhase, sampleRate, carrierFreq }, targetOffset + 10);
        
        expect(result.bestChipOffset).toBe(targetOffset);
        expect(result.isFound).toBe(true);
        expect(Math.abs(result.peakCorrelation)).toBeGreaterThan(0.8);
      }
    });

    test('should maintain precision near M-sequence boundaries', () => {
      const reference = generateSyncReference();
      const boundaryOffsets = [29, 30, 31, 32, 33];
      
      for (const targetOffset of boundaryOffsets) {
        const originalBits = new Uint8Array([0]);
        
        const spreadChips = dsssSpread(originalBits);
        const phases = dpskModulate(spreadChips);
        
        const samplesPerPhase = 240;
        const sampleRate = 48000;
        const carrierFreq = 10000;
        const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
        
        const sampleOffset = targetOffset * samplesPerPhase;
        const offsetSamples = new Array(sampleOffset).fill(0).concat(Array.from(samples)).concat(new Array(720).fill(0));
        
        const noisySamples = addAWGN(new Float32Array(offsetSamples), 25);
        
        const result = findSyncOffset(noisySamples, reference, { samplesPerPhase, sampleRate, carrierFreq }, targetOffset + 15);
        
        expect(result.bestChipOffset).toBe(targetOffset);
        expect(result.isFound).toBe(true);
        expect(Math.abs(result.peakCorrelation)).toBeGreaterThan(0.8);
      }
    });

    test('should handle fractional chip timing with interpolation accuracy', () => {
      const reference = generateSyncReference();
      
      const originalBits = new Uint8Array([0]);
      
      const spreadChips = dsssSpread(originalBits);
      const phases = dpskModulate(spreadChips);
      
      const samplesPerPhase = 240;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      
      const chipOffset = 5;
      const fractionalSampleOffset = 72;
      const sampleOffset = chipOffset * samplesPerPhase + fractionalSampleOffset;
      const offsetSamples = new Array(sampleOffset).fill(0).concat(Array.from(samples)).concat(new Array(720).fill(0));
      
      const noisySamples = addAWGN(new Float32Array(offsetSamples), 20);
      
      const result = findSyncOffset(noisySamples, reference, { samplesPerPhase, sampleRate, carrierFreq }, 20);
      
      expect(Math.abs(result.bestChipOffset - chipOffset)).toBeLessThanOrEqual(1);
      expect(result.isFound).toBe(true);
      expect(Math.abs(result.peakCorrelation)).toBeGreaterThan(0.6);
    });

    test('should detect precise offset with noise at various SNR levels', () => {
      const reference = generateSyncReference();
      const chipOffset = 8;
      const snrLevels = [15, 10, 5];
      
      for (const snr of snrLevels) {
        const originalBits = new Uint8Array([0]);
        
        const spreadChips = dsssSpread(originalBits);
        const phases = dpskModulate(spreadChips);
        
        const samplesPerPhase = 240;
        const sampleRate = 48000;
        const carrierFreq = 10000;
        const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
        
        const sampleOffset = chipOffset * samplesPerPhase;
        const offsetSamples = new Array(sampleOffset).fill(0).concat(Array.from(samples)).concat(new Array(720).fill(0));
        
        const noisySamples = addAWGN(new Float32Array(offsetSamples), snr);
        
        const result = findSyncOffset(noisySamples, reference, { samplesPerPhase, sampleRate, carrierFreq }, 20);
        
        expect(result.bestChipOffset).toBe(chipOffset);
        expect(result.isFound).toBe(true);
        
        if (snr >= 10) {
          expect(Math.abs(result.peakCorrelation)).toBeGreaterThan(0.7);
        } else {
          expect(Math.abs(result.peakCorrelation)).toBeGreaterThan(0.5);
        }
      }
    });

    test('should distinguish between similar offset positions', () => {
      const reference = generateSyncReference();
      
      const consecutiveOffsets = [10, 11, 12];
      
      for (const targetOffset of consecutiveOffsets) {
        const originalBits = new Uint8Array([0]);
        
        const spreadChips = dsssSpread(originalBits);
        const phases = dpskModulate(spreadChips);
        
        const samplesPerPhase = 240;
        const sampleRate = 48000;
        const carrierFreq = 10000;
        const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
        
        const sampleOffset = targetOffset * samplesPerPhase;
        const offsetSamples = new Array(sampleOffset).fill(0).concat(Array.from(samples)).concat(new Array(720).fill(0));
        
        const noisySamples = addAWGN(new Float32Array(offsetSamples), 25);
        
        const result = findSyncOffset(noisySamples, reference, { samplesPerPhase, sampleRate, carrierFreq }, 25);
        
        expect(result.bestChipOffset).toBe(targetOffset);
        expect(result.isFound).toBe(true);
        expect(Math.abs(result.peakCorrelation)).toBeGreaterThan(0.8);
      }
    });

    test('should handle edge cases and boundary conditions', () => {
      const reference = generateSyncReference();
      
      const edgeCases = [
        { name: 'zero offset', offset: 0 },
        { name: 'single chip offset', offset: 1 },
        { name: 'M31 sequence length offset', offset: 31 }
      ];
      
      for (const testCase of edgeCases) {
        const originalBits = new Uint8Array([0]);
        
        const spreadChips = dsssSpread(originalBits);
        const phases = dpskModulate(spreadChips);
        
        const samplesPerPhase = 240;
        const sampleRate = 48000;
        const carrierFreq = 10000;
        const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
        
        const sampleOffset = testCase.offset * samplesPerPhase;
        const offsetSamples = new Array(sampleOffset).fill(0).concat(Array.from(samples)).concat(new Array(720).fill(0));
        
        const noisySamples = addAWGN(new Float32Array(offsetSamples), 25);
        
        const result = findSyncOffset(noisySamples, reference, { samplesPerPhase, sampleRate, carrierFreq }, testCase.offset + 10);
        
        expect(result.bestChipOffset).toBe(testCase.offset);
        expect(result.isFound).toBe(true);
        expect(Math.abs(result.peakCorrelation)).toBeGreaterThan(0.8);
      }
    });

    test('should handle partial sequence at end of search range', () => {
      const reference = generateSyncReference();
      
      const originalBits = new Uint8Array([0]);
      const spreadChips = dsssSpread(originalBits);
      const phases = dpskModulate(spreadChips);
      
      const samplesPerPhase = 240;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      
      const chipOffset = 15;
      const sampleOffset = chipOffset * samplesPerPhase;
      const partialSampleLength = 20 * samplesPerPhase;
      const partialSamples = samples.slice(0, partialSampleLength);
      const received = new Array(sampleOffset).fill(0).concat(Array.from(partialSamples));
      
      const noisySamples = addAWGN(new Float32Array(received), 20);
      
      const result = findSyncOffset(noisySamples, reference, { samplesPerPhase, sampleRate, carrierFreq }, 25);
      
      expect(result.isFound).toBe(false);
    });
  });

  describe('Integrated Synchronization Tests', () => {
    test('should achieve automatic synchronization from arbitrary offset', () => {
      const originalBits = new Uint8Array([0, 1, 0, 1, 1, 0]);
      
      const spreadChips = dsssSpread(originalBits);
      const phases = dpskModulate(spreadChips);
      
      const samplesPerPhase = 240;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      
      const chipOffset = 7;
      const sampleOffset = chipOffset * samplesPerPhase;
      const offsetSamples = new Array(sampleOffset).fill(0).concat(Array.from(samples));
      
      const noisySamples = addAWGN(new Float32Array(offsetSamples), 10);
      
      const reference = generateSyncReference();
      const syncResult = findSyncOffset(noisySamples, reference, { samplesPerPhase, sampleRate, carrierFreq }, 20);
      
      expect(syncResult.isFound).toBe(true);
      
      const alignedSamples = noisySamples.slice(syncResult.bestSampleOffset);
      const demodPhases = demodulateCarrier(alignedSamples, samplesPerPhase, sampleRate, carrierFreq);
      const recoveredChips = dpskDemodulate(demodPhases);
      
      const llr = dsssDespread(new Float32Array(recoveredChips));
      
      const bitsToCompare = Math.min(originalBits.length, llr.length);
      expect(new Uint8Array(llrToBits(llr.slice(0, bitsToCompare)))).toEqual(originalBits.slice(0, bitsToCompare));
    });

    test('should handle multiple synchronization attempts', () => {
      const reference = generateSyncReference();
      const testOffsets = [0, 5, 10];
      
      for (const targetOffset of testOffsets) {
        const originalBits = new Uint8Array([0]);
        
        const spreadChips = dsssSpread(originalBits);
        const phases = dpskModulate(spreadChips);
        
        const samplesPerPhase = 240;
        const sampleRate = 48000;
        const carrierFreq = 10000;
        const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
        
        const sampleOffset = targetOffset * samplesPerPhase;
        const offsetSamples = new Array(sampleOffset).fill(0).concat(Array.from(samples)).concat(new Array(720).fill(0));
        
        const noisySamples = addAWGN(new Float32Array(offsetSamples), 25);
        
        const result = findSyncOffset(noisySamples, reference, { samplesPerPhase, sampleRate, carrierFreq }, 25);
        
        expect(result.bestChipOffset).toBe(targetOffset);
        expect(result.isFound).toBe(true);
      }
    });
  });
});

describe('DSSS-DPSK Carrier Modulation', () => {
  const TOLERANCE = 0.01;

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
      const phases = new Float32Array([0]);
      const samplesPerPhase = 100;
      const sampleRate = 48000;
      const carrierFreq = 1000;
      
      const samples = modulateCarrier(phases, samplesPerPhase, sampleRate, carrierFreq);
      
      for (const sample of samples) {
        expect(Math.abs(sample)).toBeLessThanOrEqual(1.0);
      }
    });

    test('should apply phase offset correctly', () => {
      const samplesPerPhase = 100;
      const sampleRate = 48000;
      const carrierFreq = 1000;
      
      const samples0 = modulateCarrier(new Float32Array([0]), samplesPerPhase, sampleRate, carrierFreq);
      const samplesPI = modulateCarrier(new Float32Array([Math.PI]), samplesPerPhase, sampleRate, carrierFreq);
      
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
      const samplesPerPhase = 240;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      
      const modulated = modulateCarrier(testPhases, samplesPerPhase, sampleRate, carrierFreq);
      const demodulated = demodulateCarrier(modulated, samplesPerPhase, sampleRate, carrierFreq);
      
      expect(demodulated.length).toBe(testPhases.length);
      
      for (let i = 0; i < testPhases.length; i++) {
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
      
      const samples1 = modulateCarrier(new Float32Array([0]), samplesPerPhase, sampleRate, carrierFreq, 0);
      
      const samples2 = modulateCarrier(new Float32Array([0]), samplesPerPhase, sampleRate, carrierFreq, samplesPerPhase);
      
      const combined = new Float32Array(samples1.length + samples2.length);
      combined.set(samples1, 0);
      combined.set(samples2, samples1.length);
      
      const omega = 2 * Math.PI * carrierFreq / sampleRate;
      
      const lastSample1 = samples1[samples1.length - 1];
      const expectedLastPhase = omega * (samplesPerPhase - 1);
      expect(lastSample1).toBeCloseTo(Math.sin(expectedLastPhase), 3);
      
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