// Debug test for 2-stage correlation sync
import { describe, test, expect, beforeEach } from 'vitest';
import { FSKCore, FSKConfig, DEFAULT_FSK_CONFIG } from '../../src/modulators/fsk';

describe('FSK 2-Stage Sync Debug', () => {
  let fskCore: FSKCore;
  
  beforeEach(() => {
    fskCore = new FSKCore();
    fskCore.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
  });
  
  test('debug 2-stage sync behavior with truncated signals', () => {
    const userData = new Uint8Array([0x48]);
    const fullSignal = fskCore.modulateData(userData);
    
    console.log(`Full signal length: ${fullSignal.length}`);
    
    const config = fskCore.getConfig();
    const bitsPerByte = 8 + config.startBits + config.stopBits;
    const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
    
    console.log(`Bits per byte: ${bitsPerByte}`);
    console.log(`Samples per bit: ${samplesPerBit}`);
    console.log(`Preamble pattern: [${config.preamblePattern.map(x => '0x' + x.toString(16)).join(', ')}]`);
    console.log(`SFD pattern: [${config.sfdPattern.map(x => '0x' + x.toString(16)).join(', ')}]`);
    
    // Calculate expected sync lengths
    const fullSyncLength = (config.preamblePattern.length + config.sfdPattern.length) * bitsPerByte * samplesPerBit;
    const minimalSyncLength = (1 + config.sfdPattern.length) * bitsPerByte * samplesPerBit;
    
    console.log(`Full sync length (preamble + SFD): ${fullSyncLength} samples`);
    console.log(`Minimal sync length (1 preamble + SFD): ${minimalSyncLength} samples`);
    
    // Test various truncation levels
    const truncationLevels = [0, 0.25, 0.33, 0.5];
    
    for (const level of truncationLevels) {
      const truncationSamples = Math.floor(fullSyncLength * level);
      const truncatedSignal = fullSignal.slice(truncationSamples);
      
      console.log(`\n=== Testing ${(level * 100).toFixed(0)}% truncation ===`);
      console.log(`Truncated ${truncationSamples} samples (${truncatedSignal.length} remaining)`);
      
      const result = fskCore.demodulateData(truncatedSignal);
      console.log(`Result: ${result.length} bytes`);
      
      if (result.length > 0) {
        console.log(`Decoded: [${Array.from(result).map(x => '0x' + x.toString(16)).join(', ')}]`);
      }
      
      // For 33% truncation, we should still have minimal sync pattern intact
      if (level <= 0.33) {
        const remainingSyncLength = fullSyncLength - truncationSamples;
        console.log(`Remaining sync length: ${remainingSyncLength} vs minimal required: ${minimalSyncLength}`);
        
        if (remainingSyncLength >= minimalSyncLength) {
          console.log('✅ Should be detectable with minimal pattern');
        } else {
          console.log('❌ Not enough sync pattern remaining');
        }
      }
    }
  });
  
  test('understand signal structure', () => {
    const userData = new Uint8Array([0x48]);
    const signal = fskCore.modulateData(userData);
    
    const config = fskCore.getConfig();
    const bitsPerByte = 8 + config.startBits + config.stopBits;
    const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
    
    console.log('\n=== Signal Structure Analysis ===');
    console.log(`Config: ${config.startBits} start + 8 data + ${config.stopBits} stop = ${bitsPerByte} bits per byte`);
    console.log(`Samples per bit: ${samplesPerBit}`);
    console.log(`Samples per byte: ${bitsPerByte * samplesPerBit}`);
    
    const preambleBytes = config.preamblePattern.length; // 2
    const sfdBytes = config.sfdPattern.length; // 1
    const dataBytes = userData.length; // 1
    const totalBytes = preambleBytes + sfdBytes + dataBytes; // 4
    
    console.log(`Preamble: ${preambleBytes} bytes`);
    console.log(`SFD: ${sfdBytes} bytes`);
    console.log(`Data: ${dataBytes} bytes`);
    console.log(`Total: ${totalBytes} bytes`);
    
    const expectedSamples = totalBytes * bitsPerByte * samplesPerBit + (samplesPerBit * 2); // +padding
    console.log(`Expected signal length: ${expectedSamples} samples`);
    console.log(`Actual signal length: ${signal.length} samples`);
    
    // Test minimal pattern detection on full signal
    console.log('\n=== Testing minimal pattern on full signal ===');
    const result = fskCore.demodulateData(signal);
    console.log(`Full signal result: ${result.length} bytes`);
  });
});