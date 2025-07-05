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
  data?: {
    config?: Partial<DsssDpskConfig>;
    bytes?: number[];
  };
}

interface DsssDpskConfig {
  sequenceLength?: number;
  seed?: number;
  samplesPerPhase?: number;
  carrierFreq?: number;
  correlationThreshold?: number;
  peakToNoiseRatio?: number;
}

/**
 * DSSS-DPSK AudioWorklet Processor
 * 
 * AudioWorklet processor for DSSS-DPSK modulation and demodulation.
 * Handles real-time audio processing for Direct Sequence Spread Spectrum
 * with Differential Phase Shift Keying modulation.
 * 
 * Responsibilities:
 * - Modulation: Convert byte streams to DSSS-DPSK modulated audio
 * - Demodulation: Convert audio to synchronized bit streams for upper layers
 * - Frame processing: Integration with DsssDpskFramer for complete data recovery
 * 
 * External interface (maintained for compatibility):
 * - handleMessage: Process commands from main thread
 * - abortController: Support for operation cancellation
 * - IDataChannel: Standard modulation/demodulation interface
 * - IAudioProcessor: AudioWorklet process interface
 */
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
  
  // Debug counters
  private debugCounter = 0;
  private processCallCount = 0;
  private modulationCallCount = 0;
  private messageCount = 0;
  
  constructor(options?: AudioWorkletNodeOptions) {
    super();
    
    this.instanceName = options?.processorOptions?.name || 'dsss-dpsk';
    this.log(`Initialized`);

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

  private log(message: string): void {
    console.log(`[DsssDpskProcessor:${this.instanceName}] ${message}`);
  }
  
  private createDemodulator(): DsssDpskDemodulator {
    return new DsssDpskDemodulator({
      ...this.config,
      sampleRate
    });
  }
  
  /**
   * AudioWorklet process callback - handles real-time audio processing
   * Processes demodulation from input samples and modulation to output samples
   * @param inputs - Input audio channels (for demodulation)
   * @param outputs - Output audio channels (for modulation)
   * @returns true to continue processing
   */
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    try {
      const input = inputs[0]?.[0];
      const output = outputs[0]?.[0];
      
      // Debug: Track process calls
      this.processCallCount = (this.processCallCount || 0) + 1;
      if (this.processCallCount === 1 || this.processCallCount % 2000 === 0) {
        this.log(`process() called ${this.processCallCount} times, pendingModulation: ${!!this.pendingModulation}`);
      }
      
      // Validate input/output arrays
      if (!inputs || !outputs) {
        return true; // Continue processing even with invalid arrays
      }
      
      // Process demodulation if input is available
      if (input && input.length > 0) {
        this.processDemodulation(input);
      }
      
      // Process modulation if output is available
      if (output && output.length > 0) {
        this.processModulation(output);
      }
      
      return true;
    } catch (error) {
      // Log detailed error but continue processing to maintain AudioWorklet stability
      console.error(`[DsssDpskProcessor:${this.instanceName}] FATAL Error in process() at call #${this.processCallCount}:`, error);
      console.error(`[DsssDpskProcessor:${this.instanceName}] Error details: name=${(error as Error).name}, message=${(error as Error).message}, stack=${(error as Error).stack}`);
      return true;
    }
  }
  
  /**
   * Process input samples for demodulation
   * Feeds samples to demodulator and processes resulting bits through framer
   * @param input - Audio samples to demodulate
   */
  private processDemodulation(input: Float32Array): void {
    // Add samples to demodulator
    this.demodulator.addSamples(input);
    
    // Debug: Log input signal characteristics occasionally (static counter to avoid random)
    this.debugCounter = (this.debugCounter || 0) + 1;
    if (this.debugCounter === 1000) { // Every 1000 calls
      const inputLevel = Math.sqrt(input.reduce((sum, x) => sum + x*x, 0) / input.length);
      const maxVal = Math.max(...Array.from(input));
      this.log(`Input RMS: ${inputLevel.toFixed(4)}, max: ${maxVal.toFixed(3)}, samples: ${input.length}`);
      this.debugCounter = 0;
    }
    
    // Process all available bits (optimize for AudioWorklet performance)
    const maxIterations = 20; // Reduced for better real-time performance
    
    for (let i = 0; i < maxIterations; i++) {
      const bits = this.demodulator.getAvailableBits();
      if (bits.length === 0) {
        break; // No more bits available
      }
      
      // Debug: Log when bits are available (disabled for stability)
      // if (bits.length > 0) {
      //   this.log(`[DsssDpskProcessor] Demodulator provided ${bits.length} bits`);
      // }
      
      const frames = this.framer.process(bits);
      
      // Store decoded data efficiently
      if (frames.length > 0) {
        // this.log(`[DsssDpskProcessor] Framer produced ${frames.length} frames`);
        for (const frame of frames) {
          // this.log(`[DsssDpskProcessor] Frame data: ${frame.userData.length} bytes`);
          this.decodedDataBuffer.push(frame.userData);
        }
        
        // Resolve demodulation promise if waiting
        if (this.demodulationPromise) {
          const data = this.collectDecodedData();
          this.log(`Demodulation complete: ${data.length} bytes total`);
          this.demodulationPromise.resolve(data);
          this.demodulationPromise = null;
        }
      }
    }
  }
  
  /**
   * Process modulation output to audio samples
   * Copies modulated samples from pending buffer to output
   * @param output - Output audio buffer to fill with modulated samples
   */
  private processModulation(output: Float32Array): void {
    // Clear output first for safety
    output.fill(0);
    
    // Debug: Log modulation calls occasionally
    this.modulationCallCount = (this.modulationCallCount || 0) + 1;
    if (this.modulationCallCount === 1 || this.modulationCallCount % 1000 === 0) {
      this.log(`processModulation() called ${this.modulationCallCount} times, pendingModulation: ${!!this.pendingModulation}, output length: ${output.length}`);
    }
    
    if (!this.pendingModulation) {
      return; // No modulation in progress
    }
    
    try {
      const { samples, index } = this.pendingModulation;
      
      // Validate modulation state
      if (!samples || index < 0 || index >= samples.length) {
        this.pendingModulation = null;
        if (this.modulationPromise) {
          this.modulationPromise.reject(new Error('Invalid modulation state'));
          this.modulationPromise = null;
        }
        return;
      }
      
      const remaining = samples.length - index;
      const count = Math.min(remaining, output.length);
      
      // Copy samples to output efficiently
      if (count > 0) {
        output.set(samples.subarray(index, index + count));
        this.pendingModulation.index += count;
        
        // Debug: Log modulation progress (minimal)
        if (index === 0) {
          this.log(`Started outputting ${samples.length} samples, first values: [${Array.from(samples.slice(0,5)).map(x=>x.toFixed(3)).join(',')}]`);
        }
        if (this.pendingModulation.index >= samples.length) {
          this.log(`Completed outputting all samples`);
        }
      }
      
      // Check if modulation is complete
      if (this.pendingModulation.index >= samples.length) {
        // Safe logging: only when modulation completes
        this.log(`✓ Modulation complete: ${samples.length} samples transmitted`);
        this.pendingModulation = null;
        if (this.modulationPromise) {
          this.modulationPromise.resolve();
          this.modulationPromise = null;
        }
      }
    } catch (error) {
      // Handle modulation error gracefully
      this.pendingModulation = null;
      if (this.modulationPromise) {
        this.modulationPromise.reject(error instanceof Error ? error : new Error(String(error)));
        this.modulationPromise = null;
      }
    }
  }
  
  /**
   * Collect and combine all decoded data from buffer
   * @returns Combined byte array from all decoded frames
   */
  private collectDecodedData(): Uint8Array {
    // Optimize for common case of single buffer
    if (this.decodedDataBuffer.length === 0) {
      return new Uint8Array(0);
    }
    
    if (this.decodedDataBuffer.length === 1) {
      const result = this.decodedDataBuffer[0];
      this.decodedDataBuffer = [];
      return result;
    }
    
    // Multiple buffers: calculate total length efficiently
    let totalLength = 0;
    for (const data of this.decodedDataBuffer) {
      totalLength += data.length;
    }
    
    // Combine buffers efficiently
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const data of this.decodedDataBuffer) {
      result.set(data, offset);
      offset += data.length;
    }
    
    this.decodedDataBuffer = [];
    return result;
  }
  
  /**
   * Handle messages from main thread
   * Processes configuration, modulation, demodulation, reset, and abort commands
   * @param event - Message event containing command and data
   */
  private async handleMessage(event: MessageEvent<WorkletMessage>): Promise<void> {
    try {
      // Validate message structure
      if (!event.data || typeof event.data !== 'object') {
        console.error('[DsssDpskProcessor] Invalid message format');
        return;
      }
      
      const { id, type, data } = event.data;
      
      // Debug: Track message handling
      this.messageCount = (this.messageCount || 0) + 1;
      if (this.messageCount <= 10 || this.messageCount % 100 === 0) {
        this.log(`[DsssDpskProcessor] handleMessage #${this.messageCount}: type=${type}, id=${id}`);
      }
    
    // Validate required fields (id can be null for no-reply messages)
    if (!type) {
      console.error('[DsssDpskProcessor] Missing required message type');
      return;
    }
    
    try {
      let result: { success: boolean } | { bytes: number[] };
      
      switch (type) {
        case 'configure':
          if (!data || typeof data.config !== 'object') {
            throw new Error('Invalid configuration data');
          }
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
          if (!data || !Array.isArray(data.bytes)) {
            throw new Error('Invalid modulation data: bytes array required');
          }
          this.resetAbortController();
          await this.modulate(new Uint8Array(data.bytes), { signal: this.abortController!.signal });
          // Clear receive buffer and reset demodulator after modulation to avoid self-reception
          this.decodedDataBuffer = [];
          this.demodulator.reset();
          this.framer.reset();
          this.log('Cleared receive buffer and reset demodulator/framer after modulation to prevent echo-back');
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
      
      // Send reply only if id is not null (no-reply messages)
      if (id !== null) {
        this.port.postMessage({ id, type: 'result', data: result });
      }
    } catch (error) {
      // Send error reply only if id is not null
      if (id !== null) {
        this.port.postMessage({
          id,
          type: 'error',
          data: { message: error instanceof Error ? error.message : String(error) }
        });
      }
    }
    } catch (outerError) {
      console.error(`[DsssDpskProcessor] Outer handleMessage error:`, outerError);
      // Prevent stack overflow by not rethrowing
    }
  }
  
  /**
   * Configure processor parameters
   * @param config - Partial configuration object to merge with current config
   */
  private configure(config: Partial<DsssDpskConfig>): void {
    this.config = { ...this.config, ...config };
    this.demodulator = this.createDemodulator();
    this.framer.reset();
  }
  
  /**
   * Reset processor state
   * Clears all buffers, promises, and component state
   */
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
  
  /**
   * Abort current operations
   * Cancels any active modulation or demodulation operations
   */
  private abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
  
  /**
   * Reset abort controller
   * Creates a new abort controller for subsequent operations
   */
  private resetAbortController(): void {
    this.abort();
    this.abortController = new MyAbortController();
  }
  
  /**
   * Modulate data bytes into audio signal
   * @param data - Byte array to modulate
   * @param options - Optional configuration including abort signal
   * @returns Promise that resolves when modulation is complete
   */
  async modulate(data: Uint8Array, options?: { signal?: AbortSignal }): Promise<void> {
    this.log(`[DsssDpskProcessor] Modulation requested: ${data.length} bytes`);
    this.log(`[DsssDpskProcessor] Data: [${Array.from(data.slice(0, 16)).join(', ')}${data.length > 16 ? '...' : ''}]`);

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
      
      // Debug: Log the M-sequence used for first frame  
      // if (sequenceNumber === 0) {
      //   console.log(`[DsssDpskProcessor] TRANSMIT M-sequence (len=${this.config.sequenceLength}, seed=${this.config.seed}): first 8 chips of frame=[${Array.from(chips.slice(0, 8)).join(',')}]`);
      //   
      //   // Log the first few bits of the frame and their corresponding chip expansions
      //   const firstBits = frame.bits.slice(0, 12); // preamble(4) + syncWord start(8)
      //   console.log(`[DsssDpskProcessor] TRANSMIT frame bits: preamble+syncStart=[${Array.from(firstBits).join(',')}]`);
      //   
      //   // Show first 8 bits worth of chips - including sync word bits
      //   const chipChunks = [];
      //   for (let i = 0; i < 8; i++) {
      //     const startIdx = i * this.config.sequenceLength;
      //     const endIdx = startIdx + this.config.sequenceLength;
      //     chipChunks.push(`bit${i}(${firstBits[i]}):[${Array.from(chips.slice(startIdx, Math.min(endIdx, startIdx + 8))).join(',')}...]`);
      //   }
      //   console.log(`[DsssDpskProcessor] TRANSMIT chip expansion: ${chipChunks.join(', ')}`);
      // }
      
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
    
    this.log(`[DsssDpskProcessor] Generated ${frames.length} frames, total ${totalLength} samples`);
    
    try {
      // Safe min/max calculation for large arrays
      let minVal = combinedSamples[0];
      let maxVal = combinedSamples[0];
      for (let i = 1; i < combinedSamples.length; i++) {
        if (combinedSamples[i] < minVal) minVal = combinedSamples[i];
        if (combinedSamples[i] > maxVal) maxVal = combinedSamples[i];
      }
      this.log(`[DsssDpskProcessor] Sample range: [${minVal.toFixed(3)}, ${maxVal.toFixed(3)}]`);

      // Set up modulation state
      this.pendingModulation = { samples: combinedSamples, index: 0 };
      this.log(`[DsssDpskProcessor] ✓ pendingModulation set: ${!!this.pendingModulation}, samples length: ${this.pendingModulation.samples.length}`);

      const promise = new Promise<void>((resolve, reject) => {
        this.modulationPromise = { resolve: () => resolve(), reject };
        this.log(`[DsssDpskProcessor] ✓ Promise created, waiting for AudioWorklet processing...`);

        options?.signal?.addEventListener('abort', () => {
          this.pendingModulation = null;
          if (this.modulationPromise) {
            this.modulationPromise.reject(new Error('Aborted'));
            this.modulationPromise = null;
          }
        }, { once: true });
      });

      this.log(`[DsssDpskProcessor] ✓ Modulation setup complete, returning promise`);
      return promise;
    } catch (setupError) {
      console.error(`[DsssDpskProcessor] Error during modulation setup:`, setupError);
      throw setupError;
    }
  }
  
  /**
   * Demodulate audio signal to recover data bytes
   * @param options - Optional configuration including abort signal
   * @returns Promise that resolves with recovered byte array
   */
  async demodulate(options?: { signal?: AbortSignal }): Promise<Uint8Array> {
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
