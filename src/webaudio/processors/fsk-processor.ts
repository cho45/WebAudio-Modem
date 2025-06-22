/**
 * FSK AudioWorklet Processor - Thin wrapper for FSK operations
 */

/// <reference path="./types.d.ts" />

// AudioWorkletGlobalScope provides sampleRate as a global variable
declare const sampleRate: number;

import { IAudioProcessor, IDataChannel } from '../../core';
import { FSKCore } from '../../modems/fsk';
import { ChunkedModulator } from '../chunked-modulator';
import { RingBuffer } from '../../utils';

interface WorkletMessage {
  id: string;
  type: 'configure' | 'modulate' | 'demodulate' | 'status';
  data?: any;
}

export class FSKProcessor extends AudioWorkletProcessor implements IAudioProcessor, IDataChannel {
  private fskCore: FSKCore;
  private inputBuffer: RingBuffer<Float32Array>;
  private outputBuffer: RingBuffer<Float32Array>;
  private demodulatedBuffer: RingBuffer<Uint8Array>;
  private pendingModulation: ChunkedModulator | null = null;
  private awaitingCallback: (() => void) | null = null;
  
  constructor() {
    super();
    console.log('[FSKProcessor] Initialized with sample rate:', sampleRate);
    
    // Initialize FSK core (will be configured via message)
    this.fskCore = new FSKCore();
    
    // Create simple buffers for audio streaming
    this.inputBuffer = new RingBuffer(Float32Array, 8192);
    this.outputBuffer = new RingBuffer(Float32Array, 8192);

    // 復調されたデータを保持するリングバッファ
    this.demodulatedBuffer = new RingBuffer(Uint8Array, 1024);
    
    this.port.onmessage = this.handleMessage.bind(this);
  }

  async modulate(data: Uint8Array): Promise<void> {
    /**
     * 変調リクエスト: バイト列を受けとり、変調キューに入れる
     * 変調は非同期に行われ、process内で必要に応じて行われoutputに書き出される
     */
    if (this.pendingModulation) {
      throw new Error('Modulation already in progress');
    }
    
    console.log(`[FSKProcessor] Queuing modulation of ${data.length} bytes`);
    this.pendingModulation = new ChunkedModulator(this.fskCore);
    this.pendingModulation.startModulation(data);
  }

  async demodulate(): Promise<Uint8Array> {
      /**
       * 復調リクエスト: 復調済みのデータを返す
       * 復調自体は非同期に process 内で行われるため、復調済みのバイト列をリクエストがきたら返す
       */
      // Return currently buffered demodulated data
      const availableBytes = this.demodulatedBuffer.length;
      if (availableBytes === 0) {
        await new Promise<void>((resolve) => {
          this.awaitingCallback = resolve;  
        });
      }

      const demodulatedBytes = new Uint8Array(availableBytes);
      for (let i = 0; i < availableBytes; i++) {
        demodulatedBytes[i] = this.demodulatedBuffer.remove();
      }
      return demodulatedBytes
  }
  
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];
    
    // Handle input for demodulation
    if (input && input[0]) {
      this.demodulateFrom(input[0]);
    }
    
    // Handle output for modulation
    if (output && output[0]) {
      this.modulateTo(output[0]);
    }
    
    return true;
  }

  private async handleMessage(event: MessageEvent<WorkletMessage>) {
    const { id, type, data } = event.data;
    console.log(`[FSKProcessor] Received message: ${type} (ID: ${id})`, data);

    try {
      switch (type) {
        case 'configure':
          this.fskCore.configure(data.config);
          this.port.postMessage({ id, type: 'result', data: { success: true } });
          break;
          
        case 'modulate': {
          await this.modulate(new Uint8Array(data.bytes));
          this.port.postMessage({ id, type: 'result', data: { success: true } });
          break;
        }
          
        case 'demodulate': {
          const demodulatedBytes = await this.demodulate();
          this.port.postMessage({ id, type: 'result', data: { bytes: Array.from(demodulatedBytes) } });
          break;
        }

        case 'status': {
          // Send current status of buffers
          this.port.postMessage({
            id,
            type: 'result',
            data: {
              inputBufferLength: this.inputBuffer.length,
              outputBufferLength: this.outputBuffer.length,
              demodulatedBufferLength: this.demodulatedBuffer.length,
              pendingModulation: !!this.pendingModulation
            }
          });
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
  
  private async processChunk(): Promise<void> {
    if (!this.pendingModulation) return;
    
    const result = await this.pendingModulation.processNextChunk();
    
    if (result) {
      // Add modulated signal to output buffer
      console.log(`[FSKProcessor] Processing chunk: ${result.signal.length} samples, progress: ${result.position}/${result.totalLength}`);
      this.outputBuffer.writeArray(result.signal);
      
      // Check if modulation is complete
      if (result.isComplete) {
        console.log(`[FSKProcessor] Modulation complete!`);
        this.pendingModulation = null;
      }
    }
  }
  

  /**
   * Process incoming audio samples for demodulation
   */
  private demodulateFrom(inputSamples: Float32Array): void {
    // Check if we're receiving audio data
    const hasNonZero = inputSamples.some(sample => Math.abs(sample) > 0.001);
    if (hasNonZero) {
      console.log(`[FSKProcessor] Received ${inputSamples.length} audio samples for demodulation`);
    }
    
    // Simply buffer incoming samples - FSKCore handles the complex processing
    this.inputBuffer.writeArray(inputSamples);
    this.processDemodulation();
  }

  /**
   * Generate outgoing audio samples for modulation
   */
  private modulateTo(outputSamples: Float32Array): void {
    // Fill output with zeros first
    outputSamples.fill(0);
    
    // Continue processing queued modulation if available
    if (this.pendingModulation) {
      this.processChunk().catch(error => {
        console.error('[FSKProcessor] Chunk processing error:', error);
      });
    }
    
    // Stream modulated audio data to output (128 samples at a time)
    const availableSamples = this.outputBuffer.length;
    this.outputBuffer.readArray(outputSamples);
    
    // Debug: Log when we're generating audio
    if (availableSamples > 0) {
      console.log(`[FSKProcessor] Generated ${Math.min(availableSamples, outputSamples.length)} audio samples to output`);
    }
  }
  
  private async processDemodulation(): Promise<void> {
    // Simple demodulation: delegate to FSKCore when enough samples are available
    const minSamples = 4000;
    
    if (this.inputBuffer.length >= minSamples) {
      try {
        const samples = this.inputBuffer.toArray();
        const demodulated = await this.fskCore.demodulateData(samples);
        
        if (demodulated && demodulated.length > 0) {
          // Store demodulated data
          for (const byte of demodulated) {
            this.demodulatedBuffer.put(byte);
            if (this.awaitingCallback) {
              this.awaitingCallback();
              this.awaitingCallback = null;
            }
          }
          
          // Keep overlap for continuity
          const overlapSamples = 2048;
          const keepSamples = samples.slice(-overlapSamples);
          this.inputBuffer.clear();
          this.inputBuffer.writeArray(keepSamples);
        } else if (this.inputBuffer.length > 12000) {
          // Manage buffer size
          const keepSamples = samples.slice(-8000);
          this.inputBuffer.clear();
          this.inputBuffer.writeArray(keepSamples);
        }
      } catch (error) {
        console.error('[FSKProcessor] Demodulation error:', error);
      }
    }
  }

}

// Register the processor
registerProcessor('fsk-processor', FSKProcessor);
