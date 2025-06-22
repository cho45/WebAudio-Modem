import { FilterFactory, IIRFilter } from '../dsp/filters';
import { BaseModulator, type BaseModulatorConfig, type ModulationType } from '../core';
import { RingBuffer } from '@/utils';

export interface FSKConfig extends BaseModulatorConfig {
  markFrequency: number;
  spaceFrequency: number;
  preamblePattern: number[];
  sfdPattern: number[];
  startBits: number;
  stopBits: number;
  parity: 'none' | 'even' | 'odd';
  syncThreshold: number;
  agcEnabled: boolean;
  preFilterBandwidth: number;
  adaptiveThreshold: boolean;
}

export const DEFAULT_FSK_CONFIG: FSKConfig = {
  sampleRate: 48000,
  baudRate: 300,
  markFrequency: 1650,
  spaceFrequency: 1850,
  preamblePattern: [0x55, 0x55],
  sfdPattern: [0x7E],
  startBits: 1,
  stopBits: 1,
  parity: 'none',
  syncThreshold: 0.85,
  agcEnabled: true,
  preFilterBandwidth: 800,
  adaptiveThreshold: true
};

/**
 * Automatic Gain Control processor
 */
class AGCProcessor {
  private targetLevel: number;
  private currentGain: number;
  private attackRate: number;
  private releaseRate: number;

  constructor(sampleRate: number, targetLevel = 0.5) {
    this.targetLevel = targetLevel;
    this.currentGain = 1.0;
    // AGC time constants (attack faster than release)
    this.attackRate = 1.0 - Math.exp(-1.0 / (sampleRate * 0.001)); // 1ms attack
    this.releaseRate = 1.0 - Math.exp(-1.0 / (sampleRate * 0.01)); // 10ms release
  }

  process(samples: Float32Array): Float32Array {
    const output = new Float32Array(samples.length);
    
    for (let i = 0; i < samples.length; i++) {
      // Apply current gain
      output[i] = samples[i] * this.currentGain;
      
      // Measure output level
      const outputLevel = Math.abs(output[i]);
      
      // Update gain based on output level
      if (outputLevel > this.targetLevel) {
        // Too loud, reduce gain quickly (attack)
        const targetGain = this.targetLevel / outputLevel;
        this.currentGain += (targetGain - this.currentGain) * this.attackRate;
      } else {
        // Too quiet, increase gain slowly (release)
        if (outputLevel > 0) {
          const targetGain = this.targetLevel / outputLevel;
          this.currentGain += (targetGain - this.currentGain) * this.releaseRate;
        }
      }
      
      // Limit gain to reasonable bounds
      this.currentGain = Math.max(0.1, Math.min(10.0, this.currentGain));
    }
    
    return output;
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
  private iqFilters?: { i: IIRFilter; q: IIRFilter };
  private postFilter?: IIRFilter;
  
  // Sample-by-sample processing state
  private samplesPerBit = 0;
  private bitsPerByte = 0;
  private markFreq = 0;
  private spaceFreq = 0;
  private sampleRate = 0;
  
  // I/Q demodulation state (proper FSK demodulation)
  private centerFreq = 0;
  private localOscPhase = 0;
  private lastPhase = 0;
  
  // Bit synchronization state
  private globalSampleCounter = 0; // Continuous sample counter across all chunks
  private bitSampleCounter = 0;     // Samples within current bit period
  private bitAccumulator = 0;
  private bitAccumCount = 0;
  private bitBoundaryLearned = false;
  private nextBitSampleIndex = 0;
  
  // Frame detection state
  private preambleSfdBits: number[] = [];
  private maxSyncBits = 0;
  private frameStarted = false;

  // Frame detection state2
  private syncSamplesBuffer?: RingBuffer<Uint8Array>;

  // Byte assembly state
  private currentByte = 0;
  private bitPosition = 0;
  private byteBuffer: number[] = [];
  
  // Silence detection state
  private readonly SILENCE_THRESHOLD = 0.01;
  private silenceSamplesForEOD = 0;
  private silentSampleCount = 0;

  // Simple debug counters
  private syncDetectionCount = 0;
  private demodulationCallCount = 0;
  private totalSamplesProcessed = 0;
  private lastSyncAttemptGlobalCounter = 0;

  configure(config: FSKConfig): void {
    this.config = { ...DEFAULT_FSK_CONFIG, ...config } as FSKConfig;
    
    // Initialize basic parameters
    this.sampleRate = this.config.sampleRate;
    this.markFreq = this.config.markFrequency;
    this.spaceFreq = this.config.spaceFrequency;
    this.centerFreq = (this.markFreq + this.spaceFreq) / 2;
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
    
    // Initialize I/Q filters (lowpass at baud rate)
    this.iqFilters = {
      i: FilterFactory.createIIRLowpass(this.config.baudRate, this.sampleRate),
      q: FilterFactory.createIIRLowpass(this.config.baudRate, this.sampleRate)
    };
    
    // Initialize post-filter for phase data
    this.postFilter = FilterFactory.createIIRLowpass(this.config.baudRate, this.sampleRate);

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
    this.silenceSamplesForEOD = this.bitsPerByte * this.samplesPerBit * 0.7;

    this.syncSamplesBuffer = new RingBuffer(Uint8Array, this.maxSyncBits * this.samplesPerBit * 1.1);
    
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
    
    // Add data bits (MSB first)
    for (let i = 7; i >= 0; i--) {
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
    // Reset I/Q demodulation state
    this.localOscPhase = 0;
    this.lastPhase = 0;
    
    // Reset filters
    this.iqFilters?.i.reset();
    this.iqFilters?.q.reset();
    this.postFilter?.reset();
    
    // Reset bit sync state
    this.globalSampleCounter = 0;
    this.bitSampleCounter = 0;
    this.bitAccumulator = 0;
    this.bitAccumCount = 0;
    this.bitBoundaryLearned = false;
    this.nextBitSampleIndex = 0;
    
    this.frameStarted = false;
    
    // Reset silence state
    this.silentSampleCount = 0;
  }

  async demodulateData(samples: Float32Array): Promise<Uint8Array> {
    if (!this.ready || !this.config) {
      throw new Error('FSK demodulator not configured');
    }
    
    this.demodulationCallCount++;
    this.totalSamplesProcessed += samples.length;
    
    try {
      // Process samples through AGC and preFilter
      let processedSamples = samples;
      if (this.agc) {
        processedSamples = this.agc.process(processedSamples);
      }
      if (this.preFilter) {
        processedSamples = this.preFilter.processBuffer(processedSamples);
      }
      
      // Stream processing: process each sample individually
      for (let i = 0; i < processedSamples.length; i++) {
        this.processSample(processedSamples[i]);
      }
      
      // Return accumulated bytes
      if (this.byteBuffer.length > 0) {
        const result = new Uint8Array(this.byteBuffer);
        this.byteBuffer = [];
        return result;
      }
      
      return new Uint8Array(0);
      
    } catch (error) {
      this.emit('error', { data: error });
      return new Uint8Array(0);
    }
  }

  private processSample(sample: number): boolean {
    // Step 1: I/Q demodulation - one sample at a time
    const omega = 2 * Math.PI * this.centerFreq / this.sampleRate;
    let i = sample * Math.cos(this.localOscPhase);
    let q = sample * Math.sin(this.localOscPhase);
    
    // Update local oscillator phase
    this.localOscPhase += omega;
    if (this.localOscPhase > 2 * Math.PI) {
      this.localOscPhase -= 2 * Math.PI;
    }
    
    // Step 2: Apply I/Q filters sample by sample
    if (this.iqFilters) {
      i = this.iqFilters.i.process(i);
      q = this.iqFilters.q.process(q);
    }
    
    // Step 3: Calculate instantaneous phase and amplitude
    const currentPhase = Math.atan2(q, i);
    const amplitude = Math.sqrt(i * i + q * q);
    
    // Step 4: Calculate phase difference (frequency discrimination)
    let phaseDiff = currentPhase - this.lastPhase;
    
    // Handle phase wraparound
    if (phaseDiff > Math.PI) {
      phaseDiff -= 2 * Math.PI;
    } else if (phaseDiff < -Math.PI) {
      phaseDiff += 2 * Math.PI;
    }
    
    this.lastPhase = currentPhase;
    
    // Step 5: Apply post-filter to phase difference
    let filteredPhaseDiff = phaseDiff;
    if (this.postFilter) {
      filteredPhaseDiff = this.postFilter.process(phaseDiff);
    }
    
    // Step 6: Frequency discrimination for bit decision
    // Mark frequency (1650Hz) < center < Space frequency (1850Hz)  
    // Following original implementation: positive phase diff → bit 1
    // This works despite theoretical expectation being opposite
    const bitValue = filteredPhaseDiff > 0 ? 1 : 0;
    this.syncSamplesBuffer?.put(bitValue);

    // Debug: Log first few samples (disabled)
    // if (this.bitSampleCounter < 5 && this.receivedBits.length < 10) {
    //   console.log(`Sample ${this.bitSampleCounter}: rawPhaseDiff=${phaseDiff.toFixed(4)}, filteredPhaseDiff=${filteredPhaseDiff.toFixed(4)}, bit=${bitValue}, amp=${amplitude.toFixed(4)}`);
    // }
    
    // Step 7: Sample-level silence detection (this was the original requirement!)

    this.globalSampleCounter++;

    // console.log(`[FSK] Processing sample ${this.globalSampleCounter}, bitSampleCounter=${this.bitSampleCounter}, nextBitSampleIndex=${this.nextBitSampleIndex}`);
    if (amplitude < this.SILENCE_THRESHOLD) {
      this.silentSampleCount++;
      if (this.silentSampleCount >= this.silenceSamplesForEOD) {
        //  console.log(`[FSK] End of data detected: ${this.silentSampleCount} consecutive silent samples`);
        this.emit('eod');
        this.resetState(); // Reset state on EOD
        return true;
      }
    } else {
      this.silentSampleCount = 0; // Reset on non-silent sample
    }

    if (!this.frameStarted) {
      const sampleCount = this.preambleSfdBits.length * this.samplesPerBit;
      const sampleCountForBitDecision = Math.round(this.samplesPerBit / 4); // 4x oversampling for bit decision
      let matched = 0, total = 0;
      if (this.syncSamplesBuffer && (this.syncSamplesBuffer.length >= sampleCount) && this.globalSampleCounter % sampleCountForBitDecision === 0) {
        // フレーム同期開始、サンプル単位でのパターン比較を行い一致率とビット同期位置を決定する
        for (let j = 0; j < this.preambleSfdBits.length; j++) {
          for (let k = 0; k < this.samplesPerBit; k++) {
            // Compare current sample with expected bit pattern
            if (this.syncSamplesBuffer.get(this.syncSamplesBuffer.length - (j * this.samplesPerBit + k) - 1) === this.preambleSfdBits[this.preambleSfdBits.length - j]) {
              matched++;
            }
            total++;
          }
        }

        // Calculate match ratio
        const matchRatio = total > 0 ? matched / total : 0;
        if (matchRatio> 0.5) {
          // console.log(`[FSK] Frame sync attempt: matched=${matched}, total=${total}(${sampleCount}), ratio=${matchRatio.toFixed(2)}`);
        }
        if (matchRatio > this.config.syncThreshold) {
          // console.log(`[FSK] Frame sync detected with ratio: ${matchRatio}`);
          this.frameStarted = true;
          this.currentByte = 0;
          this.bitPosition = 0;
          this.syncDetectionCount++;
          this.bitBoundaryLearned = true;
          this.bitAccumulator = 0;
          this.bitAccumCount = 0;
          this.bitSampleCounter = 0;
          this.nextBitSampleIndex = 0;
        }
      }
    } else {
      // After frame sync: use learned bit boundaries
      this.bitAccumulator += bitValue;
      this.bitAccumCount++;
      this.bitSampleCounter++;
      
      if (this.bitSampleCounter >= this.nextBitSampleIndex) {
        // Decide bit based on majority vote
        const bit = this.bitAccumulator > (this.bitAccumCount / 2) ? 1 : 0;
        
        // Reset accumulator for next bit
        this.bitAccumulator = 0;
        this.bitAccumCount = 0;
        
        // Set next bit boundary
        this.nextBitSampleIndex += this.samplesPerBit;
        
        this.processByte(bit);
      }
    }
    
    return false; // Continue processing
  }

  private processByte(bit: number): void {
    // Start bit
    if (this.bitPosition === 0) {
      console.log(`[FSK] Start bit: ${bit} (expected: 0)`);
      if (bit !== 0) {
        // Invalid start bit, reset frame and bit boundary
        console.log(`[FSK] Invalid start bit ${bit}, resetting frame`);
        this.resetState();
        return;
      }
      this.bitPosition++;
      return;
    }
    
    // Data bits (MSB first)
    if (this.bitPosition >= 1 && this.bitPosition <= 8) {
      const dataIndex = 8 - this.bitPosition;
      this.currentByte |= (bit << dataIndex);
      // console.log(`[FSK] Data bit ${this.bitPosition}: ${bit}, currentByte=0x${this.currentByte.toString(16).padStart(2, '0')}`);
      this.bitPosition++;
      return;
    }
    
    // Parity bit (if enabled)
    if (this.config.parity !== 'none' && this.bitPosition === 9) {
      // console.log(`[FSK] Parity bit: ${bit}`);
      // TODO: Check parity if needed
      this.bitPosition++;
      return;
    }
    
    // Stop bit
    const stopBitPosition = this.config.parity === 'none' ? 9 : 10;
    if (this.bitPosition === stopBitPosition) {
      console.log(`[FSK] Stop bit: ${bit} (expected: 1)`);
      if (bit !== 1) {
        // Invalid stop bit, reset frame and bit boundary
        console.log(`[FSK] Invalid stop bit ${bit}, resetting frame`);
        this.frameStarted = false;
        this.bitBoundaryLearned = false;
        return;
      }
      
      // Complete byte received
      console.log(`[FSK] Complete byte: 0x${this.currentByte.toString(16).padStart(2, '0')} (${this.currentByte}), buffer length: ${this.byteBuffer.length + 1}`);
      this.byteBuffer.push(this.currentByte);
      this.currentByte = 0;
      this.bitPosition = 0;
      return;
    }
    
    // Should not reach here
    this.frameStarted = false;
    this.bitBoundaryLearned = false;
  }

  async modulateData(data: Uint8Array): Promise<Float32Array> {
    if (!this.ready || !this.config) {
      throw new Error('FSK modulator not configured');
    }
    
    return this.generateFSKSignal(data);
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
    
    let sampleIndex = 0;
    let phase = 0;
    
    // Add initial padding silence
    sampleIndex += paddingSamples;
    
    // Helper function to generate a single bit
    const generateBit = (bit: number) => {
      const frequency = bit === 1 ? this.config.markFrequency : this.config.spaceFrequency;
      for (let i = 0; i < samplesPerBit; i++) {
        if (sampleIndex < output.length) {
          output[sampleIndex] = Math.sin(phase);
          phase += 2 * Math.PI * frequency / this.config.sampleRate;
          sampleIndex++;
        }
      }
    };
    
    // Helper function to generate a byte
    const generateByte = (byte: number) => {
      // Start bits
      for (let i = 0; i < this.config.startBits; i++) {
        generateBit(0);
      }
      
      // Data bits (MSB first)
      for (let i = 7; i >= 0; i--) {
        generateBit((byte >> i) & 1);
      }
      
      // Parity bit
      if (this.config.parity !== 'none') {
        let parity = 0;
        for (let i = 0; i < 8; i++) {
          parity ^= (byte >> i) & 1;
        }
        generateBit(this.config.parity === 'even' ? parity : 1 - parity);
      }
      
      // Stop bits
      for (let i = 0; i < this.config.stopBits; i++) {
        generateBit(1);
      }
    };
    
    // Generate preamble
    for (const byte of preambleBytes) {
      generateByte(byte);
    }
    
    // Generate SFD
    for (const byte of sfdBytes) {
      generateByte(byte);
    }
    
    // Generate data
    for (const byte of dataBytes) {
      generateByte(byte);
    }
    
    // Add silence at the end
    // (already initialized to zeros)
    
    return output;
  }

  reset(): void {
    this.resetState();

    this.syncSamplesBuffer?.clear();
    
    // Reset byte state
    this.currentByte = 0;
    this.bitPosition = 0;
    this.byteBuffer = [];
    
    // Reset debug counters
    this.syncDetectionCount = 0;
    this.demodulationCallCount = 0;
    this.totalSamplesProcessed = 0;
    this.lastSyncAttemptGlobalCounter = 0;
  }

  getSignalQuality() {
    return {
      snr: 0,
      ber: 0,
      eyeOpening: 0,
      phaseJitter: 0,
      frequencyOffset: 0
    };
  }

  getStatus() {
    return {
      ready: this.ready,
      frameStarted: this.frameStarted,
      bitBoundaryLearned: this.bitBoundaryLearned,
      globalSampleCounter: this.globalSampleCounter,
      receivedBitsLength: this.syncSamplesBuffer ? this.syncSamplesBuffer.length : 0,
      byteBufferLength: this.byteBuffer.length,
      demodulationCalls: this.demodulationCallCount,
      syncDetections: this.syncDetectionCount,
      totalSamplesProcessed: this.totalSamplesProcessed,
      lastSyncAttemptGlobalCounter: this.lastSyncAttemptGlobalCounter
    };
  }
}
