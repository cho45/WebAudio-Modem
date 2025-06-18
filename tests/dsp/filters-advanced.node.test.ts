// Advanced tests for DSP filters - thorough validation
import { describe, test, expect, beforeEach } from 'vitest';
import { IIRFilter, FIRFilter, FilterDesign, FilterFactory } from '../../src/dsp/filters';

/**
 * Advanced DSP test utilities
 */
class AdvancedDSPTests {
  /**
   * Generate white noise signal
   */
  static generateWhiteNoise(length: number, amplitude = 1): Float32Array {
    const signal = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      signal[i] = amplitude * (Math.random() * 2 - 1);
    }
    return signal;
  }
  
  /**
   * Generate step response test signal
   */
  static generateStepSignal(length: number, stepAt = 0): Float32Array {
    const signal = new Float32Array(length);
    for (let i = stepAt; i < length; i++) {
      signal[i] = 1.0;
    }
    return signal;
  }
  
  /**
   * Calculate autocorrelation at lag 0 (power)
   */
  static calculatePower(signal: Float32Array): number {
    let power = 0;
    for (let i = 0; i < signal.length; i++) {
      power += signal[i] * signal[i];
    }
    return power / signal.length;
  }
  
  /**
   * Test filter stability by checking impulse response decay
   */
  static testStability(filter: IIRFilter | FIRFilter, testLength = 1000): boolean {
    filter.reset();
    const impulse = new Float32Array(testLength);
    impulse[0] = 1.0;
    
    const response = filter.processBuffer(impulse);
    
    // Check for exponential decay or bounded response
    const maxValue = Math.max(...Array.from(response).map(Math.abs));
    const finalValues = response.slice(-100);
    const finalMax = Math.max(...Array.from(finalValues).map(Math.abs));
    
    // Filter is stable if final values are much smaller than peak
    return maxValue < 100 && finalMax < maxValue * 0.1;
  }
  
  /**
   * Simple frequency response estimation
   */
  static estimateFrequencyResponse(
    filter: IIRFilter | FIRFilter, 
    frequency: number, 
    sampleRate: number,
    testLength = 1024
  ): { magnitude: number, phase: number } {
    filter.reset();
    
    // Generate sine wave
    const input = new Float32Array(testLength);
    const omega = 2 * Math.PI * frequency / sampleRate;
    for (let i = 0; i < testLength; i++) {
      input[i] = Math.sin(omega * i);
    }
    
    const output = filter.processBuffer(input);
    
    // Skip transient response, analyze steady state
    const steadyStart = Math.floor(testLength * 0.5);
    const steadyInput = input.slice(steadyStart);
    const steadyOutput = output.slice(steadyStart);
    
    // Calculate magnitude and phase using DFT bin at test frequency
    const N = steadyInput.length;
    let inputReal = 0, inputImag = 0;
    let outputReal = 0, outputImag = 0;
    
    for (let n = 0; n < N; n++) {
      const phase = -2 * Math.PI * frequency * n / sampleRate;
      const cosPhase = Math.cos(phase);
      const sinPhase = Math.sin(phase);
      
      inputReal += steadyInput[n] * cosPhase;
      inputImag += steadyInput[n] * sinPhase;
      outputReal += steadyOutput[n] * cosPhase;
      outputImag += steadyOutput[n] * sinPhase;
    }
    
    const inputMag = Math.sqrt(inputReal * inputReal + inputImag * inputImag);
    const outputMag = Math.sqrt(outputReal * outputReal + outputImag * outputImag);
    const outputPhase = Math.atan2(outputImag, outputReal);
    const inputPhase = Math.atan2(inputImag, inputReal);
    
    return {
      magnitude: inputMag > 0 ? outputMag / inputMag : 0,
      phase: outputPhase - inputPhase
    };
  }
}

describe('IIRFilter - Advanced Tests', () => {
  test('constructor validation', () => {
    // Empty coefficients
    expect(() => new IIRFilter([], [1])).toThrow('Feedforward coefficients (b) cannot be empty');
    expect(() => new IIRFilter([1], [])).toThrow('Feedback coefficients (a) cannot be empty');
    
    // Zero a[0] coefficient
    expect(() => new IIRFilter([1], [0, 1])).toThrow('First feedback coefficient (a[0]) cannot be zero');
    
    // Valid coefficients should not throw
    expect(() => new IIRFilter([1, 2], [1, 0.5])).not.toThrow();
  });
  
  test('coefficient normalization accuracy', () => {
    const b = [2, 4, 2];
    const a = [2, -1, 0.5];
    const filter = new IIRFilter(b, a);
    
    const coeffs = filter.getCoefficients();
    
    // a[0] should be exactly 1
    expect(coeffs.a[0]).toBe(1);
    
    // Other coefficients should be properly normalized
    expect(coeffs.b[0]).toBeCloseTo(1, 10);
    expect(coeffs.b[1]).toBeCloseTo(2, 10);
    expect(coeffs.b[2]).toBeCloseTo(1, 10);
    expect(coeffs.a[1]).toBeCloseTo(-0.5, 10);
    expect(coeffs.a[2]).toBeCloseTo(0.25, 10);
  });
  
  test('circular buffer memory management', () => {
    const filter = FilterFactory.createIIRLowpass(1000, 44100);
    
    // Process many samples to test circular buffer wraparound
    const longSignal = AdvancedDSPTests.generateWhiteNoise(10000, 0.1);
    const output = filter.processBuffer(longSignal);
    
    expect(output).toHaveLength(10000);
    expect(output.every(val => Math.abs(val) < 10)).toBe(true); // No overflow
    
    // Test that filter state is preserved correctly
    const singleSample1 = filter.process(1.0);
    const singleSample2 = filter.process(0.0);
    
    expect(Math.abs(singleSample1)).toBeLessThan(10);
    expect(Math.abs(singleSample2)).toBeLessThan(10);
  });
  
  test('filter stability comprehensive test', () => {
    // Test various filter configurations
    const filters = [
      FilterFactory.createIIRLowpass(500, 44100),
      FilterFactory.createIIRLowpass(8000, 44100),
      FilterFactory.createIIRHighpass(100, 44100),
      FilterFactory.createIIRHighpass(5000, 44100),
      FilterFactory.createIIRBandpass(1000, 200, 44100),
      FilterFactory.createIIRBandpass(5000, 1000, 44100)
    ];
    
    for (const filter of filters) {
      expect(AdvancedDSPTests.testStability(filter)).toBe(true);
    }
  });
  
  test('numerical precision with extreme inputs', () => {
    const filter = FilterFactory.createIIRLowpass(1000, 44100);
    
    // Very small inputs
    const tinySignal = new Float32Array(100).fill(1e-15);
    const tinyOutput = filter.processBuffer(tinySignal);
    expect(tinyOutput.every(val => !isNaN(val) && isFinite(val))).toBe(true);
    
    filter.reset();
    
    // Very large inputs (but reasonable for audio)
    const largeSignal = new Float32Array(100).fill(10);
    const largeOutput = filter.processBuffer(largeSignal);
    expect(largeOutput.every(val => !isNaN(val) && isFinite(val))).toBe(true);
    expect(Math.max(...Array.from(largeOutput).map(Math.abs))).toBeLessThan(1000);
  });
  
  test('frequency response accuracy - lowpass', () => {
    const cutoff = 1000;
    const sampleRate = 44100;
    const filter = FilterFactory.createIIRLowpass(cutoff, sampleRate);
    
    // Test at cutoff frequency (should be ~-3dB)
    const responseAtCutoff = AdvancedDSPTests.estimateFrequencyResponse(filter, cutoff, sampleRate);
    const magDbAtCutoff = 20 * Math.log10(responseAtCutoff.magnitude);
    expect(magDbAtCutoff).toBeCloseTo(-3, 0.2); // Relaxed tolerance for numerical implementation
    
    // Test well below cutoff (should be close to 0dB)
    filter.reset();
    const responseLowFreq = AdvancedDSPTests.estimateFrequencyResponse(filter, cutoff * 0.1, sampleRate);
    const magDbLowFreq = 20 * Math.log10(responseLowFreq.magnitude);
    expect(magDbLowFreq).toBeGreaterThan(-1); // Should be close to 0dB, allowing for small passband ripple
    
    // Test well above cutoff (should be significantly attenuated)
    filter.reset();
    const responseHighFreq = AdvancedDSPTests.estimateFrequencyResponse(filter, cutoff * 10, sampleRate);
    const magDbHighFreq = 20 * Math.log10(responseHighFreq.magnitude);
    expect(magDbHighFreq).toBeLessThan(-10); // At least 10dB attenuation
  });
  
  test('step response and settling time', () => {
    const filter = FilterFactory.createIIRLowpass(1000, 44100);
    const stepSignal = AdvancedDSPTests.generateStepSignal(2000, 100);
    
    const response = filter.processBuffer(stepSignal);
    
    // Find settling time (when response reaches 95% of final value)
    const finalValue = response[response.length - 1];
    const targetValue = finalValue * 0.95;
    
    let settlingIndex = -1;
    for (let i = 100; i < response.length; i++) {
      if (Math.abs(response[i] - finalValue) <= Math.abs(finalValue - targetValue)) {
        settlingIndex = i;
        break;
      }
    }
    
    expect(settlingIndex).toBeGreaterThan(100); // Should settle after step
    expect(settlingIndex).toBeLessThan(1000); // Should settle reasonably quickly
    expect(Math.abs(finalValue)).toBeGreaterThan(0.1); // Should have meaningful DC response
  });
});

describe('FIRFilter - Advanced Tests', () => {
  test('linear phase property verification', () => {
    const filter = FilterFactory.createFIRLowpass(1000, 44100, 51);
    const coeffs = filter.getCoefficients();
    
    // Check symmetry (necessary for linear phase)
    const center = Math.floor(coeffs.length / 2);
    for (let i = 0; i < center; i++) {
      expect(coeffs[i]).toBeCloseTo(coeffs[coeffs.length - 1 - i], 8);
    }
  });
  
  test('FIR filter stability (always stable)', () => {
    const filters = [
      FilterFactory.createFIRLowpass(1000, 44100, 31),
      FilterFactory.createFIRHighpass(2000, 44100, 31),
      FilterFactory.createFIRBandpass(1500, 500, 44100, 31)
    ];
    
    for (const filter of filters) {
      expect(AdvancedDSPTests.testStability(filter)).toBe(true);
    }
  });
  
  test('FIR filter frequency response', () => {
    const cutoff = 2000;
    const sampleRate = 44100;
    const filter = FilterFactory.createFIRLowpass(cutoff, sampleRate, 51);
    
    // Test passband
    const passbandResponse = AdvancedDSPTests.estimateFrequencyResponse(filter, cutoff * 0.5, sampleRate);
    expect(passbandResponse.magnitude).toBeGreaterThan(0.8);
    
    // Test stopband
    const stopbandResponse = AdvancedDSPTests.estimateFrequencyResponse(filter, cutoff * 3, sampleRate);
    expect(stopbandResponse.magnitude).toBeLessThan(0.3);
  });
  
  test('FIR filter group delay consistency', () => {
    const filter = FilterFactory.createFIRLowpass(1000, 44100, 51);
    const coeffs = filter.getCoefficients();
    
    // For symmetric FIR filter, group delay should be (N-1)/2 samples
    const expectedDelay = (coeffs.length - 1) / 2;
    
    // Test with impulse
    filter.reset();
    const impulse = new Float32Array(100);
    impulse[10] = 1.0;
    
    const response = filter.processBuffer(impulse);
    
    // Find peak of response
    let peakIndex = 0;
    let peakValue = 0;
    for (let i = 0; i < response.length; i++) {
      if (Math.abs(response[i]) > Math.abs(peakValue)) {
        peakValue = response[i];
        peakIndex = i;
      }
    }
    
    // Peak should occur at input index + expected delay
    expect(peakIndex).toBeCloseTo(10 + expectedDelay, 1);
  });
});

describe('FilterDesign - Mathematical Accuracy', () => {
  test('Butterworth lowpass design accuracy', () => {
    const cutoff = 1000;
    const sampleRate = 44100;
    const { b, a } = FilterDesign.butterworthLowpass(cutoff, sampleRate);
    
    // Check coefficient properties
    expect(a[0]).toBeCloseTo(1, 10); // Normalized
    expect(b.length).toBe(3); // 2nd order
    expect(a.length).toBe(3);
    
    // Sum of b coefficients should be 1 for unity DC gain
    const dcGain = b.reduce((sum, coeff) => sum + coeff, 0) / a.reduce((sum, coeff) => sum + coeff, 0);
    expect(dcGain).toBeCloseTo(1, 5);
  });
  
  test('Filter design edge cases', () => {
    const sampleRate = 44100;
    
    // Very low frequency
    expect(() => FilterDesign.butterworthLowpass(1, sampleRate)).not.toThrow();
    
    // High frequency (but below Nyquist)
    expect(() => FilterDesign.butterworthLowpass(20000, sampleRate)).not.toThrow();
    
    // At Nyquist frequency should not crash (though may not be useful)
    expect(() => FilterDesign.butterworthLowpass(22050, sampleRate)).not.toThrow();
  });
  
  test('Sinc filter design mathematical properties', () => {
    const cutoff = 1000;
    const sampleRate = 44100;
    const numTaps = 51;
    const coeffs = FilterDesign.sincLowpass(cutoff, sampleRate, numTaps);
    
    // Check symmetry
    const center = (numTaps - 1) / 2;
    for (let i = 0; i < center; i++) {
      expect(coeffs[i]).toBeCloseTo(coeffs[numTaps - 1 - i], 10);
    }
    
    // Check that center coefficient is largest (for lowpass)
    const centerValue = Math.abs(coeffs[center]);
    for (let i = 0; i < numTaps; i++) {
      if (i !== center) {
        expect(Math.abs(coeffs[i])).toBeLessThanOrEqual(centerValue);
      }
    }
    
    // Check windowing effect - coefficients should decay towards edges
    const quarterPoint = Math.floor(numTaps / 4);
    expect(Math.abs(coeffs[quarterPoint])).toBeGreaterThan(Math.abs(coeffs[0]));
  });
});

describe('Performance and Resource Management', () => {
  test('memory usage stability over time', () => {
    const filter = FilterFactory.createIIRLowpass(1000, 44100);
    
    // Process multiple buffers to test memory management
    for (let iteration = 0; iteration < 100; iteration++) {
      const signal = AdvancedDSPTests.generateWhiteNoise(1000, 0.1);
      const output = filter.processBuffer(signal);
      expect(output).toHaveLength(1000);
    }
    
    // Filter should still work correctly after many operations
    filter.reset(); // Reset to clean state
    const testSignal = new Float32Array([1, 0, 0, 0, 0]);
    const response = filter.processBuffer(testSignal);
    expect(Math.abs(response[0])).toBeGreaterThan(0); // Check absolute value for positive response
  });
  
  test('concurrent filter instances independence', () => {
    const filter1 = FilterFactory.createIIRLowpass(1000, 44100);
    const filter2 = FilterFactory.createIIRLowpass(1000, 44100);
    
    // Process different signals
    const signal1 = new Float32Array([1, 0, 0, 0]);
    const signal2 = new Float32Array([0, 1, 0, 0]);
    
    const output1 = filter1.processBuffer(signal1);
    const output2 = filter2.processBuffer(signal2);
    
    // Outputs should be different due to different input timing
    expect(output1[0]).not.toBeCloseTo(output2[0], 5);
    
    // Both filters should produce meaningful output
    expect(Math.abs(output1[0])).toBeGreaterThan(0.001);
    expect(Math.abs(output2[1])).toBeGreaterThan(0.001); // output2's response to its input
  });
  
  test('reset functionality thoroughness', () => {
    const filter = FilterFactory.createIIRLowpass(1000, 44100);
    
    // Process some data to change internal state
    const noisySignal = AdvancedDSPTests.generateWhiteNoise(1000, 1);
    filter.processBuffer(noisySignal);
    
    // Reset and test with known signal
    filter.reset();
    const impulse = new Float32Array([1, 0, 0, 0, 0]);
    const response1 = filter.processBuffer(impulse);
    
    // Reset again and repeat - should get identical response
    filter.reset();
    const response2 = filter.processBuffer(impulse);
    
    for (let i = 0; i < response1.length; i++) {
      expect(response1[i]).toBeCloseTo(response2[i], 10);
    }
  });
});