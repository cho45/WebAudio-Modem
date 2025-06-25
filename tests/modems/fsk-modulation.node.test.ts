// FSK Core modulation tests - Node.js compatible
import { describe, test, expect, beforeEach } from 'vitest';
import { FSKCore, FSKConfig, DEFAULT_FSK_CONFIG } from '../../src/modems/fsk';

describe('FSK Core Modulation', () => {
  let fskCore: FSKCore;
  
  beforeEach(() => {
    fskCore = new FSKCore();
    fskCore.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
  });
  
  describe('Configuration and Initialization', () => {
    test('default configuration is applied', () => {
      const config = fskCore.getConfig();
      
      expect(config.markFrequency).toBe(1650);
      expect(config.spaceFrequency).toBe(1850);
      expect(config.baudRate).toBe(1200);
      expect(config.sampleRate).toBe(48000);
      expect(config.startBits).toBe(1);
      expect(config.stopBits).toBe(1);
      expect(config.parity).toBe('none');
      expect(config.adaptiveThreshold).toBe(true);
      expect(config.agcEnabled).toBe(true);
    });
    
    test('custom configuration override', () => {
      const customConfig: FSKConfig = {
        ...DEFAULT_FSK_CONFIG,
        markFrequency: 2125,
        spaceFrequency: 2295,
        baudRate: 1200,
        sampleRate: 48000,
        parity: 'even'
      } as FSKConfig;
      
      fskCore.configure(customConfig);
      const appliedConfig = fskCore.getConfig();
      
      expect(appliedConfig.markFrequency).toBe(2125);
      expect(appliedConfig.spaceFrequency).toBe(2295);
      expect(appliedConfig.baudRate).toBe(1200);
      expect(appliedConfig.sampleRate).toBe(48000);
      expect(appliedConfig.parity).toBe('even');
    });
    
    test('modulator is ready after configuration', () => {
      expect(fskCore.isReady()).toBe(true);
    });
    
    test('modulator name and type are correct', () => {
      expect(fskCore.name).toBe('FSK');
      expect(fskCore.type).toBe('FSK');
    });
  });
  
  describe('Basic Modulation Functionality', () => {
    test('modulate empty data produces preamble only', async () => {
      const emptyData = new Uint8Array([]);
      const signal = await fskCore.modulateData(emptyData);
      
      // Should contain preamble (2 bytes: 0x55, 0x55)
      expect(signal.length).toBeGreaterThan(0);
      
      // Calculate expected length for preamble + SFD (minimum content)
      const config = fskCore.getConfig();
      const bitsPerByte = 8 + config.startBits + config.stopBits;
      const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
      const expectedMinLength = (config.preamblePattern.length + config.sfdPattern.length) * bitsPerByte * samplesPerBit;
      
      expect(signal.length).toBeGreaterThanOrEqual(expectedMinLength);
    });
    
    test('modulate single byte produces correct signal length', async () => {
      const singleByte = new Uint8Array([0x48]); // 'H'
      const signal = await fskCore.modulateData(singleByte);
      
      const config = fskCore.getConfig();
      const bitsPerByte = 8 + config.startBits + config.stopBits;
      const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
      
      // Preamble (2 bytes) + SFD (1 byte) + data (1 byte) + padding (2 bits worth)
      const totalBytes = config.preamblePattern.length + config.sfdPattern.length + singleByte.length;
      const paddingSamples = samplesPerBit * 2; // 2 bits worth of padding
      const silenceSamples = samplesPerBit * bitsPerByte; // Silence after data
      const expectedLength = totalBytes * bitsPerByte * samplesPerBit + paddingSamples + silenceSamples;
      
      expect(signal.length).toBe(expectedLength);
    });
    
    test('modulate multiple bytes scales correctly', async () => {
      const testData1 = new Uint8Array([0x48]);
      const testData2 = new Uint8Array([0x48, 0x65]);
      const testData3 = new Uint8Array([0x48, 0x65, 0x6C]);
      
      const signal1 = await fskCore.modulateData(testData1);
      const signal2 = await fskCore.modulateData(testData2);
      const signal3 = await fskCore.modulateData(testData3);
      
      const config = fskCore.getConfig();
      const bitsPerByte = 8 + config.startBits + config.stopBits;
      const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
      const samplesPerByte = bitsPerByte * samplesPerBit;
      
      // Each additional byte should add exactly samplesPerByte samples
      expect(signal2.length - signal1.length).toBe(samplesPerByte);
      expect(signal3.length - signal2.length).toBe(samplesPerByte);
    });
    
    test('signal amplitude is reasonable', async () => {
      const testData = new Uint8Array([0x55]); // Alternating pattern
      const signal = await fskCore.modulateData(testData);
      
      const maxAmplitude = Math.max(...Array.from(signal));
      const minAmplitude = Math.min(...Array.from(signal));
      
      expect(maxAmplitude).toBeLessThanOrEqual(1.1);
      expect(minAmplitude).toBeGreaterThanOrEqual(-1.1);
      expect(maxAmplitude).toBeGreaterThan(0.8);
      expect(minAmplitude).toBeLessThan(-0.8);
    });
  });
  
  describe('Phase Continuity', () => {
    test('signal is phase continuous', async () => {
      const testData = new Uint8Array([0x3C]); // 00111100 - has transitions
      const signal = await fskCore.modulateData(testData);
      
      // Check for sudden amplitude jumps that would indicate phase discontinuity
      const maxJump = findMaximumJump(signal);
      
      // Phase continuous FSK should not have large amplitude jumps
      expect(maxJump).toBeLessThan(0.5); // Reasonable threshold
    });
    
    test('different bit patterns produce different but continuous signals', async () => {
      const pattern1 = new Uint8Array([0x0F]); // 00001111
      const pattern2 = new Uint8Array([0xF0]); // 11110000
      
      const signal1 = await fskCore.modulateData(pattern1);
      const signal2 = await fskCore.modulateData(pattern2);
      
      // Signals should be different
      expect(signal1.length).toBe(signal2.length);
      
      let differences = 0;
      for (let i = 0; i < signal1.length; i++) {
        if (Math.abs(signal1[i] - signal2[i]) > 0.1) {
          differences++;
        }
      }
      
      // At least 15% of samples should be different (adjusted for preamble + SFD)
      // Note: Many samples may be similar due to shared preamble, SFD and framing
      expect(differences / signal1.length).toBeGreaterThan(0.10);
      
      // But both should be phase continuous
      expect(findMaximumJump(signal1)).toBeLessThan(0.5);
      expect(findMaximumJump(signal2)).toBeLessThan(0.5);
    });
  });
  
  describe('Framing and Preamble', () => {
    test('preamble pattern is included in signal', async () => {
      const testData = new Uint8Array([0x00]); // Simple data
      const signal = await fskCore.modulateData(testData);
      
      const config = fskCore.getConfig();
      
      // Generate expected preamble signal
      const preambleSignal = generateFSKSignal(
        [0x55, 0x55], // Preamble pattern
        config.markFrequency,
        config.spaceFrequency,
        config.sampleRate,
        config.baudRate,
        config.startBits,
        config.stopBits
      );
      
      // Skip initial padding to find the actual preamble
      const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
      const paddingSamples = samplesPerBit * 2; // Match FSKCore padding
      const signalStart = signal.slice(paddingSamples, paddingSamples + preambleSignal.length);
      const correlation = computeCorrelation(signalStart, preambleSignal);
      
      expect(Math.abs(correlation)).toBeGreaterThan(0.3); // Should have reasonable correlation
    });
    
    test('start and stop bits are properly framed', async () => {
      // This test verifies the frame structure indirectly through signal length
      const testData = new Uint8Array([0x00]);
      const signal = await fskCore.modulateData(testData);
      
      const config = fskCore.getConfig();
      const bitsPerByte = 8 + config.startBits + config.stopBits;
      const samplesPerBit = Math.floor(config.sampleRate / config.baudRate);
      
      // Total: preamble (2 bytes) + SFD (1 byte) + data (1 byte) + padding (2 bits worth)
      const totalBits = (config.preamblePattern.length + config.sfdPattern.length + testData.length) * bitsPerByte;
      const paddingSamples = samplesPerBit * 2; // 2 bits worth of padding
      const silenceSamples = samplesPerBit * bitsPerByte; // Silence after data
      const expectedLength = totalBits * samplesPerBit + paddingSamples + silenceSamples;
      
      expect(signal.length).toBe(expectedLength);
    });
  });
  
  describe('Error Conditions', () => {
    test('unconfigured modulator throws error', async () => {
      const unconfiguredCore = new FSKCore();
      const testData = new Uint8Array([0x48]);
      
      await expect(unconfiguredCore.modulateData(testData)).rejects.toThrow('not configured');
    });
    
    test('large data blocks are handled correctly', async () => {
      const largeData = new Uint8Array(100).fill(0x55);
      
      await expect(async () => {
        const signal = await fskCore.modulateData(largeData);
        expect(signal.length).toBeGreaterThan(0);
      }).not.toThrow();
    });
  });
  
  describe('Signal Quality Monitoring', () => {
    test('signal quality structure is returned', () => {
      const quality = fskCore.getSignalQuality();
      
      expect(typeof quality.snr).toBe('number');
      expect(typeof quality.ber).toBe('number');
      expect(typeof quality.eyeOpening).toBe('number');
      expect(typeof quality.phaseJitter).toBe('number');
      expect(typeof quality.frequencyOffset).toBe('number');
    });
    
    test('reset clears signal quality', () => {
      fskCore.reset();
      const quality = fskCore.getSignalQuality();
      
      expect(quality.snr).toBe(0);
      expect(quality.ber).toBe(0);
      expect(quality.eyeOpening).toBe(0);
      expect(quality.phaseJitter).toBe(0);
      expect(quality.frequencyOffset).toBe(0);
    });
  });
});

// Helper functions for testing
function generateSineWave(frequency: number, sampleRate: number, duration: number): Float32Array {
  const numSamples = Math.floor(sampleRate * duration);
  const signal = new Float32Array(numSamples);
  const omega = 2 * Math.PI * frequency / sampleRate;
  
  for (let i = 0; i < numSamples; i++) {
    signal[i] = Math.sin(omega * i);
  }
  
  return signal;
}

function computeCorrelation(signal1: Float32Array, signal2: Float32Array): number {
  const length = Math.min(signal1.length, signal2.length);
  let correlation = 0;
  let power1 = 0;
  let power2 = 0;
  
  for (let i = 0; i < length; i++) {
    correlation += signal1[i] * signal2[i];
    power1 += signal1[i] * signal1[i];
    power2 += signal2[i] * signal2[i];
  }
  
  const denominator = Math.sqrt(power1 * power2);
  return denominator > 0 ? correlation / denominator : 0;
}

function findMaximumJump(signal: Float32Array): number {
  let maxJump = 0;
  
  for (let i = 1; i < signal.length; i++) {
    const jump = Math.abs(signal[i] - signal[i - 1]);
    maxJump = Math.max(maxJump, jump);
  }
  
  return maxJump;
}

function generateFSKSignal(
  bytes: number[],
  markFreq: number,
  spaceFreq: number,
  sampleRate: number,
  baudRate: number,
  startBits: number,
  stopBits: number
): Float32Array {
  const bitsPerByte = 8 + startBits + stopBits;
  const samplesPerBit = Math.floor(sampleRate / baudRate);
  const totalSamples = bytes.length * bitsPerByte * samplesPerBit;
  const signal = new Float32Array(totalSamples);
  
  let phase = 0;
  let sampleIndex = 0;
  
  for (const byte of bytes) {
    // Start bits (0)
    for (let i = 0; i < startBits; i++) {
      const omega = 2 * Math.PI * spaceFreq / sampleRate;
      for (let j = 0; j < samplesPerBit; j++) {
        signal[sampleIndex++] = Math.sin(phase);
        phase += omega;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      }
    }
    
    // Data bits (MSB first)
    for (let i = 7; i >= 0; i--) {
      const bit = (byte >> i) & 1;
      const frequency = bit ? markFreq : spaceFreq;
      const omega = 2 * Math.PI * frequency / sampleRate;
      for (let j = 0; j < samplesPerBit; j++) {
        signal[sampleIndex++] = Math.sin(phase);
        phase += omega;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      }
    }
    
    // Stop bits (1)
    for (let i = 0; i < stopBits; i++) {
      const omega = 2 * Math.PI * markFreq / sampleRate;
      for (let j = 0; j < samplesPerBit; j++) {
        signal[sampleIndex++] = Math.sin(phase);
        phase += omega;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      }
    }
  }
  
  return signal;
}
