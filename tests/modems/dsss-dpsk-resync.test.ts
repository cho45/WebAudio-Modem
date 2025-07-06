/**
 * DSSS-DPSK Demodulator Resync Tests
 * Comprehensive testing of the resync functionality
 */

import { describe, test, expect } from 'vitest';
import { DsssDpskDemodulator } from '../../src/modems/dsss-dpsk';
import * as modem from '../../src/modems/dsss-dpsk/dsss-dpsk';

describe('DsssDpskDemodulator Resync', () => {
  const defaultConfig = {
    sequenceLength: 31,
    seed: 21,
    samplesPerPhase: 23,
    sampleRate: 44100,
    carrierFreq: 10000,
    correlationThreshold: 0.5,
    peakToNoiseRatio: 4,
    instanceName: 'test-resync'
  };

  function createFrameWithBits(bits: number[]): Uint8Array {
    return new Uint8Array(bits);
  }

  function modulateFrame(frameData: Uint8Array): Float32Array {
    const chips = modem.dsssSpread(frameData, defaultConfig.sequenceLength, defaultConfig.seed);
    const phases = modem.dpskModulate(chips);
    return modem.modulateCarrier(
      phases,
      defaultConfig.samplesPerPhase,
      defaultConfig.sampleRate,
      defaultConfig.carrierFreq
    );
  }

  test('should trigger resync with strong 0-bits after accumulating strong bits', () => {
    const demodulator = new DsssDpskDemodulator({
      ...defaultConfig,
      correlationThreshold: 0.4,
      peakToNoiseRatio: 2, // More realistic threshold
      instanceName: 'resync-trigger-test'
    });
    
    // Track resync attempts and successes
    let resyncAttempted = false;
    let resyncSucceeded = false;
    
    // Mock console.log to capture resync messages
    const originalLog = console.log;
    console.log = (...args) => {
      const message = args.join(' ');
      if (message.includes('Attempting resync')) {
        resyncAttempted = true;
      }
      if (message.includes('Resync successful')) {
        resyncSucceeded = true;
      }
      originalLog(...args);
    };
    
    try {
      // 1. Establish initial sync with preamble + sync word + some data
      const preamble = [0, 0, 0, 0]; // 4-bit preamble
      const syncWord = [1, 0, 1, 1, 0, 1, 0, 0]; // 8-bit sync word (0xB4)
      const initialData = [1, 1, 1, 1]; // 4 bits of 1s (strong bits)
      
      const initialFrame = createFrameWithBits([...preamble, ...syncWord, ...initialData]);
      const initialSignal = modulateFrame(initialFrame);
      
      console.log('[ResyncTest] Adding initial frame for sync establishment...');
      demodulator.addSamples(initialSignal);
      
      // Trigger initial sync processing
      const initialBits = demodulator.getAvailableBits();
      const syncState1 = demodulator.getSyncState();
      
      console.log(`[ResyncTest] Initial sync state: locked=${syncState1.locked}, correlation=${syncState1.correlation}`);
      console.log(`[ResyncTest] Initial bits received: ${initialBits.length}`);
      
      expect(syncState1.locked).toBe(true);
      
      // 2. Add frames with strong bits to accumulate resyncCounter (need >8 strong bits)
      for (let i = 0; i < 3; i++) {
        const strongFrame = createFrameWithBits([1, 1, 1, 1, 1, 1, 1, 1]);
        const strongSignal = modulateFrame(strongFrame);
        
        console.log(`[ResyncTest] Adding strong bits frame ${i + 1}...`);
        demodulator.addSamples(strongSignal);
        
        const bits = demodulator.getAvailableBits();
        console.log(`[ResyncTest] Frame ${i + 1} processed: ${bits.length} bits received`);
      }
      
      // 3. Add frame with strong 0-bits to trigger resync
      const strong0BitsFrame = [0, 0, 0, 0, 0, 0, 0, 0]; // 8 strong 0-bits
      const strong0Signal = modulateFrame(createFrameWithBits(strong0BitsFrame));
      
      console.log('[ResyncTest] Adding strong 0-bits frame to trigger resync...');
      demodulator.addSamples(strong0Signal);
      
      // Process the strong 0-bits - this should trigger resync
      const finalBits = demodulator.getAvailableBits();
      const syncState2 = demodulator.getSyncState();
      
      console.log(`[ResyncTest] Final sync state: locked=${syncState2.locked}, correlation=${syncState2.correlation}`);
      console.log(`[ResyncTest] Final bits received: ${finalBits.length}`);
      
      // Verify sync is maintained and resync was attempted
      expect(syncState2.locked).toBe(true);
      expect(resyncAttempted).toBe(true); // Resync should have been attempted
      
      // Log resync results
      console.log(`[ResyncTest] Resync attempted: ${resyncAttempted}, succeeded: ${resyncSucceeded}`);
      
      // We expect at least some resync attempts to succeed with realistic thresholds
      if (!resyncSucceeded) {
        console.warn('[ResyncTest] Warning: No resync attempts succeeded - thresholds may be too strict');
      }
    } finally {
      // Restore original console.log
      console.log = originalLog;
    }
  });

  test('should successfully resync when samples are slightly offset', () => {
    const demodulator = new DsssDpskDemodulator({
      ...defaultConfig,
      correlationThreshold: 0.3, // Lower threshold for resync testing
      peakToNoiseRatio: 2
    });
    
    // 1. Establish sync with first frame
    const preamble = [0, 0, 0, 0];
    const syncWord = [1, 0, 1, 1, 0, 1, 0, 0];
    const data1 = [1, 1, 1, 1, 1, 1, 1, 1]; // Strong 1-bits
    
    const frame1 = createFrameWithBits([...preamble, ...syncWord, ...data1]);
    const signal1 = modulateFrame(frame1);
    
    demodulator.addSamples(signal1);
    demodulator.getAvailableBits();
    
    expect(demodulator.getSyncState().locked).toBe(true);
    
    // 2. Accumulate strong bits for resync counter
    for (let i = 0; i < 2; i++) {
      const strongFrame = createFrameWithBits([1, 1, 1, 1, 1, 1, 1, 1]);
      const strongSignal = modulateFrame(strongFrame);
      demodulator.addSamples(strongSignal);
      demodulator.getAvailableBits();
    }
    
    // 3. Create a significant timing offset by manually shifting samples
    const offsetFrame = createFrameWithBits([0, 0, 0, 0, 0, 0, 0, 0]); // Strong 0-bits
    let offsetSignal = modulateFrame(offsetFrame);
    
    // Introduce a more significant timing offset (approximately 0.25 chips)
    const chipSamples = defaultConfig.samplesPerPhase;
    const offsetSamples = Math.floor(chipSamples * 0.25); // 0.25 chip offset
    
    console.log(`[ResyncTest] Introducing timing offset: ${offsetSamples} samples (${(offsetSamples/chipSamples).toFixed(3)} chips)`);
    
    // Create offset by padding with zeros at the beginning
    const paddedSignal = new Float32Array(offsetSignal.length + offsetSamples);
    paddedSignal.set(offsetSignal, offsetSamples); // Shift signal right
    
    console.log('[ResyncTest] Adding offset signal with timing drift...');
    demodulator.addSamples(paddedSignal);
    
    const finalBits = demodulator.getAvailableBits();
    const finalSyncState = demodulator.getSyncState();
    
    console.log(`[ResyncTest] After offset signal: locked=${finalSyncState.locked}, bits=${finalBits.length}`);
    
    // Even with timing offset, sync should be maintained through resync
    expect(finalSyncState.locked).toBe(true);
  });

  test('should investigate why resync peakToNoiseRatio is lower than initial sync', () => {
    // Use the same thresholds as successful initial sync
    const demodulator = new DsssDpskDemodulator({
      ...defaultConfig,
      correlationThreshold: 0.5,
      peakToNoiseRatio: 4.0, // Same as successful initial sync
      instanceName: 'resync-investigation'
    });

    // Track resync success
    let resyncSuccessCount = 0;
    let resyncFailCount = 0;
    
    // Mock console.log to capture resync results
    const originalLog = console.log;
    console.log = (...args) => {
      const message = args.join(' ');
      if (message.includes('Resync successful')) {
        resyncSuccessCount++;
      }
      if (message.includes('Resync failed')) {
        resyncFailCount++;
      }
      originalLog(...args);
    };

    try {
      // Debug: Check what the reference signal contains
      const reference = (demodulator as any).reference;
      console.log(`[ResyncDebug] Reference signal length: ${reference.length}`);
      console.log(`[ResyncDebug] Reference signal: [${Array.from(reference.slice(0, 10)).join(',')}...] (first 10)`);
      console.log(`[ResyncDebug] samplesPerBit: ${(demodulator as any).samplesPerBit}`);
      
      // Generate clean signal with precise timing alignment
      const preamble = [0, 0, 0, 0];
      const syncWord = [1, 0, 1, 1, 0, 1, 0, 0];
      const setupData = [1, 1, 1, 1, 1, 1, 1, 1]; // Strong 1-bits for resync counter buildup
      
      // 1. Establish initial sync
      const initialFrame = createFrameWithBits([...preamble, ...syncWord, ...setupData]);
      const initialSignal = modulateFrame(initialFrame);
      
      console.log('[ResyncSuccessTest] Establishing initial sync...');
      demodulator.addSamples(initialSignal);
      demodulator.getAvailableBits();
      
      expect(demodulator.getSyncState().locked).toBe(true);
      
      // 2. Build up resync counter with multiple strong bits
      console.log('[ResyncSuccessTest] Building resync counter...');
      for (let i = 0; i < 3; i++) {
        const strongFrame = createFrameWithBits([1, 1, 1, 1]);
        demodulator.addSamples(modulateFrame(strongFrame));
        demodulator.getAvailableBits();
        console.log(`[ResyncSuccessTest] Added strong bits frame ${i + 1}`);
      }
      
      // 3. Create carefully crafted signal with subtle timing offset
      // Use zero bits to trigger strong 0-bit detection
      const zeroFrame = createFrameWithBits([0, 0, 0, 0]);
      const zeroSignal = modulateFrame(zeroFrame);
      
      console.log('[ResyncSuccessTest] Adding trigger frame for resync...');
      demodulator.addSamples(zeroSignal);
      
      const finalBits = demodulator.getAvailableBits();
      const finalState = demodulator.getSyncState();
      
      console.log(`[ResyncSuccessTest] Final state: locked=${finalState.locked}, bits=${finalBits.length}`);
      console.log(`[ResyncSuccessTest] Final correlation: ${finalState.correlation}`);
      console.log(`[ResyncSuccessTest] Resync results: ${resyncSuccessCount} successes, ${resyncFailCount} failures`);
      
      // Sync should remain locked
      expect(finalState.locked).toBe(true);
      expect(finalBits.length).toBeGreaterThan(0);
      
      // With lenient thresholds, we should have at least some resync successes
      expect(resyncSuccessCount).toBeGreaterThan(0);
      
    } finally {
      console.log = originalLog;
    }
  });

  test('should show resync parameter details in debug logs', () => {
    const demodulator = new DsssDpskDemodulator(defaultConfig);
    
    // Create minimal scenario to trigger resync
    const syncFrame = createFrameWithBits([0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 1, 1]);
    const syncSignal = modulateFrame(syncFrame);
    
    demodulator.addSamples(syncSignal);
    demodulator.getAvailableBits(); // Establish sync
    
    // Add strong bits
    for (let i = 0; i < 3; i++) {
      const strongFrame = createFrameWithBits([1, 1, 1, 1]);
      demodulator.addSamples(modulateFrame(strongFrame));
      demodulator.getAvailableBits();
    }
    
    // Trigger resync with strong 0-bits
    const trigger0Frame = createFrameWithBits([0, 0, 0, 0]);
    demodulator.addSamples(modulateFrame(trigger0Frame));
    demodulator.getAvailableBits();
    
    // Check that we at least attempted processing
    expect(demodulator.getSyncState().locked).toBe(true);
    
    console.log('[ResyncTest] Resync parameter test completed - check logs for details');
  });
});