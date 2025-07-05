/**
 * DSSS-DPSK AudioWorklet Processor
 * 
 * 責務：
 * - 変調：（入力として）バイト列を受け取り、DSSS-DPSK変調を行い、音声サンプルストリームを生成して、それをoutputに書きこむこと
 * - 復調：（入力として）音声サンプルストリームを受け取り、物理層の同期を確立・維持し、ビットストリーム（LLR値）を生成して、それをFramerに渡すこと
 * 
 * バイト列が上位層とのインターフェースである
 */

/// <reference path="./types.d.ts" />

declare const sampleRate: number;

import { IAudioProcessor, IDataChannel } from '../../core';
import { DsssDpskFramer } from '../../modems/dsss-dpsk/framer';
import * as modem from '../../modems/dsss-dpsk/dsss-dpsk';
import { DsssDpskDemodulator } from '../../modems/dsss-dpsk';
import { MyAbortController } from './myabort';

interface WorkletMessage {
  id: string;
  type: 'configure' | 'modulate' | 'demodulate' | 'reset' | 'abort';
  data?: any;
}

interface DsssDpskConfig {
  sequenceLength?: number;
  seed?: number;
  samplesPerPhase?: number;
  carrierFreq?: number;
  correlationThreshold?: number;
  peakToNoiseRatio?: number;
}

class DsssDpskProcessor extends AudioWorkletProcessor implements IAudioProcessor, IDataChannel {
  private readonly instanceName: string;
  private config: Required<DsssDpskConfig>;
  
  // Core components
  private demodulator: DsssDpskDemodulator;
  private framer: DsssDpskFramer;
  
  // Modulation state
  private pendingModulation: { samples: Float32Array; index: number } | null = null;
  
  // Demodulation state
  private decodedDataBuffer: Uint8Array[] = [];
  
  // Promise management
  private modulationPromise: { resolve: () => void; reject: (_error: Error) => void } | null = null;
  private demodulationPromise: { resolve: (_data: Uint8Array) => void; reject: (_error: Error) => void } | null = null;
  
  // Abort handling
  private abortController: MyAbortController | null = null;
  
  constructor(options?: AudioWorkletNodeOptions) {
    super();
    
    this.instanceName = options?.processorOptions?.name || 'dsss-dpsk';
    console.log(`[DsssDpskProcessor:${this.instanceName}] Initialized`);
    
    // Default configuration
    this.config = {
      sequenceLength: 31,
      seed: 21,
      samplesPerPhase: 23,
      carrierFreq: 10000,
      correlationThreshold: 0.5,
      peakToNoiseRatio: 4
    };
    
    // Initialize components
    this.framer = new DsssDpskFramer();
    this.demodulator = this.createDemodulator();
    
    // Set up message handler
    this.port.onmessage = this.handleMessage.bind(this);
  }
  
  private createDemodulator(): DsssDpskDemodulator {
    return new DsssDpskDemodulator({
      ...this.config,
      sampleRate
    });
  }
  
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    
    if (input) {
      this.processDemodulation(input);
    }
    
    if (output) {
      this.processModulation(output);
    }
    
    return true;
  }
  
  private processDemodulation(input: Float32Array): void {
    // Add samples to demodulator
    this.demodulator.addSamples(input);
    
    // Process all available bits (demodulator returns max 50 bits per call)
    let totalBitsProcessed = 0;
    const maxIterations = 100; // 防御的プログラミング
    
    for (let i = 0; i < maxIterations; i++) {
      const bits = this.demodulator.getAvailableBits();
      if (bits.length === 0) {
        break; // No more bits available
      }
      
      totalBitsProcessed += bits.length;
      
      // Debug sync state and bit processing (only log significant events)
      if (i === 0 || bits.length > 10 || !this.demodulator.getSyncState().locked) {
        const syncState = this.demodulator.getSyncState();
        console.log(`[DsssDpskProcessor] Iteration ${i}: bits=${bits.length}, sync=${syncState.locked}, correlation=${syncState.correlation.toFixed(3)}`);
      }
      
      const frames = this.framer.process(bits);
      
      // Store decoded data
      for (const frame of frames) {
        this.decodedDataBuffer.push(frame.userData);
        
        // Resolve demodulation promise if waiting
        if (this.demodulationPromise && this.decodedDataBuffer.length > 0) {
          const data = this.collectDecodedData();
          this.demodulationPromise.resolve(data);
          this.demodulationPromise = null;
        }
      }
    }
    
    // Log total bits processed if any
    if (totalBitsProcessed > 0) {
      console.log(`[DsssDpskProcessor] Total bits processed: ${totalBitsProcessed}`);
    }
  }
  
  private processModulation(output: Float32Array): void {
    output.fill(0);
    
    if (!this.pendingModulation) return;
    
    const { samples, index } = this.pendingModulation;
    const remaining = samples.length - index;
    const count = Math.min(remaining, output.length);
    
    // Copy samples to output
    output.set(samples.subarray(index, index + count));
    this.pendingModulation.index += count;
    
    // Check if modulation is complete
    if (this.pendingModulation.index >= samples.length) {
      this.pendingModulation = null;
      if (this.modulationPromise) {
        this.modulationPromise.resolve();
        this.modulationPromise = null;
      }
    }
  }
  
  private collectDecodedData(): Uint8Array {
    const totalLength = this.decodedDataBuffer.reduce((sum, data) => sum + data.length, 0);
    const result = new Uint8Array(totalLength);
    
    let offset = 0;
    for (const data of this.decodedDataBuffer) {
      result.set(data, offset);
      offset += data.length;
    }
    
    this.decodedDataBuffer = [];
    return result;
  }
  
  private async handleMessage(event: MessageEvent<WorkletMessage>): Promise<void> {
    const { id, type, data } = event.data;
    
    try {
      let result: any;
      
      switch (type) {
        case 'configure':
          this.configure(data.config);
          result = { success: true };
          break;
          
        case 'reset':
          await this.reset();
          result = { success: true };
          break;
          
        case 'abort':
          this.abort();
          result = { success: true };
          break;
          
        case 'modulate':
          this.resetAbortController();
          await this.modulate(new Uint8Array(data.bytes), { signal: this.abortController!.signal });
          result = { success: true };
          break;
          
        case 'demodulate': {
          this.resetAbortController();
          const bytes = await this.demodulate({ signal: this.abortController!.signal });
          result = { bytes: Array.from(bytes) };
          break;
        }
          
        default:
          throw new Error(`Unknown message type: ${type}`);
      }
      
      this.port.postMessage({ id, type: 'result', data: result });
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
    this.demodulator = this.createDemodulator();
    this.framer.reset();
  }
  
  async reset(): Promise<void> {
    // Clear all state
    this.pendingModulation = null;
    this.decodedDataBuffer = [];
    
    // Reset components
    this.demodulator.reset();
    this.framer.reset();
    
    // Reject pending promises
    if (this.modulationPromise) {
      this.modulationPromise.reject(new Error('Reset'));
      this.modulationPromise = null;
    }
    if (this.demodulationPromise) {
      this.demodulationPromise.reject(new Error('Reset'));
      this.demodulationPromise = null;
    }
  }
  
  private abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
  
  private resetAbortController(): void {
    this.abort();
    this.abortController = new MyAbortController();
  }
  
  // IDataChannel implementation
  async modulate(data: Uint8Array, options?: { signal?: any }): Promise<void> {
    if (this.pendingModulation || this.modulationPromise) {
      throw new Error('Modulation already in progress');
    }
    
    // データを適切なサイズのフレームに分割
    const frames: Float32Array[] = [];
    let offset = 0;
    let sequenceNumber = 0;
    
    // FECタイプに基づいて適切なペイロードサイズを選択
    let ldpcNType = 0;
    let maxPayloadSize = 7; // デフォルトは7バイト
    
    // データサイズに応じて適切なFECタイプを選択
    if (data.length > 30) {
      ldpcNType = 3;
      maxPayloadSize = 62;
    } else if (data.length > 15) {
      ldpcNType = 2;
      maxPayloadSize = 30;
    } else if (data.length > 7) {
      ldpcNType = 1;
      maxPayloadSize = 15;
    }
    
    while (offset < data.length) {
      const chunkSize = Math.min(maxPayloadSize, data.length - offset);
      const chunk = data.slice(offset, offset + chunkSize);
      
      // Build frame
      const frame = this.framer.build(chunk, {
        sequenceNumber: sequenceNumber,
        frameType: 0,
        ldpcNType: ldpcNType
      });
      
      // Generate modulated signal
      const chips = modem.dsssSpread(frame.bits, this.config.sequenceLength, this.config.seed);
      const phases = modem.dpskModulate(chips);
      const samples = modem.modulateCarrier(
        phases,
        this.config.samplesPerPhase,
        sampleRate,
        this.config.carrierFreq
      );
      
      frames.push(samples);
      offset += chunkSize;
      sequenceNumber = (sequenceNumber + 1) & 0xFF;
    }
    
    // 全フレームを結合
    const totalLength = frames.reduce((sum, frame) => sum + frame.length, 0);
    const combinedSamples = new Float32Array(totalLength);
    let writeOffset = 0;
    for (const frame of frames) {
      combinedSamples.set(frame, writeOffset);
      writeOffset += frame.length;
    }
    
    // Set up modulation state
    this.pendingModulation = { samples: combinedSamples, index: 0 };
    
    return new Promise((resolve, reject) => {
      this.modulationPromise = { resolve, reject };
      
      options?.signal?.addEventListener('abort', () => {
        this.pendingModulation = null;
        if (this.modulationPromise) {
          this.modulationPromise.reject(new Error('Aborted'));
          this.modulationPromise = null;
        }
      }, { once: true });
    });
  }
  
  async demodulate(options?: { signal?: any }): Promise<Uint8Array> {
    if (this.demodulationPromise) {
      throw new Error('Demodulation already in progress');
    }
    
    // Return immediately if data is available
    if (this.decodedDataBuffer.length > 0) {
      return this.collectDecodedData();
    }
    
    return new Promise((resolve, reject) => {
      this.demodulationPromise = { resolve, reject };
      
      options?.signal?.addEventListener('abort', () => {
        if (this.demodulationPromise) {
          this.demodulationPromise.reject(new Error('Aborted'));
          this.demodulationPromise = null;
        }
      }, { once: true });
    });
  }
}

// Register the processor
registerProcessor('dsss-dpsk-processor', DsssDpskProcessor);

// Export for testing
export { DsssDpskProcessor };