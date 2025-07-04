/**
 * DSSS-DPSK AudioWorklet Processor
 * 変調「（入力として）バイト列を受け取り、DSSS-DPSK変調を行い、音声サンプルストリームを生成して、それをoutputに書きこむこと
 * 復調「（入力として）音声サンプルストリームを受け取り、物理層の同期を確立・維持し、ビットストリーム（LLR値）を生成して、それをFramerに渡すこと」
 */

/// <reference path="./types.d.ts" />

declare const sampleRate: number;

import { IAudioProcessor, IDataChannel } from '../../core';
import { DsssDpskFramer } from '../../modems/dsss-dpsk/framer';
import * as modem from '../../modems/dsss-dpsk/dsss-dpsk';
import { DsssDpskDemodulator } from '../../modems/dsss-dpsk/dsss-dpsk';
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


class DsssDpskProcessor extends AudioWorkletProcessor implements IAudioProcessor, IDataChannel {
  private framer: DsssDpskFramer;
  private decodedUserDataBuffer: Uint8Array[] = [];
  private pendingModulation: {
    samples: Float32Array;
    index: number;
  } | null = null;
  private instanceName: string;
  private abortController: MyAbortController | null = null;

  // Safer async handling
  private modulationCompletion: { resolve: () => void; reject: (_reason?: any) => void; } | null = null;
  private demodulationCompletion: { resolve: (_data: Uint8Array) => void; reject: (_reason?: any) => void; } | null = null;
  
  // Configuration
  private config: Required<DsssDpskConfig>;
  private isConfigured = false;
  
  // Physical layer demodulator
  private demodulator: DsssDpskDemodulator;
  
  constructor(options?: AudioWorkletNodeOptions) {
    super();
    
    this.instanceName = options?.processorOptions?.name || 'dsss-dpsk-unnamed';
    console.log(`[DsssDpskProcessor:${this.instanceName}] Initialized`);
    
    // Default configuration
    this.config = {
      sequenceLength: 31,
      seed: 21, // 0b10101
      samplesPerPhase: 23,
      carrierFreq: 10000,
      correlationThreshold: 0.5,
      peakToNoiseRatio: 4,
      weakLLRThreshold: 50,
      maxConsecutiveWeak: 5,
      verifyIntervalFrames: 100
    };
    
    this.framer = new DsssDpskFramer();
    this.demodulator = new DsssDpskDemodulator({
      sequenceLength: this.config.sequenceLength,
      seed: this.config.seed,
      samplesPerPhase: this.config.samplesPerPhase,
      sampleRate: sampleRate,
      carrierFreq: this.config.carrierFreq,
      correlationThreshold: this.config.correlationThreshold,
      peakToNoiseRatio: this.config.peakToNoiseRatio
    });
    
    this.port.onmessage = this.handleMessage.bind(this);
  }


  async reset(): Promise<void> {
    this.decodedUserDataBuffer = [];
    this.pendingModulation = null;
    
    if (this.modulationCompletion) {
      this.modulationCompletion.reject(new Error('Modulation reset'));
      this.modulationCompletion = null;
    }
    if (this.demodulationCompletion) {
      this.demodulationCompletion.reject(new Error('Demodulation reset'));
      this.demodulationCompletion = null;
    }

    this.framer.reset();
    this.demodulator.reset();
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

    // Re-initialize demodulator with new configuration
    this.demodulator = new DsssDpskDemodulator({
      sequenceLength: this.config.sequenceLength,
      seed: this.config.seed,
      samplesPerPhase: this.config.samplesPerPhase,
      sampleRate: sampleRate,
      carrierFreq: this.config.carrierFreq,
      correlationThreshold: this.config.correlationThreshold,
      peakToNoiseRatio: this.config.peakToNoiseRatio
    });
    
    this.framer.reset();
    this.isConfigured = true;
  }

  private getStatus() {
    const framerStatus = this.framer.getState();
    const demodulatorState = this.demodulator.getSyncState();
    
    return {
      isConfigured: this.isConfigured,
      syncState: {
        locked: demodulatorState.locked,
        mode: demodulatorState.locked ? 'TRACK' : 'SEARCH',
        lastLLRs: [],
        consecutiveWeakBits: 0,
        framesSinceLastCheck: 0,
        lastSyncTime: 0,
        processedBits: 0,
        consecutiveFailures: 0
      },
      frameProcessingState: {
        isActive: false,
        expectedBits: 0,
        receivedBits: 0,
        mustComplete: false
      },
      sampleBufferLength: 0,
      decodedDataBufferLength: this.decodedUserDataBuffer.length,
      pendingModulation: !!this.pendingModulation,
      estimatedSnrDb: 10.0,
      framerStatus,
      config: { ...this.config }
    };
  }

  // IDataChannel implementation
  modulate(data: Uint8Array, options: {signal?: any }): Promise<void> {
    if (this.pendingModulation || this.modulationCompletion) {
      return Promise.reject(new Error('Modulation already in progress'));
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
    
    return new Promise<void>((resolve, reject) => {
      this.modulationCompletion = { resolve, reject };

      options?.signal?.addEventListener('abort', () => {
        if (this.modulationCompletion) {
          this.modulationCompletion.reject(new Error('Modulation aborted'));
          this.modulationCompletion = null;
        }
        this.pendingModulation = null;
      }, { once: true });
    });
  }

  demodulate(options: {signal?: any }): Promise<Uint8Array> {
    if (this.demodulationCompletion) {
      return Promise.reject(new Error('Demodulation already in progress'));
    }

    if (this.decodedUserDataBuffer.length > 0) {
      return Promise.resolve(this._getDemodulatedData());
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      this.demodulationCompletion = { resolve, reject };

      options?.signal?.addEventListener('abort', () => {
        if (this.demodulationCompletion) {
          this.demodulationCompletion.reject(new Error('Demodulation aborted'));
          this.demodulationCompletion = null;
        }
      }, { once: true });
    });
  }

  private _getDemodulatedData(): Uint8Array {
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
    // 物理層の復調器にサンプルを渡す
    this.demodulator.addSamples(inputSamples);
    
    // 復調されたビット（LLR）を取得してフレーマーに渡す
    const bits = this.demodulator.getAvailableBits();
    if (bits.length > 0) {
      const decodedFrames = this.framer.process(bits);
      
      // フレームが復号されたらバッファに追加
      for (const frame of decodedFrames) {
        this.decodedUserDataBuffer.push(frame.userData);
        
        // 復調待ちがあれば完了を通知
        if (this.demodulationCompletion) {
          this.demodulationCompletion.resolve(this._getDemodulatedData());
          this.demodulationCompletion = null;
        }
      }
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
        if (this.modulationCompletion) {
          this.modulationCompletion.resolve();
          this.modulationCompletion = null;
        }
        this.pendingModulation = null;
      }
    }
  }

}

// Register the processor
registerProcessor('dsss-dpsk-processor', DsssDpskProcessor);

// Export for testing
export { DsssDpskProcessor };
''
