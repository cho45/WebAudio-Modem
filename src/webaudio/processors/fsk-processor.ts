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
  private outputBuffer: RingBuffer<Float32Array>;
  private demodulatedBuffer: RingBuffer<Uint8Array>;
  private pendingModulation: ChunkedModulator | null = null;
  private awaitingCallback: (() => void) | null = null;
  private instanceName: string;
  
  constructor(options?: AudioWorkletNodeOptions) {
    super();
    
    // Extract instance name from processorOptions
    this.instanceName = options?.processorOptions?.name || 'unnamed';
    
    console.log(`[FSKProcessor:${this.instanceName}] Initialized with sample rate:`, sampleRate);
    
    // Initialize FSK core (will be configured via message)
    this.fskCore = new FSKCore();
    
    // Create buffers for audio streaming
    // inputBuffer: minimal buffering for frame sync detection
    this.outputBuffer = new RingBuffer(Float32Array, 8192);

    // 復調されたデータを保持するリングバッファ
    this.demodulatedBuffer = new RingBuffer(Uint8Array, 1024);
    console.log(`[FSKProcessor:${this.instanceName}] Buffers initialized - demodulatedBuffer length:`, this.demodulatedBuffer.length);
    
    this.port.onmessage = this.handleMessage.bind(this);
  }

  async modulate(data: Uint8Array): Promise<void> {
    /**
     * 変調リクエスト: バイト列を受けとり、変調キューに入れる
     * 変調は非同期に行われ、process内で必要に応じて行われoutputに書き出される
     */
    console.log(`[FSKProcessor:${this.instanceName}] modulate() called with ${data.length} bytes: [${Array.from(data).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
   //  console.log(`[FSKProcessor:${this.instanceName}] Current demodulatedBuffer length before modulation: ${this.demodulatedBuffer.length}`);
    
    if (this.pendingModulation) {
      throw new Error('Modulation already in progress');
    }
    
    // console.log(`[FSKProcessor:${this.instanceName}] Queuing modulation of ${data.length} bytes`);
    this.pendingModulation = new ChunkedModulator(this.fskCore);
    await this.pendingModulation.startModulation(data);
  }

  async demodulate(): Promise<Uint8Array> {
      /**
       * 復調リクエスト: 復調済みのデータを返す
       * 復調自体は非同期に process 内で行われるため、復調済みのバイト列をリクエストがきたら返す
       */
      console.log(`[FSKProcessor:${this.instanceName}] === demodulate() ENTRY === buffer length: ${this.demodulatedBuffer.length}, awaitingCallback: ${!!this.awaitingCallback}`);
      
      // Return currently buffered demodulated data
      const availableBytes = this.demodulatedBuffer.length;
      if (availableBytes === 0) {
        console.log(`[FSKProcessor:${this.instanceName}] *** BUFFER EMPTY *** Setting up callback wait...`);
        console.log(`[FSKProcessor:${this.instanceName}] Previous awaitingCallback state: ${!!this.awaitingCallback}`);
        await new Promise<void>((resolve) => {
          this.awaitingCallback = resolve;
          console.log(`[FSKProcessor:${this.instanceName}] *** CALLBACK SET *** New awaitingCallback assigned`);
        });
        console.log(`[FSKProcessor:${this.instanceName}] *** CALLBACK TRIGGERED *** Buffer length now: ${this.demodulatedBuffer.length}`);
      } else {
        console.log(`[FSKProcessor:${this.instanceName}] *** BUFFER HAS DATA *** ${availableBytes} bytes available`);
      }

      const finalAvailableBytes = this.demodulatedBuffer.length;
      const demodulatedBytes = new Uint8Array(finalAvailableBytes);
      
      console.log(`[FSKProcessor:${this.instanceName}] Removing ${finalAvailableBytes} bytes from buffer:`);
      for (let i = 0; i < finalAvailableBytes; i++) {
        const byte = this.demodulatedBuffer.remove();
        demodulatedBytes[i] = byte;
        console.log(`[FSKProcessor:${this.instanceName}] Removed byte ${i}: 0x${byte.toString(16).padStart(2, '0')}`);
      }
      
      console.log(`[FSKProcessor:${this.instanceName}] === demodulate() RETURN === bytes: [${Array.from(demodulatedBytes).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
      return demodulatedBytes;
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
    console.log(`[FSKProcessor:${this.instanceName}] Received message: ${type} (ID: ${id})`, data);

    try {
      switch (type) {
        case 'configure':
          try {
            console.log(`[FSKProcessor:${this.instanceName}] Configuring FSKCore with:`, data.config);
            this.fskCore.configure(data.config);
            console.log(`[FSKProcessor:${this.instanceName}] FSKCore configured successfully, ready:`, this.fskCore.isReady());
            this.port.postMessage({ id, type: 'result', data: { success: true } });
          } catch (configError) {
            console.error(`[FSKProcessor:${this.instanceName}] Configuration error:`, configError);
            throw configError;
          }
          break;
          
        case 'modulate': {
          await this.modulate(new Uint8Array(data.bytes));
          this.port.postMessage({ id, type: 'result', data: { success: true } });
          break;
        }
          
        case 'demodulate': {
          console.log(`[FSKProcessor:${this.instanceName}] === DEMODULATE MESSAGE RECEIVED === ID: ${id}`);
          console.log(`[FSKProcessor:${this.instanceName}] Current buffer length: ${this.demodulatedBuffer.length}, awaitingCallback: ${!!this.awaitingCallback}`);
          const demodulatedBytes = await this.demodulate();
          console.log(`[FSKProcessor:${this.instanceName}] === DEMODULATE COMPLETED === ID: ${id}, bytes: ${demodulatedBytes.length}`);
          this.port.postMessage({ id, type: 'result', data: { bytes: Array.from(demodulatedBytes) } });
          break;
        }

        case 'status': {
          // Send detailed status including debug info
          const fskStatus = this.fskCore.getStatus();
          this.port.postMessage({
            id,
            type: 'result',
            data: {
              outputBufferLength: this.outputBuffer.length,
              demodulatedBufferLength: this.demodulatedBuffer.length,
              pendingModulation: !!this.pendingModulation,
              fskCoreReady: this.fskCore.isReady(),
              processDemodulationCallCount: this.processDemodulationCallCount,
              ...fskStatus
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
  
  private samplesGenerated = 0;
  
  private getNextModulationSamples(sampleCount: number): void {
    if (!this.pendingModulation) return;
    
    const result = this.pendingModulation.getNextSamples(sampleCount);
    
    if (result) {
      this.samplesGenerated += result.signal.length;
      
      // Add modulated signal to output buffer
      this.outputBuffer.writeArray(result.signal);
      
      // Log modulation start and completion
      if (this.samplesGenerated === result.signal.length) {
        console.log(`[FSKProcessor] *** MODULATION STARTED *** Total signal: ${result.totalSamples} samples`);
      }
      
      // Check if modulation is complete
      if (result.isComplete) {
        console.log(`[FSKProcessor] *** MODULATION COMPLETE *** Generated ${result.totalSamples} samples total`);
        this.pendingModulation = null;
        this.samplesGenerated = 0; // Reset for next modulation
      }
    }
  }
  

  private hasLoggedAudioInput = false;
  
  /**
   * Process incoming audio samples for demodulation
   */
  private demodulateFrom(inputSamples: Float32Array): void {
    // Check if we're receiving audio data (log only once)
    const hasNonZero = inputSamples.some(sample => Math.abs(sample) > 0.001);
    if (hasNonZero && !this.hasLoggedAudioInput) {
      // console.log(`[FSKProcessor] *** AUDIO INPUT DETECTED *** First non-zero samples received`);
      this.hasLoggedAudioInput = true;
    }
    
    // Direct processing: pass audio samples directly to FSKCore
    // FSKCore handles all buffering and stream processing internally
    this.processDemodulation(inputSamples);
  }
  
  /**
   * Generate outgoing audio samples for modulation
   */
  private modulateTo(outputSamples: Float32Array): void {
    // Fill output with zeros first
    outputSamples.fill(0);
    
    // Continue processing queued modulation if available
    if (this.pendingModulation) {
      this.getNextModulationSamples(outputSamples.length);
    }
    
    // Stream modulated audio data to output (128 samples at a time)
    this.outputBuffer.readArray(outputSamples);
  }
  
  private processDemodulationCallCount = 0;
  
  private async processDemodulation(inputSamples: Float32Array): Promise<void> {
    // Check if FSKCore is ready before processing
    if (!this.fskCore.isReady()) {
      return; // Skip processing if not configured yet
    }
    
    this.processDemodulationCallCount++;
    
    try {
      // Direct processing: pass samples directly to FSKCore
      // FSKCore handles all internal buffering and stream processing
      const demodulated = await this.fskCore.demodulateData(inputSamples);
      
      // Always log when we get actual demodulation results
      if (demodulated && demodulated.length > 0) {
        console.log(`[FSKProcessor:${this.instanceName}] *** DEMODULATION SUCCESS *** Got ${demodulated.length} bytes`);
        console.log(`[FSKProcessor:${this.instanceName}] *** CALLBACK STATUS *** awaitingCallback: ${!!this.awaitingCallback}`);
        
        // Store demodulated data
        for (const byte of demodulated) {
          this.demodulatedBuffer.put(byte);
          console.log(`[FSKProcessor:${this.instanceName}] Added byte 0x${byte.toString(16).padStart(2, '0')} to buffer, new length: ${this.demodulatedBuffer.length}`);
          
          if (this.awaitingCallback) {
            console.log(`[FSKProcessor:${this.instanceName}] *** TRIGGERING CALLBACK *** Resolving awaiting promise`);
            this.awaitingCallback();
            this.awaitingCallback = null;
            console.log(`[FSKProcessor:${this.instanceName}] *** CALLBACK COMPLETED *** awaitingCallback reset to null`);
          } else {
            console.log(`[FSKProcessor:${this.instanceName}] *** NO CALLBACK *** No one waiting for this data`);
          }
        }
      }
    } catch (error) {
      console.error(`[FSKProcessor:${this.instanceName}] Demodulation error:`, error);
    }
  }

}

// Register the processor
registerProcessor('fsk-processor', FSKProcessor);
