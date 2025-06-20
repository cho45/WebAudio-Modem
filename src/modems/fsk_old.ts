// FSK Modulator implementation for WebAudio Modem
// Node.js compatible, using DSP filters for high-quality processing

import { BaseModulator, BaseModulatorConfig, SignalQuality, ModulationType } from '../core';
import { FilterFactory, IIRFilter } from '../dsp/filters';
import { RingBuffer } from '../utils';

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
  sampleRate: 48000,
  startBits: 1,
  stopBits: 1,
  parity: 'none',
  preFilterBandwidth: 800,      // Carson rule: 2 * (deviation + baudRate) = 2 * (100 + 300) = 800Hz
  adaptiveThreshold: true,
  agcEnabled: true,
  preamblePattern: [0x55, 0x55], // Alternating bit pattern for sync
  sfdPattern: [0x7E],           // Start Frame Delimiter (01111110) - unique pattern
  syncThreshold: 0.85
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

interface PhaseAmplitudeData {
  phase: Float32Array;
  amplitude: Float32Array;
}

/**
 * Automatic Gain Control processor
 */
class AGCProcessor {
  private targetLevel: number;
  private attackTime: number;
  private releaseTime: number;
  private maxGain: number;
  private currentGain = 1.0;
  private envelope = 0.0;
  
  constructor(sampleRate: number) {
    this.targetLevel = 0.5;
    this.attackTime = Math.exp(-1 / (sampleRate * 0.001));  // 1ms attack
    this.releaseTime = Math.exp(-1 / (sampleRate * 0.1));   // 100ms release
    this.maxGain = 100.0; // Maximum gain limit
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
        this.currentGain = Math.min(this.maxGain, Math.max(0.1, desiredGain)); // Limit gain range
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
  
  process(iqData: IQData): PhaseAmplitudeData {
    const { i, q } = iqData;
    const phaseData = i; // reuse
    const amplitudeData = q; // reuse
    
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
      amplitudeData[n] = Math.sqrt(i[n] * i[n] + q[n] * q[n]);
      this.lastPhase = phase;
    }

    return { phase: phaseData, amplitude: amplitudeData };
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
 * Simple pattern-based frame synchronization
 * Searches for preamble+SFD bit patterns directly in phase data
 */
class SimpleSync {
  private config: FSKConfig;
  private preambleSfdBits: number[];
  
  constructor(config: FSKConfig) {
    this.config = config;
    this.preambleSfdBits = this.generateBitPattern();
  }
  
  private generateBitPattern(): number[] {
    const bits: number[] = [];
    
    // Convert preamble + SFD bytes to bit patterns
    const allBytes = [...this.config.preamblePattern, ...this.config.sfdPattern];
    
    for (const byte of allBytes) {
      // Start bits (0)
      for (let i = 0; i < this.config.startBits; i++) {
        bits.push(0);
      }
      
      // Data bits (MSB first)
      for (let i = 7; i >= 0; i--) {
        bits.push((byte >> i) & 1);
      }
      
      // Parity bit (if enabled)
      if (this.config.parity !== 'none') {
        bits.push(this.calculateParity(byte));
      }
      
      // Stop bits (1)
      for (let i = 0; i < this.config.stopBits; i++) {
        bits.push(1);
      }
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
  
  detectFrames(phaseData: Float32Array): FrameLocation[] {
    const samplesPerBit = Math.floor(this.config.sampleRate / this.config.baudRate);
    const patternLength = this.preambleSfdBits.length;
    
    
    // Convert phase data to bits
    const bits = this.convertToBits(phaseData, samplesPerBit);
    
    
    // Search for pattern with relaxed threshold
    let bestMatch = { ratio: 0, index: -1 };
    
    for (let i = 0; i <= bits.length - patternLength; i++) {
      let matches = 0;
      for (let j = 0; j < patternLength; j++) {
        if (bits[i + j] === this.preambleSfdBits[j]) {
          matches++;
        }
      }
      
      const matchRatio = matches / patternLength;
      if (matchRatio > bestMatch.ratio) {
        bestMatch = { ratio: matchRatio, index: i };
      }
      
      // Use reasonable threshold for pattern matching
      if (matchRatio >= this.config.syncThreshold) {
        // Calculate frame start at bit boundary, not sample boundary
        // Use the same phase alignment as convertToBits for the first data bit
        const bitStartIndex = i + patternLength;
        const frameStartSample = Math.floor(bitStartIndex * samplesPerBit);
        return [{
          startIndex: frameStartSample,
          confidence: matchRatio,
          length: 0
        }];
      }
    }
    
    
    // If no perfect match found, try the best match if it's reasonably good
    if (bestMatch.index >= 0 && bestMatch.ratio >= 0.8) {
      const frameStartSample = (bestMatch.index + patternLength) * samplesPerBit;
      return [{
        startIndex: frameStartSample,
        confidence: bestMatch.ratio,
        length: 0
      }];
    }
    
    return [];
  }
  
  private convertToBits(phaseData: Float32Array, samplesPerBit: number): number[] {
    const numBits = Math.floor(phaseData.length / samplesPerBit);
    const bits: number[] = [];
    
    for (let bitIndex = 0; bitIndex < numBits; bitIndex++) {
      // Use multiple samples around the center for better accuracy
      const centerSample = Math.floor((bitIndex + 0.5) * samplesPerBit);
      const sampleWindow = Math.min(8, Math.floor(samplesPerBit / 4)); // Use up to 8 samples or 1/4 of bit period
      
      let sum = 0;
      let count = 0;
      
      for (let i = -sampleWindow; i <= sampleWindow; i++) {
        const sampleIndex = centerSample + i;
        if (sampleIndex >= 0 && sampleIndex < phaseData.length) {
          sum += phaseData[sampleIndex];
          count++;
        }
      }
      
      if (count > 0) {
        const avgValue = sum / count;
        // Negative phase difference → lower frequency (mark=1650Hz) → bit 1
        // Positive phase difference → higher frequency (space=1850Hz) → bit 0
        const bit = avgValue > 0 ? 1 : 0;
        bits.push(bit);
      }
    }
    
    return bits;
  }
}

/**
 * FSK Core implementation with sample-by-sample processing
 */
export class FSKCore extends BaseModulator<FSKConfig> {
  readonly name = 'FSK';
  readonly type: ModulationType = 'FSK';
  
  // DSP components (keep AGC and preFilter)
  private agc?: AGCProcessor;
  private preFilter?: IIRFilter;
  
  // Sample-by-sample processing state
  private samplesPerBit = 0;
  private bitsPerByte = 0;
  private markFreq = 0;
  private spaceFreq = 0;
  private sampleRate = 0;
  
  // I/Q demodulation state
  private markPhase = 0;
  private spacePhase = 0;
  private prevMarkI = 0;
  private prevMarkQ = 0;
  private prevSpaceI = 0;
  private prevSpaceQ = 0;
  
  // Bit synchronization state
  private bitSampleCounter = 0;
  private currentBitValue = 0;
  private bitAccumulator = 0;
  private bitAccumCount = 0;
  
  // Frame detection state
  private preambleSfdBits: number[] = [];
  private receivedBits: number[] = [];
  private maxSyncBits = 0;
  private frameStarted = false;
  
  // Byte assembly state
  private currentByte = 0;
  private bitPosition = 0;
  private byteBuffer: number[] = [];
  
  // Silence detection state
  private readonly SILENCE_THRESHOLD = 0.01;
  private silenceSamplesForEOD = 0;
  private silentSampleCount = 0;

  
  configure(config: FSKConfig): void {
    this.config = { ...DEFAULT_FSK_CONFIG, ...config } as FSKConfig;
    
    // Initialize basic parameters
    this.sampleRate = this.config.sampleRate;
    this.markFreq = this.config.markFrequency;
    this.spaceFreq = this.config.spaceFrequency;
    this.samplesPerBit = Math.floor(this.sampleRate / this.config.baudRate);
    this.bitsPerByte = 8 + this.config.startBits + this.config.stopBits + 
                      (this.config.parity !== 'none' ? 1 : 0);
    
    // Initialize AGC and preFilter
    if (this.config.agcEnabled) {
      this.agc = new AGCProcessor(this.sampleRate);
    }
    
    const centerFreq = (this.markFreq + this.spaceFreq) / 2;
    const freqSpan = Math.abs(this.spaceFreq - this.markFreq);
    const deviation = freqSpan / 2;
    const carsonBandwidth = 2 * (deviation + this.config.baudRate);
    const finalBandwidth = Math.max(this.config.preFilterBandwidth, carsonBandwidth);
    this.preFilter = FilterFactory.createIIRBandpass(centerFreq, finalBandwidth, this.sampleRate);
    
    // Initialize preamble+SFD pattern
    this.preambleSfdBits = [];
    for (const byte of this.config.preamblePattern) {
      this.addByteToPattern(byte);
    }
    for (const byte of this.config.sfdPattern) {
      this.addByteToPattern(byte);
    }
    this.maxSyncBits = this.preambleSfdBits.length + 32; // Allow some extra bits for sync
    
    // Initialize silence detection
    this.silenceSamplesForEOD = this.bitsPerByte * this.samplesPerBit;
    
    // Reset all state
    this.resetState();
    
    this.ready = true;
    this.emit('configured');
  }
  
  private addByteToPattern(byte: number): void {
    // Add start bits
    for (let i = 0; i < this.config.startBits; i++) {
      this.preambleSfdBits.push(0); // Start bits are 0
    }
    
    // Add data bits (LSB first)
    for (let i = 0; i < 8; i++) {
      this.preambleSfdBits.push((byte >> i) & 1);
    }
    
    // Add parity bit if enabled
    if (this.config.parity !== 'none') {
      let parity = 0;
      for (let i = 0; i < 8; i++) {
        parity ^= (byte >> i) & 1;
      }
      if (this.config.parity === 'even') {
        this.preambleSfdBits.push(parity);
      } else {
        this.preambleSfdBits.push(1 - parity);
      }
    }
    
    // Add stop bits
    for (let i = 0; i < this.config.stopBits; i++) {
      this.preambleSfdBits.push(1); // Stop bits are 1
    }
  }
  
  private resetState(): void {
    // Reset I/Q state
    this.markPhase = 0;
    this.spacePhase = 0;
    this.prevMarkI = 0;
    this.prevMarkQ = 0;
    this.prevSpaceI = 0;
    this.prevSpaceQ = 0;
    
    // Reset bit sync state
    this.bitSampleCounter = 0;
    this.currentBitValue = 0;
    this.bitAccumulator = 0;
    this.bitAccumCount = 0;
    
    // Reset frame state
    this.receivedBits = [];
    this.frameStarted = false;
    
    // Reset byte state
    this.currentByte = 0;
    this.bitPosition = 0;
    this.byteBuffer = [];
    
    // Reset silence state
    this.silentSampleCount = 0;
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
    // Use Carson rule bandwidth: 2 * (frequency_deviation + baud_rate)
    const deviation = freqSpan / 2; // 100Hz for 1650/1850 pair
    const carsonBandwidth = 2 * (deviation + baudRate); // 2 * (100 + 300) = 800Hz
    const finalBandwidth = Math.max(preFilterBandwidth, carsonBandwidth);
    this.preFilter = FilterFactory.createIIRBandpass(centerFreq, finalBandwidth, sampleRate);
    
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
    
    // Initialize simple sync
    this.correlationSync = new SimpleSync(this.config);
    
    // Initialize adaptive threshold
    if (this.config.adaptiveThreshold) {
      this.adaptiveThreshold = new AdaptiveThreshold(sampleRate, baudRate);
    }
  }
  
  async modulateData(data: Uint8Array): Promise<Float32Array> {
    if (!this.ready || !this.config) {
      throw new Error('FSK modulator not configured');
    }
    
    
    // Generate FSK signal directly from bytes (includes preamble, SFD, and data)
    return this.generateFSKSignal(data);
  }
  
  async demodulateData(samples: Float32Array): Promise<Uint8Array> {
    if (!this.ready || !this.config || !this.phaseDataBuffer || !this.demodulatedByteBuffer) {
      throw new Error('FSK demodulator not configured');
    }
    
    try {
      // Process samples to generate phase and amplitude data
      const phaseAmplitudeData = await this.processToPhaseData(samples);
      
      // Add phase and amplitude data to buffers
      this.phaseDataBuffer.writeArray(phaseAmplitudeData.phase);
      this.amplitudeDataBuffer.writeArray(phaseAmplitudeData.amplitude);
      
      // Process accumulated phase data if we have enough
      const currentPhaseLength = this.phaseDataBuffer.length;
      
      if (currentPhaseLength >= this.minPhaseDataLength) {
        console.log(`[FSK] Processing ${currentPhaseLength} phase samples (threshold: ${this.minPhaseDataLength})`);
        await this.processAccumulatedPhaseData();
      }
      
      // Return any available demodulated bytes
      const availableBytes = this.demodulatedByteBuffer.length;
      if (availableBytes > 0) {
        const result = new Uint8Array(availableBytes);
        for (let i = 0; i < availableBytes; i++) {
          result[i] = this.demodulatedByteBuffer.remove();
        }
        return result;
      }
      
      // No data available yet
      return new Uint8Array(0);
      
    } catch (error) {
      this.emit('error', { data: error });
      return new Uint8Array(0);
    }
  }
  
  
  /**
   * Process samples to generate phase data (AGC -> Filters -> I/Q -> Phase Detection)
   */
  private async processToPhaseData(samples: Float32Array): Promise<PhaseAmplitudeData> {
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
      let phaseAmplitudeData = this.phaseDetector.process(iqData);
      
      // 6. Post-filtering
      if (this.postFilter) {
        phaseAmplitudeData.phase = this.postFilter.processBuffer(phaseAmplitudeData.phase);
        phaseAmplitudeData.amplitude = this.postFilter.processBuffer(phaseAmplitudeData.amplitude);
      }

      return phaseAmplitudeData;

    } catch (error) {
      this.emit('error', { data: error });
      return { phase: new Float32Array(0), amplitude: new Float32Array(0) };
    }
  }
  
  /**
   * Calculate RMS (Root Mean Square) of signal for silence detection
   */
  private calculateRMS(samples: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }
  
  /**
   * Process accumulated phase data for frame detection and decoding
   */
  private async processAccumulatedPhaseData(): Promise<void> {
    if (!this.phaseDataBuffer || !this.demodulatedByteBuffer) {
      return;
    }
    
    // Extract phase data from buffer for processing
    const phaseDataToProcess = this.phaseDataBuffer.toArray();
    
    let frameLocation: FrameLocation;
    
    // Use existing frame location or detect new one
    if (this.pendingFrameLocation) {
      frameLocation = this.pendingFrameLocation;
      console.log(`[FSK] Continuing with pending frame: startIndex=${frameLocation.startIndex}, confidence=${frameLocation.confidence}`);
    } else {
      // Perform frame detection
      if (!this.correlationSync) {
        throw new Error('Correlation sync not initialized');
      }
      
      const frameLocations = this.correlationSync.detectFrames(phaseDataToProcess);
      console.log(`[FSK] Frame detection: found ${frameLocations.length} frames, phase data length: ${phaseDataToProcess.length}`);
      
      if (frameLocations.length === 0) {
        // No frames detected, keep overlap for continuity
        const overlapLength = Math.min(2048, Math.floor(phaseDataToProcess.length / 2));
        const keepPhaseData = phaseDataToProcess.slice(-overlapLength);
        const keepAmplitudeData = amplitudeDataToProcess.slice(-overlapLength);
        this.phaseDataBuffer.clear();
        this.amplitudeDataBuffer.clear();
        this.phaseDataBuffer.writeArray(keepPhaseData);
        this.amplitudeDataBuffer.writeArray(keepAmplitudeData);
        return;
      }
      
      frameLocation = frameLocations[0];
      console.log(`[FSK] New frame detected: startIndex=${frameLocation.startIndex}, confidence=${frameLocation.confidence}`);
      this.decodedFrameCount = 0;
    }
    
    // Extract amplitude data from buffer for processing  
    const amplitudeDataToProcess = this.amplitudeDataBuffer.toArray();
    
    
    // Attempt to decode frames starting from the detected location
    const decodedBytes = this.decodeFramesFromLocation(phaseDataToProcess, frameLocation, amplitudeDataToProcess);
    console.log(`[FSK] Decoded ${decodedBytes.length} bytes from frame location`);
    
    // Store demodulated bytes in result buffer
    if (decodedBytes.length > 0) {
      for (let i = 0; i < decodedBytes.length; i++) {
        this.demodulatedByteBuffer.put(decodedBytes[i]);
      }
      this.decodedFrameCount += decodedBytes.length;
    }
    
    // Check if we can process more frames with current data
    const samplesPerBit = Math.floor(this.config.sampleRate / this.config.baudRate);
    const bitsPerByte = 8 + this.config.startBits + this.config.stopBits + 
                       (this.config.parity !== 'none' ? 1 : 0);
    const frameLength = bitsPerByte * samplesPerBit;
    
    const nextFrameStart = frameLocation.startIndex + (this.decodedFrameCount * frameLength);
    const nextFrameEnd = nextFrameStart + frameLength;
    
    if (nextFrameEnd <= phaseDataToProcess.length) {
      // We have enough data for at least one more frame
      // Keep state for next processing cycle to continue decoding
      this.pendingFrameLocation = frameLocation;
    }
  }
  
  /**
   * Decode frames from a specific location, considering already decoded frames
   */
  private decodeFramesFromLocation(phaseData: Float32Array, frameLocation: FrameLocation, amplitudeData: Float32Array): Uint8Array {
    const decodedBytes: number[] = [];
    const samplesPerBit = Math.floor(this.config.sampleRate / this.config.baudRate);
    const bitsPerByte = 8 + this.config.startBits + this.config.stopBits + 
                       (this.config.parity !== 'none' ? 1 : 0);
    const frameLength = bitsPerByte * samplesPerBit;
    
    // Start from where we left off
    let currentFrameStart = frameLocation.startIndex + (this.decodedFrameCount * frameLength);
    let frameCount = 0;
    const maxFrames = 50; // Safety limit
    let consecutiveFailures = 0;
    const maxConsecutiveFailures = 3; // Threshold for end-of-data detection
    
    // Decode consecutive frames until we run out of data or hit framing errors
    while (currentFrameStart + frameLength <= phaseData.length && frameCount < maxFrames) {
      // Extract frame data
      const frameData = phaseData.slice(currentFrameStart, currentFrameStart + frameLength);
      

      // Bit decision using simple threshold
      const bits = this.makeBitDecisions(frameData, samplesPerBit);
      
      // Decode frame - stop on any framing error
      const byte = this.decodeFrame(bits);
      
      if (byte !== null) {
        decodedBytes.push(byte);
        currentFrameStart += frameLength;
        frameCount++;
        consecutiveFailures = 0; // Reset failure counter on successful decode
        this.silentSampleCount = 0; // Reset silence counter on successful decode
      } else {
        // Stop on first framing error
        break;
      }
    }
    
    return new Uint8Array(decodedBytes);
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
    const silenceSamples = bitsPerByte * samplesPerBit; // 1byte of silence at the end
    const totalSamples = totalBytes * bitsPerByte * samplesPerBit + paddingSamples + silenceSamples;
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

    // Addd silence at the end
    for (let i = 0; i < silenceSamples; i++) {
      if (sampleIndex < output.length) {
        output[sampleIndex++] = 0;
      } else {
        // 必要ならバッファ拡張も可
        break;
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
        if (phase > 2 * Math.PI) {phase -= 2 * Math.PI;}
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
        if (phase > 2 * Math.PI) {phase -= 2 * Math.PI;}
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
        if (phase > 2 * Math.PI) {phase -= 2 * Math.PI;}
      }
    }
    
    // Stop bits (mark frequency = 1)
    for (let i = 0; i < this.config.stopBits; i++) {
      const omega = 2 * Math.PI * this.config.markFrequency / this.config.sampleRate;
      for (let j = 0; j < samplesPerBit; j++) {
        output[sampleIndex++] = Math.sin(phase);
        phase += omega;
        if (phase > 2 * Math.PI) {phase -= 2 * Math.PI;}
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
    
    // Calculate maximum reasonable frames to prevent runaway decoding
    const totalSignalFrames = Math.floor(phaseData.length / frameLength);
    const maxFrames = Math.min(totalSignalFrames, 50); // Reasonable upper limit
    
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
      
      
      // Decode consecutive frames until framing error occurs
      while (currentFrameStart + frameLength <= phaseData.length && frameCount < maxFrames) {
        // Extract frame data
        const frameData = phaseData.slice(currentFrameStart, currentFrameStart + frameLength);
        
        // Bit decision using simple threshold
        const bits = this.makeBitDecisions(frameData, samplesPerBit);
        
        
        // Decode frame - stop on any framing error
        const byte = this.decodeFrame(bits);
        
        if (byte !== null) {
          decodedBytes.push(byte);
          currentFrameStart += frameLength;
          frameCount++;
        } else {
          // Stop on first framing error (start bit, stop bit, parity)
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
      // Use multiple samples around the center for better accuracy (same as convertToBits)
      const centerSample = Math.floor((bitIndex + 0.5) * samplesPerBit);
      const sampleWindow = Math.min(8, Math.floor(samplesPerBit / 4)); // Use up to 8 samples or 1/4 of bit period
      
      let sum = 0;
      let count = 0;
      
      for (let i = -sampleWindow; i <= sampleWindow; i++) {
        const sampleIndex = centerSample + i;
        if (sampleIndex >= 0 && sampleIndex < frameData.length) {
          sum += frameData[sampleIndex];
          count++;
        }
      }
      
      if (count > 0) {
        const avgValue = sum / count;
        // For FSK phase discrimination:
        // Negative phase difference → lower frequency (mark=1650Hz) → bit 1
        // Positive phase difference → higher frequency (space=1850Hz) → bit 0
        bits.push(avgValue > 0 ? 1 : 0);
      }
    }
    
    return bits;
  }
  
  private decodeFrame(bits: number[]): number | null {
    let bitIndex = 0;
    
    
    // Check start bits
    for (let i = 0; i < this.config.startBits; i++) {
      if (bitIndex >= bits.length) {
        return null;
      }
      if (bits[bitIndex] !== 0) {
        return null; // Framing error
      }
      bitIndex++;
    }
    
    // Extract data bits (MSB first)
    let byte = 0;
    for (let i = 7; i >= 0; i--) {
      if (bitIndex >= bits.length) {
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
      if (bitIndex >= bits.length) {
        return null;
      }
      if (bits[bitIndex] !== 1) {
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
    
    // Reset streaming buffers
    this.phaseDataBuffer?.clear();
    this.demodulatedByteBuffer?.clear();
    
    // Reset streaming state
    this.pendingFrameLocation = undefined;
    this.decodedFrameCount = 0;
    this.silentSampleCount = 0;
    
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
