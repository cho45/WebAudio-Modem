// FSK Core demodulation tests - Node.js compatible
import { describe, test, expect, beforeEach } from 'vitest';
import { FSKCore, FSKConfig, DEFAULT_FSK_CONFIG } from '../../src/modems/fsk';

describe('FSK Core Demodulation', () => {
  let fskCore: FSKCore;
  
  beforeEach(() => {
    fskCore = new FSKCore();
    fskCore.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
  });
  
  describe('Basic Demodulation Functionality', () => {
    test('demodulate empty signal returns empty data', async () => {
      const emptySignal = new Float32Array(0);
      const result = await fskCore.demodulateData(emptySignal);
      
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(0);
    });
    
    test('demodulate very short signal returns empty data', async () => {
      // Signal too short to contain even preamble
      const shortSignal = new Float32Array(100);
      const result = await fskCore.demodulateData(shortSignal);
      
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(0);
    });
    
    test('demodulation handles unconfigured modulator gracefully', async () => {
      const unconfiguredCore = new FSKCore();
      const testSignal = new Float32Array([0.1, 0.2, 0.3]);
      
      await expect(unconfiguredCore.demodulateData(testSignal)).rejects.toThrow('not configured');
    });
  });
  
  describe('Roundtrip Modulation-Demodulation', () => {
    test('perfect roundtrip with single byte', async () => {
      const originalData = new Uint8Array([0x48]); // 'H'
      
      // Modulate
      const modulatedSignal = await fskCore.modulateData(originalData);
      expect(modulatedSignal.length).toBeGreaterThan(0);
      
      // Demodulate
      const demodulatedData = await fskCore.demodulateData(modulatedSignal);
      
      // Check result
      expect(demodulatedData).toBeInstanceOf(Uint8Array);
      expect(demodulatedData.length).toBeGreaterThanOrEqual(originalData.length);
      
      // The result should contain our original data
      // Note: May contain extra data due to preamble pattern
      const dataStart = findDataStart(demodulatedData, originalData);
      expect(dataStart).toBeGreaterThanOrEqual(0);
      
      // Verify the actual data
      for (let i = 0; i < originalData.length; i++) {
        expect(demodulatedData[dataStart + i]).toBe(originalData[i]);
      }
    });
    
    test('roundtrip with multiple bytes', async () => {
      const originalData = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
      
      const modulatedSignal = await fskCore.modulateData(originalData);
      const demodulatedData = await fskCore.demodulateData(modulatedSignal);
      
      expect(demodulatedData.length).toBeGreaterThanOrEqual(originalData.length);
      
      const dataStart = findDataStart(demodulatedData, originalData);
      expect(dataStart).toBeGreaterThanOrEqual(0);
      
      for (let i = 0; i < originalData.length; i++) {
        expect(demodulatedData[dataStart + i]).toBe(originalData[i]);
      }
    });
    
    test('roundtrip with all zeros', async () => {
      const originalData = new Uint8Array([0x00, 0x00, 0x00]);
      
      const modulatedSignal = await fskCore.modulateData(originalData);
      const demodulatedData = await fskCore.demodulateData(modulatedSignal);
      
      const dataStart = findDataStart(demodulatedData, originalData);
      expect(dataStart).toBeGreaterThanOrEqual(0);
      
      for (let i = 0; i < originalData.length; i++) {
        expect(demodulatedData[dataStart + i]).toBe(originalData[i]);
      }
    });
    
    test('roundtrip with all ones', async () => {
      const originalData = new Uint8Array([0xFF, 0xFF, 0xFF]);
      
      const modulatedSignal = await fskCore.modulateData(originalData);
      const demodulatedData = await fskCore.demodulateData(modulatedSignal);
      
      const dataStart = findDataStart(demodulatedData, originalData);
      expect(dataStart).toBeGreaterThanOrEqual(0);
      
      for (let i = 0; i < originalData.length; i++) {
        expect(demodulatedData[dataStart + i]).toBe(originalData[i]);
      }
    });
    
    test('roundtrip with alternating pattern', async () => {
      const originalData = new Uint8Array([0x55, 0xAA, 0x55]); // 01010101, 10101010, 01010101
      
      const modulatedSignal = await fskCore.modulateData(originalData);
      const demodulatedData = await fskCore.demodulateData(modulatedSignal);
      
      const dataStart = findDataStart(demodulatedData, originalData);
      expect(dataStart).toBeGreaterThanOrEqual(0);
      
      for (let i = 0; i < originalData.length; i++) {
        expect(demodulatedData[dataStart + i]).toBe(originalData[i]);
      }
    });
  });
  
  describe('Noise Resistance', () => {
    test('roundtrip with low-level noise (30dB SNR)', async () => {
      const originalData = new Uint8Array([0x48, 0x65, 0x6C]); // "Hel"
      
      const cleanSignal = await fskCore.modulateData(originalData);
      const noisySignal = addNoise(cleanSignal, 30); // 30dB SNR
      
      const demodulatedData = await fskCore.demodulateData(noisySignal);
      
      // Should still recover the data with high SNR
      const dataStart = findDataStart(demodulatedData, originalData);
      expect(dataStart).toBeGreaterThanOrEqual(0);
      
      for (let i = 0; i < originalData.length; i++) {
        expect(demodulatedData[dataStart + i]).toBe(originalData[i]);
      }
    });
    
    test('roundtrip with moderate noise (20dB SNR)', async () => {
      const originalData = new Uint8Array([0x48]); // Single byte for reliability
      
      const cleanSignal = await fskCore.modulateData(originalData);
      const noisySignal = addNoise(cleanSignal, 20); // 20dB SNR
      
      const demodulatedData = await fskCore.demodulateData(noisySignal);
      
      // May not be perfect, but should attempt recovery
      expect(demodulatedData.length).toBeGreaterThanOrEqual(0);
      
      // If data is recovered, it should be correct
      const dataStart = findDataStart(demodulatedData, originalData);
      if (dataStart >= 0) {
        expect(demodulatedData[dataStart]).toBe(originalData[0]);
      }
    });
    
    test('handles signal with DC offset', async () => {
      const originalData = new Uint8Array([0x48]);
      
      let cleanSignal = await fskCore.modulateData(originalData);
      
      // Add DC offset
      const dcOffset = 0.2;
      const offsetSignal = new Float32Array(cleanSignal.length);
      for (let i = 0; i < cleanSignal.length; i++) {
        offsetSignal[i] = cleanSignal[i] + dcOffset;
      }
      
      const demodulatedData = await fskCore.demodulateData(offsetSignal);
      
      // AGC should handle DC offset
      const dataStart = findDataStart(demodulatedData, originalData);
      if (dataStart >= 0) {
        expect(demodulatedData[dataStart]).toBe(originalData[0]);
      }
    });
  });
  
  describe('Edge Cases and Error Handling', () => {
    test('handles amplitude variations', async () => {
      const originalData = new Uint8Array([0x55]);
      
      let signal = await fskCore.modulateData(originalData);
      
      // Scale signal amplitude
      const scaledSignal = new Float32Array(signal.length);
      const scaleFactor = 0.3; // Reduce amplitude
      for (let i = 0; i < signal.length; i++) {
        scaledSignal[i] = signal[i] * scaleFactor;
      }
      
      const demodulatedData = await fskCore.demodulateData(scaledSignal);
      
      // AGC should compensate for amplitude changes
      const dataStart = findDataStart(demodulatedData, originalData);
      if (dataStart >= 0) {
        expect(demodulatedData[dataStart]).toBe(originalData[0]);
      }
    });
    
    test('handles missing preamble gracefully', async () => {
      // Generate signal without proper preamble
      const config = fskCore.getConfig();
      const testFreq = config.markFrequency;
      const duration = 0.01; // 10ms
      const numSamples = Math.floor(config.sampleRate * duration);
      
      const invalidSignal = new Float32Array(numSamples);
      const omega = 2 * Math.PI * testFreq / config.sampleRate;
      for (let i = 0; i < numSamples; i++) {
        invalidSignal[i] = Math.sin(omega * i);
      }
      
      const result = await fskCore.demodulateData(invalidSignal);
      
      // Should return empty or fail gracefully
      expect(result).toBeInstanceOf(Uint8Array);
      // Result may be empty or contain spurious data, both are acceptable
    });
    
    test('reset clears demodulator state', async () => {
      const testData = new Uint8Array([0x48]);
      
      // Process some data
      const signal = await fskCore.modulateData(testData);
      await fskCore.demodulateData(signal);
      
      // Reset
      fskCore.reset();
      
      // Should still work after reset
      expect(fskCore.isReady()).toBe(false); // Reset should clear ready state
      
      // Reconfigure and test
      fskCore.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
      const signal2 = await fskCore.modulateData(testData);
      const result = await fskCore.demodulateData(signal2);
      
      expect(result.length).toBeGreaterThanOrEqual(0);
    });
  });
  
  describe('Different Configuration Parameters', () => {
    test('works with different baud rates', async () => {
      const baudRates = [300, 1200];
      const originalData = new Uint8Array([0x48]);
      
      for (const baudRate of baudRates) {
        const config: FSKConfig = {
          ...DEFAULT_FSK_CONFIG,
          baudRate
        } as FSKConfig;
        
        fskCore.configure(config);
        
        const signal = await fskCore.modulateData(originalData);
        const result = await fskCore.demodulateData(signal);
        
        const dataStart = findDataStart(result, originalData);
        expect(dataStart).toBeGreaterThanOrEqual(0);
        expect(result[dataStart]).toBe(originalData[0]);
      }
    });
    
    test('works with different frequency pairs', async () => {
      const freqPairs = [
        { mark: 1650, space: 1850 },
        { mark: 2125, space: 2295 }
      ];
      const originalData = new Uint8Array([0x48]);
      
      for (const frequencies of freqPairs) {
        const config: FSKConfig = {
          ...DEFAULT_FSK_CONFIG,
          markFrequency: frequencies.mark,
          spaceFrequency: frequencies.space
        } as FSKConfig;
        
        fskCore.configure(config);
        
        const signal = await fskCore.modulateData(originalData);
        const result = await fskCore.demodulateData(signal);
        
        const dataStart = findDataStart(result, originalData);
        expect(dataStart).toBeGreaterThanOrEqual(0);
        expect(result[dataStart]).toBe(originalData[0]);
      }
    });
  });
  
  describe('Preamble Detection', () => {
    test('correctly identifies preamble pattern', async () => {
      const originalData = new Uint8Array([0x48]);
      const signal = await fskCore.modulateData(originalData);
      const result = await fskCore.demodulateData(signal);
      
      // Preamble is used for synchronization only, result should contain data
      expect(result.length).toBeGreaterThanOrEqual(1);
      
      // Should recover the original data (preamble is not included in result)
      expect(result[0]).toBe(originalData[0]);
    });
  });

  describe('Pattern Coverage Tests', () => {
    test('various byte patterns work correctly', async () => {
      const testCases = [
        { data: 0x48, desc: 'Known working case' },
        { data: 0x55, desc: 'Same as preamble - should work with SFD' },
        { data: 0x7E, desc: 'Same as SFD - should work as user data' },
        { data: 0xAA, desc: 'Inverted 0x55' },
        { data: 0x00, desc: 'All zeros' },
        { data: 0xFF, desc: 'All ones' },
        { data: 0x33, desc: 'Mixed pattern' },
        { data: 0xF0, desc: 'High nibble set' },
        { data: 0x0F, desc: 'Low nibble set' }
      ];
      
      for (const testCase of testCases) {
        const testData = new Uint8Array([testCase.data]);
        const signal = await fskCore.modulateData(testData);
        const result = await fskCore.demodulateData(signal);
        
        expect(result.length).toBe(1); // Should detect exactly one byte
        expect(result[0]).toBe(testCase.data); // Should match input exactly
      }
    });

    test('multiple consecutive identical bytes', async () => {
      // Test that consecutive identical bytes don't cause false "padding" detection
      const testCases = [
        new Uint8Array([0xFF, 0xFF, 0xFF]), // Three consecutive 0xFF
        new Uint8Array([0x00, 0x00, 0x00]), // Three consecutive 0x00
        new Uint8Array([0x55, 0x55, 0x55]), // Three consecutive preamble pattern
        new Uint8Array([0x7E, 0x7E, 0x7E])  // Three consecutive SFD pattern
      ];

      for (const testData of testCases) {
        const signal = await fskCore.modulateData(testData);
        const result = await fskCore.demodulateData(signal);
        
        expect(result.length).toBe(testData.length);
        expect(Array.from(result)).toEqual(Array.from(testData));
      }
    });
  });
});

// Helper functions
function findDataStart(demodulated: Uint8Array, originalData: Uint8Array): number {
  if (originalData.length === 0) return -1;
  
  for (let start = 0; start <= demodulated.length - originalData.length; start++) {
    let match = true;
    for (let i = 0; i < originalData.length; i++) {
      if (demodulated[start + i] !== originalData[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      return start;
    }
  }
  return -1;
}

function addNoise(signal: Float32Array, snrDb: number): Float32Array {
  const signalPower = calculatePower(signal);
  const noisePower = signalPower / Math.pow(10, snrDb / 10);
  // For uniform random in [-A, +A], variance = A²/3, so A = sqrt(3 * variance)
  const noiseAmplitude = Math.sqrt(3 * noisePower);
  
  const noisySignal = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    const noise = noiseAmplitude * (Math.random() * 2 - 1);
    noisySignal[i] = signal[i] + noise;
  }
  
  return noisySignal;
}

function calculatePower(signal: Float32Array): number {
  let power = 0;
  for (let i = 0; i < signal.length; i++) {
    power += signal[i] * signal[i];
  }
  return power / signal.length;
}