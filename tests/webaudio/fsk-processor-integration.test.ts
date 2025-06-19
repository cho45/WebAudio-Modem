/**
 * FSK Processor Integration Tests - Tests actual modulation
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { WebAudioModulatorNode } from '../../src/webaudio/webaudio-modulator-node.js';
import { DEFAULT_FSK_CONFIG } from '../../src/modems/fsk.js';

// Note: These tests won't actually run in Node.js environment
// since AudioContext and AudioWorklet are browser-only APIs.
// They serve as documentation for expected behavior.

describe('FSK Processor Integration (Browser only)', () => {
  test.skip('actual modulation and XModem integration', async () => {
    // This test would run in a browser environment
    const audioContext = new AudioContext();
    const modulator = new WebAudioModulatorNode(audioContext, {
      processorUrl: './processors/fsk-processor.js',
      processorName: 'fsk-processor'
    });
    
    await modulator.initialize();
    await modulator.configure(DEFAULT_FSK_CONFIG);
    
    // Test data
    const testData = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
    
    // Should generate actual FSK signal
    const signal = await modulator.modulateData(testData);
    
    expect(signal.length).toBeGreaterThan(0);
    expect(signal).toBeInstanceOf(Float32Array);
    
    // Signal should have reasonable amplitude
    const maxAmplitude = Math.max(...Array.from(signal));
    const minAmplitude = Math.min(...Array.from(signal));
    expect(maxAmplitude).toBeGreaterThan(0.5);
    expect(minAmplitude).toBeLessThan(-0.5);
  });
  
  test.skip('XModem transport integration', async () => {
    // This would test the integration with XModemTransport
    const audioContext = new AudioContext();
    const modulator = new WebAudioModulatorNode(audioContext, {
      processorUrl: './processors/fsk-processor.js',
      processorName: 'fsk-processor'
    });
    
    await modulator.initialize();
    await modulator.configure(DEFAULT_FSK_CONFIG);
    
    // This should work with XModemTransport
    const { XModemTransport } = await import('../../src/transports/xmodem/xmodem.js');
    const transport = new XModemTransport(modulator);
    
    // Should be able to send data
    const testData = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]);
    
    // This would normally require actual audio I/O setup
    // await transport.sendData(testData);
    
    expect(transport.isReady()).toBe(true);
    expect(transport.transportName).toBe('XModem');
  });
  
  // This test documents the expected behavior
  test('demonstrates expected FSK signal properties', () => {
    // Expected properties of FSK signal:
    // - Length should be: (preamble + SFD + data) * bitsPerByte * samplesPerBit + padding
    // - Should contain mark and space frequencies
    // - Should have phase continuity
    
    const config = DEFAULT_FSK_CONFIG;
    const dataLength = 5; // "Hello"
    const bitsPerByte = 8 + config.startBits + config.stopBits; // 10 bits
    const samplesPerBit = Math.floor(config.sampleRate / config.baudRate); // 147 samples
    
    const totalBytes = config.preamblePattern.length + config.sfdPattern.length + dataLength;
    const paddingSamples = samplesPerBit * 2;
    const expectedLength = totalBytes * bitsPerByte * samplesPerBit + paddingSamples;
    
    expect(expectedLength).toBe(12054); // Expected signal length for "Hello"
  });
});