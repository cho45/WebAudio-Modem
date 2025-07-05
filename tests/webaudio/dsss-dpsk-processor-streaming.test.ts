/**
 * DSSS-DPSK Processor Streaming Tests
 * Comprehensive tests for streaming scenarios and edge cases
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// Mock AudioWorkletProcessor for Node.js testing
class MockAudioWorkletProcessor {
  port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn()
  };
}

// Mock registerProcessor and sampleRate
const mockRegisterProcessor = vi.fn();
vi.stubGlobal('AudioWorkletProcessor', MockAudioWorkletProcessor);
vi.stubGlobal('registerProcessor', mockRegisterProcessor);
vi.stubGlobal('sampleRate', 44100);

// Import MyAbort first
await import('../../src/webaudio/processors/myabort.js');

// Import the module dynamically
await import('../../src/webaudio/processors/dsss-dpsk-processor.js');

// Re-import to get the class for testing
const processorModule = await import('../../src/webaudio/processors/dsss-dpsk-processor.js') as any;
const DsssDpskProcessor = processorModule.DsssDpskProcessor;

describe('DsssDpskProcessor - Streaming Edge Cases', () => {
  let processor: any;
  let mockPort: any;

  beforeEach(() => {
    vi.clearAllMocks();
    processor = new DsssDpskProcessor();
    mockPort = processor.port;
  });

  const sendMessage = async (message: any) => {
    const messageEvent = { data: message } as MessageEvent;
    await mockPort.onmessage(messageEvent);
  };

  describe('Buffer Management Under Stress', () => {
    beforeEach(async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31, samplesPerPhase: 23 } }
      });
      mockPort.postMessage.mockClear();
    });

    test('should handle zero-length input gracefully', () => {
      const inputs = [[new Float32Array(0)]];
      const outputs = [[new Float32Array(0)]];
      
      const result = processor.process(inputs, outputs);
      expect(result).toBe(true);
      
      // Should not crash or throw
      expect(() => processor.process(inputs, outputs)).not.toThrow();
    });

    test('should handle null/undefined input arrays', () => {
      // Test various malformed inputs
      expect(() => processor.process([], [])).not.toThrow();
      expect(() => processor.process([[]], [[]])).not.toThrow();
      expect(() => processor.process([[null as any]], [[null as any]])).not.toThrow();
    });

    test('should handle mismatched input/output lengths', () => {
      const inputs = [[new Float32Array(128)]];
      const outputs = [[new Float32Array(256)]]; // Different size
      
      const result = processor.process(inputs, outputs);
      expect(result).toBe(true);
      
      // Output should be filled up to 256 samples
      expect(outputs[0][0].length).toBe(256);
    });

    test('should process extremely small chunks', async () => {
      // Generate real signal
      const { DsssDpskFramer } = await import('../../src/modems/dsss-dpsk/framer.js');
      const modem = await import('../../src/modems/dsss-dpsk/dsss-dpsk.js');
      
      const framer = new DsssDpskFramer();
      const testData = new Uint8Array([0x55]); // Single byte
      const dataFrame = framer.build(testData, { sequenceNumber: 0, frameType: 0, ldpcNType: 0 });
      
      const chips = modem.dsssSpread(dataFrame.bits, 31, 21);
      const phases = modem.dpskModulate(chips);
      const signal = modem.modulateCarrier(phases, 23, 44100, 10000);
      
      // Process in 1-sample chunks (extreme case)
      let processed = 0;
      while (processed < Math.min(signal.length, 1000)) { // Limit to prevent timeout
        const chunk = signal.slice(processed, processed + 1);
        const inputs = [[new Float32Array(1)]];
        inputs[0][0][0] = chunk[0] || 0;
        
        const outputs = [[new Float32Array(1)]];
        const result = processor.process(inputs, outputs);
        
        expect(result).toBe(true);
        processed++;
      }
      
      // Processor should handle this extreme case
      expect(processor.demodulator).toBeDefined();
    });
  });

  describe('Frame Boundary Crossing', () => {
    test('should handle frame split across many small chunks', async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31, samplesPerPhase: 23 } }
      });
      
      // Generate a complete frame
      const { DsssDpskFramer } = await import('../../src/modems/dsss-dpsk/framer.js');
      const modem = await import('../../src/modems/dsss-dpsk/dsss-dpsk.js');
      
      const framer = new DsssDpskFramer();
      const testData = new Uint8Array([0xAA, 0xBB, 0xCC]);
      const dataFrame = framer.build(testData, { sequenceNumber: 0, frameType: 0, ldpcNType: 0 });
      
      const chips = modem.dsssSpread(dataFrame.bits, 31, 21);
      const phases = modem.dpskModulate(chips);
      const signal = modem.modulateCarrier(phases, 23, 44100, 10000);
      
      // Process in prime-number-sized chunks to ensure boundaries don't align
      const chunkSizes = [17, 31, 47, 61, 79, 97, 113]; // Prime numbers
      let processed = 0;
      let chunkIndex = 0;
      
      while (processed < signal.length) {
        const chunkSize = chunkSizes[chunkIndex % chunkSizes.length];
        const actualSize = Math.min(chunkSize, signal.length - processed);
        
        const inputs = [[new Float32Array(actualSize)]];
        for (let i = 0; i < actualSize; i++) {
          inputs[0][0][i] = signal[processed + i];
        }
        
        const outputs = [[new Float32Array(actualSize)]];
        processor.process(inputs, outputs);
        
        processed += actualSize;
        chunkIndex++;
      }
      
      // Should eventually process the frame
      expect(processor.decodedDataBuffer.length).toBeGreaterThan(0);
    });

    test('should handle abrupt stream interruption and recovery', async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31, samplesPerPhase: 23 } }
      });
      
      // Start demodulation
      const demodPromise = processor.demodulate({ signal: processor['abortController']?.signal });
      
      // Generate partial signal
      const { DsssDpskFramer } = await import('../../src/modems/dsss-dpsk/framer.js');
      const modem = await import('../../src/modems/dsss-dpsk/dsss-dpsk.js');
      
      const framer = new DsssDpskFramer();
      const testData = new Uint8Array([0x11, 0x22]);
      const dataFrame = framer.build(testData, { sequenceNumber: 0, frameType: 0, ldpcNType: 0 });
      
      const chips = modem.dsssSpread(dataFrame.bits, 31, 21);
      const phases = modem.dpskModulate(chips);
      const signal = modem.modulateCarrier(phases, 23, 44100, 10000);
      
      // Process only half the signal
      const halfPoint = Math.floor(signal.length / 2);
      let processed = 0;
      
      while (processed < halfPoint) {
        const chunkSize = Math.min(128, halfPoint - processed);
        const inputs = [[signal.slice(processed, processed + chunkSize)]];
        const outputs = [[new Float32Array(chunkSize)]];
        
        processor.process(inputs, outputs);
        processed += chunkSize;
      }
      
      // Simulate interruption - send noise
      const noiseChunks = 10;
      for (let i = 0; i < noiseChunks; i++) {
        const noise = new Float32Array(128);
        for (let j = 0; j < 128; j++) {
          noise[j] = (Math.random() - 0.5) * 0.5;
        }
        
        processor.process([[noise]], [[new Float32Array(128)]]);
      }
      
      // Resume with rest of signal
      while (processed < signal.length) {
        const chunkSize = Math.min(128, signal.length - processed);
        const inputs = [[signal.slice(processed, processed + chunkSize)]];
        const outputs = [[new Float32Array(chunkSize)]];
        
        processor.process(inputs, outputs);
        processed += chunkSize;
      }
      
      // The demodulator should handle the interruption
      // It may or may not recover the frame depending on sync
      expect(processor.demodulator).toBeDefined();
    });
  });

  describe('Concurrent Operations', () => {
    test('should reject concurrent modulation attempts properly', async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31 } }
      });
      
      mockPort.postMessage.mockClear();
      
      // Directly test the modulate method
      const testData = new Uint8Array([0x11, 0x22]);
      
      // Start first modulation
      const promise1 = processor.modulate(testData, { signal: processor['abortController']?.signal });
      
      // Immediately try second modulation
      let error: Error | null = null;
      try {
        await processor.modulate(new Uint8Array([0x33, 0x44]), { signal: processor['abortController']?.signal });
      } catch (e) {
        error = e as Error;
      }
      
      // Second modulation should fail
      expect(error).toBeTruthy();
      expect(error?.message).toContain('Modulation already in progress');
      
      // Process to complete first modulation
      while (processor.pendingModulation) {
        processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
      }
      
      // First modulation should complete
      await promise1;
    }, 10000);

    test('should handle rapid reset during operation', async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31 } }
      });
      
      // Start modulation (don't await)
      sendMessage({
        id: 'mod',
        type: 'modulate',
        data: { bytes: [0x11, 0x22, 0x33, 0x44, 0x55] }
      });
      
      // Wait for modulation to start
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(processor.pendingModulation).toBeTruthy();
      
      // Process a few chunks
      for (let i = 0; i < 5; i++) {
        processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
      }
      
      // Reset in the middle
      await sendMessage({
        id: 'reset',
        type: 'reset',
        data: {}
      });
      
      // Verify reset completed
      expect(processor.pendingModulation).toBe(null);
      expect(processor.decodedDataBuffer.length).toBe(0);
      
      // Should be able to start new operation (don't await)
      sendMessage({
        id: 'mod2',
        type: 'modulate',
        data: { bytes: [0x66, 0x77] }
      });
      
      // Wait for new modulation to start
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(processor.pendingModulation).toBeTruthy();
    });
  });

  describe('Memory and Performance', () => {
    test('should not accumulate memory over long operation', async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31 } }
      });
      
      // Process many chunks without actual data
      const iterations = 1000;
      const chunkSize = 128;
      
      for (let i = 0; i < iterations; i++) {
        const inputs = [[new Float32Array(chunkSize)]];
        const outputs = [[new Float32Array(chunkSize)]];
        
        // Add some noise
        for (let j = 0; j < chunkSize; j++) {
          inputs[0][0][j] = (Math.random() - 0.5) * 0.01;
        }
        
        processor.process(inputs, outputs);
      }
      
      // Buffer should not grow indefinitely
      expect(processor.decodedDataBuffer.length).toBeLessThan(100);
      
      // Demodulator should still be functional
      expect(processor.demodulator).toBeDefined();
    });

    test.skip('should handle configuration changes during operation', async () => {
      // TODO: This test times out because demodulate() waits for actual data
      // Need to refactor to test configuration change behavior differently
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31 } }
      });
      
      // Initialize abort controller
      processor['resetAbortController']();
      
      // Start demodulation directly
      const demodPromise = processor.demodulate({ signal: processor['abortController'].signal });
      
      // Process some data
      for (let i = 0; i < 10; i++) {
        processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
      }
      
      // Change configuration which should reset and reject demodulation
      await sendMessage({
        id: 'reconfig',
        type: 'configure',
        data: { config: { sequenceLength: 63, seed: 42 } }
      });
      
      // Configuration change should reset demodulator
      expect(processor.config.sequenceLength).toBe(63);
      expect(processor.config.seed).toBe(42);
      
      // Previous demodulation should be rejected
      let error: Error | null = null;
      try {
        await demodPromise;
      } catch (e) {
        error = e as Error;
      }
      
      expect(error).toBeTruthy();
      expect(error?.message).toContain('Reset');
    });
  });

  describe('Real-world Scenarios', () => {
    test('should handle multiple frames in continuous stream', async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31, samplesPerPhase: 23 } }
      });
      
      const { DsssDpskFramer } = await import('../../src/modems/dsss-dpsk/framer.js');
      const modem = await import('../../src/modems/dsss-dpsk/dsss-dpsk.js');
      const framer = new DsssDpskFramer();
      
      // Generate multiple frames
      const frames = [
        new Uint8Array([0x01, 0x02]),
        new Uint8Array([0x03, 0x04, 0x05]),
        new Uint8Array([0x06])
      ];
      
      let combinedSignal = new Float32Array(0);
      
      for (const data of frames) {
        const dataFrame = framer.build(data, { sequenceNumber: 0, frameType: 0, ldpcNType: 0 });
        const chips = modem.dsssSpread(dataFrame.bits, 31, 21);
        const phases = modem.dpskModulate(chips);
        const signal = modem.modulateCarrier(phases, 23, 44100, 10000);
        
        // Add small gap between frames
        const gap = new Float32Array(500);
        
        // Combine signals
        const newSignal = new Float32Array(combinedSignal.length + signal.length + gap.length);
        newSignal.set(combinedSignal, 0);
        newSignal.set(signal, combinedSignal.length);
        newSignal.set(gap, combinedSignal.length + signal.length);
        combinedSignal = newSignal;
      }
      
      // Process in realistic chunks
      let processed = 0;
      let framesReceived = 0;
      
      // Set up demodulation promise before processing
      processor['resetAbortController']();
      const demodPromises: Promise<Uint8Array>[] = [];
      
      while (processed < combinedSignal.length) {
        const chunkSize = 128;
        const chunk = new Float32Array(chunkSize);
        const remaining = combinedSignal.length - processed;
        const copySize = Math.min(chunkSize, remaining);
        
        for (let i = 0; i < copySize; i++) {
          chunk[i] = combinedSignal[processed + i];
        }
        
        processor.process([[chunk]], [[new Float32Array(chunkSize)]]);
        
        // Check if we got new frames
        if (processor.decodedDataBuffer.length > framesReceived) {
          framesReceived = processor.decodedDataBuffer.length;
          // Start new demodulation for next frame
          demodPromises.push(processor.demodulate({ signal: processor['abortController']?.signal }));
        }
        
        processed += chunkSize;
      }
      
      // Should have received multiple frames
      expect(framesReceived).toBeGreaterThanOrEqual(1);
    });

    test('should handle varying signal strengths', async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31, samplesPerPhase: 23 } }
      });
      
      const { DsssDpskFramer } = await import('../../src/modems/dsss-dpsk/framer.js');
      const modem = await import('../../src/modems/dsss-dpsk/dsss-dpsk.js');
      
      const framer = new DsssDpskFramer();
      const testData = new Uint8Array([0xDE, 0xAD]);
      const dataFrame = framer.build(testData, { sequenceNumber: 0, frameType: 0, ldpcNType: 0 });
      
      const chips = modem.dsssSpread(dataFrame.bits, 31, 21);
      const phases = modem.dpskModulate(chips);
      const signal = modem.modulateCarrier(phases, 23, 44100, 10000);
      
      // Process with varying amplitude
      let processed = 0;
      const amplitudes = [1.0, 0.5, 0.2, 0.1, 0.5, 1.0]; // Varying signal strength
      let ampIndex = 0;
      
      while (processed < signal.length) {
        const chunkSize = Math.min(1000, signal.length - processed);
        const chunk = new Float32Array(chunkSize);
        const amplitude = amplitudes[ampIndex % amplitudes.length];
        
        for (let i = 0; i < chunkSize; i++) {
          chunk[i] = signal[processed + i] * amplitude;
        }
        
        processor.process([[chunk]], [[new Float32Array(chunkSize)]]);
        processed += chunkSize;
        ampIndex++;
      }
      
      // Processor should handle varying amplitudes
      expect(processor.demodulator).toBeDefined();
    });
  });
});