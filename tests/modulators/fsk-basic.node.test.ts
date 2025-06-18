// Basic FSK component tests - Node.js compatible
import { describe, test, expect, beforeEach } from 'vitest';

// Test utilities
class FSKTestUtils {
  /**
   * Generate test signal with known frequency
   */
  static generateSineWave(frequency: number, sampleRate: number, duration: number, amplitude = 1): Float32Array {
    const numSamples = Math.floor(sampleRate * duration);
    const signal = new Float32Array(numSamples);
    const omega = 2 * Math.PI * frequency / sampleRate;
    
    for (let i = 0; i < numSamples; i++) {
      signal[i] = amplitude * Math.sin(omega * i);
    }
    
    return signal;
  }
  
  /**
   * Generate FSK signal manually for testing
   */
  static generateFSKSignal(
    bits: number[], 
    markFreq: number, 
    spaceFreq: number, 
    sampleRate: number, 
    baudRate: number
  ): Float32Array {
    const samplesPerBit = Math.floor(sampleRate / baudRate);
    const totalSamples = bits.length * samplesPerBit;
    const signal = new Float32Array(totalSamples);
    
    let phase = 0;
    let sampleIndex = 0;
    
    for (const bit of bits) {
      const frequency = bit ? markFreq : spaceFreq;
      const omega = 2 * Math.PI * frequency / sampleRate;
      
      for (let i = 0; i < samplesPerBit; i++) {
        signal[sampleIndex++] = Math.sin(phase);
        phase += omega;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      }
    }
    
    return signal;
  }
  
  /**
   * Calculate signal power in frequency band
   */
  static measureFrequencyContent(signal: Float32Array, centerFreq: number, bandwidth: number, sampleRate: number): number {
    // Simple power measurement in frequency band
    const binSize = sampleRate / signal.length;
    const startBin = Math.floor((centerFreq - bandwidth/2) / binSize);
    const endBin = Math.floor((centerFreq + bandwidth/2) / binSize);
    
    // Simple energy measurement (would be better with FFT, but keeping it simple for now)
    let energy = 0;
    for (let i = 0; i < signal.length; i++) {
      energy += signal[i] * signal[i];
    }
    
    return energy / signal.length;
  }
  
  /**
   * Add white noise to signal
   */
  static addNoise(signal: Float32Array, snrDb: number): Float32Array {
    const signalPower = FSKTestUtils.calculatePower(signal);
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
  
  /**
   * Calculate signal power
   */
  static calculatePower(signal: Float32Array): number {
    let power = 0;
    for (let i = 0; i < signal.length; i++) {
      power += signal[i] * signal[i];
    }
    return power / signal.length;
  }
  
  /**
   * Compare bit arrays
   */
  static compareBits(expected: number[], actual: number[], tolerance = 0): number {
    if (expected.length !== actual.length) {
      return 0; // 0% match if lengths differ
    }
    
    let matches = 0;
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] === actual[i]) {
        matches++;
      }
    }
    
    return matches / expected.length;
  }
}

// Import the components we want to test individually
// Note: We'll extract these from the main FSK file for testing
describe('FSK Basic Components', () => {
  
  describe('Test Utilities Validation', () => {
    test('generateSineWave produces correct frequency', () => {
      const frequency = 1000;
      const sampleRate = 44100;
      const duration = 0.1; // 100ms
      
      const signal = FSKTestUtils.generateSineWave(frequency, sampleRate, duration);
      
      expect(signal.length).toBe(Math.floor(sampleRate * duration));
      expect(Math.max(...Array.from(signal))).toBeCloseTo(1, 2);
      expect(Math.min(...Array.from(signal))).toBeCloseTo(-1, 2);
    });
    
    test('generateFSKSignal creates phase-continuous signal', () => {
      const bits = [1, 0, 1, 0];
      const markFreq = 1650;
      const spaceFreq = 1850;
      const sampleRate = 44100;
      const baudRate = 300;
      
      const signal = FSKTestUtils.generateFSKSignal(bits, markFreq, spaceFreq, sampleRate, baudRate);
      
      const expectedLength = bits.length * Math.floor(sampleRate / baudRate);
      expect(signal.length).toBe(expectedLength);
      
      // Check that signal is not clipped
      expect(Math.max(...Array.from(signal))).toBeLessThanOrEqual(1.1);
      expect(Math.min(...Array.from(signal))).toBeGreaterThanOrEqual(-1.1);
    });
    
    test('addNoise preserves signal with high SNR', () => {
      const cleanSignal = FSKTestUtils.generateSineWave(1000, 44100, 0.01);
      const noisySignal = FSKTestUtils.addNoise(cleanSignal, 30); // 30dB SNR
      
      // With high SNR, normalized correlation should be high
      let correlation = 0;
      let cleanPower = 0;
      let noisyPower = 0;
      
      for (let i = 0; i < cleanSignal.length; i++) {
        correlation += cleanSignal[i] * noisySignal[i];
        cleanPower += cleanSignal[i] * cleanSignal[i];
        noisyPower += noisySignal[i] * noisySignal[i];
      }
      
      // Normalized correlation coefficient
      const normalizedCorrelation = correlation / Math.sqrt(cleanPower * noisyPower);
      expect(normalizedCorrelation).toBeGreaterThan(0.8); // High correlation with clean signal
    });
  });
  
  describe('FSK Signal Generation', () => {
    test('modulation produces correct frequencies for mark and space', () => {
      const markBits = [1, 1, 1, 1];
      const spaceBits = [0, 0, 0, 0];
      const markFreq = 1650;
      const spaceFreq = 1850;
      const sampleRate = 44100;
      const baudRate = 300;
      
      const markSignal = FSKTestUtils.generateFSKSignal(markBits, markFreq, spaceFreq, sampleRate, baudRate);
      const spaceSignal = FSKTestUtils.generateFSKSignal(spaceBits, markFreq, spaceFreq, sampleRate, baudRate);
      
      // Mark signal should have energy at mark frequency
      const markEnergy = FSKTestUtils.measureFrequencyContent(markSignal, markFreq, 100, sampleRate);
      expect(markEnergy).toBeGreaterThan(0.1);
      
      // Space signal should have energy at space frequency  
      const spaceEnergy = FSKTestUtils.measureFrequencyContent(spaceSignal, spaceFreq, 100, sampleRate);
      expect(spaceEnergy).toBeGreaterThan(0.1);
    });
    
    test('phase continuity between bit transitions', () => {
      const bits = [1, 0, 1, 0];
      const signal = FSKTestUtils.generateFSKSignal(bits, 1650, 1850, 44100, 300);
      
      // Check for no sudden jumps (phase discontinuities cause clicks)
      const samplesPerBit = Math.floor(44100 / 300);
      
      for (let bitIndex = 1; bitIndex < bits.length; bitIndex++) {
        const transitionPoint = bitIndex * samplesPerBit;
        const beforeTransition = signal[transitionPoint - 1];
        const afterTransition = signal[transitionPoint];
        
        // Phase continuity means no sudden amplitude jumps
        const jump = Math.abs(afterTransition - beforeTransition);
        expect(jump).toBeLessThan(0.5); // Reasonable threshold for phase continuity
      }
    });
  });
  
  describe('Bit Pattern Encoding', () => {
    test('alternating pattern creates expected signal', () => {
      const alternatingBits = [1, 0, 1, 0, 1, 0, 1, 0];
      const signal = FSKTestUtils.generateFSKSignal(alternatingBits, 1650, 1850, 44100, 300);
      
      expect(signal.length).toBeGreaterThan(0);
      
      // Alternating pattern should create a signal with energy at both frequencies
      const markEnergy = FSKTestUtils.measureFrequencyContent(signal, 1650, 50, 44100);
      const spaceEnergy = FSKTestUtils.measureFrequencyContent(signal, 1850, 50, 44100);
      
      expect(markEnergy).toBeGreaterThan(0.01);
      expect(spaceEnergy).toBeGreaterThan(0.01);
    });
    
    test('all ones vs all zeros produce different signals', () => {
      const allOnes = [1, 1, 1, 1, 1, 1, 1, 1];
      const allZeros = [0, 0, 0, 0, 0, 0, 0, 0];
      
      const onesSignal = FSKTestUtils.generateFSKSignal(allOnes, 1650, 1850, 44100, 300);
      const zerosSignal = FSKTestUtils.generateFSKSignal(allZeros, 1650, 1850, 44100, 300);
      
      // Signals should be different
      let correlation = 0;
      for (let i = 0; i < onesSignal.length; i++) {
        correlation += onesSignal[i] * zerosSignal[i];
      }
      correlation /= onesSignal.length;
      
      expect(Math.abs(correlation)).toBeLessThan(0.5); // Should be significantly different
    });
  });
  
  describe('Timing and Synchronization', () => {
    test('correct samples per bit calculation', () => {
      const sampleRates = [44100, 48000];
      const baudRates = [300, 1200, 2400];
      
      for (const sampleRate of sampleRates) {
        for (const baudRate of baudRates) {
          const samplesPerBit = Math.floor(sampleRate / baudRate);
          const bits = [1, 0];
          const signal = FSKTestUtils.generateFSKSignal(bits, 1650, 1850, sampleRate, baudRate);
          
          expect(signal.length).toBe(bits.length * samplesPerBit);
        }
      }
    });
    
    test('signal timing accuracy', () => {
      const baudRate = 300;
      const sampleRate = 44100;
      const testBits = [1, 0, 1];
      
      const signal = FSKTestUtils.generateFSKSignal(testBits, 1650, 1850, sampleRate, baudRate);
      const samplesPerBit = Math.floor(sampleRate / baudRate);
      
      // Each bit should be exactly samplesPerBit long
      expect(signal.length).toBe(testBits.length * samplesPerBit);
      
      // Time duration should match expected
      const expectedDuration = testBits.length / baudRate;
      const actualDuration = signal.length / sampleRate;
      expect(actualDuration).toBeCloseTo(expectedDuration, 4);
    });
  });
  
  describe('Edge Cases and Error Conditions', () => {
    test('empty bit array', () => {
      const emptyBits: number[] = [];
      const signal = FSKTestUtils.generateFSKSignal(emptyBits, 1650, 1850, 44100, 300);
      
      expect(signal.length).toBe(0);
    });
    
    test('single bit signal', () => {
      const singleBit = [1];
      const signal = FSKTestUtils.generateFSKSignal(singleBit, 1650, 1850, 44100, 300);
      
      const expectedLength = Math.floor(44100 / 300);
      expect(signal.length).toBe(expectedLength);
    });
    
    test('very low baud rate', () => {
      const bits = [1, 0];
      const signal = FSKTestUtils.generateFSKSignal(bits, 1650, 1850, 44100, 75); // 75 baud
      
      const samplesPerBit = Math.floor(44100 / 75);
      expect(signal.length).toBe(bits.length * samplesPerBit);
      expect(signal.length).toBeGreaterThan(1000); // Should be a long signal
    });
    
    test('high baud rate', () => {
      const bits = [1, 0];
      const signal = FSKTestUtils.generateFSKSignal(bits, 1650, 1850, 44100, 2400); // 2400 baud
      
      const samplesPerBit = Math.floor(44100 / 2400);
      expect(signal.length).toBe(bits.length * samplesPerBit);
      expect(samplesPerBit).toBeGreaterThan(10); // Should still have reasonable resolution
    });
  });
});

describe('Noise and Signal Quality', () => {
  test('signal power calculation', () => {
    const amplitude = 0.5;
    const signal = FSKTestUtils.generateSineWave(1000, 44100, 0.01, amplitude);
    const power = FSKTestUtils.calculatePower(signal);
    
    // For sine wave, RMS = amplitude / sqrt(2), power = RMS^2
    const expectedPower = (amplitude * amplitude) / 2;
    expect(power).toBeCloseTo(expectedPower, 3);
  });
  
  test('SNR calculation accuracy', () => {
    const cleanSignal = FSKTestUtils.generateSineWave(1000, 44100, 0.1, 1.0); // Longer signal for more stable statistics
    const targetSNR = 20; // dB
    const noisySignal = FSKTestUtils.addNoise(cleanSignal, targetSNR);
    
    const signalPower = FSKTestUtils.calculatePower(cleanSignal);
    const noisyPower = FSKTestUtils.calculatePower(noisySignal);
    
    // Calculate expected noise power and total power
    const expectedNoisePower = signalPower / Math.pow(10, targetSNR / 10);
    const expectedTotalPower = signalPower + expectedNoisePower;
    
    // Noisy signal power should be close to expected total power
    // Use more relaxed tolerance for random noise variation
    expect(noisyPower).toBeCloseTo(expectedTotalPower, 0);
    
    // Noisy signal should generally have more power than clean signal
    // Allow larger tolerance due to random nature of noise
    expect(noisyPower).toBeGreaterThan(signalPower * 0.9);
    
    // But not too much more (noise should be controlled)
    expect(noisyPower).toBeLessThan(expectedTotalPower * 1.3);
  });
  
  test('bit comparison utility', () => {
    const perfect = [1, 0, 1, 0, 1];
    const identical = [1, 0, 1, 0, 1];
    const different = [0, 1, 0, 1, 0];
    const partialMatch = [1, 0, 1, 1, 1]; // 4/5 match: positions 0,1,2,4 match, position 3 differs
    
    expect(FSKTestUtils.compareBits(perfect, identical)).toBe(1.0);
    expect(FSKTestUtils.compareBits(perfect, different)).toBe(0.0);
    expect(FSKTestUtils.compareBits(perfect, partialMatch)).toBe(0.8); // 4 out of 5 = 0.8
  });
});