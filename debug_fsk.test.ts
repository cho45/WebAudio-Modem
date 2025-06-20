import { describe, test, expect } from 'vitest';
import { FSKCore } from './src/modems/fsk';

describe('FSK Debug', () => {
  test('debug single byte modulation/demodulation', async () => {
    const fsk = new FSKCore();
    
    fsk.configure({
      sampleRate: 48000,
      baudRate: 300,
      markFrequency: 1650,
      spaceFrequency: 1850,
      preamblePattern: [0xAA, 0xAA, 0xAA, 0xAA],
      sfdPattern: [0x55],
      startBits: 1,
      stopBits: 1,
      parity: 'none',
      syncThreshold: 0.6, // Lower threshold for testing
      agcEnabled: true,
      preFilterBandwidth: 800,
      adaptiveThreshold: false
    });

    console.log('Expected preamble+SFD pattern:');
    // 0xAA = 10101010, 0x55 = 01010101
    // With start(0) and stop(1) bits for each byte
    console.log('0xAA with framing: 0,0,1,0,1,0,1,0,1,1 (LSB first)');
    console.log('0x55 with framing: 0,1,0,1,0,1,0,1,0,1 (LSB first)');

    console.log('FSK configured');
    
    // Test simple single byte
    const testData = new Uint8Array([0x48]); // 'H'
    console.log('Original data:', Array.from(testData));
    
    // Modulate
    const signal = await fsk.modulateData(testData);
    console.log('Signal length:', signal.length);
    console.log('Signal first 20 samples:', Array.from(signal.slice(0, 20)));
    console.log('Signal has non-zero values:', signal.some(x => Math.abs(x) > 0.01));
    
    // Demodulate
    const result = await fsk.demodulateData(signal);
    console.log('Result length:', result.length);
    console.log('Result data:', Array.from(result));
    
    expect(signal.length).toBeGreaterThan(0);
  });
});