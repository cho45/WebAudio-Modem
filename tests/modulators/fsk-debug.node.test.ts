// FSK Core debugging tests - find where the demodulation fails
import { describe, test, expect, beforeEach } from 'vitest';
import { FSKCore, FSKConfig, DEFAULT_FSK_CONFIG } from '../../src/modulators/fsk';

describe('FSK Core Debug', () => {
  let fskCore: FSKCore;
  
  beforeEach(() => {
    fskCore = new FSKCore();
    fskCore.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
  });
  
  test('debug single byte modulation-demodulation pipeline', () => {
    const originalData = new Uint8Array([0x48]); // 'H'
    
    // Step 1: Modulate data
    const modulatedSignal = fskCore.modulateData(originalData);
    console.log('Modulated signal length:', modulatedSignal.length);
    console.log('Modulated signal sample values (first 10):', 
                Array.from(modulatedSignal.slice(0, 10)).map(x => x.toFixed(3)));
    
    // Check modulated signal is reasonable
    expect(modulatedSignal.length).toBeGreaterThan(1000); // Should have substantial length
    
    // Get max/min values
    const maxVal = Math.max(...modulatedSignal);
    const minVal = Math.min(...modulatedSignal);
    console.log('Modulated signal range:', minVal.toFixed(3), 'to', maxVal.toFixed(3));
    
    // Signal should have both positive and negative values (FSK)
    expect(maxVal).toBeGreaterThan(0.1);
    expect(minVal).toBeLessThan(-0.1);
    
    // Step 2: Try demodulation
    const demodulatedData = fskCore.demodulateData(modulatedSignal);
    console.log('Demodulated data length:', demodulatedData.length);
    console.log('Demodulated data:', Array.from(demodulatedData).map(x => '0x' + x.toString(16)));
    
    // For debugging, let's see if we can at least get some data back
    expect(demodulatedData).toBeInstanceOf(Uint8Array);
  });
  
  test('verify preamble pattern in modulated signal', () => {
    const originalData = new Uint8Array([0x48]);
    const modulatedSignal = fskCore.modulateData(originalData);
    
    // Check that the signal starts with a recognizable pattern
    // The first part should be the preamble pattern (0x55, 0x55)
    
    const config = fskCore.getConfig();
    console.log('Config preamble pattern:', config.preamblePattern.map(x => '0x' + x.toString(16)));
    console.log('Config frequencies - mark:', config.markFrequency, 'space:', config.spaceFrequency);
    console.log('Config baud rate:', config.baudRate);
    console.log('Config sample rate:', config.sampleRate);
    
    const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
    console.log('Samples per bit:', samplesPerBit);
    
    // The preamble should be the first part of the signal
    const preambleLength = config.preamblePattern.length * 8 * samplesPerBit; // 2 bytes * 8 bits * samples per bit
    console.log('Expected preamble length in samples:', preambleLength);
    
    expect(modulatedSignal.length).toBeGreaterThan(preambleLength);
  });
  
  test('check if correlation sync can find preamble in perfect signal', () => {
    // Create a simple test with just the preamble pattern
    const config = fskCore.getConfig();
    const preambleData = new Uint8Array(config.preamblePattern);
    
    console.log('Testing with preamble only:', Array.from(preambleData).map(x => '0x' + x.toString(16)));
    
    const preambleSignal = fskCore.modulateData(preambleData);
    console.log('Preamble signal length:', preambleSignal.length);
    
    const demodulatedPreamble = fskCore.demodulateData(preambleSignal);
    console.log('Demodulated preamble length:', demodulatedPreamble.length);
    console.log('Demodulated preamble:', Array.from(demodulatedPreamble).map(x => '0x' + x.toString(16)));
    
    // Should be able to decode the preamble pattern
    expect(demodulatedPreamble.length).toBeGreaterThan(0);
  });
  
  test('understand the encoding format', () => {
    const config = fskCore.getConfig();
    
    console.log('=== UNDERSTANDING ENCODING ===');
    console.log('Preamble pattern:', Array.from(config.preamblePattern).map(x => '0x' + x.toString(16)));
    
    // Test 1: What modulateData([0x55, 0x55]) actually produces
    const preambleInput = new Uint8Array([0x55, 0x55]);
    const preambleSignal = fskCore.modulateData(preambleInput);
    const demodPreamble = fskCore.demodulateData(preambleSignal);
    
    console.log('Input [0x55, 0x55] -> actual data sent:');
    console.log('- Preamble added: [0x55, 0x55]');
    console.log('- User data: [0x55, 0x55]');  
    console.log('- Total: [0x55, 0x55, 0x55, 0x55] (4 bytes)');
    console.log('Signal length:', preambleSignal.length);
    console.log('Demodulated length:', demodPreamble.length);
    console.log('Demodulated:', Array.from(demodPreamble).map(x => '0x' + x.toString(16)));
    
    // Test 2: What modulateData([0x48]) actually produces  
    const dataInput = new Uint8Array([0x48]);
    const dataSignal = fskCore.modulateData(dataInput);
    const demodData = fskCore.demodulateData(dataSignal);
    
    console.log('Input [0x48] -> actual data sent:');
    console.log('- Preamble added: [0x55, 0x55]');
    console.log('- User data: [0x48]');
    console.log('- Total: [0x55, 0x55, 0x48] (3 bytes)');
    console.log('Signal length:', dataSignal.length);
    console.log('Demodulated length:', demodData.length);
    console.log('Demodulated:', Array.from(demodData).map(x => '0x' + x.toString(16)));
    
    // Test 3: Try with 2 data bytes to match preamble length
    const twoByteInput = new Uint8Array([0x48, 0x65]);
    const twoByteSignal = fskCore.modulateData(twoByteInput);
    const demodTwoByte = fskCore.demodulateData(twoByteSignal);
    
    console.log('Input [0x48, 0x65] -> actual data sent:');
    console.log('- Preamble added: [0x55, 0x55]');
    console.log('- User data: [0x48, 0x65]');
    console.log('- Total: [0x55, 0x55, 0x48, 0x65] (4 bytes)');
    console.log('Signal length:', twoByteSignal.length);
    console.log('Demodulated length:', demodTwoByte.length);
    console.log('Demodulated:', Array.from(demodTwoByte).map(x => '0x' + x.toString(16)));
    
    // All should produce some output
    expect(demodPreamble.length).toBeGreaterThan(0);
    
    // Check if longer signals work better
    expect(twoByteSignal.length).toBeGreaterThan(dataSignal.length);
    
    // The key insight: 2-byte signals should work, 1-byte signals should fail
    expect(demodTwoByte.length).toBeGreaterThan(0); // Should work
    // demodData.length can be 0 (that's expected for 1-byte inputs)
  });
});