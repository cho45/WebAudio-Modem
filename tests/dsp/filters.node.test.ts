// Tests for DSP filters - Node.js compatible
import { describe, test, expect, beforeEach } from 'vitest';
import { IIRFilter, FIRFilter, FilterDesign, FilterFactory } from '../../src/dsp/filters';

/**
 * DSP test utilities
 */
class DSPTestUtils {
  /**
   * Generate test signal with multiple frequency components
   */
  static generateTestSignal(
    frequencies: number[], 
    amplitudes: number[], 
    sampleRate: number, 
    duration: number
  ): Float32Array {
    const numSamples = Math.floor(sampleRate * duration);
    const signal = new Float32Array(numSamples);
    
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      let sample = 0;
      
      for (let j = 0; j < frequencies.length; j++) {
        sample += amplitudes[j] * Math.sin(2 * Math.PI * frequencies[j] * t);
      }
      
      signal[i] = sample;
    }
    
    return signal;
  }
  
  /**
   * Simple power spectral density estimation
   */
  static estimatePSD(signal: Float32Array, sampleRate: number): { frequencies: number[], power: number[] } {
    const N = signal.length;
    const frequencies: number[] = [];
    const power: number[] = [];
    
    // Simple DFT for power estimation (not optimized, but accurate for testing)
    for (let k = 0; k < N / 2; k++) {
      const freq = k * sampleRate / N;
      frequencies.push(freq);
      
      let realPart = 0;
      let imagPart = 0;
      
      for (let n = 0; n < N; n++) {
        const angle = -2 * Math.PI * k * n / N;
        realPart += signal[n] * Math.cos(angle);
        imagPart += signal[n] * Math.sin(angle);
      }
      
      power.push((realPart * realPart + imagPart * imagPart) / (N * N));
    }
    
    return { frequencies, power };
  }
  
  /**
   * Find peak frequency in power spectrum
   */
  static findPeakFrequency(frequencies: number[], power: number[]): number {
    let maxPower = 0;
    let peakFreq = 0;
    
    for (let i = 0; i < power.length; i++) {
      if (power[i] > maxPower) {
        maxPower = power[i];
        peakFreq = frequencies[i];
      }
    }
    
    return peakFreq;
  }
  
  /**
   * Calculate signal power in frequency band
   */
  static bandPower(frequencies: number[], power: number[], lowFreq: number, highFreq: number): number {
    let totalPower = 0;
    
    for (let i = 0; i < frequencies.length; i++) {
      if (frequencies[i] >= lowFreq && frequencies[i] <= highFreq) {
        totalPower += power[i];
      }
    }
    
    return totalPower;
  }
  
  /**
   * Generate impulse signal for impulse response testing
   */
  static generateImpulse(length: number): Float32Array {
    const impulse = new Float32Array(length);
    impulse[0] = 1.0;
    return impulse;
  }
  
  /**
   * Calculate RMS value of signal
   */
  static calculateRMS(signal: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < signal.length; i++) {
      sum += signal[i] * signal[i];
    }
    return Math.sqrt(sum / signal.length);
  }
}

describe('IIRFilter', () => {
  let filter: IIRFilter;
  const sampleRate = 44100;
  
  beforeEach(() => {
    // Reset filter before each test
  });
  
  test('constructor and initialization', () => {
    const b = [1, 2, 1];
    const a = [1, -0.5, 0.25];
    filter = new IIRFilter(b, a);
    
    expect(filter).toBeInstanceOf(IIRFilter);
    const coeffs = filter.getCoefficients();
    expect(coeffs.b).toEqual(b);
    expect(coeffs.a).toEqual(a);
  });
  
  test('coefficient normalization', () => {
    const b = [2, 4, 2];
    const a = [2, -1, 0.5];
    filter = new IIRFilter(b, a);
    
    const coeffs = filter.getCoefficients();
    expect(coeffs.a[0]).toBe(1); // Should be normalized to 1
    expect(coeffs.b[0]).toBe(1); // b coefficients normalized by a[0]
  });
  
  test('impulse response stability', () => {
    const { b, a } = FilterDesign.butterworthLowpass(1000, sampleRate);
    filter = new IIRFilter(b, a);
    
    const impulse = DSPTestUtils.generateImpulse(100);
    const response = filter.processBuffer(impulse);
    
    // Check that response doesn't blow up (stability test)
    const maxValue = Math.max(...Array.from(response).map(Math.abs));
    expect(maxValue).toBeLessThan(10); // Should be reasonable
    
    // Check that response eventually decays
    const earlyRMS = DSPTestUtils.calculateRMS(response.slice(0, 20));
    const lateRMS = DSPTestUtils.calculateRMS(response.slice(80, 100));
    expect(lateRMS).toBeLessThan(earlyRMS);
  });
  
  test('reset functionality', () => {
    filter = FilterFactory.createIIRLowpass(1000, sampleRate);
    
    // Process some data
    const testSignal = DSPTestUtils.generateTestSignal([500], [1], sampleRate, 0.01);
    filter.processBuffer(testSignal);
    
    // Reset and process impulse
    filter.reset();
    const impulse = DSPTestUtils.generateImpulse(10);
    const response = filter.processBuffer(impulse);
    
    // Response should start from clean state
    expect(response[0]).toBeCloseTo(impulse[0] * filter.getCoefficients().b[0], 5);
  });
});

describe('FIRFilter', () => {
  let filter: FIRFilter;
  
  test('constructor and basic operation', () => {
    const coefficients = [0.1, 0.2, 0.4, 0.2, 0.1];
    filter = new FIRFilter(coefficients);
    
    expect(filter).toBeInstanceOf(FIRFilter);
    expect(filter.getCoefficients()).toEqual(coefficients);
  });
  
  test('impulse response matches coefficients', () => {
    const coefficients = [0.1, 0.2, 0.4, 0.2, 0.1];
    filter = new FIRFilter(coefficients);
    
    const impulse = DSPTestUtils.generateImpulse(10);
    const response = filter.processBuffer(impulse);
    
    // Impulse response should match coefficients
    for (let i = 0; i < coefficients.length; i++) {
      expect(response[i]).toBeCloseTo(coefficients[i], 5); // Reduced precision for floating point
    }
    
    // Should be zero after coefficients
    for (let i = coefficients.length; i < response.length; i++) {
      expect(response[i]).toBeCloseTo(0, 10);
    }
  });
  
  test('linearity property', () => {
    const coefficients = [0.25, 0.5, 0.25];
    filter = new FIRFilter(coefficients);
    
    const signal1 = new Float32Array([1, 0, 0, 0]);
    const signal2 = new Float32Array([0, 1, 0, 0]);
    
    filter.reset();
    const response1 = filter.processBuffer(signal1);
    
    filter.reset();
    const response2 = filter.processBuffer(signal2);
    
    filter.reset();
    const combinedSignal = new Float32Array([1, 1, 0, 0]);
    const combinedResponse = filter.processBuffer(combinedSignal);
    
    // Check linearity: response to (signal1 + signal2) = response1 + response2
    for (let i = 0; i < combinedResponse.length; i++) {
      expect(combinedResponse[i]).toBeCloseTo(response1[i] + response2[i], 10);
    }
  });
});

describe('FilterDesign - Butterworth IIR', () => {
  const sampleRate = 44100;
  
  test('lowpass filter design and response', () => {
    const cutoffFreq = 1000;
    const { b, a } = FilterDesign.butterworthLowpass(cutoffFreq, sampleRate);
    const filter = new IIRFilter(b, a);
    
    // Test with frequencies below and above cutoff
    const testFrequencies = [500, 1000, 2000, 4000];
    const testAmplitudes = [1, 1, 1, 1];
    const testSignal = DSPTestUtils.generateTestSignal(testFrequencies, testAmplitudes, sampleRate, 0.1);
    
    const filteredSignal = filter.processBuffer(testSignal);
    const { frequencies, power } = DSPTestUtils.estimatePSD(filteredSignal, sampleRate);
    
    // Low frequencies should pass through better than high frequencies
    const lowPower = DSPTestUtils.bandPower(frequencies, power, 0, 800);
    const highPower = DSPTestUtils.bandPower(frequencies, power, 1500, 4000);
    
    expect(lowPower).toBeGreaterThan(highPower * 2); // Significant attenuation at high freq
  });
  
  test('highpass filter design and response', () => {
    const cutoffFreq = 1000;
    const { b, a } = FilterDesign.butterworthHighpass(cutoffFreq, sampleRate);
    const filter = new IIRFilter(b, a);
    
    const testFrequencies = [500, 2000];
    const testAmplitudes = [1, 1];
    const testSignal = DSPTestUtils.generateTestSignal(testFrequencies, testAmplitudes, sampleRate, 0.1);
    
    const filteredSignal = filter.processBuffer(testSignal);
    const { frequencies, power } = DSPTestUtils.estimatePSD(filteredSignal, sampleRate);
    
    // High frequencies should pass through better than low frequencies
    const lowPower = DSPTestUtils.bandPower(frequencies, power, 0, 800);
    const highPower = DSPTestUtils.bandPower(frequencies, power, 1500, 3000);
    
    expect(highPower).toBeGreaterThan(lowPower * 2);
  });
  
  test('bandpass filter design and response', () => {
    const centerFreq = 1500;
    const bandwidth = 400;
    const { b, a } = FilterDesign.butterworthBandpass(centerFreq, bandwidth, sampleRate);
    const filter = new IIRFilter(b, a);
    
    const testFrequencies = [500, 1500, 3000];
    const testAmplitudes = [1, 1, 1];
    const testSignal = DSPTestUtils.generateTestSignal(testFrequencies, testAmplitudes, sampleRate, 0.1);
    
    const filteredSignal = filter.processBuffer(testSignal);
    const { frequencies, power } = DSPTestUtils.estimatePSD(filteredSignal, sampleRate);
    
    // Center frequency should have highest power
    const centerPower = DSPTestUtils.bandPower(frequencies, power, 1400, 1600);
    const lowPower = DSPTestUtils.bandPower(frequencies, power, 400, 600);
    const highPower = DSPTestUtils.bandPower(frequencies, power, 2800, 3200);
    
    expect(centerPower).toBeGreaterThan(lowPower * 2);
    expect(centerPower).toBeGreaterThan(highPower * 2);
  });
});

describe('FilterDesign - Windowed Sinc FIR', () => {
  const sampleRate = 44100;
  
  test('sinc lowpass filter design', () => {
    const cutoffFreq = 1000;
    const numTaps = 51;
    const coefficients = FilterDesign.sincLowpass(cutoffFreq, sampleRate, numTaps);
    
    expect(coefficients).toHaveLength(numTaps);
    
    // Check symmetry (linear phase property)
    const center = Math.floor(numTaps / 2);
    for (let i = 0; i < center; i++) {
      expect(coefficients[i]).toBeCloseTo(coefficients[numTaps - 1 - i], 10);
    }
    
    // Test filter response
    const filter = new FIRFilter(coefficients);
    const testSignal = DSPTestUtils.generateTestSignal([500, 2000], [1, 1], sampleRate, 0.1);
    const filteredSignal = filter.processBuffer(testSignal);
    
    const { frequencies, power } = DSPTestUtils.estimatePSD(filteredSignal, sampleRate);
    const lowPower = DSPTestUtils.bandPower(frequencies, power, 0, 800);
    const highPower = DSPTestUtils.bandPower(frequencies, power, 1500, 3000);
    
    expect(lowPower).toBeGreaterThan(highPower);
  });
  
  test('sinc highpass filter design', () => {
    const cutoffFreq = 1000;
    const numTaps = 51;
    const coefficients = FilterDesign.sincHighpass(cutoffFreq, sampleRate, numTaps);
    
    expect(coefficients).toHaveLength(numTaps);
    
    // Test filter response
    const filter = new FIRFilter(coefficients);
    const testSignal = DSPTestUtils.generateTestSignal([500, 2000], [1, 1], sampleRate, 0.1);
    const filteredSignal = filter.processBuffer(testSignal);
    
    const { frequencies, power } = DSPTestUtils.estimatePSD(filteredSignal, sampleRate);
    const lowPower = DSPTestUtils.bandPower(frequencies, power, 0, 800);
    const highPower = DSPTestUtils.bandPower(frequencies, power, 1500, 3000);
    
    expect(highPower).toBeGreaterThan(lowPower);
  });
  
  test('odd number of taps enforcement', () => {
    const coefficients = FilterDesign.sincLowpass(1000, sampleRate, 50); // Even number
    expect(coefficients).toHaveLength(51); // Should be made odd
  });
});

describe('FilterFactory integration', () => {
  const sampleRate = 44100;
  
  test('factory creates working IIR filters', () => {
    const lowpass = FilterFactory.createIIRLowpass(1000, sampleRate);
    const highpass = FilterFactory.createIIRHighpass(1000, sampleRate);
    const bandpass = FilterFactory.createIIRBandpass(1500, 400, sampleRate);
    
    expect(lowpass).toBeInstanceOf(IIRFilter);
    expect(highpass).toBeInstanceOf(IIRFilter);
    expect(bandpass).toBeInstanceOf(IIRFilter);
    
    // Quick functionality test
    const testSignal = new Float32Array([1, 0, 0, 0, 0]);
    
    const lpResponse = lowpass.processBuffer(testSignal);
    const hpResponse = highpass.processBuffer(testSignal);
    const bpResponse = bandpass.processBuffer(testSignal);
    
    expect(lpResponse[0]).toBeGreaterThan(0);
    expect(hpResponse[0]).toBeGreaterThan(0);
    expect(Math.abs(bpResponse[0])).toBeLessThan(0.1); // Bandpass DC response should be small but not necessarily zero
  });
  
  test('factory creates working FIR filters', () => {
    const lowpass = FilterFactory.createFIRLowpass(1000, sampleRate, 25);
    const highpass = FilterFactory.createFIRHighpass(1000, sampleRate, 25);
    const bandpass = FilterFactory.createFIRBandpass(1500, 400, sampleRate, 25);
    
    expect(lowpass).toBeInstanceOf(FIRFilter);
    expect(highpass).toBeInstanceOf(FIRFilter);
    expect(bandpass).toBeInstanceOf(FIRFilter);
    
    // Check coefficient lengths
    expect(lowpass.getCoefficients()).toHaveLength(25);
    expect(highpass.getCoefficients()).toHaveLength(25);
    expect(bandpass.getCoefficients()).toHaveLength(25);
  });
});

describe('Performance and edge cases', () => {
  test('filter stability with extreme inputs', () => {
    const filter = FilterFactory.createIIRLowpass(1000, 44100);
    
    // Test with large amplitude
    const largeSignal = new Float32Array(100).fill(1000);
    const response1 = filter.processBuffer(largeSignal);
    expect(response1.every(val => Math.abs(val) < 10000)).toBe(true);
    
    filter.reset();
    
    // Test with small amplitude
    const smallSignal = new Float32Array(100).fill(0.001);
    const response2 = filter.processBuffer(smallSignal);
    expect(response2.every(val => Math.abs(val) < 1)).toBe(true);
  });
  
  test('filter with zero-length input', () => {
    const filter = FilterFactory.createIIRLowpass(1000, 44100);
    const emptySignal = new Float32Array(0);
    const response = filter.processBuffer(emptySignal);
    
    expect(response).toHaveLength(0);
  });
  
  test('coefficient access immutability', () => {
    const filter = FilterFactory.createIIRLowpass(1000, 44100);
    const coeffs1 = filter.getCoefficients();
    const coeffs2 = filter.getCoefficients();
    
    // Modify returned coefficients
    coeffs1.b[0] = 999;
    
    // Original filter should be unaffected
    expect(coeffs2.b[0]).not.toBe(999);
  });
});