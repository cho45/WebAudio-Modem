// Individual FSK component tests - Node.js compatible
import { describe, test, expect, beforeEach } from 'vitest';

// We need to extract the individual components from FSK for testing
// Let's start by creating simplified test versions of each component

/**
 * Test version of AGCProcessor (extracted from FSK implementation)
 */
class AGCProcessor {
  private targetLevel: number;
  private attackTime: number;
  private releaseTime: number;
  private currentGain = 1.0;
  private envelope = 0.0;
  
  constructor(sampleRate: number) {
    this.targetLevel = 0.5;
    this.attackTime = Math.exp(-1 / (sampleRate * 0.001));  // 1ms attack
    this.releaseTime = Math.exp(-1 / (sampleRate * 0.1));   // 100ms release
  }
  
  process(samples: Float32Array): Float32Array {
    if (!samples || samples.length === 0) {
      return new Float32Array(0);
    }
    
    const output = new Float32Array(samples.length);
    
    for (let i = 0; i < samples.length; i++) {
      const inputLevel = Math.abs(samples[i]);
      
      // Envelope follower
      if (inputLevel > this.envelope) {
        this.envelope += (inputLevel - this.envelope) * (1 - this.attackTime);
      } else {
        this.envelope += (inputLevel - this.envelope) * (1 - this.releaseTime);
      }
      
      // Gain calculation
      if (this.envelope > 0.001) {
        const desiredGain = this.targetLevel / this.envelope;
        this.currentGain = Math.min(10.0, Math.max(0.1, desiredGain)); // Limit gain range
      }
      
      output[i] = samples[i] * this.currentGain;
    }
    
    return output;
  }
  
  reset(): void {
    this.currentGain = 1.0;
    this.envelope = 0.0;
  }
  
  getCurrentGain(): number {
    return this.currentGain;
  }
  
  getEnvelope(): number {
    return this.envelope;
  }
}

/**
 * Test version of IQDemodulator
 */
class IQDemodulator {
  private centerFrequency: number;
  private sampleRate: number;
  private localOscPhase = 0;
  
  constructor(centerFrequency: number, sampleRate: number) {
    this.centerFrequency = centerFrequency;
    this.sampleRate = sampleRate;
  }
  
  process(samples: Float32Array): { i: Float32Array, q: Float32Array } {
    const i = new Float32Array(samples.length);
    const q = new Float32Array(samples.length);
    const omega = 2 * Math.PI * this.centerFrequency / this.sampleRate;
    
    for (let n = 0; n < samples.length; n++) {
      i[n] = samples[n] * Math.cos(this.localOscPhase);
      q[n] = samples[n] * Math.sin(this.localOscPhase);
      
      this.localOscPhase += omega;
      if (this.localOscPhase > 2 * Math.PI) {
        this.localOscPhase -= 2 * Math.PI;
      }
    }
    
    return { i, q };
  }
  
  reset(): void {
    this.localOscPhase = 0;
  }
  
  getPhase(): number {
    return this.localOscPhase;
  }
}

/**
 * Test version of PhaseDetector
 */
class PhaseDetector {
  private lastPhase = 0;
  
  process(iqData: { i: Float32Array, q: Float32Array }): Float32Array {
    const { i, q } = iqData;
    const phaseData = new Float32Array(i.length);
    
    for (let n = 0; n < i.length; n++) {
      // Calculate instantaneous phase
      const phase = Math.atan2(q[n], i[n]);
      
      // Calculate phase difference (frequency)
      let phaseDiff = phase - this.lastPhase;
      
      // Handle phase wraparound
      if (phaseDiff > Math.PI) {
        phaseDiff -= 2 * Math.PI;
      } else if (phaseDiff < -Math.PI) {
        phaseDiff += 2 * Math.PI;
      }
      
      phaseData[n] = phaseDiff;
      this.lastPhase = phase;
    }
    
    return phaseData;
  }
  
  reset(): void {
    this.lastPhase = 0;
  }
  
  getLastPhase(): number {
    return this.lastPhase;
  }
}

// Test utilities
function generateSineWave(frequency: number, sampleRate: number, duration: number, amplitude = 1): Float32Array {
  const numSamples = Math.floor(sampleRate * duration);
  const signal = new Float32Array(numSamples);
  const omega = 2 * Math.PI * frequency / sampleRate;
  
  for (let i = 0; i < numSamples; i++) {
    signal[i] = amplitude * Math.sin(omega * i);
  }
  
  return signal;
}

function calculateRMS(signal: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < signal.length; i++) {
    sum += signal[i] * signal[i];
  }
  return Math.sqrt(sum / signal.length);
}

describe('Individual FSK Components', () => {
  
  describe('AGCProcessor', () => {
    let agc: AGCProcessor;
    const sampleRate = 44100;
    
    beforeEach(() => {
      agc = new AGCProcessor(sampleRate);
    });
    
    test('constructor initializes correctly', () => {
      expect(agc.getCurrentGain()).toBe(1.0);
      expect(agc.getEnvelope()).toBe(0.0);
    });
    
    test('handles empty input', () => {
      const emptyInput = new Float32Array(0);
      const result = agc.process(emptyInput);
      
      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(0);
    });
    
    test('processes normal amplitude signal', () => {
      const normalSignal = generateSineWave(1000, sampleRate, 0.01, 0.5); // 0.5 amplitude
      const result = agc.process(normalSignal);
      
      expect(result.length).toBe(normalSignal.length);
      
      // AGC should maintain output around target level (0.5)
      const outputRMS = calculateRMS(result);
      expect(outputRMS).toBeGreaterThan(0.2);
      expect(outputRMS).toBeLessThan(0.8);
    });
    
    test('amplifies weak signals', () => {
      const weakSignal = generateSineWave(1000, sampleRate, 0.01, 0.1); // 0.1 amplitude
      const result = agc.process(weakSignal);
      
      const inputRMS = calculateRMS(weakSignal);
      const outputRMS = calculateRMS(result);
      
      // Output should be amplified
      expect(outputRMS).toBeGreaterThan(inputRMS);
      expect(agc.getCurrentGain()).toBeGreaterThan(1.0);
    });
    
    test('attenuates strong signals', () => {
      const strongSignal = generateSineWave(1000, sampleRate, 0.01, 1.5); // 1.5 amplitude
      const result = agc.process(strongSignal);
      
      const inputRMS = calculateRMS(strongSignal);
      const outputRMS = calculateRMS(result);
      
      // Output should be attenuated
      expect(outputRMS).toBeLessThan(inputRMS);
      expect(agc.getCurrentGain()).toBeLessThan(1.0);
    });
    
    test('gain limiting works', () => {
      const veryWeakSignal = generateSineWave(1000, sampleRate, 0.01, 0.001); // Very weak
      agc.process(veryWeakSignal);
      
      // Gain should be limited to maximum of 10.0
      expect(agc.getCurrentGain()).toBeLessThanOrEqual(10.0);
      
      const veryStrongSignal = generateSineWave(1000, sampleRate, 0.01, 10.0); // Very strong
      agc.process(veryStrongSignal);
      
      // Gain should be limited to minimum of 0.1
      expect(agc.getCurrentGain()).toBeGreaterThanOrEqual(0.1);
    });
    
    test('reset clears state', () => {
      const signal = generateSineWave(1000, sampleRate, 0.01, 2.0);
      agc.process(signal);
      
      // Verify state has changed
      expect(agc.getCurrentGain()).not.toBe(1.0);
      expect(agc.getEnvelope()).toBeGreaterThan(0);
      
      // Reset
      agc.reset();
      
      // State should be cleared
      expect(agc.getCurrentGain()).toBe(1.0);
      expect(agc.getEnvelope()).toBe(0.0);
    });
  });
  
  describe('IQDemodulator', () => {
    let iqDemod: IQDemodulator;
    const sampleRate = 44100;
    const centerFreq = 1750; // Between mark and space
    
    beforeEach(() => {
      iqDemod = new IQDemodulator(centerFreq, sampleRate);
    });
    
    test('constructor initializes correctly', () => {
      expect(iqDemod.getPhase()).toBe(0);
    });
    
    test('processes sine wave at center frequency', () => {
      const duration = 0.001; // 1ms
      const inputSignal = generateSineWave(centerFreq, sampleRate, duration, 1.0);
      const result = iqDemod.process(inputSignal);
      
      expect(result.i).toBeInstanceOf(Float32Array);
      expect(result.q).toBeInstanceOf(Float32Array);
      expect(result.i.length).toBe(inputSignal.length);
      expect(result.q.length).toBe(inputSignal.length);
      
      // At center frequency, after filtering, we should get DC components
      // This is a basic sanity check
      expect(Math.max(...Array.from(result.i))).toBeGreaterThan(0.1);
      expect(Math.max(...Array.from(result.q))).toBeGreaterThan(0.1);
    });
    
    test('phase advances correctly', () => {
      const shortSignal = new Float32Array(10).fill(1.0);
      const initialPhase = iqDemod.getPhase();
      
      iqDemod.process(shortSignal);
      
      const finalPhase = iqDemod.getPhase();
      expect(finalPhase).toBeGreaterThan(initialPhase);
    });
    
    test('phase wrapping works', () => {
      // Process enough samples to wrap phase multiple times
      const longSignal = generateSineWave(centerFreq, sampleRate, 0.01, 1.0);
      iqDemod.process(longSignal);
      
      const phase = iqDemod.getPhase();
      // Phase should be wrapped to [0, 2π]
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(2 * Math.PI);
    });
    
    test('reset clears phase', () => {
      const signal = generateSineWave(centerFreq, sampleRate, 0.001, 1.0);
      iqDemod.process(signal);
      
      expect(iqDemod.getPhase()).toBeGreaterThan(0);
      
      iqDemod.reset();
      expect(iqDemod.getPhase()).toBe(0);
    });
    
    test('different frequency inputs produce different outputs', () => {
      const freq1 = 1000;
      const freq2 = 2000;
      const duration = 0.001;
      
      const signal1 = generateSineWave(freq1, sampleRate, duration, 1.0);
      const signal2 = generateSineWave(freq2, sampleRate, duration, 1.0);
      
      iqDemod.reset();
      const result1 = iqDemod.process(signal1);
      
      iqDemod.reset();
      const result2 = iqDemod.process(signal2);
      
      // Results should be different
      let differences = 0;
      for (let i = 0; i < result1.i.length; i++) {
        if (Math.abs(result1.i[i] - result2.i[i]) > 0.1) {
          differences++;
        }
      }
      
      expect(differences).toBeGreaterThan(result1.i.length * 0.5); // At least 50% different
    });
  });
  
  describe('PhaseDetector', () => {
    let phaseDetector: PhaseDetector;
    
    beforeEach(() => {
      phaseDetector = new PhaseDetector();
    });
    
    test('constructor initializes correctly', () => {
      expect(phaseDetector.getLastPhase()).toBe(0);
    });
    
    test('processes constant I/Q values', () => {
      const length = 10;
      const constantI = new Float32Array(length).fill(1.0);
      const constantQ = new Float32Array(length).fill(0.0);
      
      const result = phaseDetector.process({ i: constantI, q: constantQ });
      
      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(length);
      
      // Constant I/Q should produce near-zero phase differences
      for (let i = 1; i < result.length; i++) {
        expect(Math.abs(result[i])).toBeLessThan(0.1);
      }
    });
    
    test('detects phase changes', () => {
      const length = 10;
      const changingI = new Float32Array(length);
      const changingQ = new Float32Array(length);
      
      // Create a signal with changing phase
      for (let i = 0; i < length; i++) {
        const phase = (i / length) * Math.PI; // 0 to π
        changingI[i] = Math.cos(phase);
        changingQ[i] = Math.sin(phase);
      }
      
      const result = phaseDetector.process({ i: changingI, q: changingQ });
      
      // Should detect positive phase changes
      let positiveChanges = 0;
      for (let i = 0; i < result.length; i++) {
        if (result[i] > 0.05) {
          positiveChanges++;
        }
      }
      
      expect(positiveChanges).toBeGreaterThan(0);
    });
    
    test('handles phase wraparound correctly', () => {
      // Test transition from +π to -π
      const i1 = new Float32Array([-1, -1]); // phase ≈ π
      const q1 = new Float32Array([0.1, -0.1]); // slight change crossing -π
      
      const result = phaseDetector.process({ i: i1, q: q1 });
      
      // Should handle wraparound without large jumps
      expect(Math.abs(result[1])).toBeLessThan(Math.PI); // Should not be 2π jump
    });
    
    test('reset clears state', () => {
      const testI = new Float32Array([1, 0]);
      const testQ = new Float32Array([0, 1]);
      
      phaseDetector.process({ i: testI, q: testQ });
      expect(phaseDetector.getLastPhase()).not.toBe(0);
      
      phaseDetector.reset();
      expect(phaseDetector.getLastPhase()).toBe(0);
    });
    
    test('empty input handling', () => {
      const emptyI = new Float32Array(0);
      const emptyQ = new Float32Array(0);
      
      const result = phaseDetector.process({ i: emptyI, q: emptyQ });
      
      expect(result.length).toBe(0);
    });
  });
});