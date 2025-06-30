import { describe, test, expect, beforeEach } from 'vitest';
import { AGCProcessor } from '../../src/dsp/agc';

describe('AGCProcessor', () => {
  let agc: AGCProcessor;
  const sampleRate = 48000;

  beforeEach(() => {
    agc = new AGCProcessor(sampleRate, 0.5); // Target level 0.5
  });

  describe('Construction and Configuration', () => {
    test('should initialize with default parameters', () => {
      expect(agc.getCurrentGain()).toBe(1.0);
    });

    test('should accept custom target level', () => {
      const customAGC = new AGCProcessor(sampleRate, 0.8);
      expect(customAGC.getCurrentGain()).toBe(1.0);
    });

    test('should accept custom time constants', () => {
      const customAGC = new AGCProcessor(sampleRate, 0.5, 2.0, 20.0);
      expect(customAGC.getCurrentGain()).toBe(1.0);
    });
  });

  describe('Gain Control', () => {
    test('should reduce gain for loud signals', () => {
      // Create loud signal (amplitude 1.0, target is 0.5)
      const samples = new Float32Array([1.0, 1.0, 1.0, 1.0]);
      const initialGain = agc.getCurrentGain();
      
      agc.process(samples);
      
      // Gain should be reduced
      expect(agc.getCurrentGain()).toBeLessThan(initialGain);
      // Output should be closer to target level (AGC takes time to converge)
      expect(Math.abs(samples[samples.length - 1])).toBeLessThan(1.0);
    });

    test('should increase gain for quiet signals', () => {
      // Create quiet signal (amplitude 0.1, target is 0.5)
      const samples = new Float32Array([0.1, 0.1, 0.1, 0.1]);
      const initialGain = agc.getCurrentGain();
      
      agc.process(samples);
      
      // Gain should be increased
      expect(agc.getCurrentGain()).toBeGreaterThan(initialGain);
      // Output should be closer to target level
      expect(Math.abs(samples[samples.length - 1])).toBeGreaterThan(0.1);
    });

    test('should maintain stable gain for target-level signals', () => {
      // Create signal at target level
      const samples = new Float32Array([0.5, 0.5, 0.5, 0.5]);
      const initialGain = agc.getCurrentGain();
      
      agc.process(samples);
      
      // Gain should remain close to initial value
      expect(Math.abs(agc.getCurrentGain() - initialGain)).toBeLessThan(0.1);
    });
  });

  describe('Gain Limiting', () => {
    test('should limit maximum gain', () => {
      // Create very quiet signal to test gain limiting
      const samples = new Float32Array(1000).fill(0.001);
      
      agc.process(samples);
      
      // Gain should not exceed maximum limit (10.0)
      expect(agc.getCurrentGain()).toBeLessThanOrEqual(10.0);
    });

    test('should limit minimum gain', () => {
      // Create very loud signal to test gain limiting
      const samples = new Float32Array(1000).fill(10.0);
      
      agc.process(samples);
      
      // Gain should not go below minimum limit (0.1)
      expect(agc.getCurrentGain()).toBeGreaterThanOrEqual(0.1);
    });
  });

  describe('Attack and Release Behavior', () => {
    test('should attack quickly for loud signals', () => {
      const agcFast = new AGCProcessor(sampleRate, 0.5, 0.1, 10.0); // Very fast attack
      const agcSlow = new AGCProcessor(sampleRate, 0.5, 10.0, 10.0); // Slow attack
      
      const loudSamples1 = new Float32Array([2.0, 2.0, 2.0]);
      const loudSamples2 = new Float32Array([2.0, 2.0, 2.0]);
      
      agcFast.process(loudSamples1);
      agcSlow.process(loudSamples2);
      
      // Fast attack should reduce gain more quickly
      expect(agcFast.getCurrentGain()).toBeLessThan(agcSlow.getCurrentGain());
    });

    test('should release slowly for quiet signals', () => {
      // Start with reduced gain
      const loudSignal = new Float32Array([5.0, 5.0, 5.0]);
      agc.process(loudSignal);
      const reducedGain = agc.getCurrentGain();
      
      // Then apply quiet signal
      const quietSignal = new Float32Array([0.1, 0.1, 0.1]);
      agc.process(quietSignal);
      
      // Gain should increase, but slowly
      expect(agc.getCurrentGain()).toBeGreaterThan(reducedGain);
      expect(agc.getCurrentGain()).toBeLessThan(1.0); // But not back to 1.0 immediately
    });
  });

  describe('State Management', () => {
    test('should reset to initial state', () => {
      // Modify AGC state
      const samples = new Float32Array([5.0, 5.0, 5.0]);
      agc.process(samples);
      const modifiedGain = agc.getCurrentGain();
      
      // Reset
      agc.reset();
      
      expect(agc.getCurrentGain()).toBe(1.0);
      expect(agc.getCurrentGain()).not.toBe(modifiedGain);
    });

    test('should reset with custom initial gain', () => {
      agc.reset(2.0);
      expect(agc.getCurrentGain()).toBe(2.0);
    });

    test('should update target level', () => {
      const newTarget = 0.8;
      agc.setTargetLevel(newTarget);
      
      // Test with signal at new target level
      const samples = new Float32Array([0.8, 0.8, 0.8, 0.8]);
      const initialGain = agc.getCurrentGain();
      
      agc.process(samples);
      
      // Gain should remain relatively stable at new target
      expect(Math.abs(agc.getCurrentGain() - initialGain)).toBeLessThan(0.2);
    });

    test('should clamp target level to valid range', () => {
      agc.setTargetLevel(1.5); // Above max
      agc.setTargetLevel(-0.1); // Below min
      
      // Should not crash and should still function
      const samples = new Float32Array([0.5, 0.5, 0.5, 0.5]);
      expect(() => agc.process(samples)).not.toThrow();
    });
  });

  describe('Processing Edge Cases', () => {
    test('should handle zero input gracefully', () => {
      const samples = new Float32Array([0, 0, 0, 0]);
      const initialGain = agc.getCurrentGain();
      
      expect(() => agc.process(samples)).not.toThrow();
      
      // Gain should not change significantly for zero input
      expect(agc.getCurrentGain()).toBeCloseTo(initialGain, 1);
    });

    test('should handle alternating positive/negative signals', () => {
      const samples = new Float32Array([1.0, -1.0, 1.0, -1.0]);
      
      expect(() => agc.process(samples)).not.toThrow();
      
      // Should process based on absolute values
      expect(agc.getCurrentGain()).toBeLessThan(1.0); // Gain reduced for loud signals
    });

    test('should handle empty buffer', () => {
      const samples = new Float32Array(0);
      const initialGain = agc.getCurrentGain();
      
      expect(() => agc.process(samples)).not.toThrow();
      expect(agc.getCurrentGain()).toBe(initialGain);
    });
  });

  describe('Real-world Scenarios', () => {
    test('should handle speech-like dynamic signal', () => {
      // Simulate speech with varying amplitudes
      const speechLike = new Float32Array(1000);
      for (let i = 0; i < speechLike.length; i++) {
        // Varying amplitude with some quiet periods
        const envelope = i < 200 ? 0.1 : i < 400 ? 0.8 : i < 600 ? 0.3 : 0.9;
        speechLike[i] = envelope * Math.sin(2 * Math.PI * i / 100);
      }
      
      expect(() => agc.process(speechLike)).not.toThrow();
      
      // AGC should have adapted to the varying levels
      expect(agc.getCurrentGain()).toBeGreaterThan(0.1);
      expect(agc.getCurrentGain()).toBeLessThan(10.0);
    });

    test('should converge output to target level over time', () => {
      const targetLevel = 0.5;
      const testAGC = new AGCProcessor(sampleRate, targetLevel);
      
      // Process multiple blocks of constant amplitude
      const amplitude = 1.5; // Above target
      const blockSize = 100;
      let finalOutputLevel = 0;
      
      for (let block = 0; block < 10; block++) {
        const samples = new Float32Array(blockSize).fill(amplitude);
        testAGC.process(samples);
        finalOutputLevel = Math.abs(samples[samples.length - 1]);
      }
      
      // Final output should be reasonably close to target level
      expect(finalOutputLevel).toBeCloseTo(targetLevel, 0);
    });
  });
});