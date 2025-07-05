/**
 * DSSS-DPSK Processor Data Integrity Tests
 * Tests for data correctness, error tolerance, and performance
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// Mock setup
class MockAudioWorkletProcessor {
  port = {
    onmessage: null as ((_event: MessageEvent) => void) | null,
    postMessage: vi.fn()
  };
}

const mockRegisterProcessor = vi.fn();
vi.stubGlobal('AudioWorkletProcessor', MockAudioWorkletProcessor);
vi.stubGlobal('registerProcessor', mockRegisterProcessor);
vi.stubGlobal('sampleRate', 44100);

await import('../../src/webaudio/processors/myabort.js');
await import('../../src/webaudio/processors/dsss-dpsk-processor.js');

const processorModule = await import('../../src/webaudio/processors/dsss-dpsk-processor.js') as any;
const DsssDpskProcessor = processorModule.DsssDpskProcessor;

describe('DsssDpskProcessor - Data Integrity and Performance', () => {
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

  describe('Data Integrity Under Noise', () => {
    beforeEach(async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31, samplesPerPhase: 23 } }
      });
      mockPort.postMessage.mockClear();
    });

    test('should maintain data integrity with SNR variations', async () => {
      const { DsssDpskFramer } = await import('../../src/modems/dsss-dpsk/framer.js');
      const modem = await import('../../src/modems/dsss-dpsk/dsss-dpsk.js');
      
      const framer = new DsssDpskFramer();
      const originalData = new Uint8Array([0xCA, 0xFE, 0xBA, 0xBE]);
      const dataFrame = framer.build(originalData, { sequenceNumber: 0, frameType: 0, ldpcNType: 0 });
      
      const chips = modem.dsssSpread(dataFrame.bits, 31, 21);
      const phases = modem.dpskModulate(chips);
      const cleanSignal = modem.modulateCarrier(phases, 23, 44100, 10000);
      
      // Test with different noise levels
      const snrLevels = [20, 10, 5, 3]; // dB
      
      for (const snrDb of snrLevels) {
        // Reset processor for each test
        await processor.reset();
        processor['resetAbortController']();
        
        // Calculate noise amplitude from SNR
        const signalPower = cleanSignal.reduce((sum, s) => sum + s * s, 0) / cleanSignal.length;
        const signalAmplitude = Math.sqrt(signalPower);
        const noiseAmplitude = signalAmplitude / Math.pow(10, snrDb / 20);
        
        // Add noise to signal
        const noisySignal = new Float32Array(cleanSignal.length);
        for (let i = 0; i < cleanSignal.length; i++) {
          noisySignal[i] = cleanSignal[i] + (Math.random() - 0.5) * 2 * noiseAmplitude;
        }
        
        // Process noisy signal
        const demodPromise = processor.demodulate({ signal: processor['abortController'].signal });
        
        let processed = 0;
        while (processed < noisySignal.length) {
          const chunkSize = 128;
          const chunk = noisySignal.slice(processed, Math.min(processed + chunkSize, noisySignal.length));
          const paddedChunk = new Float32Array(chunkSize);
          paddedChunk.set(chunk);
          
          processor.process([[paddedChunk]], [[new Float32Array(chunkSize)]]);
          processed += chunkSize;
        }
        
        try {
          const decodedData = await demodPromise;
          const actualData = decodedData.slice(0, originalData.length);
          
          if (snrDb >= 10) {
            // Should decode correctly at higher SNR
            expect(actualData).toEqual(originalData);
          }
          // At lower SNR, may have errors but should not crash
          expect(decodedData).toBeDefined();
        } catch (error) {
          // At very low SNR, might fail to decode
          expect(snrDb).toBeLessThan(5);
        }
      }
    });

    test('should handle phase jumps and discontinuities', async () => {
      const { DsssDpskFramer } = await import('../../src/modems/dsss-dpsk/framer.js');
      const modem = await import('../../src/modems/dsss-dpsk/dsss-dpsk.js');
      
      const framer = new DsssDpskFramer();
      const testData = new Uint8Array([0x55, 0xAA]); // Alternating bits
      const dataFrame = framer.build(testData, { sequenceNumber: 0, frameType: 0, ldpcNType: 0 });
      
      const chips = modem.dsssSpread(dataFrame.bits, 31, 21);
      const phases = modem.dpskModulate(chips);
      const signal = modem.modulateCarrier(phases, 23, 44100, 10000);
      
      // Introduce phase jumps at random positions
      const phaseJumps = 5;
      const jumpPositions = new Set<number>();
      while (jumpPositions.size < phaseJumps) {
        jumpPositions.add(Math.floor(Math.random() * signal.length));
      }
      
      const distortedSignal = new Float32Array(signal);
      for (const pos of jumpPositions) {
        // Add π phase jump
        for (let i = pos; i < Math.min(pos + 100, signal.length); i++) {
          distortedSignal[i] = -distortedSignal[i];
        }
      }
      
      // Process distorted signal
      let processed = 0;
      while (processed < distortedSignal.length) {
        const chunkSize = 128;
        const chunk = distortedSignal.slice(processed, Math.min(processed + chunkSize, distortedSignal.length));
        const paddedChunk = new Float32Array(chunkSize);
        paddedChunk.set(chunk);
        
        processor.process([[paddedChunk]], [[new Float32Array(chunkSize)]]);
        processed += chunkSize;
      }
      
      // Should handle phase jumps without crashing
      expect(processor.demodulator).toBeDefined();
    });
  });

  describe('Frame Boundary Integrity', () => {
    test('should correctly decode frames split at worst-case boundaries', async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31, samplesPerPhase: 23 } }
      });
      
      const { DsssDpskFramer } = await import('../../src/modems/dsss-dpsk/framer.js');
      const modem = await import('../../src/modems/dsss-dpsk/dsss-dpsk.js');
      
      const framer = new DsssDpskFramer();
      
      // Test multiple frames with different data patterns
      const testPatterns = [
        new Uint8Array([0x00, 0x00]), // All zeros
        new Uint8Array([0xFF, 0xFF]), // All ones
        new Uint8Array([0x55, 0xAA]), // Alternating
        new Uint8Array([0x12, 0x34, 0x56, 0x78]) // Sequential
      ];
      
      for (const pattern of testPatterns) {
        await processor.reset();
        processor['resetAbortController']();
        
        const dataFrame = framer.build(pattern, { sequenceNumber: 0, frameType: 0, ldpcNType: 0 });
        const chips = modem.dsssSpread(dataFrame.bits, 31, 21); // Using seed 21 to match processor default
        const phases = modem.dpskModulate(chips);
        const signal = modem.modulateCarrier(phases, 23, 44100, 10000);
        
        // Process with worst-case chunk boundaries (prime numbers)
        const chunkSizes = [7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47];
        let processed = 0;
        let chunkIndex = 0;
        
        const demodPromise = processor.demodulate({ signal: processor['abortController'].signal });
        
        while (processed < signal.length) {
          const chunkSize = chunkSizes[chunkIndex % chunkSizes.length];
          const actualSize = Math.min(chunkSize, signal.length - processed);
          
          const chunk = new Float32Array(chunkSize);
          for (let i = 0; i < actualSize; i++) {
            chunk[i] = signal[processed + i];
          }
          
          processor.process([[chunk]], [[new Float32Array(chunkSize)]]);
          processed += actualSize;
          chunkIndex++;
        }
        
        try {
          const decodedData = await demodPromise;
          const actualData = decodedData.slice(0, pattern.length);
          expect(actualData).toEqual(pattern);
        } catch (error) {
          // Log which pattern failed
          console.error(`Failed to decode pattern: ${Array.from(pattern)}`);
          throw error;
        }
      }
    });

    test('should handle back-to-back frames correctly', async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31, samplesPerPhase: 23 } }
      });
      
      const { DsssDpskFramer } = await import('../../src/modems/dsss-dpsk/framer.js');
      const modem = await import('../../src/modems/dsss-dpsk/dsss-dpsk.js');
      
      const framer = new DsssDpskFramer();
      
      // Test with 2 frames to debug multi-frame issue
      const frames = [
        { data: new Uint8Array([0x01]), seq: 0 },
        { data: new Uint8Array([0x02]), seq: 1 }
      ];
      
      // Combine all signals with minimal gap
      let combinedSignal = new Float32Array(0);
      
      for (const frame of frames) {
        const dataFrame = framer.build(frame.data, { 
          sequenceNumber: frame.seq, 
          frameType: 0, 
          ldpcNType: 0 
        });
        
        const chips = modem.dsssSpread(dataFrame.bits, 31, 21); // Using seed 21 to match processor default
        const phases = modem.dpskModulate(chips);
        const signal = modem.modulateCarrier(phases, 23, 44100, 10000);
        
        // Add small gap between frames (1000 samples = ~22.7ms at 44.1kHz)
        const gapSamples = 1000;
        const gap = new Float32Array(gapSamples); // Silent gap
        
        const newSignal = new Float32Array(combinedSignal.length + signal.length + gapSamples);
        newSignal.set(combinedSignal);
        newSignal.set(signal, combinedSignal.length);
        newSignal.set(gap, combinedSignal.length + signal.length);
        
        console.log(`Frame ${frame.seq}: data=${Array.from(frame.data)}, signal length=${signal.length}`);
        
        combinedSignal = newSignal;
      }
      
      // Process the combined signal
      const receivedFrames: Uint8Array[] = [];
      
      // Set up multiple demodulation promises
      let processed = 0;
      let chunkCount = 0;
      while (processed < combinedSignal.length) {
        const chunkSize = 128;
        const chunk = combinedSignal.slice(processed, Math.min(processed + chunkSize, combinedSignal.length));
        const paddedChunk = new Float32Array(chunkSize);
        paddedChunk.set(chunk);
        
        processor.process([[paddedChunk]], [[new Float32Array(chunkSize)]]);
        chunkCount++;
        
        // Check if new frames are available
        const prevFrameCount = receivedFrames.length;
        while (processor.decodedDataBuffer.length > receivedFrames.length) {
          const frameData = processor.decodedDataBuffer[receivedFrames.length];
          receivedFrames.push(frameData);
          console.log(`[Chunk ${chunkCount}] Frame ${receivedFrames.length} decoded: ${Array.from(frameData.slice(0, 3))}`);
        }
        
        // Log framer state periodically
        if (chunkCount % 10 === 0 || receivedFrames.length > prevFrameCount) {
          const framerState = processor.framer.getState();
          console.log(`[Chunk ${chunkCount}] Framer: ${framerState.state}, buffer=${framerState.bufferLength}, processed=${framerState.processedBits}`);
        }
        
        processed += chunkSize;
      }
      
      // Process additional samples to ensure all frames are decoded
      // The demodulator might need extra samples after the last frame
      let additionalChunks = 0;
      for (let k = 0; k < 10; k++) {
        const extraChunk = new Float32Array(128);
        // Add low noise
        for (let j = 0; j < 128; j++) {
          extraChunk[j] = (Math.random() - 0.5) * 0.01;
        }
        processor.process([[extraChunk]], [[new Float32Array(128)]]);
        additionalChunks++;
        
        // Check if new frames are available
        while (processor.decodedDataBuffer.length > receivedFrames.length) {
          const frameData = processor.decodedDataBuffer[receivedFrames.length];
          receivedFrames.push(frameData);
        }
        
        // Stop if we have all frames
        if (receivedFrames.length >= frames.length) {
          break;
        }
      }
      
      // Debug info
      console.log(`Expected frames: ${frames.length}, Received frames: ${receivedFrames.length}`);
      console.log(`Combined signal length: ${combinedSignal.length} samples`);
      console.log(`Processed samples: ${processed}`);
      console.log(`Additional chunks processed: ${additionalChunks}`);
      for (let i = 0; i < receivedFrames.length; i++) {
        console.log(`Frame ${i}: ${Array.from(receivedFrames[i].slice(0, 5))}`);
      }
      
      // Check processor state
      const syncState = processor.demodulator.getSyncState();
      console.log(`Final sync state: locked=${syncState.locked}, correlation=${syncState.correlation}`);
      console.log(`Decoded buffer length: ${processor.decodedDataBuffer.length}`);
      
      // Get framer state for debugging
      const framerState = processor.framer.getState();
      console.log(`Final framer state: ${framerState.state}, bufferLength=${framerState.bufferLength}, processedBits=${framerState.processedBits}`);
      
      // Verify all frames were received
      expect(receivedFrames.length).toBeGreaterThanOrEqual(frames.length);
      
      // Verify frame data (accounting for FEC padding)
      for (let i = 0; i < frames.length && i < receivedFrames.length; i++) {
        const actualData = receivedFrames[i].slice(0, frames[i].data.length);
        expect(actualData).toEqual(frames[i].data);
      }
    });
  });

  describe('Performance and Memory', () => {
    test('should maintain consistent processing time', async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31, samplesPerPhase: 23 } }
      });
      
      const chunkSize = 128;
      const iterations = 100;
      const processingTimes: number[] = [];
      
      // Warm up
      for (let i = 0; i < 10; i++) {
        processor.process([[new Float32Array(chunkSize)]], [[new Float32Array(chunkSize)]]);
      }
      
      // Measure processing times
      for (let i = 0; i < iterations; i++) {
        const input = new Float32Array(chunkSize);
        // Add varying signal
        for (let j = 0; j < chunkSize; j++) {
          input[j] = Math.sin(2 * Math.PI * 10000 * (i * chunkSize + j) / 44100) * 0.5;
        }
        
        const start = performance.now();
        processor.process([[input]], [[new Float32Array(chunkSize)]]);
        const end = performance.now();
        
        processingTimes.push(end - start);
      }
      
      // Calculate statistics
      const avgTime = processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length;
      const maxTime = Math.max(...processingTimes);
      const minTime = Math.min(...processingTimes);
      
      // Performance should be consistent
      expect(maxTime).toBeLessThan(avgTime * 5); // Max should not be more than 5x average
      expect(minTime).toBeGreaterThan(avgTime * 0.2); // Min should not be less than 20% of average
      
      // Average processing time should be reasonable (< 5ms for 128 samples)
      expect(avgTime).toBeLessThan(5);
    });

    test('should not leak memory during extended operation', async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31, samplesPerPhase: 23 } }
      });
      
      const { DsssDpskFramer } = await import('../../src/modems/dsss-dpsk/framer.js');
      const modem = await import('../../src/modems/dsss-dpsk/dsss-dpsk.js');
      
      // Generate test signal
      const framer = new DsssDpskFramer();
      const testData = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
      const dataFrame = framer.build(testData, { sequenceNumber: 0, frameType: 0, ldpcNType: 0 });
      
      const chips = modem.dsssSpread(dataFrame.bits, 31, 21);
      const phases = modem.dpskModulate(chips);
      const signal = modem.modulateCarrier(phases, 23, 44100, 10000);
      
      // Process the same signal multiple times
      const repetitions = 50;
      
      for (let rep = 0; rep < repetitions; rep++) {
        // Reset for each repetition
        await processor.reset();
        processor['resetAbortController']();
        
        let processed = 0;
        while (processed < signal.length) {
          const chunkSize = 128;
          const chunk = signal.slice(processed, Math.min(processed + chunkSize, signal.length));
          const paddedChunk = new Float32Array(chunkSize);
          paddedChunk.set(chunk);
          
          processor.process([[paddedChunk]], [[new Float32Array(chunkSize)]]);
          processed += chunkSize;
        }
        
        // Buffer sizes should remain bounded
        expect(processor.decodedDataBuffer.length).toBeLessThan(10);
      }
      
      // Final state should be clean
      await processor.reset();
      expect(processor.decodedDataBuffer.length).toBe(0);
      expect(processor.pendingModulation).toBe(null);
    });
  });

  describe('Edge Cases', () => {
    test('should handle rapid modulation/demodulation switches', async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31 } }
      });
      
      // Rapidly switch between modulation and demodulation
      for (let i = 0; i < 10; i++) {
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
        
        // Reset and switch mode
        await processor.reset();
      }
      
      // Should remain stable
      expect(processor.demodulator).toBeDefined();
    });

    test('should handle extremely long frames', async () => {
      await sendMessage({
        id: 'config',
        type: 'configure',
        data: { config: { sequenceLength: 31, samplesPerPhase: 23 } }
      });
      
      const { DsssDpskFramer } = await import('../../src/modems/dsss-dpsk/framer.js');
      const modem = await import('../../src/modems/dsss-dpsk/dsss-dpsk.js');
      
      // Create maximum size frame within current FEC limits (7 bytes for BCH_63_56_1)
      const longData = new Uint8Array(7);
      for (let i = 0; i < longData.length; i++) {
        longData[i] = i & 0xFF;
      }
      
      const framer = new DsssDpskFramer();
      const dataFrame = framer.build(longData, { sequenceNumber: 0, frameType: 0, ldpcNType: 0 });
      
      const chips = modem.dsssSpread(dataFrame.bits, 31, 21);
      const phases = modem.dpskModulate(chips);
      const signal = modem.modulateCarrier(phases, 23, 44100, 10000);
      
      console.log(`Long frame signal length: ${signal.length} samples`);
      
      // Process the very long signal
      let processed = 0;
      const startTime = performance.now();
      
      while (processed < signal.length) {
        const chunkSize = 128;
        const remaining = signal.length - processed;
        const actualChunkSize = Math.min(chunkSize, remaining);
        const chunk = signal.slice(processed, processed + actualChunkSize);
        const paddedChunk = new Float32Array(chunkSize);
        paddedChunk.set(chunk);
        
        processor.process([[paddedChunk]], [[new Float32Array(chunkSize)]]);
        processed += actualChunkSize;
        
        // Prevent infinite loops
        if (performance.now() - startTime > 30000) { // 30 second timeout
          throw new Error('Processing took too long');
        }
      }
      
      // Should complete without timeout
      expect(processed).toBe(signal.length);
    });
  });
});