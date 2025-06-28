import { describe, test, expect } from 'vitest';
import { 
  bitsToPhaseDifferences, 
  accumulatePhases, 
  dpskModulate,
  modulateCarrier, 
  demodulateCarrier 
} from '../../src/modems/dsss-dpsk';

describe('DPSK Modulation', () => {
  const TOLERANCE = 0.01; // Phase tolerance in radians

  describe('bitsToPhaseDifferences', () => {
    test('should convert bits to correct phase differences', () => {
      const bits = [0, 1, 0, 1];
      const phaseDiffs = bitsToPhaseDifferences(bits);
      
      expect(phaseDiffs).toEqual([0, Math.PI, 0, Math.PI]);
    });

    test('should handle empty array', () => {
      const bits: number[] = [];
      const phaseDiffs = bitsToPhaseDifferences(bits);
      
      expect(phaseDiffs).toEqual([]);
    });

    test('should handle all zeros', () => {
      const bits = [0, 0, 0, 0];
      const phaseDiffs = bitsToPhaseDifferences(bits);
      
      expect(phaseDiffs).toEqual([0, 0, 0, 0]);
    });

    test('should handle all ones', () => {
      const bits = [1, 1, 1, 1];
      const phaseDiffs = bitsToPhaseDifferences(bits);
      
      expect(phaseDiffs).toEqual([Math.PI, Math.PI, Math.PI, Math.PI]);
    });
  });

  describe('accumulatePhases', () => {
    test('should accumulate phase differences correctly', () => {
      const phaseDiffs = [0, Math.PI, 0, Math.PI];
      const phases = accumulatePhases(phaseDiffs);
      
      expect(phases).toEqual([0, 0, Math.PI, Math.PI]);
    });

    test('should use custom initial phase', () => {
      const phaseDiffs = [0, Math.PI];
      const initialPhase = Math.PI / 2;
      const phases = accumulatePhases(phaseDiffs, initialPhase);
      
      expect(phases[0]).toBeCloseTo(Math.PI / 2, 5);
      expect(phases[1]).toBeCloseTo(Math.PI / 2, 5);
    });

    test('should handle empty array', () => {
      const phaseDiffs: number[] = [];
      const phases = accumulatePhases(phaseDiffs);
      
      expect(phases).toEqual([]);
    });

    test('should maintain phase continuity', () => {
      const phaseDiffs = [Math.PI, Math.PI, Math.PI];
      const phases = accumulatePhases(phaseDiffs);
      
      expect(phases[0]).toBeCloseTo(0, 5);
      expect(phases[1]).toBeCloseTo(Math.PI, 5);
      expect(phases[2]).toBeCloseTo(2 * Math.PI, 5);
    });
  });

  describe('dpskModulate', () => {
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

    test('should maintain discrete phase output', () => {
      const testPhases = [0, Math.PI/4, Math.PI/2, Math.PI];
      const samplesPerPhase = 240;
      const sampleRate = 48000;
      const carrierFreq = 10000;
      
      const modulated = modulateCarrier(testPhases, samplesPerPhase, sampleRate, carrierFreq);
      const demodulated = demodulateCarrier(modulated, samplesPerPhase, sampleRate, carrierFreq);
      
      expect(demodulated.length).toBe(testPhases.length);
      
      // Each demodulated phase should match its input
      for (let i = 0; i < testPhases.length; i++) {
        let phaseDiff = demodulated[i] - testPhases[i];
        while (phaseDiff > Math.PI) phaseDiff -= 2 * Math.PI;
        while (phaseDiff < -Math.PI) phaseDiff += 2 * Math.PI;
        expect(Math.abs(phaseDiff)).toBeLessThan(TOLERANCE);
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