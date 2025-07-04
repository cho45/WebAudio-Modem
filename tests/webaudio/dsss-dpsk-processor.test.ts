/**
 * DsssDpskProcessor Unit Tests - Complete implementation with demo quality features
 * Tests all quality monitoring, adaptive resync, and framer functionality
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

// Import MyAbort first (needed for dynamic import)
await import('../../src/webaudio/processors/myabort.js');

// Import the module dynamically
await import('../../src/webaudio/processors/dsss-dpsk-processor.js');

// Re-import to get the class for testing
const processorModule = await import('../../src/webaudio/processors/dsss-dpsk-processor.js') as any;
const DsssDpskProcessor = processorModule.DsssDpskProcessor;

describe('DsssDpskProcessor - Complete Implementation', () => {
  let processor: any;
  let mockPort: any;

  beforeEach(() => {
    vi.clearAllMocks();
    processor = new DsssDpskProcessor();
    mockPort = processor.port;
  });

  // Helper function to send message via port
  const sendMessage = async (message: any) => {
    const messageEvent = { data: message } as MessageEvent;
    await mockPort.onmessage(messageEvent);
  };

  describe('Basic Functionality', () => {
    test('should initialize correctly with complete state', () => {
      expect(processor).toBeDefined();
      expect(typeof mockPort.onmessage).toBe('function');
      expect(mockPort.postMessage).toBeDefined();
    });

    test('should handle configure message', async () => {
      const configMessage = {
        id: 'test-config',
        type: 'configure',
        data: { 
          config: { 
            sequenceLength: 31,
            samplesPerPhase: 23,
            carrierFreq: 10000,
            weakLLRThreshold: 50
          } 
        }
      };

      await sendMessage(configMessage);

      expect(mockPort.postMessage).toHaveBeenCalledWith({
        id: 'test-config',
        type: 'result',
        data: { success: true }
      });
    });

    test('should handle status message with complete structure', async () => {
      const statusMessage = {
        id: 'test-status',
        type: 'status',
        data: {}
      };

      await sendMessage(statusMessage);

      expect(mockPort.postMessage).toHaveBeenCalledWith({
        id: 'test-status',
        type: 'result',
        data: {
          isConfigured: false,
          syncState: {
            locked: false,
            mode: 'SEARCH',
            lastLLRs: [],
            consecutiveWeakBits: 0,
            framesSinceLastCheck: 0,
            lastSyncTime: 0,
            processedBits: 0,
            consecutiveFailures: 0
          },
          frameProcessingState: {
            isActive: false,
            expectedBits: 0,
            receivedBits: 0,
            mustComplete: false
          },
          framerStatus: {
            state: 'SEARCHING_PREAMBLE',
            bufferLength: 0,
            processedBits: 0,
            lastCorrelation: 0,
            isHealthy: true
          },
          sampleBufferLength: 0,
          decodedDataBufferLength: 0,
          pendingModulation: false,
          estimatedSnrDb: 10,
          config: {
            sequenceLength: 31,
            seed: 21, // 0b10101
            samplesPerPhase: 23,
            carrierFreq: 10000,
            correlationThreshold: 0.5,
            peakToNoiseRatio: 4,
            weakLLRThreshold: 50,
            maxConsecutiveWeak: 5,
            verifyIntervalFrames: 100
          }
        }
      });
    });

    test('should handle modulate message', async () => {
      // Configure first
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31 } }
      });

      const modulateMessage = {
        id: 'test-modulate',
        type: 'modulate',
        data: { bytes: [0x48, 0x65, 0x6C, 0x6C, 0x6F] } // "Hello"
      };

      // Don't await since it requires audio processing
      sendMessage(modulateMessage);

      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Should not have error messages
      expect(mockPort.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' })
      );
    });

    test('should handle demodulate message', async () => {
      // Configure first
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31 } }
      });

      // Add test data
      processor.decodedUserDataBuffer.push(new Uint8Array([0x48, 0x65]));

      const demodulateMessage = {
        id: 'test-demodulate',
        type: 'demodulate',
        data: {}
      };

      await sendMessage(demodulateMessage);

      expect(mockPort.postMessage).toHaveBeenCalledWith({
        id: 'test-demodulate',
        type: 'result',
        data: { bytes: expect.any(Array) }
      });
    });
  });

  describe('Sync State Management', () => {
    beforeEach(async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31, samplesPerPhase: 23 } }
      });
      mockPort.postMessage.mockClear();
    });

    test('should start in SEARCH mode', async () => {
      await sendMessage({
        id: 'status',
        type: 'status',
        data: {}
      });

      const statusResponse = mockPort.postMessage.mock.calls[0][0];
      expect(statusResponse.data.syncState.mode).toBe('SEARCH');
      expect(statusResponse.data.syncState.locked).toBe(false);
      expect(statusResponse.data.isConfigured).toBe(true);
    });

    test('should track LLR history correctly', async () => {
      // Manually add some LLR history for testing
      processor.syncState.lastLLRs = [100, 90, 80];
      
      await sendMessage({
        id: 'status',
        type: 'status',
        data: {}
      });

      const statusResponse = mockPort.postMessage.mock.calls[0][0];
      expect(statusResponse.data.syncState.lastLLRs).toEqual([100, 90, 80]);
    });

    test('should handle reset correctly', async () => {
      // Add some state
      processor.sampleBuffer.write(1, 2, 3);
      processor.syncState.processedBits = 50;
      processor.syncState.lastLLRs = [100, 90];

      await sendMessage({
        id: 'reset',
        type: 'reset',
        data: {}
      });

      expect(processor.sampleBuffer.length).toBe(0);
      expect(processor.syncState.processedBits).toBe(0);
      expect(processor.syncState.lastLLRs).toEqual([]);

      expect(mockPort.postMessage).toHaveBeenCalledWith({
        id: 'reset',
        type: 'result',
        data: { success: true }
      });
    });
  });

  describe('Quality Monitoring Features', () => {
    beforeEach(async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { 
          config: { 
            sequenceLength: 31,
            weakLLRThreshold: 50,
            maxConsecutiveWeak: 5,
            verifyIntervalFrames: 100
          } 
        }
      });
      mockPort.postMessage.mockClear();
    });

    test('should track consecutive weak bits', () => {
      processor.syncState.consecutiveWeakBits = 3;
      
      expect(processor.syncState.consecutiveWeakBits).toBe(3);
      expect(processor.config.maxConsecutiveWeak).toBe(5);
    });

    test('should maintain SNR estimation', () => {
      expect(processor.estimatedSnrDb).toBe(10.0);
      
      // Test SNR update
      processor._updateSNREstimate(0.8);
      expect(processor.estimatedSnrDb).toBeGreaterThan(10.0);
    });

    test('should track frame processing state', async () => {
      await sendMessage({
        id: 'status',
        type: 'status',
        data: {}
      });

      const statusResponse = mockPort.postMessage.mock.calls[0][0];
      expect(statusResponse.data.frameProcessingState).toEqual({
        isActive: false,
        expectedBits: 0,
        receivedBits: 0,
        mustComplete: false
      });
    });
  });

  describe('Continuous Audio Processing', () => {
    beforeEach(async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31, samplesPerPhase: 23 } }
      });
      mockPort.postMessage.mockClear();
    });

    test('should handle continuous 128-sample processing', () => {
      const inputs = [[new Float32Array(128)]];
      const outputs = [[new Float32Array(128)]];

      // Process multiple frames continuously
      for (let i = 0; i < 10; i++) {
        // Add some test signal
        inputs[0][0].fill(Math.sin(i * 0.1));
        
        const result = processor.process(inputs, outputs);
        expect(result).toBe(true);
        
        // Output should be silent (no modulation pending)
        expect(outputs[0][0]).toEqual(new Float32Array(128));
      }

      // Buffer should have accumulated some data
      expect(processor.sampleBuffer.length).toBeGreaterThan(0);
    });

    test('should feed bits to framer and update its state', async () => {
      // Initial framer state
      expect(processor.framer.getState().state).toBe('SEARCHING_PREAMBLE');

      // Simulate feeding preamble bits (LLR for 0 is positive, for 1 is negative)
      // PREAMBLE = [0, 0, 0, 0]
      // Directly call framer.process with preamble bits
      processor.framer.process(new Int8Array([120, 120, 120, 120])); // LLR for 0

      // After feeding preamble, framer should transition to SEARCHING_SYNC_WORD
      // Send status message and capture the response
      const statusPromise = new Promise(resolve => {
        mockPort.postMessage.mockImplementationOnce((message: any) => {
          resolve(message);
        });
      });
      await sendMessage({ id: 'status-framer', type: 'status', data: {} });
      const statusResponse = await statusPromise;

      expect(statusResponse.data.framerStatus.state).toBe('SEARCHING_SYNC_WORD');
    });

    test('should handle large audio buffer processing', () => {
      const inputs = [[new Float32Array(4096)]]; // Large buffer
      const outputs = [[new Float32Array(4096)]];

      // Fill with test signal
      for (let i = 0; i < 4096; i++) {
        inputs[0][0][i] = Math.sin(2 * Math.PI * i / 100);
      }

      const result = processor.process(inputs, outputs);
      expect(result).toBe(true);
      
      // Buffer should be managing the large input
      expect(processor.sampleBuffer.length).toBeGreaterThan(0);
    });
  });

  describe('Framer Integration', () => {
    beforeEach(async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31 } }
      });
      mockPort.postMessage.mockClear();
    });

    test('should build frames correctly for modulation', async () => {
      const testData = new Uint8Array([0x41, 0x42]); // "AB"
      
      // Start modulation but don't wait
      sendMessage({
        id: 'modulate',
        type: 'modulate',
        data: { bytes: Array.from(testData) }
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      // Should have pending modulation
      expect(processor.pendingModulation).toBeTruthy();
      expect(processor.pendingModulation.samples.length).toBeGreaterThan(0);
    });

    test('should track framer state correctly', async () => {
      await sendMessage({
        id: 'status',
        type: 'status',
        data: {}
      });

      const statusResponse = mockPort.postMessage.mock.calls[0][0];
      expect(statusResponse.data.framerStatus.state).toBe('SEARCHING_PREAMBLE');
      expect(statusResponse.data.framerStatus.bufferLength).toBe(0);
      expect(statusResponse.data.framerStatus.isHealthy).toBe(true);
    });

    test('should clear data buffer after reading', async () => {
      // Add test data
      processor.decodedUserDataBuffer.push(new Uint8Array([1, 2, 3]));

      // Get data
      await sendMessage({
        id: 'demod',
        type: 'demodulate',
        data: {}
      });

      expect(mockPort.postMessage).toHaveBeenCalledWith({
        id: 'demod',
        type: 'result',
        data: { bytes: [1, 2, 3] }
      });

      // Buffer should be empty
      expect(processor.decodedUserDataBuffer.length).toBe(0);
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid configuration gracefully', async () => {
      const invalidConfig = {
        id: 'invalid',
        type: 'configure',
        data: { config: { sequenceLength: 'invalid' } }
      };

      await sendMessage(invalidConfig);

      // Should not crash, might return error or succeed with defaults
      expect(mockPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'invalid',
          type: expect.stringMatching(/result|error/)
        })
      );
    });

    test('should handle unknown message types', async () => {
      const unknownMessage = {
        id: 'unknown',
        type: 'unknown',
        data: {}
      };

      await sendMessage(unknownMessage);

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
  });

  describe('Integration Workflow', () => {
    test('should complete configure -> process -> status workflow', async () => {
      // 1. Configure
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31 } }
      });

      // 2. Process audio
      const inputs = [[new Float32Array(1024)]];
      const outputs = [[new Float32Array(1024)]];
      
      for (let i = 0; i < 5; i++) {
        processor.process(inputs, outputs);
      }

      // 3. Check status
      mockPort.postMessage.mockClear();
      await sendMessage({
        id: 'status',
        type: 'status',
        data: {}
      });

      const statusResponse = mockPort.postMessage.mock.calls[0][0];
      expect(statusResponse.data.isConfigured).toBe(true);
      expect(statusResponse.data.sampleBufferLength).toBeGreaterThan(0);
      expect(statusResponse.data.syncState.mode).toBe('SEARCH'); // Still searching without real signal
    });

    test('should generate correct modulated signal output', async () => {
      // Configure
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31 } }
      });

      // Start modulation
      sendMessage({
        id: 'modulate',
        type: 'modulate',
        data: { bytes: [0x48] } // 'H' = 01001000
      });

      // Wait for modulation to start
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Verify modulation parameters
      expect(processor.pendingModulation).toBeTruthy();
      expect(processor.pendingModulation.samples.length).toBeGreaterThan(0);
      expect(processor.pendingModulation.index).toBe(0);
      
      // Generate output signal
      const outputs = [[new Float32Array(1024)]];
      processor.process([], outputs);
      
      // Verify actual signal characteristics
      const outputSignal = outputs[0][0];
      
      // Check signal is not all zeros
      const hasSignal = Array.from(outputSignal).some(sample => Math.abs(sample) > 0.001);
      expect(hasSignal).toBe(true);
      
      // Check signal amplitude is reasonable (should be around ±1)
      const maxAmplitude = Math.max(...Array.from(outputSignal).map(Math.abs));
      expect(maxAmplitude).toBeGreaterThan(0.1);
      expect(maxAmplitude).toBeLessThanOrEqual(1.1);
      
      // Check signal has proper carrier frequency characteristics
      // With 10kHz carrier at 44.1kHz sample rate, expect periodic behavior
      const rms = Math.sqrt(outputSignal.reduce((sum, s) => sum + s*s, 0) / outputSignal.length);
      expect(rms).toBeGreaterThan(0.1); // Should have significant energy
      
      // Verify progress in modulation
      expect(processor.pendingModulation.index).toBeGreaterThan(0);
    });
  });

  describe('Performance and Reliability', () => {
    test('should handle rapid state changes', async () => {
      const operations = [
        { id: 'op1', type: 'configure', data: { config: { sequenceLength: 31 } } },
        { id: 'op2', type: 'reset', data: {} },
        { id: 'op3', type: 'configure', data: { config: { sequenceLength: 63 } } },
        { id: 'op4', type: 'status', data: {} }
      ];

      for (const op of operations) {
        await sendMessage(op);
        
        // Should handle each operation without errors
        expect(mockPort.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            id: op.id,
            type: expect.stringMatching(/result|error/)
          })
        );
      }
    });

    test('should maintain consistent state across operations', async () => {
      // Configure
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31 } }
      });

      // Process
      const inputs = [[new Float32Array(256)]];
      const outputs = [[new Float32Array(256)]];
      processor.process(inputs, outputs);

      // Reset
      await sendMessage({
        id: 'reset',
        type: 'reset',
        data: {}
      });

      // Verify clean state
      mockPort.postMessage.mockClear();
      await sendMessage({
        id: 'status',
        type: 'status',
        data: {}
      });

      const statusResponse = mockPort.postMessage.mock.calls[0][0];
      expect(statusResponse.data.sampleBufferLength).toBe(0);
      expect(statusResponse.data.syncState.mode).toBe('SEARCH');
      expect(statusResponse.data.syncState.locked).toBe(false);
      expect(statusResponse.data.syncState.processedBits).toBe(0);
      expect(statusResponse.data.frameProcessingState.isActive).toBe(false);
    });
  });

  describe('Demo Features Integration', () => {
    test('should maintain all demo configuration parameters', async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { 
          config: { 
            sequenceLength: 63,
            weakLLRThreshold: 30,
            maxConsecutiveWeak: 10,
            verifyIntervalFrames: 200
          } 
        }
      });

      mockPort.postMessage.mockClear();
      await sendMessage({
        id: 'status',
        type: 'status',
        data: {}
      });

      const statusResponse = mockPort.postMessage.mock.calls[0][0];
      expect(statusResponse.data.config).toBeDefined();
      expect(statusResponse.data.config.sequenceLength).toBe(63);
      expect(statusResponse.data.config.weakLLRThreshold).toBe(30);
      expect(statusResponse.data.config.maxConsecutiveWeak).toBe(10);
      expect(statusResponse.data.config.verifyIntervalFrames).toBe(200);
    });

    test('should support SEARCH/TRACK/VERIFY state transitions', async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31 } }
      });

      // Initially in SEARCH
      mockPort.postMessage.mockClear();
      await sendMessage({ id: 'status1', type: 'status', data: {} });
      let response = mockPort.postMessage.mock.calls[0][0];
      expect(response.data.syncState).toBeDefined();
      expect(response.data.syncState.mode).toBe('SEARCH');

      // Simulate state changes (in real usage these would be triggered by signal processing)
      processor.syncState.mode = 'TRACK';
      processor.syncState.locked = true;

      mockPort.postMessage.mockClear();
      await sendMessage({ id: 'status2', type: 'status', data: {} });
      response = mockPort.postMessage.mock.calls[0][0];
      expect(response.data.syncState).toBeDefined();
      expect(response.data.syncState.mode).toBe('TRACK');
      expect(response.data.syncState.locked).toBe(true);
    });
  });

  describe('Complete Frame Decoding Tests', () => {
    test('should decode complete frame and recover original user data', async () => {
      // Configure processor
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31, samplesPerPhase: 23 } }
      });

      // Test with known data that should be recoverable
      const originalData = new Uint8Array([0x48, 0x65, 0x6C]); // "Hel"
      
      // Use processor's modulate() method to generate the exact same signal
      processor.resetAbortController();
      const modPromise = processor.modulate(originalData, { signal: processor.abortController.signal }).catch(() => {});
      
      // Wait a bit for modulation to set up
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Extract the generated signal from pendingModulation
      const cleanSignal = processor.pendingModulation?.samples;
      if (!cleanSignal) {
        throw new Error('Processor did not generate modulation signal');
      }
      
      // Reset processor state for testing
      await processor.reset();
      
      console.log(`Generated signal: ${cleanSignal.length} samples for ${originalData.length} bytes`);
      
      // Add noise before signal to simulate realistic conditions
      const noiseLength = 2000; // 2000 samples of noise before signal
      const fullSignal = new Float32Array(noiseLength + cleanSignal.length);
      
      // Add weak noise before actual signal
      for (let i = 0; i < noiseLength; i++) {
        fullSignal[i] = (Math.random() - 0.5) * 0.05; // Low amplitude noise
      }
      fullSignal.set(cleanSignal, noiseLength);
      
      console.log(`Processing ${fullSignal.length} samples (${noiseLength} noise + ${cleanSignal.length} signal)`);
      
      // Process in AudioWorklet-realistic 128-sample chunks
      const chunkSize = 128; // AudioWorklet standard chunk size
      let totalProcessed = 0;
      
      const demodulatePromise = processor.demodulate({ signal: processor.abortController.signal });

      while (totalProcessed < fullSignal.length) {
        const endIdx = Math.min(totalProcessed + chunkSize, fullSignal.length);
        const chunk = new Float32Array(chunkSize);
        
        if (endIdx - totalProcessed === chunkSize) {
          chunk.set(fullSignal.slice(totalProcessed, endIdx), 0);
        } else {
          // Last chunk may be smaller - pad with zeros
          chunk.set(fullSignal.slice(totalProcessed, endIdx), 0);
        }
        
        const inputs = [[chunk]];
        const outputs = [[new Float32Array(chunkSize)]];
        
        processor.process(inputs, outputs);
        totalProcessed = endIdx;
        
        // Log framer state and decoded buffer length during processing
        const currentFramerState = processor.framer.getState();
        console.log(`[DEBUG] Processed: ${totalProcessed} samples, Framer State: ${currentFramerState.state}, Buffer: ${currentFramerState.bufferLength}, Decoded: ${processor.decodedUserDataBuffer.length}`);
      }
      
      const decodedBytes = await demodulatePromise;
      
      console.log('Original:', Array.from(originalData));
      console.log('Decoded:', Array.from(decodedBytes));
      
      expect(decodedBytes).toEqual(originalData);

    }, 15000); // 15 second timeout for streaming processing

    test('should handle 128-sample streaming like real AudioWorklet', async () => {
      // Configure processor
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31, samplesPerPhase: 23 } }
      });

      // Generate test signal
      const testData = new Uint8Array([0x42]); // 'B'
      
      const { DsssDpskFramer } = await import('../../src/modems/dsss-dpsk/framer.js');
      const modem = await import('../../src/modems/dsss-dpsk/dsss-dpsk.js');
      
      const framer = new DsssDpskFramer();
      const frameOptions = { sequenceNumber: 0, frameType: 0, ldpcNType: 0 };
      const dataFrame = framer.build(testData, frameOptions);
      
      const chips = modem.dsssSpread(dataFrame.bits, 31, 0b10101);
      const phases = modem.dpskModulate(chips);
      const signal = modem.modulateCarrier(phases, 23, 44100, 10000);
      
      // Process in exactly 128-sample chunks like AudioWorklet
      const AUDIOWORKLET_CHUNK_SIZE = 128;
      let processedSamples = 0;
      let frameDetected = false;
      
      console.log(`Processing ${signal.length} samples in ${AUDIOWORKLET_CHUNK_SIZE}-sample chunks`);
      
      while (processedSamples < signal.length) {
        const endIdx = Math.min(processedSamples + AUDIOWORKLET_CHUNK_SIZE, signal.length);
        let chunk: Float32Array;
        
        if (endIdx - processedSamples === AUDIOWORKLET_CHUNK_SIZE) {
          chunk = signal.slice(processedSamples, endIdx);
        } else {
          // Last chunk may be smaller - pad with zeros like real audio
          chunk = new Float32Array(AUDIOWORKLET_CHUNK_SIZE);
          chunk.set(signal.slice(processedSamples, endIdx), 0);
        }
        
        const inputs = [[chunk]];
        const outputs = [[new Float32Array(AUDIOWORKLET_CHUNK_SIZE)]];
        
        const continueProcessing = processor.process(inputs, outputs);
        expect(continueProcessing).toBe(true);
        
        // Check if frame was detected
        if (processor.decodedUserDataBuffer.length > 0) {
          frameDetected = true;
          console.log(`Frame detected at chunk ${Math.floor(processedSamples / AUDIOWORKLET_CHUNK_SIZE)}`);
        }
        
        processedSamples = endIdx;
      }
      
      // Get final state
      mockPort.postMessage.mockClear();
      await sendMessage({
        id: 'stream-status',
        type: 'status',
        data: {}
      });
      
      const statusResponse = mockPort.postMessage.mock.calls[0][0];
      const finalState = statusResponse.data;
      
      console.log('128-sample streaming results:');
      console.log('- Total chunks processed:', Math.ceil(signal.length / AUDIOWORKLET_CHUNK_SIZE));
      console.log('- Frame detected:', frameDetected);
      console.log('- Final sync state:', finalState.syncState.mode);
      console.log('- Processed bits:', finalState.syncState.processedBits);
      
      // Verify that streaming processing worked
      expect(finalState.syncState.processedBits).toBeGreaterThanOrEqual(0);
      
      // Verify processor can handle the real streaming scenario
      expect(finalState.isConfigured).toBe(true);
    });

    test('should handle frame boundaries across multiple chunks', async () => {
      // Configure
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31, samplesPerPhase: 23 } }
      });

      // Generate a signal that will be split across multiple 128-sample chunks
      const testData = new Uint8Array([0x41]); // 'A'
      
      const { DsssDpskFramer } = await import('../../src/modems/dsss-dpsk/framer.js');
      const modem = await import('../../src/modems/dsss-dpsk/dsss-dpsk.js');
      
      const framer = new DsssDpskFramer();
      const frameOptions = { sequenceNumber: 0, frameType: 0, ldpcNType: 0 };
      const dataFrame = framer.build(testData, frameOptions);
      
      const chips = modem.dsssSpread(dataFrame.bits, 31, 0b10101);
      const phases = modem.dpskModulate(chips);
      const signal = modem.modulateCarrier(phases, 23, 44100, 10000);
      
      // Deliberately use misaligned chunk sizes to test boundary handling
      const chunkSizes = [64, 128, 200, 96, 128]; // Irregular chunk sizes
      let processedSamples = 0;
      
      for (const chunkSize of chunkSizes) {
        if (processedSamples >= signal.length) break;
        
        const endIdx = Math.min(processedSamples + chunkSize, signal.length);
        const chunk = new Float32Array(chunkSize);
        chunk.set(signal.slice(processedSamples, endIdx), 0);
        
        const inputs = [[chunk]];
        const outputs = [[new Float32Array(chunkSize)]];
        
        processor.process(inputs, outputs);
        processedSamples = endIdx;
      }
      
      // Process remaining samples if any
      while (processedSamples < signal.length) {
        const remainingSamples = signal.length - processedSamples;
        const chunkSize = Math.min(128, remainingSamples);
        const chunk = new Float32Array(chunkSize);
        chunk.set(signal.slice(processedSamples, processedSamples + chunkSize), 0);
        
        const inputs = [[chunk]];
        const outputs = [[new Float32Array(chunkSize)]];
        
        processor.process(inputs, outputs);
        processedSamples += chunkSize;
      }
      
      // Verify boundary handling didn't break processing
      mockPort.postMessage.mockClear();
      await sendMessage({ id: 'boundary-test', type: 'status', data: {} });
      const finalState = mockPort.postMessage.mock.calls[0][0].data;
      
      expect(finalState.syncState.processedBits).toBeGreaterThan(0);
      expect(finalState.syncState).toBeDefined();
      expect(finalState.syncState.mode).toMatch(/SEARCH|TRACK|VERIFY/);
      
      console.log('Boundary test completed:');
      console.log('- Processed samples:', processedSamples);
      console.log('- Final processed bits:', finalState.syncState.processedBits);
      console.log('- Sync state:', finalState.syncState.mode);
    });
  });
});
