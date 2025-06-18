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
 * Bit-level correlation-based frame synchronization with SFD validation
 */
class CorrelationSync {
  private preambleSfdTemplate: Float32Array;
  private config: FSKConfig;
  private iqDemodulator: IQDemodulator;
  private iqFilters: { i: IIRFilter; q: IIRFilter };
  private phaseDetector: PhaseDetector;
  
  constructor(config: FSKConfig) {
    this.config = config;
    
    // Initialize same DSP chain as main demodulator
    const centerFreq = (config.markFrequency + config.spaceFrequency) / 2;
    this.iqDemodulator = new IQDemodulator(centerFreq, config.sampleRate);
    this.iqFilters = {
      i: FilterFactory.createIIRLowpass(config.baudRate, config.sampleRate),
      q: FilterFactory.createIIRLowpass(config.baudRate, config.sampleRate)
    };
    this.phaseDetector = new PhaseDetector();
    
    this.preambleSfdTemplate = this.generateBitTemplate();
  }
  
  private generateBitTemplate(): Float32Array {
    // Generate complete preamble + SFD pattern with proper framing
    const samplesPerBit = Math.floor(this.config.sampleRate / this.config.baudRate);
    
    // Combine preamble and SFD bytes
    const templateBytes = [...this.config.preamblePattern, ...this.config.sfdPattern];
    
    // 1. Generate raw FSK signal
    const rawFSKSignal = this.generateFSKSignalFromBytes(templateBytes, samplesPerBit);
    
    // 2. Process through same DSP chain as main demodulator
    // I/Q demodulation
    const iqData = this.iqDemodulator.process(rawFSKSignal);
    
    // I/Q filtering
    iqData.i = this.iqFilters.i.processBuffer(iqData.i);
    iqData.q = this.iqFilters.q.processBuffer(iqData.q);
    
    // Phase detection -> returns phase difference data
    const phaseTemplate = this.phaseDetector.process(iqData);
    
    return phaseTemplate;
  }
  
  
  private generateFSKSignalFromBytes(bytes: number[], samplesPerBit: number): Float32Array {
    const bitsPerByte = 8 + this.config.startBits + this.config.stopBits + 
                       (this.config.parity !== 'none' ? 1 : 0);
    const totalSamples = bytes.length * bitsPerByte * samplesPerBit;
    const output = new Float32Array(totalSamples);
    
    let phase = 0;
    let sampleIndex = 0;
    
    for (const byte of bytes) {
      const result = this.encodeByteForTemplate(byte, output, sampleIndex, samplesPerBit, phase);
      sampleIndex = result.sampleIndex;
      phase = result.phase;
    }
    
    return output;
  }
  
  private encodeByteForTemplate(byte: number, output: Float32Array, startIndex: number, samplesPerBit: number, startPhase: number): { sampleIndex: number; phase: number } {
    let phase = startPhase;
    let sampleIndex = startIndex;
    
    // Start bits (space frequency = 0)
    for (let i = 0; i < this.config.startBits; i++) {
      const omega = 2 * Math.PI * this.config.spaceFrequency / this.config.sampleRate;
      for (let j = 0; j < samplesPerBit; j++) {
        output[sampleIndex++] = Math.sin(phase);
        phase += omega;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      }
    }
    
    // Data bits (MSB first)
    for (let i = 7; i >= 0; i--) {
      const bit = (byte >> i) & 1;
      const frequency = bit ? this.config.markFrequency : this.config.spaceFrequency;
      const omega = 2 * Math.PI * frequency / this.config.sampleRate;
      for (let j = 0; j < samplesPerBit; j++) {
        output[sampleIndex++] = Math.sin(phase);
        phase += omega;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      }
    }
    
    // Parity bit (if enabled)
    if (this.config.parity !== 'none') {
      const parity = this.calculateParityLocal(byte);
      const frequency = parity ? this.config.markFrequency : this.config.spaceFrequency;
      const omega = 2 * Math.PI * frequency / this.config.sampleRate;
      for (let j = 0; j < samplesPerBit; j++) {
        output[sampleIndex++] = Math.sin(phase);
        phase += omega;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      }
    }
    
    // Stop bits (mark frequency = 1)
    for (let i = 0; i < this.config.stopBits; i++) {
      const omega = 2 * Math.PI * this.config.markFrequency / this.config.sampleRate;
      for (let j = 0; j < samplesPerBit; j++) {
        output[sampleIndex++] = Math.sin(phase);
        phase += omega;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      }
    }
    
    return { sampleIndex, phase };
  }
  
  private calculateParityLocal(byte: number): number {
    let parity = 0;
    for (let i = 0; i < 8; i++) {
      parity ^= (byte >> i) & 1;
    }
    return this.config.parity === 'even' ? parity : 1 - parity;
  }
  
  
  private calculateParity(byte: number): number {
    let parity = 0;
    for (let i = 0; i < 8; i++) {
      parity ^= (byte >> i) & 1;
    }
    return this.config.parity === 'even' ? parity : 1 - parity;
  }
  
  detectFrames(phaseData: Float32Array): FrameLocation[] {
    // Correlate phase data with phase template
    const correlations = this.crossCorrelate(phaseData, this.preambleSfdTemplate);
    const threshold = 0.6; // Relaxed threshold for phase correlation
    
    
    const frameLocations: FrameLocation[] = [];
    const minDistance = this.preambleSfdTemplate.length / 2; // Minimum distance between detections
    
    
    for (let i = 0; i < correlations.length; i++) {
      if (correlations[i] > threshold) {
        // Check minimum distance from previous detections
        let validPeak = true;
        for (const existing of frameLocations) {
          if (Math.abs(i - existing.startIndex + this.preambleSfdTemplate.length) < minDistance) {
            validPeak = false;
            break;
          }
        }
        
        if (validPeak) {
          // Frame starts after complete preamble+SFD pattern
          // Add small offset to compensate for correlation timing
          const samplesPerBit = Math.floor(this.config.sampleRate / this.config.baudRate);
          const frameStartIndex = i + this.preambleSfdTemplate.length + Math.floor(samplesPerBit * 0.5);
          
          
          frameLocations.push({
            startIndex: frameStartIndex,
            confidence: correlations[i],
            length: 0
          });
        }
      }
    }
    
    return frameLocations;
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
    
    
    // Generate FSK signal directly from bytes (includes preamble, SFD, and data)
    return this.generateFSKSignal(data);
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
      
      // 3. I/Q demodulation
      if (!this.iqDemodulator) {
        throw new Error('I/Q demodulator not initialized');
      }
      const iqData = this.iqDemodulator.process(processedSamples);
      
      // 4. I/Q filtering
      if (this.iqFilters) {
        iqData.i = this.iqFilters.i.processBuffer(iqData.i);
        iqData.q = this.iqFilters.q.processBuffer(iqData.q);
      }
      
      // 5. Phase detection
      if (!this.phaseDetector) {
        throw new Error('Phase detector not initialized');
      }
      let phaseData = this.phaseDetector.process(iqData);
      
      // 6. Post-filtering
      if (this.postFilter) {
        phaseData = this.postFilter.processBuffer(phaseData);
      }
      
      // 7. Correlation-based synchronization (on phase data)
      if (!this.correlationSync) {
        throw new Error('Correlation sync not initialized');
      }
      const frameLocations = this.correlationSync.detectFrames(phaseData);
      
      // 8. Bit decision and frame decoding using phase data
      return this.decodeFrames(phaseData, frameLocations);
      
    } catch (error) {
      this.emit('error', { data: error });
      return new Uint8Array(0);
    }
  }
  
  
  
  private calculateParity(byte: number): number {
    let parity = 0;
    for (let i = 0; i < 8; i++) {
      parity ^= (byte >> i) & 1;
    }
    return this.config.parity === 'even' ? parity : 1 - parity;
  }
  
  private generateFSKSignal(dataBytes: Uint8Array): Float32Array {
    return this.generateFSKSignalInternal(this.config.preamblePattern, this.config.sfdPattern, dataBytes);
  }
  
  private generateFSKSignalInternal(preambleBytes: number[], sfdBytes: number[], dataBytes: Uint8Array): Float32Array {
    const samplesPerBit = Math.floor(this.config.sampleRate / this.config.baudRate);
    const bitsPerByte = 8 + this.config.startBits + this.config.stopBits + 
                       (this.config.parity !== 'none' ? 1 : 0);
    
    // Calculate total samples needed
    const totalBytes = preambleBytes.length + sfdBytes.length + dataBytes.length;
    const paddingSamples = totalBytes > 0 ? samplesPerBit * 2 : 0; // Extra padding
    const totalSamples = totalBytes * bitsPerByte * samplesPerBit + paddingSamples;
    const output = new Float32Array(totalSamples);
    
    let phase = 0;
    let sampleIndex = 0;
    
    // Process preamble
    for (const byte of preambleBytes) {
      const result = this.encodeByteDirect(byte, output, sampleIndex, samplesPerBit, phase);
      sampleIndex = result.sampleIndex;
      phase = result.phase;
    }
    
    // Process SFD
    for (const byte of sfdBytes) {
      const result = this.encodeByteDirect(byte, output, sampleIndex, samplesPerBit, phase);
      sampleIndex = result.sampleIndex;
      phase = result.phase;
    }
    
    // Process data
    for (const byte of dataBytes) {
      const result = this.encodeByteDirect(byte, output, sampleIndex, samplesPerBit, phase);
      sampleIndex = result.sampleIndex;
      phase = result.phase;
    }
    
    // Add padding (mark frequency)
    if (paddingSamples > 0) {
      const markOmega = 2 * Math.PI * this.config.markFrequency / this.config.sampleRate;
      for (let i = 0; i < paddingSamples; i++) {
        output[sampleIndex++] = Math.sin(phase);
        phase += markOmega;
        if (phase > 2 * Math.PI) {
          phase -= 2 * Math.PI;
        }
      }
    }
    
    return output;
  }
  
  private encodeByteDirect(byte: number, output: Float32Array, startIndex: number, samplesPerBit: number, startPhase: number): { sampleIndex: number; phase: number } {
    let phase = startPhase;
    let sampleIndex = startIndex;
    
    // Start bits (space frequency = 0)
    for (let i = 0; i < this.config.startBits; i++) {
      const omega = 2 * Math.PI * this.config.spaceFrequency / this.config.sampleRate;
      for (let j = 0; j < samplesPerBit; j++) {
        output[sampleIndex++] = Math.sin(phase);
        phase += omega;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      }
    }
    
    // Data bits (MSB first)
    for (let i = 7; i >= 0; i--) {
      const bit = (byte >> i) & 1;
      const frequency = bit ? this.config.markFrequency : this.config.spaceFrequency;
      const omega = 2 * Math.PI * frequency / this.config.sampleRate;
      for (let j = 0; j < samplesPerBit; j++) {
        output[sampleIndex++] = Math.sin(phase);
        phase += omega;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      }
    }
    
    // Parity bit (if enabled)
    if (this.config.parity !== 'none') {
      const parity = this.calculateParity(byte);
      const frequency = parity ? this.config.markFrequency : this.config.spaceFrequency;
      const omega = 2 * Math.PI * frequency / this.config.sampleRate;
      for (let j = 0; j < samplesPerBit; j++) {
        output[sampleIndex++] = Math.sin(phase);
        phase += omega;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      }
    }
    
    // Stop bits (mark frequency = 1)
    for (let i = 0; i < this.config.stopBits; i++) {
      const omega = 2 * Math.PI * this.config.markFrequency / this.config.sampleRate;
      for (let j = 0; j < samplesPerBit; j++) {
        output[sampleIndex++] = Math.sin(phase);
        phase += omega;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      }
    }
    
    return { sampleIndex, phase };
  }
  
  
  private decodeFrames(phaseData: Float32Array, frameLocations: FrameLocation[]): Uint8Array {
    const decodedBytes: number[] = [];
    const samplesPerBit = Math.floor(this.config.sampleRate / this.config.baudRate);
    const bitsPerByte = 8 + this.config.startBits + this.config.stopBits + 
                       (this.config.parity !== 'none' ? 1 : 0);
    const frameLength = bitsPerByte * samplesPerBit;
    
    // Calculate reasonable maximum frames based on signal length
    // Account for preamble+SFD overhead and padding
    const preambleSfdLength = (this.config.preamblePattern.length + this.config.sfdPattern.length) * bitsPerByte * samplesPerBit;
    const dataLength = phaseData.length - preambleSfdLength;
    const maxFrames = Math.ceil(dataLength / frameLength) + 2; // Small margin for noise tolerance
    
    // Use only the first (highest confidence) correlation peak for FSK
    // Multiple peaks are usually false detections from data patterns
    const bestFrameLocation = frameLocations.length > 0 ? frameLocations[0] : null;
    if (!bestFrameLocation) {
      return new Uint8Array(0);
    }
    
    {
      const frameLocation = bestFrameLocation;
      let currentFrameStart = frameLocation.startIndex;
      let frameCount = 0;
      
      // Decode consecutive frames with reasonable limits
      while (currentFrameStart + frameLength <= phaseData.length && frameCount < maxFrames) {
        
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
          frameCount++;
        } else {
          // Frame decode failed (start/stop bit error, parity error) - stop processing
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
      // Sample at the center of the bit period for better stability
      const centerSample = Math.floor((bitIndex + 0.5) * samplesPerBit);
      
      if (centerSample < frameData.length) {
        // Single sample decision at optimal point
        const value = frameData[centerSample];
        
        
        // For FSK: higher frequency (space=1850Hz) → bit 0, lower frequency (mark=1650Hz) → bit 1
        // Empirically determined: negative phase diff → bit 0, positive phase diff → bit 1
        bits.push(value < 0 ? 0 : 1);
      }
    }
    
    return bits;
  }
  
  private decodeFrame(bits: number[]): number | null {
    let bitIndex = 0;
    
    
    // Check start bits
    for (let i = 0; i < this.config.startBits; i++) {
      if (bitIndex >= bits.length) {
        console.log(`[DecodeFrame] Not enough bits for start bit ${i}`);
        return null;
      }
      if (bits[bitIndex] !== 0) {
        console.log(`[DecodeFrame] Start bit ${i} error: expected 0, got ${bits[bitIndex]} at index ${bitIndex}`);
        return null; // Framing error
      }
      bitIndex++;
    }
    
    // Extract data bits (MSB first)
    let byte = 0;
    for (let i = 7; i >= 0; i--) {
      if (bitIndex >= bits.length) {
        console.log(`[DecodeFrame] Not enough bits for data bit ${i}`);
        return null;
      }
      if (bits[bitIndex]) {
        byte |= (1 << i);
      }
      bitIndex++;
    }
    
    
    // Check parity bit
    if (this.config.parity !== 'none') {
      if (bitIndex >= bits.length) {
        console.log(`[DecodeFrame] Not enough bits for parity`);
        return null;
      }
      const receivedParity = bits[bitIndex++];
      const calculatedParity = this.calculateParity(byte);
      if (receivedParity !== calculatedParity) {
        console.log(`[DecodeFrame] Parity error: received ${receivedParity}, calculated ${calculatedParity}`);
        return null; // Parity error
      }
    }
    
    // Check stop bits
    for (let i = 0; i < this.config.stopBits; i++) {
      if (bitIndex >= bits.length) {
        console.log(`[DecodeFrame] Not enough bits for stop bit ${i}`);
        return null;
      }
      if (bits[bitIndex] !== 1) {
        console.log(`[DecodeFrame] Stop bit ${i} error: expected 1, got ${bits[bitIndex]} at index ${bitIndex}`);
        return null; // Framing error
      }
      bitIndex++;
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