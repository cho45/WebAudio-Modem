// FSK Modulator implementation for WebAudio Modem
// Node.js compatible, using DSP filters for high-quality processing

import { BaseModulator, BaseModulatorConfig, SignalQuality, ModulationType } from '../core';
import { FilterFactory, IIRFilter } from '../dsp/filters';

/**
 * FSK-specific configuration extending base modulator config
 */
export interface FSKConfig extends BaseModulatorConfig {
  // Core FSK parameters
  markFrequency: number;        // Mark frequency (bit 1) - default 1650Hz
  spaceFrequency: number;       // Space frequency (bit 0) - default 1850Hz
  
  // Framing parameters
  startBits: number;            // Number of start bits - default 1
  stopBits: number;             // Number of stop bits - default 1
  parity: 'none' | 'even' | 'odd'; // Parity type - default 'none'
  
  // DSP parameters
  preFilterBandwidth: number;   // Pre-filter bandwidth - default baudRate * 2
  adaptiveThreshold: boolean;   // Adaptive threshold enable - default true
  agcEnabled: boolean;          // AGC enable - default true
  
  // Synchronization parameters
  preamblePattern: number[];    // Preamble pattern for correlation sync
  sfdPattern: number[];         // Start Frame Delimiter pattern
  syncThreshold: number;        // Correlation threshold for sync detection
}

/**
 * Default FSK configuration
 */
export const DEFAULT_FSK_CONFIG: Partial<FSKConfig> = {
  markFrequency: 1650,
  spaceFrequency: 1850,
  baudRate: 300,
  sampleRate: 44100,
  startBits: 1,
  stopBits: 1,
  parity: 'none',
  preFilterBandwidth: 600,      // baudRate * 2
  adaptiveThreshold: true,
  agcEnabled: true,
  preamblePattern: [0x55, 0x55], // Alternating bit pattern for sync
  sfdPattern: [0x7E],           // Start Frame Delimiter (01111110) - unique pattern
  syncThreshold: 0.8
};

/**
 * Frame location information from correlation sync
 */
interface FrameLocation {
  startIndex: number;
  confidence: number;
  length: number;
}

/**
 * I/Q demodulation data
 */
interface IQData {
  i: Float32Array;
  q: Float32Array;
}

/**
 * Automatic Gain Control processor
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
}

/**
 * I/Q Demodulator for coherent detection
 */
class IQDemodulator {
  private centerFrequency: number;
  private sampleRate: number;
  private localOscPhase = 0;
  
  constructor(centerFrequency: number, sampleRate: number) {
    this.centerFrequency = centerFrequency;
    this.sampleRate = sampleRate;
  }
  
  process(samples: Float32Array): IQData {
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
}

/**
 * Phase detector for frequency discrimination
 */
class PhaseDetector {
  private lastPhase = 0;
  
  process(iqData: IQData): Float32Array {
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
}

/**
 * Adaptive threshold processor
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
}

/**
 * Correlation-based frame synchronization with SFD detection
 */
class CorrelationSync {
  private syncTemplate: Float32Array;
  private config: FSKConfig;
  
  constructor(config: FSKConfig) {
    this.config = config;
    this.syncTemplate = this.generateSyncTemplate();
  }
  
  private generateSyncTemplate(): Float32Array {
    // Generate FSK-modulated preamble + SFD pattern for correlation
    const bitsPerByte = 8 + this.config.startBits + this.config.stopBits;
    const samplesPerBit = Math.floor(this.config.sampleRate / this.config.baudRate);
    const totalBytes = this.config.preamblePattern.length + this.config.sfdPattern.length;
    const totalSamples = totalBytes * bitsPerByte * samplesPerBit;
    
    const template = new Float32Array(totalSamples);
    let sampleIndex = 0;
    let phase = 0;
    
    // Generate preamble
    for (const byte of this.config.preamblePattern) {
      const frameBits = this.encodeByteWithFraming(byte);
      
      for (const bit of frameBits) {
        const frequency = bit ? this.config.markFrequency : this.config.spaceFrequency;
        const omega = 2 * Math.PI * frequency / this.config.sampleRate;
        
        for (let i = 0; i < samplesPerBit; i++) {
          template[sampleIndex++] = Math.sin(phase);
          phase += omega;
          if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
        }
      }
    }
    
    // Generate SFD
    for (const byte of this.config.sfdPattern) {
      const frameBits = this.encodeByteWithFraming(byte);
      
      for (const bit of frameBits) {
        const frequency = bit ? this.config.markFrequency : this.config.spaceFrequency;
        const omega = 2 * Math.PI * frequency / this.config.sampleRate;
        
        for (let i = 0; i < samplesPerBit; i++) {
          template[sampleIndex++] = Math.sin(phase);
          phase += omega;
          if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
        }
      }
    }
    
    return template;
  }
  
  private encodeByteWithFraming(byte: number): number[] {
    const bits: number[] = [];
    
    // Start bits (space frequency = 0)
    for (let i = 0; i < this.config.startBits; i++) {
      bits.push(0);
    }
    
    // Data bits (LSB first)
    for (let i = 0; i < 8; i++) {
      bits.push((byte >> i) & 1);
    }
    
    // Parity bit (if enabled)
    if (this.config.parity !== 'none') {
      bits.push(this.calculateParity(byte));
    }
    
    // Stop bits (mark frequency = 1)
    for (let i = 0; i < this.config.stopBits; i++) {
      bits.push(1);
    }
    
    return bits;
  }
  
  private calculateParity(byte: number): number {
    let parity = 0;
    for (let i = 0; i < 8; i++) {
      parity ^= (byte >> i) & 1;
    }
    return this.config.parity === 'even' ? parity : 1 - parity;
  }
  
  detectFrames(signal: Float32Array): FrameLocation[] {
    const correlations = this.crossCorrelate(signal, this.syncTemplate);
    return this.findPeaks(correlations);
  }
  
  private crossCorrelate(signal: Float32Array, template: Float32Array): Float32Array {
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
  
  private findPeaks(correlations: Float32Array): FrameLocation[] {
    const peaks: FrameLocation[] = [];
    const minDistance = this.syncTemplate.length; // Minimum distance between peaks
    
    // Debug: Find the maximum correlation value
    let maxCorr = 0;
    for (let i = 0; i < correlations.length; i++) {
      if (correlations[i] > maxCorr) {
        maxCorr = correlations[i];
      }
    }
    
    // Debug: Max correlation tracking (commented out for production)
    // if (maxCorr > 0.3) console.log(`[CorrelationSync] Max correlation: ${maxCorr.toFixed(3)}, threshold: ${this.config.syncThreshold}`);
    
    for (let i = 1; i < correlations.length - 1; i++) {
      if (correlations[i] > this.config.syncThreshold &&
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
          // Calculate sync pattern length (preamble + SFD) in samples
          const bitsPerByte = 8 + this.config.startBits + this.config.stopBits + 
                             (this.config.parity !== 'none' ? 1 : 0);
          const samplesPerBit = Math.floor(this.config.sampleRate / this.config.baudRate);
          const syncPatternSamples = (this.config.preamblePattern.length + this.config.sfdPattern.length) * bitsPerByte * samplesPerBit;
          
          peaks.push({
            startIndex: i + syncPatternSamples, // Start after complete preamble + SFD
            confidence: correlations[i],
            length: 0 // Will be determined during frame decoding
          });
        }
      }
    }
    
    return peaks;
  }
}

/**
 * FSK Core implementation with I/Q demodulation and correlation sync
 */
export class FSKCore extends BaseModulator<FSKConfig> {
  readonly name = 'FSK';
  readonly type: ModulationType = 'FSK';
  
  // DSP components
  private agc?: AGCProcessor;
  private preFilter?: IIRFilter;
  private iqDemodulator?: IQDemodulator;
  private iqFilters?: { i: IIRFilter; q: IIRFilter };
  private phaseDetector?: PhaseDetector;
  private postFilter?: IIRFilter;
  private correlationSync?: CorrelationSync;
  private adaptiveThreshold?: AdaptiveThreshold;
  
  // Signal quality monitoring
  private signalQuality: SignalQuality = {
    snr: 0,
    ber: 0,
    eyeOpening: 0,
    phaseJitter: 0,
    frequencyOffset: 0
  };
  
  configure(config: FSKConfig): void {
    this.config = { ...DEFAULT_FSK_CONFIG, ...config } as FSKConfig;
    this.initializeDSPComponents();
    this.ready = true;
    this.emit('configured');
  }
  
  private initializeDSPComponents(): void {
    const { sampleRate, baudRate, markFrequency, spaceFrequency, preFilterBandwidth } = this.config;
    
    // Initialize AGC
    if (this.config.agcEnabled) {
      this.agc = new AGCProcessor(sampleRate);
    }
    
    // Initialize pre-filter (bandpass)
    const centerFreq = (markFrequency + spaceFrequency) / 2;
    const freqSpan = Math.abs(spaceFrequency - markFrequency);
    // Ensure bandwidth covers both frequencies with margin
    const adaptiveBandwidth = Math.max(preFilterBandwidth, freqSpan * 4, 800); // Minimum 800Hz bandwidth
    this.preFilter = FilterFactory.createIIRBandpass(centerFreq, adaptiveBandwidth, sampleRate);
    
    // Initialize I/Q demodulator
    this.iqDemodulator = new IQDemodulator(centerFreq, sampleRate);
    
    // Initialize I/Q filters (lowpass)
    this.iqFilters = {
      i: FilterFactory.createIIRLowpass(baudRate, sampleRate),
      q: FilterFactory.createIIRLowpass(baudRate, sampleRate)
    };
    
    // Initialize phase detector
    this.phaseDetector = new PhaseDetector();
    
    // Initialize post-filter (lowpass)
    this.postFilter = FilterFactory.createIIRLowpass(baudRate, sampleRate);
    
    // Initialize correlation sync
    this.correlationSync = new CorrelationSync(this.config);
    
    // Initialize adaptive threshold
    if (this.config.adaptiveThreshold) {
      this.adaptiveThreshold = new AdaptiveThreshold(sampleRate, baudRate);
    }
  }
  
  modulateData(data: Uint8Array): Float32Array {
    if (!this.ready || !this.config) {
      throw new Error('FSK modulator not configured');
    }
    
    // 1. Encode bytes with framing and preamble
    const framedBits = this.encodeWithPreambleAndFraming(data);
    
    // 2. Generate FSK-modulated signal
    return this.generateFSKSignal(framedBits);
  }
  
  demodulateData(samples: Float32Array): Uint8Array {
    if (!this.ready || !this.config) {
      throw new Error('FSK demodulator not configured');
    }
    
    try {
      // 1. AGC processing
      let processedSamples = samples;
      if (this.agc) {
        processedSamples = this.agc.process(processedSamples);
      }
      
      // 2. Pre-filtering (bandpass)
      if (this.preFilter) {
        processedSamples = this.preFilter.processBuffer(processedSamples);
      }
      
      // 3. Correlation-based synchronization (on original signal)
      if (!this.correlationSync) {
        throw new Error('Correlation sync not initialized');
      }
      const frameLocations = this.correlationSync.detectFrames(processedSamples);
      
      // 4. I/Q demodulation
      if (!this.iqDemodulator) {
        throw new Error('I/Q demodulator not initialized');
      }
      const iqData = this.iqDemodulator.process(processedSamples);
      
      // 5. I/Q filtering
      if (this.iqFilters) {
        iqData.i = this.iqFilters.i.processBuffer(iqData.i);
        iqData.q = this.iqFilters.q.processBuffer(iqData.q);
      }
      
      // 6. Phase detection
      if (!this.phaseDetector) {
        throw new Error('Phase detector not initialized');
      }
      let phaseData = this.phaseDetector.process(iqData);
      
      // 7. Post-filtering
      if (this.postFilter) {
        phaseData = this.postFilter.processBuffer(phaseData);
      }
      
      // 8. Bit decision and frame decoding (using phase data for decoding, but frame locations from original signal)
      return this.decodeFrames(phaseData, frameLocations);
      
    } catch (error) {
      this.emit('error', { data: error });
      return new Uint8Array(0);
    }
  }
  
  private encodeWithPreambleAndFraming(data: Uint8Array): number[] {
    const bits: number[] = [];
    
    // Add preamble
    for (const byte of this.config.preamblePattern) {
      const frameBits = this.encodeByteWithFraming(byte);
      bits.push(...frameBits);
    }
    
    // Add SFD (Start Frame Delimiter)
    for (const byte of this.config.sfdPattern) {
      const frameBits = this.encodeByteWithFraming(byte);
      bits.push(...frameBits);
    }
    
    // Add data with framing
    for (const byte of data) {
      const frameBits = this.encodeByteWithFraming(byte);
      bits.push(...frameBits);
    }
    
    return bits;
  }
  
  private encodeByteWithFraming(byte: number): number[] {
    const bits: number[] = [];
    
    // Start bits
    for (let i = 0; i < this.config.startBits; i++) {
      bits.push(0); // Space frequency
    }
    
    // Data bits (LSB first)
    for (let i = 0; i < 8; i++) {
      bits.push((byte >> i) & 1);
    }
    
    // Parity bit
    if (this.config.parity !== 'none') {
      bits.push(this.calculateParity(byte));
    }
    
    // Stop bits
    for (let i = 0; i < this.config.stopBits; i++) {
      bits.push(1); // Mark frequency
    }
    
    return bits;
  }
  
  private calculateParity(byte: number): number {
    let parity = 0;
    for (let i = 0; i < 8; i++) {
      parity ^= (byte >> i) & 1;
    }
    return this.config.parity === 'even' ? parity : 1 - parity;
  }
  
  private generateFSKSignal(bits: number[]): Float32Array {
    const samplesPerBit = Math.floor(this.config.sampleRate / this.config.baudRate);
    
    // Add padding to ensure frame decoding has enough samples
    const paddingSamples = samplesPerBit * 2; // Extra 2 bits worth of padding
    const totalSamples = bits.length * samplesPerBit + paddingSamples;
    const output = new Float32Array(totalSamples);
    
    let phase = 0;
    let sampleIndex = 0;
    
    for (const bit of bits) {
      const frequency = bit ? this.config.markFrequency : this.config.spaceFrequency;
      const omega = 2 * Math.PI * frequency / this.config.sampleRate;
      
      // Generate samples for this bit (phase-continuous)
      for (let i = 0; i < samplesPerBit; i++) {
        output[sampleIndex++] = Math.sin(phase);
        phase += omega;
        if (phase > 2 * Math.PI) {
          phase -= 2 * Math.PI;
        }
      }
    }
    
    // Add padding (silence or mark frequency)
    const markOmega = 2 * Math.PI * this.config.markFrequency / this.config.sampleRate;
    for (let i = 0; i < paddingSamples; i++) {
      output[sampleIndex++] = Math.sin(phase);
      phase += markOmega;
      if (phase > 2 * Math.PI) {
        phase -= 2 * Math.PI;
      }
    }
    
    return output;
  }
  
  private decodeFrames(phaseData: Float32Array, frameLocations: FrameLocation[]): Uint8Array {
    const decodedBytes: number[] = [];
    const samplesPerBit = Math.floor(this.config.sampleRate / this.config.baudRate);
    const bitsPerByte = 8 + this.config.startBits + this.config.stopBits + 
                       (this.config.parity !== 'none' ? 1 : 0);
    const frameLength = bitsPerByte * samplesPerBit;
    
    // Debug: Frame decoding info (disabled)
    // console.log(`[DecodeFrames] Phase data length: ${phaseData.length}, Found ${frameLocations.length} frame locations`);
    
    for (const frameLocation of frameLocations) {
      let currentFrameStart = frameLocation.startIndex;
      
      // Decode consecutive frames after preamble until we run out of data or hit errors
      while (currentFrameStart + frameLength <= phaseData.length) {
        // Extract frame data
        const frameData = phaseData.slice(currentFrameStart, currentFrameStart + frameLength);
        
        // Bit decision
        const bits = this.makeBitDecisions(frameData, samplesPerBit);
        
        // Decode frame
        const byte = this.decodeFrame(bits);
        if (byte !== null) {
          decodedBytes.push(byte);
          // Move to next frame
          currentFrameStart += frameLength;
        } else {
          // Frame decode failed - stop processing this sequence
          break;
        }
      }
    }
    
    return new Uint8Array(decodedBytes);
  }
  
  private makeBitDecisions(frameData: Float32Array, samplesPerBit: number): number[] {
    const numBits = Math.floor(frameData.length / samplesPerBit);
    const bits: number[] = [];
    
    for (let bitIndex = 0; bitIndex < numBits; bitIndex++) {
      const start = bitIndex * samplesPerBit;
      const end = start + samplesPerBit;
      
      // Simple majority vote within bit period
      let sum = 0;
      for (let i = start; i < end && i < frameData.length; i++) {
        sum += frameData[i];
      }
      
      const average = sum / (end - start);
      bits.push(average > 0 ? 1 : 0);
    }
    
    return bits;
  }
  
  private decodeFrame(bits: number[]): number | null {
    let bitIndex = 0;
    
    // Check start bits
    for (let i = 0; i < this.config.startBits; i++) {
      if (bitIndex >= bits.length || bits[bitIndex++] !== 0) {
        return null; // Framing error
      }
    }
    
    // Extract data bits (LSB first)
    let byte = 0;
    for (let i = 0; i < 8; i++) {
      if (bitIndex >= bits.length) {
        return null;
      }
      if (bits[bitIndex++]) {
        byte |= (1 << i);
      }
    }
    
    // Check parity bit
    if (this.config.parity !== 'none') {
      if (bitIndex >= bits.length) {
        return null;
      }
      const receivedParity = bits[bitIndex++];
      const calculatedParity = this.calculateParity(byte);
      if (receivedParity !== calculatedParity) {
        return null; // Parity error
      }
    }
    
    // Check stop bits
    for (let i = 0; i < this.config.stopBits; i++) {
      if (bitIndex >= bits.length || bits[bitIndex++] !== 1) {
        return null; // Framing error
      }
    }
    
    return byte;
  }
  
  reset(): void {
    super.reset();
    
    // Reset all DSP components
    this.agc?.reset();
    this.preFilter?.reset();
    this.iqDemodulator?.reset();
    this.iqFilters?.i.reset();
    this.iqFilters?.q.reset();
    this.phaseDetector?.reset();
    this.postFilter?.reset();
    this.adaptiveThreshold?.reset();
    
    // Reset signal quality
    this.signalQuality = {
      snr: 0,
      ber: 0,
      eyeOpening: 0,
      phaseJitter: 0,
      frequencyOffset: 0
    };
  }
  
  getSignalQuality(): SignalQuality {
    return { ...this.signalQuality };
  }
}