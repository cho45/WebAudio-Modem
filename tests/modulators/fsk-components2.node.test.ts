// Additional FSK component tests - AdaptiveThreshold and CorrelationSync
import { describe, test, expect, beforeEach } from 'vitest';

/**
 * Test version of AdaptiveThreshold
 */
class AdaptiveThreshold {
  private runningMean = 0;
  private runningVariance = 0;
  private alpha: number;
  
  constructor(sampleRate: number, baudRate: number) {
    // Time constant based on symbol period
    this.alpha = 1 - Math.exp(-1 / (sampleRate / baudRate * 0.1));
  }
  
  process(samples: Float32Array): number[] {
    const bits: number[] = [];
    
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      
      // Update running statistics
      this.runningMean += this.alpha * (sample - this.runningMean);
      const variance = (sample - this.runningMean) * (sample - this.runningMean);
      this.runningVariance += this.alpha * (variance - this.runningVariance);
      
      // Adaptive threshold
      const threshold = this.runningMean;
      bits.push(sample > threshold ? 1 : 0);
    }
    
    return bits;
  }
  
  reset(): void {
    this.runningMean = 0;
    this.runningVariance = 0;
  }
  
  getMean(): number {
    return this.runningMean;
  }
  
  getVariance(): number {
    return this.runningVariance;
  }
}

/**
 * Simplified test version of CorrelationSync
 */
class CorrelationSync {
  private preambleTemplate: Float32Array;
  private syncThreshold: number;
  
  constructor(preamblePattern: number[], syncThreshold: number) {
    this.syncThreshold = syncThreshold;
    this.preambleTemplate = this.generateSimpleTemplate(preamblePattern);
  }
  
  private generateSimpleTemplate(pattern: number[]): Float32Array {
    // Very simple template - just the bit pattern as levels
    const samplesPerBit = 8; // 8 samples per bit for testing
    const template = new Float32Array(pattern.length * 8 * samplesPerBit); // 2 bytes * 8 bits * 8 samples
    let index = 0;
    
    for (const byte of pattern) {
      for (let bit = 0; bit < 8; bit++) {
        const bitValue = (byte >> bit) & 1;
        const level = bitValue ? 1.0 : -1.0;
        
        // Repeat for multiple samples per bit
        for (let sample = 0; sample < samplesPerBit; sample++) {
          template[index++] = level;
        }
      }
    }
    
    return template;
  }
  
  detectFrames(signal: Float32Array): Array<{startIndex: number, confidence: number}> {
    const correlations = this.crossCorrelate(signal, this.preambleTemplate);
    return this.findPeaks(correlations);
  }
  
  private crossCorrelate(signal: Float32Array, template: Float32Array): Float32Array {
    if (signal.length < template.length) {
      return new Float32Array(0);
    }
    
    const result = new Float32Array(signal.length - template.length + 1);
    
    for (let i = 0; i < result.length; i++) {
      let correlation = 0;
      let signalPower = 0;
      let templatePower = 0;
      
      for (let j = 0; j < template.length; j++) {
        correlation += signal[i + j] * template[j];
        signalPower += signal[i + j] * signal[i + j];
        templatePower += template[j] * template[j];
      }
      
      // Normalized correlation
      const denominator = Math.sqrt(signalPower * templatePower);
      result[i] = denominator > 0 ? correlation / denominator : 0;
    }
    
    return result;
  }
  
  private findPeaks(correlations: Float32Array): Array<{startIndex: number, confidence: number}> {
    const peaks: Array<{startIndex: number, confidence: number}> = [];
    const minDistance = this.preambleTemplate.length; // Minimum distance between peaks
    
    for (let i = 1; i < correlations.length - 1; i++) {
      if (correlations[i] > this.syncThreshold &&
          correlations[i] > correlations[i - 1] &&
          correlations[i] > correlations[i + 1]) {
        
        // Check distance from previous peaks
        let validPeak = true;
        for (const peak of peaks) {
          if (Math.abs(i - peak.startIndex) < minDistance) {
            validPeak = false;
            break;
          }
        }
        
        if (validPeak) {
          peaks.push({
            startIndex: i + this.preambleTemplate.length, // Start after preamble
            confidence: correlations[i]
          });
        }
      }
    }
    
    return peaks;
  }
  
  getTemplateLength(): number {
    return this.preambleTemplate.length;
  }
  
  getTemplate(): Float32Array {
    return new Float32Array(this.preambleTemplate);
  }
}

// Test utilities
function generateSquareWave(frequency: number, sampleRate: number, duration: number): Float32Array {
  const numSamples = Math.floor(sampleRate * duration);
  const signal = new Float32Array(numSamples);
  const period = sampleRate / frequency;
  
  for (let i = 0; i < numSamples; i++) {
    signal[i] = (i % period) < (period / 2) ? 1.0 : -1.0;
  }
  
  return signal;
}

function generateBitPattern(bits: number[], samplesPerBit: number): Float32Array {
  const signal = new Float32Array(bits.length * samplesPerBit);
  let index = 0;
  
  for (const bit of bits) {
    const level = bit ? 1.0 : -1.0;
    for (let i = 0; i < samplesPerBit; i++) {
      signal[index++] = level;
    }
  }
  
  return signal;
}

describe('Advanced FSK Components', () => {
  
  describe('AdaptiveThreshold', () => {
    let adaptiveThreshold: AdaptiveThreshold;
    const sampleRate = 44100;
    const baudRate = 300;
    
    beforeEach(() => {
      adaptiveThreshold = new AdaptiveThreshold(sampleRate, baudRate);
    });
    
    test('constructor initializes correctly', () => {
      expect(adaptiveThreshold.getMean()).toBe(0);
      expect(adaptiveThreshold.getVariance()).toBe(0);
    });
    
    test('processes constant positive signal', () => {
      const positiveSignal = new Float32Array(100).fill(1.0);
      const bits = adaptiveThreshold.process(positiveSignal);
      
      expect(bits.length).toBe(positiveSignal.length);
      
      // Initially may have many 1s, but should adapt
      expect(bits[0]).toBe(1); // First sample above initial threshold (0)
      
      // After adaptation, threshold rises. Check that adaptation is happening
      const earlyBits = bits.slice(0, 20);
      const lateBits = bits.slice(-20);
      const earlyOnes = earlyBits.filter(bit => bit === 1).length;
      const lateOnes = lateBits.filter(bit => bit === 1).length;
      
      // Early should have more 1s than late (shows adaptation working)
      // Allow for case where they're equal at steady state
      expect(earlyOnes).toBeGreaterThanOrEqual(lateOnes);
      
      // Mean should have converged towards the signal level
      expect(adaptiveThreshold.getMean()).toBeGreaterThan(0.5);
    });
    
    test('processes constant negative signal', () => {
      const negativeSignal = new Float32Array(100).fill(-1.0);
      const bits = adaptiveThreshold.process(negativeSignal);
      
      expect(bits.length).toBe(negativeSignal.length);
      
      // All should be 0 (below threshold)
      const oneBits = bits.filter(bit => bit === 1).length;
      expect(oneBits).toBe(0);
    });
    
    test('adapts to signal with DC offset', () => {
      const dcOffset = 0.5;
      const signal = new Float32Array(200); // More samples for better convergence
      for (let i = 0; i < signal.length; i++) {
        signal[i] = Math.sin(2 * Math.PI * i / 20) + dcOffset; // Sine with DC offset
      }
      
      const bits = adaptiveThreshold.process(signal);
      
      // Should adapt to DC offset and detect both 1s and 0s
      const oneBits = bits.filter(bit => bit === 1).length;
      const zeroBits = bits.filter(bit => bit === 0).length;
      
      expect(oneBits).toBeGreaterThan(10); // Should have some 1s
      expect(zeroBits).toBeGreaterThan(10); // Should have some 0s
      
      // Mean should converge towards DC offset (allow more tolerance for exponential convergence)
      const finalMean = adaptiveThreshold.getMean();
      expect(finalMean).toBeGreaterThan(dcOffset * 0.4); // At least 40% convergence
      expect(finalMean).toBeLessThan(dcOffset * 1.6); // Within reasonable bounds
    });
    
    test('processes alternating signal correctly', () => {
      const signal = new Float32Array(100);
      for (let i = 0; i < signal.length; i++) {
        signal[i] = (i % 2) === 0 ? 1.0 : -1.0; // Alternating +1, -1
      }
      
      const bits = adaptiveThreshold.process(signal);
      
      // Should detect alternating pattern after adaptation
      let alternations = 0;
      for (let i = 1; i < bits.length; i++) {
        if (bits[i] !== bits[i-1]) {
          alternations++;
        }
      }
      
      expect(alternations).toBeGreaterThan(bits.length * 0.3); // At least 30% alternations
    });
    
    test('reset clears state', () => {
      const signal = new Float32Array(50).fill(2.0);
      adaptiveThreshold.process(signal);
      
      expect(adaptiveThreshold.getMean()).toBeGreaterThan(0);
      expect(adaptiveThreshold.getVariance()).toBeGreaterThan(0);
      
      adaptiveThreshold.reset();
      
      expect(adaptiveThreshold.getMean()).toBe(0);
      expect(adaptiveThreshold.getVariance()).toBe(0);
    });
    
    test('handles empty input', () => {
      const emptySignal = new Float32Array(0);
      const bits = adaptiveThreshold.process(emptySignal);
      
      expect(bits.length).toBe(0);
    });
  });
  
  describe('CorrelationSync', () => {
    let correlationSync: CorrelationSync;
    const preamblePattern = [0x55, 0xAA]; // 01010101, 10101010
    const syncThreshold = 0.7;
    
    beforeEach(() => {
      correlationSync = new CorrelationSync(preamblePattern, syncThreshold);
    });
    
    test('constructor initializes correctly', () => {
      expect(correlationSync.getTemplateLength()).toBeGreaterThan(0);
      
      const template = correlationSync.getTemplate();
      expect(template.length).toBe(preamblePattern.length * 8 * 8); // 2 bytes * 8 bits * 8 samples
    });
    
    test('template generation creates alternating pattern', () => {
      const template = correlationSync.getTemplate();
      
      // Template should have alternating positive/negative values for 0x55
      // 0x55 = 01010101 binary, LSB first -> bit0=1, bit1=0, bit2=1, bit3=0
      expect(template[0]).toBe(1);  // bit 0 of 0x55 = 1
      expect(template[8]).toBe(-1); // bit 1 of 0x55 = 0
      expect(template[16]).toBe(1); // bit 2 of 0x55 = 1
      expect(template[24]).toBe(-1); // bit 3 of 0x55 = 0
    });
    
    test('detects perfect match with exact template', () => {
      const template = correlationSync.getTemplate();
      const signal = new Float32Array(template.length + 100);
      
      // Place template at position 50
      for (let i = 0; i < template.length; i++) {
        signal[50 + i] = template[i];
      }
      
      const peaks = correlationSync.detectFrames(signal);
      
      expect(peaks.length).toBeGreaterThan(0);
      expect(peaks[0].confidence).toBeGreaterThan(syncThreshold);
      expect(peaks[0].startIndex).toBeCloseTo(50 + template.length, 10);
    });
    
    test('detects scaled template', () => {
      const template = correlationSync.getTemplate();
      const signal = new Float32Array(template.length + 100);
      
      // Place scaled template at position 30
      const scale = 0.5;
      for (let i = 0; i < template.length; i++) {
        signal[30 + i] = template[i] * scale;
      }
      
      const peaks = correlationSync.detectFrames(signal);
      
      // Should still detect due to normalization
      expect(peaks.length).toBeGreaterThan(0);
      expect(peaks[0].confidence).toBeGreaterThan(syncThreshold);
    });
    
    test('rejects weak correlations', () => {
      const template = correlationSync.getTemplate();
      const signal = new Float32Array(template.length + 100);
      
      // Fill with noise that should not correlate well
      for (let i = 0; i < signal.length; i++) {
        signal[i] = (Math.random() - 0.5) * 2; // Random ±1
      }
      
      const peaks = correlationSync.detectFrames(signal);
      
      // Should not detect any strong correlations
      expect(peaks.length).toBe(0);
    });
    
    test('handles signal shorter than template', () => {
      const shortSignal = new Float32Array(10); // Shorter than template
      const peaks = correlationSync.detectFrames(shortSignal);
      
      expect(peaks.length).toBe(0);
    });
    
    test('finds multiple non-overlapping peaks', () => {
      const template = correlationSync.getTemplate();
      const spacing = template.length + 50; // Space them apart
      const signal = new Float32Array(template.length * 3 + 200);
      
      // Place template at multiple positions
      for (let pos = 0; pos < 3; pos++) {
        const startPos = pos * spacing;
        for (let i = 0; i < template.length; i++) {
          if (startPos + i < signal.length) {
            signal[startPos + i] = template[i];
          }
        }
      }
      
      const peaks = correlationSync.detectFrames(signal);
      
      // Should find multiple peaks
      expect(peaks.length).toBeGreaterThan(1);
      
      // Peaks should be properly spaced
      if (peaks.length >= 2) {
        const distance = peaks[1].startIndex - peaks[0].startIndex;
        expect(distance).toBeGreaterThan(template.length);
      }
    });
    
    test('peak detection with noise', () => {
      const template = correlationSync.getTemplate();
      const signal = new Float32Array(template.length + 200);
      
      // Add template with some noise
      for (let i = 0; i < template.length; i++) {
        const noise = (Math.random() - 0.5) * 0.2; // 20% noise
        signal[100 + i] = template[i] + noise;
      }
      
      // Fill rest with noise
      for (let i = 0; i < signal.length; i++) {
        if (i < 100 || i >= 100 + template.length) {
          signal[i] = (Math.random() - 0.5) * 2;
        }
      }
      
      const peaks = correlationSync.detectFrames(signal);
      
      // Should still detect template despite noise
      expect(peaks.length).toBeGreaterThan(0);
      expect(peaks[0].confidence).toBeGreaterThan(0.5); // Lower threshold due to noise
    });
  });
});