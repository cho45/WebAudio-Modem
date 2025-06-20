// FSK SFD (Start Frame Delimiter) tests - Node.js compatible
import { describe, test, expect, beforeEach } from 'vitest';
import { FSKCore, FSKConfig, DEFAULT_FSK_CONFIG } from '../../src/modems/fsk';

describe('FSK SFD (Start Frame Delimiter) Tests', () => {
  let fskCore: FSKCore;
  
  beforeEach(() => {
    fskCore = new FSKCore();
    fskCore.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
  });
  
  describe('SFD Configuration', () => {
    test('default SFD pattern is included in configuration', async () => {
      const config = fskCore.getConfig();
      
      expect(config.sfdPattern).toBeDefined();
      expect(config.sfdPattern).toEqual([0x7E]); // Default SFD pattern
      expect(config.preamblePattern).toEqual([0x55, 0x55]); // Preamble still present
    });
    
    test('custom SFD pattern can be configured', async () => {
      const customConfig: FSKConfig = {
        ...DEFAULT_FSK_CONFIG,
        sfdPattern: [0xF0, 0x0F] // Custom two-byte SFD
      } as FSKConfig;
      
      fskCore.configure(customConfig);
      const appliedConfig = fskCore.getConfig();
      
      expect(appliedConfig.sfdPattern).toEqual([0xF0, 0x0F]);
    });
  });
  
  describe('0x55 User Data Transmission', () => {
    test('can transmit single 0x55 byte as user data', async () => {
      const userData = new Uint8Array([0x55]); // Same as preamble pattern
      
      const modulatedSignal = await fskCore.modulateData(userData);
      expect(modulatedSignal.length).toBeGreaterThan(0);
      
      const demodulatedData = await fskCore.demodulateData(modulatedSignal);
      
      // Should recover the user data correctly, distinguished from preamble
      expect(demodulatedData.length).toBe(1);
      expect(demodulatedData[0]).toBe(0x55);
    });
    
    test('can transmit multiple 0x55 bytes as user data', async () => {
      const userData = new Uint8Array([0x55, 0x55, 0x55]); // Multiple preamble-like bytes
      
      const modulatedSignal = await fskCore.modulateData(userData);
      const demodulatedData = await fskCore.demodulateData(modulatedSignal);
      
      expect(demodulatedData.length).toBe(3);
      expect(demodulatedData[0]).toBe(0x55);
      expect(demodulatedData[1]).toBe(0x55);
      expect(demodulatedData[2]).toBe(0x55);
    });
    
    test('mixed data including 0x55 is transmitted correctly', async () => {
      const userData = new Uint8Array([0x48, 0x55, 0x65, 0x55, 0x6C]); // "H" + 0x55 + "e" + 0x55 + "l"
      
      const modulatedSignal = await fskCore.modulateData(userData);
      const demodulatedData = await fskCore.demodulateData(modulatedSignal);
      
      expect(demodulatedData.length).toBe(5);
      expect(Array.from(demodulatedData)).toEqual([0x48, 0x55, 0x65, 0x55, 0x6C]);
    });
  });
  
  describe('SFD Pattern Transmission', () => {
    test('can transmit SFD pattern (0x7E) as user data', async () => {
      const userData = new Uint8Array([0x7E]); // Same as default SFD pattern
      
      const modulatedSignal = await fskCore.modulateData(userData);
      const demodulatedData = await fskCore.demodulateData(modulatedSignal);
      
      // Should recover the SFD byte as user data
      expect(demodulatedData.length).toBe(1);
      expect(demodulatedData[0]).toBe(0x7E);
    });
    
    test('mixed data including both 0x55 and 0x7E', async () => {
      const userData = new Uint8Array([0x55, 0x7E, 0x48, 0x55, 0x7E]); // Mix of preamble and SFD patterns
      
      const modulatedSignal = await fskCore.modulateData(userData);
      const demodulatedData = await fskCore.demodulateData(modulatedSignal);
      
      expect(demodulatedData.length).toBe(5);
      expect(Array.from(demodulatedData)).toEqual([0x55, 0x7E, 0x48, 0x55, 0x7E]);
    });
  });
  
  describe('Frame Structure Verification', () => {
    test('signal structure includes preamble + SFD + data', async () => {
      const userData = new Uint8Array([0x48]); // Simple test data
      const config = fskCore.getConfig();
      
      const modulatedSignal = await fskCore.modulateData(userData);
      
      // Calculate expected signal structure
      const bitsPerByte = 8 + config.startBits + config.stopBits;
      const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
      
      // Expected: preamble (2 bytes) + SFD (1 byte) + data (1 byte) + padding
      const totalBytes = config.preamblePattern.length + config.sfdPattern.length + userData.length;
      const paddingSamples = samplesPerBit * 2; // 2 bits worth of padding
      const silenceSamples = samplesPerBit * bitsPerByte; // Silence after data
      const expectedLength = totalBytes * bitsPerByte * samplesPerBit + paddingSamples + silenceSamples;
      
      expect(modulatedSignal.length).toBe(expectedLength);
    });
    
    test('longer data transmission with SFD', async () => {
      const userData = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
      
      const modulatedSignal = await fskCore.modulateData(userData);
      const demodulatedData = await fskCore.demodulateData(modulatedSignal);
      
      expect(demodulatedData.length).toBe(5);
      expect(Array.from(demodulatedData)).toEqual([0x48, 0x65, 0x6C, 0x6C, 0x6F]);
    });
  });
  
  describe('SFD vs Preamble Distinction', () => {
    test('preamble pattern in data does not cause false sync', async () => {
      // This test verifies that 0x55 in user data doesn't trigger false frame detection
      const userData = new Uint8Array([0x55, 0x55, 0x48]); // Preamble-like pattern followed by data
      
      const modulatedSignal = await fskCore.modulateData(userData);
      const demodulatedData = await fskCore.demodulateData(modulatedSignal);
      
      // Should receive exactly the user data, not multiple detections
      expect(demodulatedData.length).toBe(3);
      expect(Array.from(demodulatedData)).toEqual([0x55, 0x55, 0x48]);
    });
    
    test('multiple transmissions are distinguished correctly', async () => {
      // Test that multiple frames can be sent and each has proper SFD detection
      const userData1 = new Uint8Array([0x55]);
      const userData2 = new Uint8Array([0x48]);
      
      const signal1 = await fskCore.modulateData(userData1);
      const signal2 = await fskCore.modulateData(userData2);
      
      const result1 = await fskCore.demodulateData(signal1);
      // fskCore.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
      const result2 = await fskCore.demodulateData(signal2);
      
      expect([...result1]).toEqual([0x55]);
      expect([...result2]).toEqual([0x48]);
    });
  });
  
  describe('Error Cases', () => {
    test('empty data with SFD structure', async () => {
      const emptyData = new Uint8Array([]);
      
      const modulatedSignal = await fskCore.modulateData(emptyData);
      expect(modulatedSignal.length).toBeGreaterThan(0); // Should contain preamble + SFD
      
      const demodulatedData = await fskCore.demodulateData(modulatedSignal);
      expect(demodulatedData.length).toBe(0); // No user data
    });
  });
});
