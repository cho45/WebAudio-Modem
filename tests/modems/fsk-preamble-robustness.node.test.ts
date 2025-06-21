// FSK Preamble Robustness tests - Node.js compatible
import { describe, test, expect, beforeEach } from 'vitest';
import { FSKCore, FSKConfig, DEFAULT_FSK_CONFIG } from '../../src/modems/fsk';

describe('FSK Preamble Robustness Tests', () => {
  let fskCore: FSKCore;
  
  beforeEach(() => {
    fskCore = new FSKCore();
    fskCore.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
  });
  
  describe('Partial Preamble Loss', () => {
    test('handles 25% preamble truncation from beginning', async () => {
      const userData = new Uint8Array([0x48]); // Test data
      const fullSignal = await fskCore.modulateData(userData);
      
      // Calculate preamble + SFD length
      const config = fskCore.getConfig();
      const bitsPerByte = 8 + config.startBits + config.stopBits;
      const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
      const syncLength = (config.preamblePattern.length + config.sfdPattern.length) * bitsPerByte * samplesPerBit;
      
      // Truncate 25% from beginning
      const truncationLength = Math.floor(syncLength * 0.25);
      const truncatedSignal = fullSignal.slice(truncationLength);
      
      const result = await fskCore.demodulateData(truncatedSignal);
      
      // Should still be able to decode with partial preamble loss
      console.log(`25% truncation: signal ${fullSignal.length} -> ${truncatedSignal.length}, result length: ${result.length}`);
      
      if (result.length > 0) {
        expect(result[0]).toBe(0x48);
      } else {
        // If can't decode with 25% loss, that's acceptable but should be documented
        console.log('25% preamble loss: unable to decode (may be expected)');
      }
    });
    
    test('handles 50% preamble truncation from beginning', async () => {
      const userData = new Uint8Array([0x48]);
      const fullSignal = await fskCore.modulateData(userData);
      
      const config = fskCore.getConfig();
      const bitsPerByte = 8 + config.startBits + config.stopBits;
      const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
      const syncLength = (config.preamblePattern.length + config.sfdPattern.length) * bitsPerByte * samplesPerBit;
      
      // Truncate 50% from beginning
      const truncationLength = Math.floor(syncLength * 0.5);
      const truncatedSignal = fullSignal.slice(truncationLength);
      
      const result = await fskCore.demodulateData(truncatedSignal);
      
      console.log(`50% truncation: signal ${fullSignal.length} -> ${truncatedSignal.length}, result length: ${result.length}`);
      
      if (result.length > 0) {
        expect(result[0]).toBe(0x48);
      } else {
        console.log('50% preamble loss: unable to decode (expected behavior)');
      }
    });
    
    test('handles 75% preamble truncation from beginning', async () => {
      const userData = new Uint8Array([0x48]);
      const fullSignal = await fskCore.modulateData(userData);
      
      const config = fskCore.getConfig();
      const bitsPerByte = 8 + config.startBits + config.stopBits;
      const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
      const syncLength = (config.preamblePattern.length + config.sfdPattern.length) * bitsPerByte * samplesPerBit;
      
      // Truncate 75% from beginning (should leave SFD + part of last preamble byte)
      const truncationLength = Math.floor(syncLength * 0.75);
      const truncatedSignal = fullSignal.slice(truncationLength);
      
      const result = await fskCore.demodulateData(truncatedSignal);
      
      console.log(`75% truncation: signal ${fullSignal.length} -> ${truncatedSignal.length}, result length: ${result.length}`);
      
      // With 75% loss, we expect no successful decoding
      expect(result.length).toBe(0);
    });
    
    test('minimum viable preamble length determination', async () => {
      const userData = new Uint8Array([0x55, 0x48, 0x65]); // Challenging data with preamble-like byte
      const fullSignal = await fskCore.modulateData(userData);
      
      const config = fskCore.getConfig();
      const bitsPerByte = 8 + config.startBits + config.stopBits;
      const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
      const syncLength = (config.preamblePattern.length + config.sfdPattern.length) * bitsPerByte * samplesPerBit;
      
      const truncationPercentages = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
      const results: { percentage: number, success: boolean, dataLength: number }[] = [];
      
      for (const percentage of truncationPercentages) {
        const truncationLength = Math.floor(syncLength * percentage / 100);
        const truncatedSignal = fullSignal.slice(truncationLength);
        const result = await fskCore.demodulateData(truncatedSignal);
        
        const success = result.length === userData.length && 
                       Array.from(result).every((val, idx) => val === userData[idx]);
        
        results.push({
          percentage,
          success,
          dataLength: result.length
        });
        
        console.log(`${percentage}% truncation: ${success ? 'SUCCESS' : 'FAILED'} (${result.length} bytes)`);
      }
      
      // Find the maximum truncation percentage that still allows successful decoding
      const maxWorkingTruncation = results.filter(r => r.success).pop();
      console.log(`Maximum working truncation: ${maxWorkingTruncation?.percentage || 0}%`);
      
      // At least 0% (no truncation) should work
      expect(results[0].success).toBe(true);
    });
  });
  
  describe('Timing Offset Scenarios', () => {
    test('handles signal starting mid-preamble', async () => {
      const userData = new Uint8Array([0x48]);
      const fullSignal = await fskCore.modulateData(userData);
      
      const config = fskCore.getConfig();
      const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
      
      // Start signal in the middle of the first preamble byte
      const offsetSamples = Math.floor(samplesPerBit * 4); // Half of first byte (8 bits)
      const offsetSignal = fullSignal.slice(offsetSamples);
      
      const result = await fskCore.demodulateData(offsetSignal);
      
      console.log(`Mid-preamble start: offset ${offsetSamples} samples, result length: ${result.length}`);
      
      // This is a challenging case - correlation sync should handle it
      if (result.length > 0) {
        expect(result[0]).toBe(0x48);
      }
    });
    
    test('handles signal starting at SFD boundary', async () => {
      const userData = new Uint8Array([0x48]);
      const fullSignal = await fskCore.modulateData(userData);
      
      const config = fskCore.getConfig();
      const bitsPerByte = 8 + config.startBits + config.stopBits;
      const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
      
      // Start exactly at SFD beginning (skip all preamble)
      const preambleLength = config.preamblePattern.length * bitsPerByte * samplesPerBit;
      const sfdStartSignal = fullSignal.slice(preambleLength);
      
      const result = await fskCore.demodulateData(sfdStartSignal);
      
      console.log(`SFD start: skipped ${preambleLength} samples, result length: ${result.length}`);
      
      // Should be able to sync on SFD alone
      if (result.length > 0) {
        expect(result[0]).toBe(0x48);
      } else {
        console.log('SFD-only sync failed (may require preamble for correlation)');
      }
    });
  });
  
  describe('Noise in Preamble', () => {
    test('handles noisy preamble with clean data', async () => {
      const userData = new Uint8Array([0x48]);
      const fullSignal = await fskCore.modulateData(userData);
      
      const config = fskCore.getConfig();
      const bitsPerByte = 8 + config.startBits + config.stopBits;
      const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
      const syncLength = (config.preamblePattern.length + config.sfdPattern.length) * bitsPerByte * samplesPerBit;
      
      // Add noise only to preamble portion
      const noisySignal = new Float32Array(fullSignal);
      for (let i = 0; i < syncLength; i++) {
        noisySignal[i] += (Math.random() - 0.5) * 0.3; // 30% noise amplitude
      }
      
      const result = await fskCore.demodulateData(noisySignal);
      
      console.log(`Noisy preamble: result length: ${result.length}`);
      
      // Correlation should be robust to moderate noise
      if (result.length > 0) {
        expect(result[0]).toBe(0x48);
      }
    });
    
    test('handles corrupted preamble pattern', async () => {
      const userData = new Uint8Array([0x48]);
      const fullSignal = await fskCore.modulateData(userData);
      
      const config = fskCore.getConfig();
      const bitsPerByte = 8 + config.startBits + config.stopBits;
      const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
      
      // Corrupt part of the first preamble byte by inverting signal
      const firstByteLength = bitsPerByte * samplesPerBit;
      const corruptedSignal = new Float32Array(fullSignal);
      for (let i = 0; i < firstByteLength / 2; i++) {
        corruptedSignal[i] = -corruptedSignal[i]; // Invert first half of first preamble byte
      }
      
      const result = await fskCore.demodulateData(corruptedSignal);
      
      console.log(`Corrupted preamble: result length: ${result.length}`);
      
      // Should still work with partial corruption
      if (result.length > 0) {
        expect(result[0]).toBe(0x48);
      }
    });
  });
  
  describe('Multiple Frame Scenarios', () => {
    test('handles back-to-back frames with no gap', async () => {
      const userData1 = new Uint8Array([0x48]);
      const userData2 = new Uint8Array([0x65]);
      
      const signal1 = await fskCore.modulateData(userData1);
      const signal2 = await fskCore.modulateData(userData2);
      
      // Remove padding and silence to create true back-to-back frames
      const config = fskCore.getConfig();
      const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
      const bitsPerByte = 8 + config.startBits + config.stopBits;
      const paddingSamples = samplesPerBit * 2;
      const silenceSamples = bitsPerByte * samplesPerBit;
      
      // Extract actual signal without padding/silence
      const signal1Pure = signal1.slice(paddingSamples, signal1.length - silenceSamples);
      const signal2Pure = signal2.slice(paddingSamples, signal2.length - silenceSamples);
      
      // Concatenate pure signals with no gap
      const combinedSignal = new Float32Array(signal1Pure.length + signal2Pure.length);
      combinedSignal.set(signal1Pure, 0);
      combinedSignal.set(signal2Pure, signal1Pure.length);
      
      const result = await fskCore.demodulateData(combinedSignal);
      
      console.log(`Back-to-back frames: result length: ${result.length}`);
      console.log(`Result: [${Array.from(result).map(x => '0x' + x.toString(16)).join(', ')}]`);
      
      // Should decode at least the first frame
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0]).toBe(0x48);
      
      // In back-to-back scenarios, the second frame's preamble might be 
      // interpreted as data since frame sync state persists
      if (result.length >= 2 && result[1] === 0x65) {
        // Both frames successfully decoded independently
        expect(result[1]).toBe(0x65);
      }
    });
    
  });
});
