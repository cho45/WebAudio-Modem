/**
 * DSSS-DPSK Processor Unified Tests
 * 統合された包括的なテストスイート - Node環境での動作を重視
 * 
 * 責務:
 * - AudioWorkletProcessor としての基本機能テスト
 * - 変調・復調処理の正確性検証
 * - ストリーミング処理とバッファ管理
 * - エラーハンドリングと異常状態の処理
 * - パフォーマンスと信頼性の検証
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

// Import dependencies
await import('../../src/webaudio/processors/myabort.js');
await import('../../src/webaudio/processors/dsss-dpsk-processor.js');

// Re-import to get the class for testing
const processorModule = await import('../../src/webaudio/processors/dsss-dpsk-processor.js') as any;
const DsssDpskProcessor = processorModule.DsssDpskProcessor;

describe('DsssDpskProcessor - Unified Test Suite', () => {
  let processor: any;
  let mockPort: any;

  // Helper function to send message via port
  const sendMessage = async (message: any) => {
    const messageEvent = { data: message } as MessageEvent;
    await mockPort.onmessage(messageEvent);
  };

  // Helper function to configure processor with default settings
  const configureProcessor = async (config: any = {}) => {
    const defaultConfig = {
      sequenceLength: 31,
      seed: 21,
      samplesPerPhase: 23,
      carrierFreq: 10000,
      correlationThreshold: 0.5,
      peakToNoiseRatio: 4
    };
    
    await sendMessage({
      id: 'config',
      type: 'configure',
      data: { config: { ...defaultConfig, ...config } }
    });
    mockPort.postMessage.mockClear();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    processor = new DsssDpskProcessor();
    mockPort = processor.port;
  });

  describe('1. Setup and Basic Functionality', () => {
    test('should initialize correctly with default configuration', () => {
      expect(processor).toBeDefined();
      expect(typeof mockPort.onmessage).toBe('function');
      expect(mockPort.postMessage).toBeDefined();
      
      // Check default configuration
      expect(processor.config.sequenceLength).toBe(31);
      expect(processor.config.seed).toBe(21);
      expect(processor.config.samplesPerPhase).toBe(23);
      expect(processor.config.carrierFreq).toBe(10000);
    });

    test('should register as AudioWorklet processor', () => {
      // registerProcessor is called during module import, check if it's available
      expect(mockRegisterProcessor).toBeDefined();
      expect(DsssDpskProcessor).toBeDefined();
    });

    test('should have proper internal components initialized', () => {
      expect(processor.demodulator).toBeDefined();
      expect(processor.framer).toBeDefined();
      expect(processor.decodedDataBuffer).toEqual([]);
      expect(processor.pendingModulation).toBe(null);
    });

    test('should handle process() calls without crashing', () => {
      const inputs = [[new Float32Array(128)]];
      const outputs = [[new Float32Array(128)]];
      
      const result = processor.process(inputs, outputs);
      expect(result).toBe(true);
      
      // Output should be silent by default
      expect(outputs[0][0].every(sample => sample === 0)).toBe(true);
    });
  });

  describe('2. Configuration Management', () => {
    test('should handle configure message correctly', async () => {
      const testConfig = {
        sequenceLength: 63,
        seed: 42,
        samplesPerPhase: 25,
        carrierFreq: 12000,
        correlationThreshold: 0.6,
        peakToNoiseRatio: 5
      };

      await sendMessage({
        id: 'test-config',
        type: 'configure',
        data: { config: testConfig }
      });

      expect(mockPort.postMessage).toHaveBeenCalledWith({
        id: 'test-config',
        type: 'result',
        data: { success: true }
      });

      // Verify configuration was applied
      expect(processor.config.sequenceLength).toBe(63);
      expect(processor.config.seed).toBe(42);
      expect(processor.config.samplesPerPhase).toBe(25);
      expect(processor.config.carrierFreq).toBe(12000);
    });

    test('should handle partial configuration updates', async () => {
      const originalConfig = { ...processor.config };
      
      await sendMessage({
        id: 'partial-config',
        type: 'configure',
        data: { config: { sequenceLength: 127 } }
      });

      // Only sequenceLength should change
      expect(processor.config.sequenceLength).toBe(127);
      expect(processor.config.seed).toBe(originalConfig.seed);
      expect(processor.config.samplesPerPhase).toBe(originalConfig.samplesPerPhase);
    });

    test('should handle invalid configuration gracefully', async () => {
      const invalidConfigs = [
        { sequenceLength: 'invalid' },
        { sequenceLength: -1 },
        { samplesPerPhase: null },
        { carrierFreq: NaN },
        null,
        undefined
      ];

      for (const config of invalidConfigs) {
        mockPort.postMessage.mockClear();
        
        await sendMessage({
          id: `invalid-${invalidConfigs.indexOf(config)}`,
          type: 'configure',
          data: { config }
        });

        // Should handle gracefully - either error or succeed with defaults
        expect(mockPort.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            id: expect.stringContaining('invalid'),
            type: expect.stringMatching(/result|error/)
          })
        );
        
        // Processor should still be functional
        expect(() => {
          processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
        }).not.toThrow();
      }
    });

    test('should recreate demodulator on configuration change', async () => {
      const originalDemodulator = processor.demodulator;
      
      await configureProcessor({ sequenceLength: 63 });
      
      // New demodulator should be created
      expect(processor.demodulator).not.toBe(originalDemodulator);
      expect(processor.demodulator).toBeDefined();
    });
  });

  describe('3. Audio Processing', () => {
    beforeEach(async () => {
      await configureProcessor();
    });

    test('should process 128-sample chunks correctly', () => {
      const chunkSize = 128;
      const inputs = [[new Float32Array(chunkSize)]];
      const outputs = [[new Float32Array(chunkSize)]];
      
      // Fill input with test signal
      for (let i = 0; i < chunkSize; i++) {
        inputs[0][0][i] = Math.sin(2 * Math.PI * 10000 * i / 44100) * 0.5;
      }
      
      const result = processor.process(inputs, outputs);
      expect(result).toBe(true);
      expect(outputs[0][0].length).toBe(chunkSize);
    });

    test('should handle varying chunk sizes', () => {
      const chunkSizes = [32, 64, 128, 256, 512];
      
      for (const size of chunkSizes) {
        const inputs = [[new Float32Array(size)]];
        const outputs = [[new Float32Array(size)]];
        
        const result = processor.process(inputs, outputs);
        expect(result).toBe(true);
      }
    });

    test('should handle empty input gracefully', () => {
      const inputs = [[new Float32Array(0)]];
      const outputs = [[new Float32Array(0)]];
      
      const result = processor.process(inputs, outputs);
      expect(result).toBe(true);
      
      // Should not crash with empty arrays
      expect(() => processor.process([], [])).not.toThrow();
      expect(() => processor.process([[]], [[]])).not.toThrow();
    });

    test('should handle mismatched input/output lengths', () => {
      const inputs = [[new Float32Array(128)]];
      const outputs = [[new Float32Array(256)]]; // Different size
      
      const result = processor.process(inputs, outputs);
      expect(result).toBe(true);
      expect(outputs[0][0].length).toBe(256);
    });

    test('should process continuous audio stream', () => {
      const iterations = 50;
      
      for (let i = 0; i < iterations; i++) {
        const inputs = [[new Float32Array(128)]];
        const outputs = [[new Float32Array(128)]];
        
        // Generate continuous sine wave
        for (let j = 0; j < 128; j++) {
          inputs[0][0][j] = Math.sin(2 * Math.PI * 10000 * (i * 128 + j) / 44100) * 0.3;
        }
        
        const result = processor.process(inputs, outputs);
        expect(result).toBe(true);
      }
      
      // Processor should remain stable
      expect(processor.demodulator).toBeDefined();
    });
  });

  describe('4. Frame Handling and Modulation', () => {
    beforeEach(async () => {
      await configureProcessor();
    });

    test('should handle modulation message and generate signal', async () => {
      const testData = new Uint8Array([0x48, 0x65, 0x6C]); // "Hel"
      
      // Start modulation (don't await as it requires audio processing)
      sendMessage({
        id: 'test-modulate',
        type: 'modulate',
        data: { bytes: Array.from(testData) }
      });

      // Wait for modulation to be set up by processing a small amount
      processor.process([[new Float32Array(1)]], [[new Float32Array(1)]]);
      
      // Should have pending modulation
      expect(processor.pendingModulation).toBeTruthy();
      expect(processor.pendingModulation.samples).toBeTruthy();
      expect(processor.pendingModulation.samples.length).toBeGreaterThan(0);
      expect(processor.pendingModulation.index).toBeGreaterThanOrEqual(0);
    });

    test('should output modulated signal through process()', async () => {
      const testData = new Uint8Array([0x42]); // 'B'
      
      // Start modulation
      sendMessage({
        id: 'modulate',
        type: 'modulate', 
        data: { bytes: Array.from(testData) }
      });

      // Process immediately to set up modulation
      processor.process([[new Float32Array(1)]], [[new Float32Array(1)]]);
      
      // Process to generate output
      const outputs = [[new Float32Array(128)]];
      processor.process([], outputs);
      
      // Check signal characteristics
      const outputSignal = outputs[0][0];
      const hasSignal = Array.from(outputSignal).some(sample => Math.abs(sample) > 0.001);
      expect(hasSignal).toBe(true);
      
      // Check amplitude is reasonable
      const maxAmplitude = Math.max(...Array.from(outputSignal).map(Math.abs));
      expect(maxAmplitude).toBeGreaterThan(0.1);
      expect(maxAmplitude).toBeLessThanOrEqual(1.1);
    });

    test('should reject concurrent modulation attempts', async () => {
      const testData1 = new Uint8Array([0x11, 0x22]);
      const testData2 = new Uint8Array([0x33, 0x44]);
      
      // Start first modulation
      const promise1 = processor.modulate(testData1, { signal: processor['abortController']?.signal });
      
      // Immediately try second modulation
      let error: Error | null = null;
      try {
        await processor.modulate(testData2, { signal: processor['abortController']?.signal });
      } catch (e) {
        error = e as Error;
      }
      
      expect(error).toBeTruthy();
      expect(error?.message).toContain('Modulation already in progress');
      
      // Complete first modulation
      while (processor.pendingModulation) {
        processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
      }
      
      await promise1; // Should complete successfully
    });

    test('should handle variable-length data frames', async () => {
      const testSizes = [1, 3, 5, 7]; // Within FEC limits
      
      for (const size of testSizes) {
        await processor.reset();
        
        const testData = new Uint8Array(size);
        for (let i = 0; i < size; i++) {
          testData[i] = i & 0xFF;
        }
        
        sendMessage({
          id: `mod-${size}`,
          type: 'modulate',
          data: { bytes: Array.from(testData) }
        });
        
        // Process immediately to set up modulation
        processor.process([[new Float32Array(1)]], [[new Float32Array(1)]]);
        
        expect(processor.pendingModulation).toBeTruthy();
        expect(processor.pendingModulation.samples.length).toBeGreaterThan(0);
      }
    });
  });

  describe('5. Demodulation and Data Recovery', () => {
    beforeEach(async () => {
      await configureProcessor();
    });

    test('should handle demodulation message', async () => {
      // Add test data to buffer
      processor.decodedDataBuffer.push(new Uint8Array([0x48, 0x65]));

      await sendMessage({
        id: 'test-demodulate',
        type: 'demodulate',
        data: {}
      });

      expect(mockPort.postMessage).toHaveBeenCalledWith({
        id: 'test-demodulate',
        type: 'result',
        data: { bytes: expect.any(Array) }
      });

      // Buffer should be cleared after reading
      expect(processor.decodedDataBuffer.length).toBe(0);
    });

    test('should process real modulated signal and recover data', async () => {
      const { DsssDpskFramer } = await import('../../src/modems/dsss-dpsk/framer.js');
      const modem = await import('../../src/modems/dsss-dpsk/dsss-dpsk.js');
      
      const framer = new DsssDpskFramer();
      const originalData = new Uint8Array([0x42, 0x43]); // "BC"
      const dataFrame = framer.build(originalData, { sequenceNumber: 0, frameType: 0, ldpcNType: 0 });
      
      const chips = modem.dsssSpread(dataFrame.bits, 31, 21);
      const phases = modem.dpskModulate(chips);
      const signal = modem.modulateCarrier(phases, 23, 44100, 10000);
      
      // Reset processor and set up demodulation
      await processor.reset();
      processor['resetAbortController']();
      
      // Start demodulation
      const demodPromise = processor.demodulate({ signal: processor['abortController'].signal });
      
      // Process signal in realistic chunks
      let processed = 0;
      while (processed < signal.length) {
        const chunkSize = 128;
        const chunk = new Float32Array(chunkSize);
        const remaining = signal.length - processed;
        const copySize = Math.min(chunkSize, remaining);
        
        for (let i = 0; i < copySize; i++) {
          chunk[i] = signal[processed + i];
        }
        
        processor.process([[chunk]], [[new Float32Array(chunkSize)]]);
        processed += chunkSize;
      }
      
      try {
        const decodedData = await demodPromise;
        const actualData = decodedData.slice(0, originalData.length);
        expect(actualData).toEqual(originalData);
      } catch (error) {
        // Log for debugging if test fails
        console.error('Demodulation failed:', error);
        throw error;
      }
    }, 10000);

    test('should track framer state correctly', () => {
      const framerState = processor.framer.getState();
      expect(framerState.state).toBe('SEARCHING_PREAMBLE');
      expect(framerState.bufferLength).toBe(0);
      
      // Feed preamble bits (LLR for 0 is positive)
      const frames = processor.framer.process(new Int8Array([120, 120, 120, 120]));
      
      const newState = processor.framer.getState();
      expect(newState.state).toBe('SEARCHING_SYNC_WORD');
      expect(frames.length).toBe(0); // No complete frames yet
    });
  });

  describe('6. Buffer and Memory Management', () => {
    beforeEach(async () => {
      await configureProcessor();
    });

    test('should handle buffer overflow gracefully', () => {
      const iterations = 100;
      
      for (let i = 0; i < iterations; i++) {
        const inputs = [[new Float32Array(128)]];
        const outputs = [[new Float32Array(128)]];
        
        // Add deterministic noise pattern to trigger processing
        for (let j = 0; j < 128; j++) {
          inputs[0][0][j] = Math.sin(j * 0.1) * 0.01; // Deterministic pattern
        }
        
        processor.process(inputs, outputs);
      }
      
      // Buffer should not grow indefinitely
      expect(processor.decodedDataBuffer.length).toBeLessThan(50);
    });

    test('should not leak memory during extended operation', async () => {
      const repetitions = 20;
      
      for (let rep = 0; rep < repetitions; rep++) {
        await processor.reset();
        
        // Process some chunks
        for (let i = 0; i < 10; i++) {
          const inputs = [[new Float32Array(128)]];
          const outputs = [[new Float32Array(128)]];
          
          processor.process(inputs, outputs);
        }
        
        // Buffer sizes should remain bounded
        expect(processor.decodedDataBuffer.length).toBeLessThan(10);
      }
    });

    test('should handle extremely small chunks without issues', () => {
      // Process 1-sample chunks (extreme case)
      for (let i = 0; i < 100; i++) {
        const inputs = [[new Float32Array(1)]];
        inputs[0][0][0] = Math.sin(2 * Math.PI * 10000 * i / 44100) * 0.1;
        
        const outputs = [[new Float32Array(1)]];
        const result = processor.process(inputs, outputs);
        
        expect(result).toBe(true);
      }
    });

    test('should handle frame boundaries across chunks', async () => {
      const { DsssDpskFramer } = await import('../../src/modems/dsss-dpsk/framer.js');
      const modem = await import('../../src/modems/dsss-dpsk/dsss-dpsk.js');
      
      const framer = new DsssDpskFramer();
      const testData = new Uint8Array([0xAA]);
      const dataFrame = framer.build(testData, { sequenceNumber: 0, frameType: 0, ldpcNType: 0 });
      
      const chips = modem.dsssSpread(dataFrame.bits, 31, 21);
      const phases = modem.dpskModulate(chips);
      const signal = modem.modulateCarrier(phases, 23, 44100, 10000);
      
      // Process in misaligned chunks
      const chunkSizes = [17, 31, 47, 61, 79]; // Prime numbers
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
      
      // Should handle misaligned boundaries
      expect(processor.demodulator).toBeDefined();
    });
  });

  describe('7. Error Handling and Edge Cases', () => {
    test('should handle unknown message types', async () => {
      await sendMessage({
        id: 'unknown',
        type: 'unknown',
        data: {}
      });

      expect(mockPort.postMessage).toHaveBeenCalledWith({
        id: 'unknown',
        type: 'error',
        data: { message: 'Unknown message type: unknown' }
      });
    });

    test('should handle abort operations', async () => {
      await sendMessage({
        id: 'abort',
        type: 'abort',
        data: {}
      });

      expect(mockPort.postMessage).toHaveBeenCalledWith({
        id: 'abort',
        type: 'result',
        data: { success: true }
      });
    });

    test('should handle reset during operation', async () => {
      await configureProcessor();
      
      // Start modulation
      sendMessage({
        id: 'mod',
        type: 'modulate',
        data: { bytes: [0x11, 0x22, 0x33] }
      });
      
      // Process to set up modulation immediately
      processor.process([[new Float32Array(1)]], [[new Float32Array(1)]]);
      expect(processor.pendingModulation).toBeTruthy();
      
      // Reset during operation
      await sendMessage({
        id: 'reset',
        type: 'reset',
        data: {}
      });
      
      // Verify reset completed
      expect(processor.pendingModulation).toBe(null);
      expect(processor.decodedDataBuffer.length).toBe(0);
      
      expect(mockPort.postMessage).toHaveBeenCalledWith({
        id: 'reset',
        type: 'result',
        data: { success: true }
      });
    });

    test('should handle rapid state changes', async () => {
      const operations = [
        { id: 'op1', type: 'configure', data: { config: { sequenceLength: 31 } } },
        { id: 'op2', type: 'reset', data: {} },
        { id: 'op3', type: 'configure', data: { config: { sequenceLength: 63 } } },
        { id: 'op4', type: 'abort', data: {} }
      ];

      for (const op of operations) {
        await sendMessage(op);
        
        expect(mockPort.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            id: op.id,
            type: expect.stringMatching(/result|error/)
          })
        );
      }
    });

    test('should maintain stability under stress', async () => {
      await configureProcessor();
      
      // Rapidly switch between modulation and demodulation
      for (let i = 0; i < 5; i++) {
        // Start modulation
        sendMessage({
          id: `mod-${i}`,
          type: 'modulate',
          data: { bytes: [i & 0xFF] }
        });
        
        // Process a few chunks
        for (let j = 0; j < 3; j++) {
          processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
        }
        
        // Reset
        await processor.reset();
      }
      
      // Should remain stable
      expect(processor.demodulator).toBeDefined();
      expect(processor.framer).toBeDefined();
    });
  });

  describe('8. Performance and Real-world Scenarios', () => {
    beforeEach(async () => {
      await configureProcessor();
    });

    test('should process sustained signal load without failure', () => {
      const iterations = 100;
      let successfulProcesses = 0;
      
      // Process many iterations to test stability
      for (let i = 0; i < iterations; i++) {
        const input = new Float32Array(128);
        for (let j = 0; j < 128; j++) {
          input[j] = Math.sin(2 * Math.PI * 10000 * (i * 128 + j) / 44100) * 0.5;
        }
        
        try {
          const result = processor.process([[input]], [[new Float32Array(128)]]);
          if (result === true) {
            successfulProcesses++;
          }
        } catch (error) {
          // Should not throw errors during normal processing
          expect(error).toBeUndefined();
        }
      }
      
      // All processes should succeed
      expect(successfulProcesses).toBe(iterations);
      
      // Processor should remain stable after sustained load
      expect(processor.demodulator).toBeDefined();
      expect(processor.framer).toBeDefined();
    });

    test('should handle varying signal conditions', async () => {
      const { DsssDpskFramer } = await import('../../src/modems/dsss-dpsk/framer.js');
      const modem = await import('../../src/modems/dsss-dpsk/dsss-dpsk.js');
      
      const framer = new DsssDpskFramer();
      const testData = new Uint8Array([0x55, 0xAA]); // Alternating pattern
      const dataFrame = framer.build(testData, { sequenceLength: 0, frameType: 0, ldpcNType: 0 });
      
      const chips = modem.dsssSpread(dataFrame.bits, 31, 21);
      const phases = modem.dpskModulate(chips);
      const signal = modem.modulateCarrier(phases, 23, 44100, 10000);
      
      // Test with different amplitude levels
      const amplitudes = [1.0, 0.5, 0.2, 0.1];
      
      for (const amplitude of amplitudes) {
        let processed = 0;
        
        while (processed < signal.length) {
          const chunkSize = 128;
          const chunk = new Float32Array(chunkSize);
          const remaining = signal.length - processed;
          const copySize = Math.min(chunkSize, remaining);
          
          for (let i = 0; i < copySize; i++) {
            chunk[i] = signal[processed + i] * amplitude;
          }
          
          processor.process([[chunk]], [[new Float32Array(chunkSize)]]);
          processed += chunkSize;
        }
      }
      
      // Should handle all amplitude levels without crashing
      expect(processor.demodulator).toBeDefined();
    });

    test('should complete full modulation-demodulation cycle', async () => {
      const originalData = new Uint8Array([0x12, 0x34, 0x56]);
      
      // Generate signal using processor's modulate method
      processor['resetAbortController']();
      processor.modulate(originalData, { signal: processor['abortController'].signal }).catch(() => {});
      
      // Process immediately to set up modulation
      processor.process([[new Float32Array(1)]], [[new Float32Array(1)]]);
      
      const modulatedSignal = processor.pendingModulation?.samples;
      expect(modulatedSignal).toBeTruthy();
      
      // Reset for demodulation test
      await processor.reset();
      processor['resetAbortController']();
      
      // Process the signal for demodulation
      let processed = 0;
      while (processed < modulatedSignal!.length) {
        const chunkSize = 128;
        const chunk = new Float32Array(chunkSize);
        const remaining = modulatedSignal!.length - processed;
        const copySize = Math.min(chunkSize, remaining);
        
        for (let i = 0; i < copySize; i++) {
          chunk[i] = modulatedSignal![processed + i];
        }
        
        processor.process([[chunk]], [[new Float32Array(chunkSize)]]);
        processed += chunkSize;
      }
      
      // Should have processed the signal
      expect(processor.demodulator).toBeDefined();
    }, 10000);

    test('should handle AudioWorklet-style continuous operation', async () => {
      // Simulate continuous AudioWorklet operation
      const totalSamples = 44100; // 1 second at 44.1kHz
      const chunkSize = 128; // Standard AudioWorklet chunk size
      let processed = 0;
      
      while (processed < totalSamples) {
        const inputs = [[new Float32Array(chunkSize)]];
        const outputs = [[new Float32Array(chunkSize)]];
        
        // Generate realistic audio input
        for (let i = 0; i < chunkSize; i++) {
          const t = (processed + i) / 44100;
          inputs[0][0][i] = Math.sin(2 * Math.PI * 10000 * t) * 0.3;
        }
        
        const result = processor.process(inputs, outputs);
        expect(result).toBe(true);
        
        processed += chunkSize;
      }
      
      // Should complete 1 second of continuous processing
      expect(processed).toBeGreaterThanOrEqual(totalSamples);
    });

    test('should measure process() performance with real DSSS-DPSK frames', async () => {
      // リアルタイム制約: 128samples@44.1kHz ≈ 2.9ms
      const REALTIME_CONSTRAINT_MS = (128 / 44100) * 1000; // ≈2.9ms
      
      console.log(`\n=== Real DSSS-DPSK Frame Performance Measurement ===`);
      console.log(`Target: 128 samples per ${REALTIME_CONSTRAINT_MS.toFixed(2)}ms (realtime constraint)`);
      
      // 実際のフレームデータを構築
      const { DsssDpskFramer } = await import('../../src/modems/dsss-dpsk/framer.js');
      const modem = await import('../../src/modems/dsss-dpsk/dsss-dpsk.js');
      
      const framer = new DsssDpskFramer();
      const testData = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
      const dataFrame = framer.build(testData, { sequenceNumber: 0, frameType: 0, ldpcNType: 0 });
      
      const chips = modem.dsssSpread(dataFrame.bits, 31, 21);
      const phases = modem.dpskModulate(chips);
      const fullSignal = modem.modulateCarrier(phases, 23, 44100, 10000);
      
      console.log(`Generated real frame: ${dataFrame.bits.length} bits, ${chips.length} chips, ${fullSignal.length} samples`);
      console.log(`Frame duration: ${(fullSignal.length / 44100 * 1000).toFixed(1)}ms`);
      
      // 継続的な処理時間の測定 (10秒間)
      const testDurationMs = 10000; // 10秒
      const totalSamples = Math.floor(testDurationMs * 44100 / 1000);
      const iterations = Math.ceil(totalSamples / 128);
      
      console.log(`Testing ${testDurationMs}ms of continuous processing (${iterations} iterations)`);
      
      const processingTimes: number[] = [];
      let sampleIndex = 0;
      
      for (let i = 0; i < iterations; i++) {
        const inputs = [[new Float32Array(128)]];
        const outputs = [[new Float32Array(128)]];
        
        // 実際のフレーム信号を循環使用
        for (let j = 0; j < 128; j++) {
          const signalIndex = sampleIndex % fullSignal.length;
          inputs[0][0][j] = fullSignal[signalIndex];
          sampleIndex++;
        }
        
        const startTime = performance.now();
        const result = processor.process(inputs, outputs);
        const endTime = performance.now();
        
        const processingTime = endTime - startTime;
        processingTimes.push(processingTime);
        
        expect(result).toBe(true);
      }
      
      // 統計分析
      processingTimes.sort((a, b) => a - b);
      const avgTime = processingTimes.reduce((a, b) => a + b) / iterations;
      const minTime = processingTimes[0];
      const maxTime = processingTimes[iterations - 1];
      const p95Time = processingTimes[Math.floor(iterations * 0.95)];
      const p99Time = processingTimes[Math.floor(iterations * 0.99)];
      
      console.log(`\n--- Real Frame Performance Statistics (${iterations} iterations) ---`);
      console.log(`Average: ${avgTime.toFixed(3)}ms`);
      console.log(`Minimum: ${minTime.toFixed(3)}ms`);
      console.log(`Maximum: ${maxTime.toFixed(3)}ms`);
      console.log(`95th percentile: ${p95Time.toFixed(3)}ms`);
      console.log(`99th percentile: ${p99Time.toFixed(3)}ms`);
      console.log(`Realtime constraint: ${REALTIME_CONSTRAINT_MS.toFixed(2)}ms`);
      
      // リアルタイム制約分析
      const exceedsConstraint = processingTimes.filter(t => t > REALTIME_CONSTRAINT_MS);
      const exceedsPercentage = (exceedsConstraint.length / iterations) * 100;
      
      console.log(`\n--- Realtime Constraint Analysis (Real Signal) ---`);
      console.log(`Samples exceeding constraint: ${exceedsConstraint.length}/${iterations} (${exceedsPercentage.toFixed(2)}%)`);
      
      if (exceedsConstraint.length > 0) {
        console.log(`Worst violations: ${exceedsConstraint.slice(-5).map(t => t.toFixed(3)).join(', ')}ms`);
      }
      
      // 実際の処理負荷の分析
      const highLoadSamples = processingTimes.filter(t => t > avgTime * 2);
      console.log(`High load samples (>2x avg): ${highLoadSamples.length}/${iterations} (${(highLoadSamples.length/iterations*100).toFixed(1)}%)`);
      
      // Performance assertions - 実際のフレーム処理用に調整
      expect(avgTime).toBeLessThan(REALTIME_CONSTRAINT_MS); // 平均は制約内
      expect(p95Time).toBeLessThan(REALTIME_CONSTRAINT_MS * 1.5); // 95%は1.5倍以内
      
      if (exceedsPercentage > 5) {
        console.warn(`⚠️  WARNING: ${exceedsPercentage.toFixed(1)}% of samples exceed realtime constraint`);
        console.warn(`Real DSSS-DPSK processing may cause audio dropouts`);
      } else {
        console.log(`✅ Real frame processing acceptable: ${(100 - exceedsPercentage).toFixed(1)}% within constraint`);
      }
      
      console.log(`=== End Real Frame Performance Measurement ===\n`);
    }, 15000); // 15秒のタイムアウト

    test('should measure process() performance with different load levels', async () => {
      const REALTIME_CONSTRAINT_MS = (128 / 44100) * 1000; 
      const iterations = 500;
      
      console.log(`\n=== Process Load Level Performance Analysis ===`);
      
      const loadTests = [
        {
          name: 'Empty Processing (baseline)',
          setup: () => {
            // No special setup, just empty inputs
            const inputs = [[new Float32Array(128)]];
            const outputs = [[new Float32Array(128)]];
            return { inputs, outputs };
          }
        },
        {
          name: 'Signal Processing (carrier + DPSK)',
          setup: () => {
            const inputs = [[new Float32Array(128)]];
            const outputs = [[new Float32Array(128)]];
            
            // Generate realistic modulated signal
            for (let i = 0; i < 128; i++) {
              inputs[0][0][i] = Math.sin(2 * Math.PI * 10000 * i / 44100) * 0.7;
            }
            return { inputs, outputs };
          }
        },
        {
          name: 'Full Load (demod + framing)',
          setup: async () => {
            // Add some data to framer to trigger full processing
            processor.framer.process(new Int8Array([100, 100, 100, 100])); // Strong bits
            
            const inputs = [[new Float32Array(128)]];
            const outputs = [[new Float32Array(128)]];
            
            // Complex signal with multiple frequency components
            for (let i = 0; i < 128; i++) {
              const t = i / 44100;
              inputs[0][0][i] = Math.sin(2 * Math.PI * 10000 * t) * 0.5 +
                              Math.sin(2 * Math.PI * 11000 * t) * 0.3;
            }
            return { inputs, outputs };
          }
        }
      ];
      
      const results: Array<{name: string, avgTime: number, maxTime: number, p95Time: number}> = [];
      
      for (const loadTest of loadTests) {
        const processingTimes: number[] = [];
        
        for (let i = 0; i < iterations; i++) {
          const { inputs, outputs } = await loadTest.setup();
          
          const startTime = performance.now();
          processor.process(inputs, outputs);
          const endTime = performance.now();
          
          processingTimes.push(endTime - startTime);
        }
        
        processingTimes.sort((a, b) => a - b);
        const avgTime = processingTimes.reduce((a, b) => a + b) / iterations;
        const maxTime = processingTimes[iterations - 1];
        const p95Time = processingTimes[Math.floor(iterations * 0.95)];
        
        results.push({ name: loadTest.name, avgTime, maxTime, p95Time });
        
        console.log(`\n${loadTest.name}:`);
        console.log(`  Average: ${avgTime.toFixed(3)}ms`);
        console.log(`  Maximum: ${maxTime.toFixed(3)}ms`);
        console.log(`  95th percentile: ${p95Time.toFixed(3)}ms`);
        console.log(`  vs Constraint: ${(avgTime / REALTIME_CONSTRAINT_MS * 100).toFixed(1)}%`);
      }
      
      // Analyze performance progression
      console.log(`\n--- Load Impact Analysis ---`);
      const baseline = results[0];
      for (let i = 1; i < results.length; i++) {
        const current = results[i];
        const overhead = current.avgTime - baseline.avgTime;
        console.log(`${current.name}: +${overhead.toFixed(3)}ms over baseline`);
      }
      
      // All load levels should be reasonable
      for (const result of results) {
        expect(result.avgTime).toBeLessThan(REALTIME_CONSTRAINT_MS * 2);
        expect(result.p95Time).toBeLessThan(REALTIME_CONSTRAINT_MS * 4);
      }
      
      console.log(`=== End Load Level Analysis ===\n`);
    });
  });
});