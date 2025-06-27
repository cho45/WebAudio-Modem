// FSK False Positive Detection Tests - Node.js compatible
import { describe, test, expect, beforeEach } from 'vitest';
import { FSKCore, FSKConfig, DEFAULT_FSK_CONFIG } from '../../src/modems/fsk';

describe('FSK False Positive Detection Tests', () => {
  let fskCore: FSKCore;
  
  beforeEach(() => {
    fskCore = new FSKCore();
    fskCore.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
  });

  describe('No Signal Tests', () => {
    test('zero signal should not produce any data', async () => {
      // Create 4000 samples of complete silence
      const zeroSignal = new Float32Array(4000).fill(0);
      
      const result = await fskCore.demodulateData(zeroSignal);
      
      console.log(`Zero signal test: ${result.length} bytes demodulated`);
      if (result.length > 0) {
        console.log(`Unexpected data: [${Array.from(result).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
      }
      
      expect(result.length).toBe(0);
    });

    test('DC signal should not produce any data', async () => {
      // Create 4000 samples of constant DC offset
      const dcSignal = new Float32Array(4000).fill(0.5);
      
      const result = await fskCore.demodulateData(dcSignal);
      
      console.log(`DC signal test: ${result.length} bytes demodulated`);
      if (result.length > 0) {
        console.log(`Unexpected data: [${Array.from(result).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
      }
      
      expect(result.length).toBe(0);
    });

    test('negative DC signal should not produce any data', async () => {
      // Create 4000 samples of negative DC offset
      const negDcSignal = new Float32Array(4000).fill(-0.3);
      
      const result = await fskCore.demodulateData(negDcSignal);
      
      console.log(`Negative DC signal test: ${result.length} bytes demodulated`);
      if (result.length > 0) {
        console.log(`Unexpected data: [${Array.from(result).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
      }
      
      expect(result.length).toBe(0);
    });

    test('long silence should not produce any data', async () => {
      // Create 12000 samples (longer than typical preamble) of silence
      const longSilence = new Float32Array(12000).fill(0);
      
      const result = await fskCore.demodulateData(longSilence);
      
      console.log(`Long silence test: ${result.length} bytes demodulated`);
      if (result.length > 0) {
        console.log(`Unexpected data: [${Array.from(result).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
      }
      
      expect(result.length).toBe(0);
    });
  });

  describe('Non-FSK Signal Tests', () => {
    test('single frequency outside FSK range should not produce data', async () => {
      const config = fskCore.getConfig();
      const testFreq = 2000; // Outside mark (1650) and space (1850) range
      const numSamples = 8000;
      
      const singleFreqSignal = new Float32Array(numSamples);
      const omega = 2 * Math.PI * testFreq / config.sampleRate;
      for (let i = 0; i < numSamples; i++) {
        singleFreqSignal[i] = Math.sin(omega * i);
      }
      
      const result = await fskCore.demodulateData(singleFreqSignal);
      
      console.log(`Single frequency (${testFreq}Hz) test: ${result.length} bytes demodulated`);
      if (result.length > 0) {
        console.log(`Unexpected data: [${Array.from(result).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
      }
      
      expect(result.length).toBe(0);
    });

    test('random noise should not produce valid data', async () => {
      const numSamples = 8000;
      const randomSignal = new Float32Array(numSamples);
      
      // Generate random noise
      for (let i = 0; i < numSamples; i++) {
        randomSignal[i] = (Math.random() - 0.5) * 2; // Range -1 to 1
      }
      
      const result = await fskCore.demodulateData(randomSignal);
      
      console.log(`Random noise test: ${result.length} bytes demodulated`);
      if (result.length > 0) {
        console.log(`Unexpected data: [${Array.from(result).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
      }
      
      // Random noise might occasionally match preamble pattern by chance,
      // but it should be extremely rare
      expect(result.length).toBeLessThanOrEqual(1);
    });

    test('alternating high-low signal should not produce valid data', async () => {
      const numSamples = 8000;
      const alternatingSignal = new Float32Array(numSamples);
      
      // Create alternating high-low pattern (like square wave)
      for (let i = 0; i < numSamples; i++) {
        alternatingSignal[i] = i % 2 === 0 ? 1.0 : -1.0;
      }
      
      const result = await fskCore.demodulateData(alternatingSignal);
      
      console.log(`Alternating signal test: ${result.length} bytes demodulated`);
      if (result.length > 0) {
        console.log(`Unexpected data: [${Array.from(result).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
      }
      
      expect(result.length).toBe(0);
    });
  });

  describe('Partial Preamble-like Signals', () => {
    test('incomplete preamble pattern should not trigger detection', async () => {
      const config = fskCore.getConfig();
      const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
      
      // Generate only first half of preamble pattern
      const preambleByte = config.preamblePattern[0]; // Usually 0x55
      const incompleteBits: number[] = [];
      
      // Only generate first 4 bits of the preamble byte
      for (let bit = 7; bit >= 4; bit--) {
        incompleteBits.push((preambleByte >> bit) & 1);
      }
      
      const incompleteSignal = new Float32Array(incompleteBits.length * samplesPerBit);
      let sampleIndex = 0;
      let phase = 0;
      
      for (const bit of incompleteBits) {
        const frequency = bit === 1 ? config.markFrequency : config.spaceFrequency;
        for (let i = 0; i < samplesPerBit; i++) {
          incompleteSignal[sampleIndex] = Math.sin(phase);
          phase += 2 * Math.PI * frequency / config.sampleRate;
          sampleIndex++;
        }
      }
      
      const result = await fskCore.demodulateData(incompleteSignal);
      
      console.log(`Incomplete preamble test: ${result.length} bytes demodulated`);
      if (result.length > 0) {
        console.log(`Unexpected data: [${Array.from(result).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
      }
      
      expect(result.length).toBe(0);
    });

    test('wrong preamble pattern should not trigger detection', async () => {
      const config = fskCore.getConfig();
      const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
      
      // Generate signal with wrong preamble pattern (0xAA instead of 0x55)
      const wrongPreamble = 0xAA;
      const wrongBits: number[] = [];
      
      // Convert wrong preamble to bits
      for (let bit = 7; bit >= 0; bit--) {
        wrongBits.push((wrongPreamble >> bit) & 1);
      }
      
      const wrongSignal = new Float32Array(wrongBits.length * samplesPerBit);
      let sampleIndex = 0;
      let phase = 0;
      
      for (const bit of wrongBits) {
        const frequency = bit === 1 ? config.markFrequency : config.spaceFrequency;
        for (let i = 0; i < samplesPerBit; i++) {
          wrongSignal[sampleIndex] = Math.sin(phase);
          phase += 2 * Math.PI * frequency / config.sampleRate;
          sampleIndex++;
        }
      }
      
      const result = await fskCore.demodulateData(wrongSignal);
      
      console.log(`Wrong preamble test: ${result.length} bytes demodulated`);
      if (result.length > 0) {
        console.log(`Unexpected data: [${Array.from(result).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
      }
      
      expect(result.length).toBe(0);
    });
  });

  describe('Multiple Demodulation Calls', () => {
    test('repeated zero signal calls should not accumulate false data', async () => {
      const zeroSignal = new Float32Array(4000).fill(0);
      
      // Call demodulation multiple times
      for (let i = 0; i < 3; i++) {
        const result = await fskCore.demodulateData(zeroSignal);
        
        console.log(`Zero signal call ${i + 1}: ${result.length} bytes demodulated`);
        if (result.length > 0) {
          console.log(`Unexpected data: [${Array.from(result).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
        }
        
        expect(result.length).toBe(0);
      }
    });

    test('mixed no-signal and valid signal should work correctly', async () => {
      // First: no signal
      const zeroSignal = new Float32Array(4000).fill(0);
      const noSignalResult = await fskCore.demodulateData(zeroSignal);
      expect(noSignalResult.length).toBe(0);
      
      // Then: valid signal
      const validData = new Uint8Array([0x48]); // 'H'
      const validSignal = await fskCore.modulateData(validData);
      const validResult = await fskCore.demodulateData(validSignal);
      
      console.log(`Valid signal after no-signal: ${validResult.length} bytes demodulated`);
      expect(validResult.length).toBeGreaterThan(0);
      
      // Should contain our valid data
      const validBytes = Array.from(validResult);
      expect(validBytes).toContain(0x48);
    });
  });
});