// ChunkedModulator tests - Node.js compatible
import { describe, test, expect, beforeEach } from 'vitest';
import { FSKCore, FSKConfig, DEFAULT_FSK_CONFIG } from '../../src/modems/fsk';
import { ChunkedModulator, ChunkResult } from '../../src/webaudio/chunked-modulator';

describe('ChunkedModulator', () => {
  let fskCore: FSKCore;
  let chunkedModulator: ChunkedModulator;
  
  beforeEach(() => {
    fskCore = new FSKCore();
    fskCore.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
    chunkedModulator = new ChunkedModulator(fskCore);
  });
  
  describe('Initialization', () => {
    test('creates instance correctly', () => {
      expect(chunkedModulator).toBeInstanceOf(ChunkedModulator);
      expect(chunkedModulator.isModulating()).toBe(false);
      expect(chunkedModulator.getProgress()).toBe(0);
    });
  });
  
  describe('Signal Generation', () => {
    test('generates same signal as FSKCore direct generation', async () => {
      const testData = new Uint8Array([0x41, 0x42]); // "AB"
      
      // Generate signal using FSKCore directly
      const directSignal = await fskCore.modulateData(testData);
      
      // Generate signal using ChunkedModulator
      await chunkedModulator.startModulation(testData);
      
      // Collect all samples from ChunkedModulator
      const chunkedSignal: number[] = [];
      let result: ChunkResult | null;
      while ((result = chunkedModulator.getNextSamples(128)) !== null) {
        chunkedSignal.push(...result.signal);
        if (result.isComplete) break;
      }
      
      // Compare signals
      expect(chunkedSignal.length).toBe(directSignal.length);
      for (let i = 0; i < directSignal.length; i++) {
        expect(chunkedSignal[i]).toBeCloseTo(directSignal[i], 10);
      }
    });
    
    test('handles empty data correctly', async () => {
      await chunkedModulator.startModulation(new Uint8Array(0));
      
      expect(chunkedModulator.isModulating()).toBe(false);
      expect(chunkedModulator.getNextSamples(128)).toBe(null);
    });
    
    test('handles single byte data', async () => {
      const testData = new Uint8Array([0x48]); // "H"
      
      await chunkedModulator.startModulation(testData);
      expect(chunkedModulator.isModulating()).toBe(true);
      
      // Collect all samples
      const samples: number[] = [];
      let result: ChunkResult | null;
      while ((result = chunkedModulator.getNextSamples(128)) !== null) {
        expect(result.signal.length).toBeGreaterThan(0);
        expect(result.signal.length).toBeLessThanOrEqual(128);
        expect(result.totalSamples).toBeGreaterThan(0);
        
        samples.push(...result.signal);
        
        if (result.isComplete) {
          expect(chunkedModulator.isModulating()).toBe(false);
          break;
        }
      }
      
      expect(samples.length).toBeGreaterThan(0);
    });
  });
  
  describe('WebAudio 128-sample Chunking', () => {
    test('provides exactly 128 samples per request when available', async () => {
      const testData = new Uint8Array([0x41, 0x42, 0x43, 0x44]); // "ABCD"
      
      await chunkedModulator.startModulation(testData);
      
      let totalSamples = 0;
      let chunkCount = 0;
      let result: ChunkResult | null;
      
      while ((result = chunkedModulator.getNextSamples(128)) !== null) {
        chunkCount++;
        
        if (!result.isComplete) {
          // Non-final chunks should be exactly 128 samples
          expect(result.signal.length).toBe(128);
        } else {
          // Final chunk can be less than 128 samples
          expect(result.signal.length).toBeLessThanOrEqual(128);
          expect(result.signal.length).toBeGreaterThan(0);
        }
        
        totalSamples += result.signal.length;
        
        if (result.isComplete) break;
      }
      
      expect(chunkCount).toBeGreaterThan(0);
      expect(totalSamples).toBeGreaterThan(0);
    });
    
    test('handles various chunk sizes correctly', async () => {
      const testData = new Uint8Array([0x55]); // Single byte
      
      await chunkedModulator.startModulation(testData);
      
      // Test different chunk sizes
      const chunkSizes = [1, 32, 64, 128, 256];
      
      for (const chunkSize of chunkSizes) {
        // Reset for each test
        await chunkedModulator.startModulation(testData);
        
        const samples: number[] = [];
        let result: ChunkResult | null;
        
        while ((result = chunkedModulator.getNextSamples(chunkSize)) !== null) {
          expect(result.signal.length).toBeLessThanOrEqual(chunkSize);
          expect(result.signal.length).toBeGreaterThan(0);
          
          samples.push(...result.signal);
          
          if (result.isComplete) break;
        }
        
        expect(samples.length).toBeGreaterThan(0);
      }
    });
  });
  
  describe('Progress Tracking', () => {
    test('tracks progress correctly', async () => {
      const testData = new Uint8Array([0x41, 0x42]); // "AB"
      
      await chunkedModulator.startModulation(testData);
      
      let lastProgress = 0;
      let result: ChunkResult | null;
      
      while ((result = chunkedModulator.getNextSamples(64)) !== null) {
        const currentProgress = chunkedModulator.getProgress();
        
        if (!result.isComplete) {
          // Progress should be non-decreasing until completion
          expect(currentProgress).toBeGreaterThanOrEqual(lastProgress);
          expect(currentProgress).toBeLessThanOrEqual(1);
          
          // Check consistency with ChunkResult
          if (result.totalSamples > 0) {
            const expectedProgress = result.samplesConsumed / result.totalSamples;
            expect(currentProgress).toBeCloseTo(expectedProgress, 5);
          }
          
          lastProgress = currentProgress;
        } else {
          // After completion, progress should reset to 0
          expect(currentProgress).toBe(0);
          break;
        }
      }
    });
  });
  
  describe('State Management', () => {
    test('cancellation works correctly', async () => {
      const testData = new Uint8Array([0x41, 0x42]);
      
      await chunkedModulator.startModulation(testData);
      expect(chunkedModulator.isModulating()).toBe(true);
      
      // Get some samples
      const result1 = chunkedModulator.getNextSamples(128);
      expect(result1).not.toBe(null);
      
      // Cancel modulation
      chunkedModulator.cancel();
      expect(chunkedModulator.isModulating()).toBe(false);
      expect(chunkedModulator.getProgress()).toBe(0);
      
      // Should return null after cancellation
      const result2 = chunkedModulator.getNextSamples(128);
      expect(result2).toBe(null);
    });
    
    test('handles multiple startModulation calls', async () => {
      const testData1 = new Uint8Array([0x41]);
      const testData2 = new Uint8Array([0x42]);
      
      // Start first modulation
      await chunkedModulator.startModulation(testData1);
      expect(chunkedModulator.isModulating()).toBe(true);
      
      // Start second modulation (should replace first)
      await chunkedModulator.startModulation(testData2);
      expect(chunkedModulator.isModulating()).toBe(true);
      
      // Should generate signal for second data only
      const directSignal = await fskCore.modulateData(testData2);
      
      const chunkedSamples: number[] = [];
      let result: ChunkResult | null;
      while ((result = chunkedModulator.getNextSamples(128)) !== null) {
        chunkedSamples.push(...result.signal);
        if (result.isComplete) break;
      }
      
      expect(chunkedSamples.length).toBe(directSignal.length);
    });
  });
  
  describe('Demodulation Verification', () => {
    test('generated signal can be demodulated correctly', async () => {
      const originalData = new Uint8Array([0x41, 0x42]); // "AB"
      
      // Generate signal using ChunkedModulator
      await chunkedModulator.startModulation(originalData);
      
      const samples: number[] = [];
      let result: ChunkResult | null;
      while ((result = chunkedModulator.getNextSamples(128)) !== null) {
        samples.push(...result.signal);
        if (result.isComplete) break;
      }
      
      // Create fresh FSKCore for demodulation
      const demodFsk = new FSKCore();
      demodFsk.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
      
      // Demodulate the signal
      const signal = new Float32Array(samples);
      const demodulatedData = await demodFsk.demodulateData(signal);
      
      // Should recover the original data exactly
      expect(demodulatedData.length).toBe(originalData.length);
      for (let i = 0; i < originalData.length; i++) {
        expect(demodulatedData[i]).toBe(originalData[i]);
      }
    });
  });
});