/**
 * SimpleSync unit tests - focused on pattern matching accuracy
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FSKCore, DEFAULT_FSK_CONFIG } from '../../src/modems/fsk.js';

describe('SimpleSync Pattern Matching', () => {
  let fskCore: FSKCore;
  const testConfig = {
    ...DEFAULT_FSK_CONFIG,
    sampleRate: 48000,
    baudRate: 300,
    markFrequency: 1650,
    spaceFrequency: 1850,
    syncThreshold: 0.85
  };

  beforeEach(() => {
    fskCore = new FSKCore(testConfig);
    fskCore.configure(testConfig);
  });

  describe('Known Pattern Detection', () => {
    it('should detect preamble+SFD pattern in clean signal', async () => {
      // Create a simple test message
      const testData = new Uint8Array([0x48]); // 'H'
      
      // Generate FSK signal
      const signal = await fskCore.modulateData(testData);
      console.log(`Generated test signal: ${signal.length} samples`);
      
      // Demodulate and check frame detection
      const demodulated = await fskCore.demodulateData(signal);
      
      // Should successfully demodulate the 'H'
      expect(demodulated.length).toBe(1);
      expect(demodulated[0]).toBe(0x48);
    });

    it('should detect pattern in signal with multiple bytes', async () => {
      // Test with "Hello"
      const testData = new TextEncoder().encode('Hello');
      
      const signal = await fskCore.modulateData(testData);
      const demodulated = await fskCore.demodulateData(signal);
      
      expect(demodulated.length).toBe(5);
      const decodedText = new TextDecoder().decode(demodulated);
      expect(decodedText).toBe('Hello');
    });

    it('should handle exact preamble+SFD pattern', async () => {
      // Test with exact preamble pattern
      const testData = new Uint8Array([0x55, 0x55, 0x7E, 0x48]); // preamble + SFD + 'H'
      
      const signal = await fskCore.modulateData(testData);
      const demodulated = await fskCore.demodulateData(signal);
      
      // Should demodulate all 4 bytes
      expect(demodulated.length).toBe(4);
      expect(Array.from(demodulated)).toEqual([0x55, 0x55, 0x7E, 0x48]);
    });
  });

  describe('Pattern Positioning', () => {
    it('should start demodulation from correct position', async () => {
      // Generate a test signal and verify the first decoded byte
      const testData = new Uint8Array([0x41, 0x42, 0x43]); // 'ABC'
      
      const signal = await fskCore.modulateData(testData);
      const demodulated = await fskCore.demodulateData(signal);
      
      // First decoded byte should be 'A', not something from preamble
      expect(demodulated.length).toBeGreaterThan(0);
      expect(demodulated[0]).toBe(0x41); // 'A'
      
      if (demodulated.length >= 3) {
        expect(demodulated[1]).toBe(0x42); // 'B'
        expect(demodulated[2]).toBe(0x43); // 'C'
      }
    });

    it('should detect pattern with different thresholds', async () => {
      const testData = new Uint8Array([0x48]); // 'H'
      const signal = await fskCore.modulateData(testData);
      
      // Test with different sync thresholds
      const thresholds = [0.7, 0.75, 0.8, 0.85, 0.9];
      
      for (const threshold of thresholds) {
        const config = { ...testConfig, syncThreshold: threshold };
        fskCore.configure(config);
        
        const demodulated = await fskCore.demodulateData(signal);
        console.log(`Threshold ${threshold}: demodulated ${demodulated.length} bytes`);
        
        if (demodulated.length > 0) {
          expect(demodulated[0]).toBe(0x48);
        }
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle partial pattern matches', async () => {
      // Create a signal that might have partial matches
      const testData = new Uint8Array([0x54, 0x55, 0x56]); // Similar to preamble 0x55
      
      const signal = await fskCore.modulateData(testData);
      const demodulated = await fskCore.demodulateData(signal);
      
      // Should still correctly identify the real preamble and decode the data
      expect(demodulated.length).toBe(3);
      expect(Array.from(demodulated)).toEqual([0x54, 0x55, 0x56]);
    });

    it('should handle noisy signal', async () => {
      const testData = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
      
      const signal = await fskCore.modulateData(testData);
      
      // Add small amount of noise
      const noisySignal = new Float32Array(signal.length);
      for (let i = 0; i < signal.length; i++) {
        noisySignal[i] = signal[i] + (Math.random() - 0.5) * 0.1; // 10% noise
      }
      
      const demodulated = await fskCore.demodulateData(noisySignal);
      
      // Should still decode most of the data correctly
      expect(demodulated.length).toBeGreaterThan(0);
      if (demodulated.length >= 5) {
        const decoded = new TextDecoder().decode(demodulated);
        expect(decoded).toBe('Hello');
      }
    });

    it('should fail gracefully with no pattern', async () => {
      // Create random noise without any FSK pattern
      const randomSignal = new Float32Array(8192);
      for (let i = 0; i < randomSignal.length; i++) {
        randomSignal[i] = (Math.random() - 0.5) * 2; // Random noise
      }
      
      const demodulated = await fskCore.demodulateData(randomSignal);
      
      // Should return empty result, not crash
      expect(demodulated.length).toBe(0);
    });
  });

  describe('Signal Structure Validation', () => {
    it('should generate correct bit pattern for preamble+SFD', async () => {
      // Generate a minimal signal to inspect its structure
      const testData = new Uint8Array([0x00]); // Single zero byte
      const signal = await fskCore.modulateData(testData);
      
      // Signal should contain: preamble(0x55,0x55) + SFD(0x7E) + data(0x00)
      // At 300 baud, 48kHz: 160 samples per bit
      // Each byte: 1 start + 8 data + 1 stop = 10 bits = 1600 samples
      // Total: 4 bytes × 1600 = 6400 samples + padding
      
      expect(signal.length).toBeGreaterThan(6400);
      expect(signal.length).toBeLessThan(10000); // Reasonable upper bound
      
      // Signal should have proper amplitude
      const maxLevel = Math.max(...Array.from(signal));
      const minLevel = Math.min(...Array.from(signal));
      expect(maxLevel).toBeCloseTo(1.0, 1);
      expect(minLevel).toBeCloseTo(-1.0, 1);
    });
  });
});