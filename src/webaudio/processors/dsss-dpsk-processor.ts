/**
 * DSSS-DPSK AudioWorklet Processor - Compact implementation with demo features
 * Handles byte-level modulation/demodulation with framer integration
 */

/// <reference path="./types.d.ts" />

declare const sampleRate: number;

import { IAudioProcessor, IDataChannel } from '../../core';
import { DsssDpskFramer } from '../../modems/dsss-dpsk/framer';
import * as modem from '../../modems/dsss-dpsk/dsss-dpsk';
import { MyAbortController } from './myabort';

interface WorkletMessage {
  id: string;
  type: 'configure' | 'modulate' | 'demodulate' | 'status' | 'reset' | 'abort';
  data?: any;
}

interface DsssDpskConfig {
  sequenceLength?: number;
  seed?: number;
  samplesPerPhase?: number;
  carrierFreq?: number;
  correlationThreshold?: number;
  peakToNoiseRatio?: number;
  weakLLRThreshold?: number;
  maxConsecutiveWeak?: number;
  verifyIntervalFrames?: number;
}

// Simplified sync state from demo
interface SyncState {
  locked: boolean;
  mode: 'SEARCH' | 'TRACK' | 'VERIFY';
  offset: number;
  chipPosition: number;
  bitPosition: number;
  lastLLRs: number[];
  consecutiveWeakBits: number;
  framesSinceLastCheck: number;
  lastSyncTime: number;
  processedBits: number;
  consecutiveFailures: number;
}

export class DsssDpskProcessor extends AudioWorkletProcessor implements IAudioProcessor, IDataChannel {
  private framer: DsssDpskFramer;
  private decodedUserDataBuffer: Uint8Array[] = [];
  private pendingModulation: {
    samples: Float32Array;
    index: number;
  } | null = null;
  private awaitingCallback: (() => void) | null = null;
  private instanceName: string;
  private abortController: MyAbortController | null = null;
  
  // Configuration
  private config: Required<DsssDpskConfig>;
  private isConfigured = false;
  
  // Audio processing
  private inputBuffer: Float32Array;
  private bufferIndex: number = 0;
  
  // Sync state
  private syncState: SyncState;
  private reference: Int8Array;
  private estimatedSnrDb: number = 10.0;
  
  // Bit accumulation for framer
  private softBitAccumulator: Int8Array;
  private accumulatorIndex: number = 0;
  private readonly ACCUMULATOR_SIZE = 64;
  
  constructor(options?: AudioWorkletNodeOptions) {
    super();
    
    this.instanceName = options?.processorOptions?.name || 'dsss-dpsk-unnamed';
    console.log(`[DsssDpskProcessor:${this.instanceName}] Initialized`);
    
    // Default configuration
    this.config = {
      sequenceLength: 31,
      seed: 0b10101,
      samplesPerPhase: 23,
      carrierFreq: 10000,
      correlationThreshold: 0.5,
      peakToNoiseRatio: 4.0,
      weakLLRThreshold: 50,
      maxConsecutiveWeak: 5,
      verifyIntervalFrames: 100
    };
    
    this.inputBuffer = new Float32Array(sampleRate);
    this.framer = new DsssDpskFramer();
    this.softBitAccumulator = new Int8Array(this.ACCUMULATOR_SIZE);
    this.syncState = this._createInitialSyncState();
    this.reference = modem.generateSyncReference(this.config.sequenceLength, this.config.seed);
    
    this.port.onmessage = this.handleMessage.bind(this);
  }

  private _createInitialSyncState(): SyncState {
    return {
      locked: false,
      mode: 'SEARCH',
      offset: 0,
      chipPosition: 0,
      bitPosition: 0,
      lastLLRs: [],
      consecutiveWeakBits: 0,
      framesSinceLastCheck: 0,
      lastSyncTime: 0,
      processedBits: 0,
      consecutiveFailures: 0
    };
  }

  async reset(): Promise<void> {
    this.decodedUserDataBuffer = [];
    this.pendingModulation = null;
    this.awaitingCallback = null;
    this.bufferIndex = 0;
    this.accumulatorIndex = 0;
    this.inputBuffer.fill(0);
    this.softBitAccumulator.fill(0);
    this.syncState = this._createInitialSyncState();
    this.framer.reset();
    this.estimatedSnrDb = 10.0;
  }
  
  private resetAbortController(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new MyAbortController();
  }
  
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];
    
    if (input?.[0] && this.isConfigured) {
      this.processInput(input[0]);
    }
    
    if (output?.[0]) {
      this.processOutput(output[0]);
    }
    
    return true;
  }

  private async handleMessage(event: MessageEvent<WorkletMessage>) {
    const { id, type, data } = event.data;

    try {
      switch (type) {
        case 'configure': {
          this.configure(data.config);
          this.port.postMessage({ id, type: 'result', data: { success: true } });
          break;
        }
          
        case 'reset': {
          await this.reset();
          this.port.postMessage({ id, type: 'result', data: { success: true } });
          break;
        }

        case 'abort': {
          if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
          }
          if (id) this.port.postMessage({ id, type: 'result', data: { success: true } });
          break;
        }

        case 'modulate': {
          this.resetAbortController();
          await this.modulate(new Uint8Array(data.bytes), { signal: this.abortController!.signal });
          this.port.postMessage({ id, type: 'result', data: { success: true } });
          break;
        }
          
        case 'demodulate': {
          this.resetAbortController();
          const demodulatedBytes = await this.demodulate({ signal: this.abortController!.signal });
          this.port.postMessage({ id, type: 'result', data: { bytes: Array.from(demodulatedBytes) } });
          break;
        }

        case 'status': {
          const status = this.getStatus();
          this.port.postMessage({ id, type: 'result', data: status });
          break;
        }
          
        default:
          throw new Error(`Unknown message type: ${type}`);
      }
    } catch (error) {
      this.port.postMessage({ 
        id, 
        type: 'error', 
        data: { message: error instanceof Error ? error.message : String(error) } 
      });
    }
  }

  private configure(config: Partial<DsssDpskConfig>): void {
    this.config = { ...this.config, ...config };
    this.reference = modem.generateSyncReference(this.config.sequenceLength, this.config.seed);
    this.syncState = this._createInitialSyncState();
    this.framer.reset();
    this.isConfigured = true;
  }

  private getStatus() {
    const framerStatus = this.framer.getState();
    return {
      isConfigured: this.isConfigured,
      syncState: { ...this.syncState },
      frameProcessingState: {
        isActive: false,
        expectedBits: 0,
        receivedBits: 0,
        mustComplete: false
      },
      bufferIndex: this.bufferIndex,
      decodedDataBufferLength: this.decodedUserDataBuffer.length,
      pendingModulation: !!this.pendingModulation,
      estimatedSnrDb: this.estimatedSnrDb,
      accumulatorIndex: this.accumulatorIndex,
      framerStatus,
      config: { ...this.config }
    };
  }

  // IDataChannel implementation
  async modulate(data: Uint8Array, options: {signal?: any }): Promise<void> {
    if (this.pendingModulation) {
      throw new Error('Modulation already in progress');
    }
    
    // Build frame using framer
    const frameOptions = {
      sequenceNumber: 0,
      frameType: 0,
      ldpcNType: 0
    };
    
    const dataFrame = this.framer.build(data, frameOptions);
    
    // Generate DSSS-DPSK signal using existing functions
    const bits = dataFrame.bits;
    const chips = modem.dsssSpread(bits, this.config.sequenceLength, this.config.seed);
    const phases = modem.dpskModulate(chips);
    const samples = modem.modulateCarrier(
      phases,
      this.config.samplesPerPhase,
      sampleRate,
      this.config.carrierFreq
    );
    
    this.pendingModulation = {
      samples,
      index: 0
    };
    
    // Wait for completion
    await new Promise<void>((resolve, reject) => {
      const handleAbort = () => {
        this.pendingModulation = null;
        reject(new Error('Modulation aborted'));
      };
      
      const modulationWaitCallback = () => {
        options?.signal.removeEventListener('abort', handleAbort);
        resolve();
      };
      
      (this as any).modulationWaitCallback = modulationWaitCallback;
      options?.signal.addEventListener('abort', handleAbort, { once: true });
    });
  }

  async demodulate(options: {signal?: any }): Promise<Uint8Array> {
    const availableData = this.decodedUserDataBuffer.length;
    if (availableData === 0) {
      await new Promise<void>((resolve, reject) => {
        this.awaitingCallback = resolve;
        options?.signal.addEventListener('abort', () => {
          this.awaitingCallback = null;
          reject(new Error('Demodulation aborted'));
        }, { once: true });
      });
    }

    const totalLength = this.decodedUserDataBuffer.reduce((sum, data) => sum + data.length, 0);
    const demodulatedData = new Uint8Array(totalLength);
    
    let offset = 0;
    while (this.decodedUserDataBuffer.length > 0) {
      const data = this.decodedUserDataBuffer.shift()!;
      demodulatedData.set(data, offset);
      offset += data.length;
    }
    
    return demodulatedData;
  }

  private processInput(inputSamples: Float32Array): void {
    this._appendToBuffer(inputSamples);
    const currentTime = Date.now();

    switch (this.syncState.mode) {
      case 'SEARCH':
        this._searchMode(currentTime);
        break;
      case 'TRACK':
        this._trackMode();
        break;
      case 'VERIFY':
        this._verifyMode();
        break;
    }
  }
  
  private processOutput(outputSamples: Float32Array): void {
    outputSamples.fill(0);
    
    if (this.pendingModulation) {
      const remainingSamples = this.pendingModulation.samples.length - this.pendingModulation.index;
      const samplesToProcess = Math.min(remainingSamples, outputSamples.length);
      
      for (let i = 0; i < samplesToProcess; i++) {
        outputSamples[i] = this.pendingModulation.samples[this.pendingModulation.index + i];
      }
      
      this.pendingModulation.index += samplesToProcess;
      
      if (this.pendingModulation.index >= this.pendingModulation.samples.length) {
        const callback = (this as any).modulationWaitCallback;
        if (callback) {
          callback();
          (this as any).modulationWaitCallback = undefined;
        }
        this.pendingModulation = null;
      }
    }
  }

  private _appendToBuffer(inputSamples: Float32Array): void {
    const remainingSpace = this.inputBuffer.length - this.bufferIndex;
    if (inputSamples.length <= remainingSpace) {
      this.inputBuffer.set(inputSamples, this.bufferIndex);
      this.bufferIndex += inputSamples.length;
    } else {
      const keepSamples = this.inputBuffer.length - inputSamples.length;
      this.inputBuffer.set(this.inputBuffer.subarray(this.inputBuffer.length - keepSamples), 0);
      this.inputBuffer.set(inputSamples, keepSamples);
      this.bufferIndex = this.inputBuffer.length;
      
      if (this.syncState.locked) {
        this.syncState.offset = Math.max(0, this.syncState.offset - inputSamples.length);
      }
    }
  }

  private _searchMode(currentTime: number): void {
    if (currentTime - this.syncState.lastSyncTime < 1000) {
      return;
    }

    const minSamplesNeeded = this.reference.length * this.config.samplesPerPhase * 2;
    if (this.bufferIndex < minSamplesNeeded) {
      return;
    }

    const result = modem.findSyncOffset(
      this.inputBuffer.subarray(0, this.bufferIndex),
      this.reference,
      {
        samplesPerPhase: this.config.samplesPerPhase,
        sampleRate: sampleRate,
        carrierFreq: this.config.carrierFreq
      },
      50,
      { 
        correlationThreshold: this.config.correlationThreshold, 
        peakToNoiseRatio: this.config.peakToNoiseRatio 
      }
    );

    if (result.isFound) {
      this.syncState.locked = true;
      this.syncState.mode = 'TRACK';
      this.syncState.offset = result.bestSampleOffset;
      this.syncState.chipPosition = 0;
      this.syncState.bitPosition = 0;
      this.syncState.lastLLRs = [];
      this.syncState.consecutiveWeakBits = 0;
      this.syncState.lastSyncTime = currentTime;
      this.syncState.processedBits = 0;
      this.syncState.consecutiveFailures = 0;
      this._updateSNREstimate(Math.abs(result.peakCorrelation));
      this.framer.reset();
    }
  }

  private _trackMode(): void {
    const samplesPerBit = this.reference.length * this.config.samplesPerPhase;
    const availableSamples = this.bufferIndex - this.syncState.offset;
    
    if (availableSamples < samplesPerBit) {
      return;
    }

    const bitSamples = this.inputBuffer.subarray(
      this.syncState.offset,
      this.syncState.offset + samplesPerBit
    );

    const demodResult = this._demodulateOneBit(bitSamples);
    
    if (demodResult) {
      const { llr } = demodResult;
      
      // Update LLR history
      this.syncState.lastLLRs.push(Math.abs(llr));
      if (this.syncState.lastLLRs.length > 10) {
        this.syncState.lastLLRs.shift();
      }

      // Quality monitoring
      const llrAbs = Math.abs(llr);
      const recentAvgLLR = this.syncState.lastLLRs.length > 0 ?
        this.syncState.lastLLRs.reduce((a, b) => a + b, 0) / this.syncState.lastLLRs.length : 127;

      if (recentAvgLLR > 80 && llrAbs < 30) {
        this._attemptLocalResync();
        return;
      }

      const isWeakBit = llrAbs < this.config.weakLLRThreshold;
      if (isWeakBit) {
        this.syncState.consecutiveWeakBits++;
      } else {
        this.syncState.consecutiveWeakBits = 0;
      }

      if (this.syncState.consecutiveWeakBits >= this.config.maxConsecutiveWeak) {
        this._resetSyncState();
        return;
      }

      this._processBitForFraming(llr);
      this.syncState.consecutiveFailures = 0;
      this.syncState.offset += samplesPerBit;
      this.syncState.bitPosition++;
      this.syncState.processedBits++;

      this.syncState.framesSinceLastCheck++;
      if (this.syncState.framesSinceLastCheck >= this.config.verifyIntervalFrames) {
        this.syncState.mode = 'VERIFY';
        this.syncState.framesSinceLastCheck = 0;
      }
    } else {
      this.syncState.consecutiveFailures++;
      
      if (this.syncState.consecutiveFailures >= 10) {
        this._resetSyncState();
        return;
      }
      
      this.syncState.offset += Math.floor(samplesPerBit / 4);
    }
  }

  private _verifyMode(): void {
    const recentAvgLLR = this.syncState.lastLLRs.length > 0 ?
      this.syncState.lastLLRs.reduce((a, b) => a + b, 0) / this.syncState.lastLLRs.length : 0;

    if (recentAvgLLR < this.config.weakLLRThreshold) {
      this._resetSyncState();
    } else {
      this.syncState.mode = 'TRACK';
    }
  }

  private _demodulateOneBit(bitSamples: Float32Array): { llr: number; bit: number } | null {
    try {
      const phases = modem.demodulateCarrier(
        bitSamples,
        this.config.samplesPerPhase,
        sampleRate,
        this.config.carrierFreq
      );

      if (phases.length === 0) {
        return null;
      }

      const chipLlrs = modem.dpskDemodulate(phases);
      if (chipLlrs.length === 0) {
        return null;
      }

      let adjustedChipLlrs = chipLlrs;
      if (chipLlrs.length === this.reference.length - 1) {
        adjustedChipLlrs = new Float32Array(this.reference.length);
        adjustedChipLlrs.set(chipLlrs, 0);
        adjustedChipLlrs[adjustedChipLlrs.length - 1] = chipLlrs[chipLlrs.length - 1];
      }

      const snrLinear = Math.pow(10, this.estimatedSnrDb / 10);
      const noiseVariance = 1.0 / snrLinear;

      const llrs = modem.dsssDespread(adjustedChipLlrs, this.reference.length, this.config.seed, noiseVariance);
      
      if (!llrs || llrs.length === 0) {
        return null;
      }

      const llr = llrs[0];
      const bit = llr >= 0 ? 0 : 1;

      return { llr, bit };
    } catch (error) {
      return null;
    }
  }

  private _processBitForFraming(llr: number): void {
    this.softBitAccumulator[this.accumulatorIndex] = Math.max(-127, Math.min(127, Math.round(llr)));
    this.accumulatorIndex++;
    
    if (this.accumulatorIndex >= this.ACCUMULATOR_SIZE) {
      this._feedAccumulatorToFramer();
    }
  }

  private _feedAccumulatorToFramer(): void {
    if (this.accumulatorIndex === 0) return;
    
    const softBits = this.softBitAccumulator.slice(0, this.accumulatorIndex);
    
    try {
      const decodedFrames = this.framer.process(softBits);
      
      if (decodedFrames.length > 0) {
        for (const frame of decodedFrames) {
          this.decodedUserDataBuffer.push(frame.userData);
          
          if (this.awaitingCallback) {
            this.awaitingCallback();
            this.awaitingCallback = null;
          }
        }
      }
    } catch (error) {
      // Ignore frame processing errors
    }
    
    this.accumulatorIndex = 0;
  }

  private _updateSNREstimate(peakCorrelation: number): void {
    const minCorr = 0.3;
    const maxCorr = 1.0;
    const snrRange = 20.0;

    if (peakCorrelation > minCorr) {
      const normalizedCorr = (peakCorrelation - minCorr) / (maxCorr - minCorr);
      this.estimatedSnrDb = Math.max(0, Math.min(snrRange, normalizedCorr * snrRange));
    }
  }

  private _attemptLocalResync(): void {
    const searchRange = 200;
    const startOffset = Math.max(0, this.syncState.offset - searchRange);
    const endOffset = Math.min(this.bufferIndex - this.reference.length * this.config.samplesPerPhase, 
                                this.syncState.offset + searchRange);
    
    if (startOffset >= endOffset) {
      this._resetSyncState();
      return;
    }
    
    const searchSamples = this.inputBuffer.subarray(startOffset, endOffset + this.reference.length * this.config.samplesPerPhase);
    const maxChipOffset = Math.floor((endOffset - startOffset) / this.config.samplesPerPhase);
    
    try {
      const result = modem.findSyncOffset(
        searchSamples,
        this.reference,
        {
          samplesPerPhase: this.config.samplesPerPhase,
          sampleRate: sampleRate,
          carrierFreq: this.config.carrierFreq
        },
        maxChipOffset,
        { correlationThreshold: 0.3, peakToNoiseRatio: 2.0 }
      );
      
      if (result.isFound) {
        const newOffset = startOffset + result.bestSampleOffset;
        this.syncState.offset = newOffset;
        this.syncState.consecutiveWeakBits = 0;
        this.syncState.lastLLRs = [];
        this._updateSNREstimate(Math.abs(result.peakCorrelation));
      } else {
        this._resetSyncState();
      }
    } catch (error) {
      this._resetSyncState();
    }
  }

  private _resetSyncState(): void {
    this.syncState = this._createInitialSyncState();
    this.framer.reset();
    this._feedAccumulatorToFramer();
  }
}

// Register the processor
registerProcessor('dsss-dpsk-processor', DsssDpskProcessor);