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
  type: 'configure' | 'modulate' | 'demodulate' | 'status' | 'reset' | 'abort';
  data?: any
}

/**
 * Note:
 * AudioWorkletGlobalScope では標準の AbortController / AbortSignal が利用できません。
 * そのため、キャンセル制御には独自実装の MyAbortController / MyAbortSignal を使用しています。
 */
class MyAbortSignal {
  private _aborted = false;
  private listeners: (() => void)[] = [];
  onabort: (() => void) | null = null;

  get aborted() { return this._aborted; }

  addEventListener(type: 'abort', listener: () => void) {
    if (type === 'abort') this.listeners.push(listener);
  }

  removeEventListener(type: 'abort', listener: () => void) {
    if (type === 'abort') this.listeners = this.listeners.filter(l => l !== listener);
  }

  dispatchEvent() {
    this.onabort?.();
    this.listeners.forEach(l => l());
    this.listeners = [];
  }

  throwIfAborted() {
    if (this._aborted) throw new DOMException('Aborted', 'AbortError');
  }
}

class MyAbortController {
  signal = new MyAbortSignal();

  abort() {
    if (!this.signal.aborted) {
      (this.signal as any)._aborted = true;
      this.signal.dispatchEvent();
    }
  }
}

export class FSKProcessor extends AudioWorkletProcessor implements IAudioProcessor, IDataChannel {
  private fskCore: FSKCore;
  private demodulatedBuffer: RingBuffer<Uint8Array>;
  private pendingModulation: ChunkedModulator | null = null;
  private awaitingCallback: (() => void) | null = null;
  private modulationWaitCallback: () => void = () => {};
  private instanceName: string;
  private abortController: MyAbortController | null = null;
  
  constructor(options?: AudioWorkletNodeOptions) {
    super();
    
    // Extract instance name from processorOptions
    this.instanceName = options?.processorOptions?.name || 'unnamed';
    
    console.log(`[FSKProcessor:${this.instanceName}] Initialized with sample rate:`, sampleRate);
    
    // Initialize FSK core (will be configured via message)
    this.fskCore = new FSKCore();
    
    // 復調されたデータを保持するリングバッファ
    this.demodulatedBuffer = new RingBuffer(Uint8Array, 1024);
    
    this.port.onmessage = this.handleMessage.bind(this);
  }

  async modulate(data: Uint8Array, options: {signal: AbortSignal }): Promise<void> {
    console.log(`[FSKProcessor:${this.instanceName}] modulate() called with ${data.length} bytes: [${Array.from(data).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
    
    if (this.pendingModulation) {
      throw new Error('Modulation already in progress');
    }
    
    this.pendingModulation = new ChunkedModulator(this.fskCore);
    await this.pendingModulation.startModulation(data);
    await new Promise<void>((resolve, reject) => {
      const handleAbort = () => {
        console.warn(`[FSKProcessor:${this.instanceName}] Modulation aborted`);
        this.pendingModulation = null;
        this.modulationWaitCallback = () => {};
        reject(new Error('FSK Processor Modulation aborted'));
      };
      this.modulationWaitCallback = () => {
        options?.signal.removeEventListener('abort', handleAbort);
        resolve();
      }
      options?.signal.addEventListener('abort', handleAbort, { once: true });
    });
  }

  async demodulate(options: {signal: AbortSignal }): Promise<Uint8Array> {
      // Return currently buffered demodulated data
      const availableBytes = this.demodulatedBuffer.length;
      if (availableBytes === 0) {
        await new Promise<void>((resolve, reject) => {
          this.awaitingCallback = resolve;
          options?.signal.addEventListener('abort', () => {
            this.awaitingCallback = null;
            reject(new Error('Demodulation aborted'));
          }, { once: true });
        });
      }

      const finalAvailableBytes = this.demodulatedBuffer.length;
      const demodulatedBytes = new Uint8Array(finalAvailableBytes);
      
      for (let i = 0; i < finalAvailableBytes; i++) {
        const byte = this.demodulatedBuffer.remove();
        demodulatedBytes[i] = byte;
      }
      
      return demodulatedBytes;
  }

  async reset(): Promise<void> {
      console.log(`[FSKProcessor:${this.instanceName}] Resetting FSKProcessor state`);
      this.demodulatedBuffer.clear();
      this.pendingModulation = null;
      this.awaitingCallback = null;
      this.modulationWaitCallback = () => {};
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
    
    // Handle input for demodulation
    if (input?.[0]) {
      this.demodulateFrom(input[0]);
    }
    
    // Handle output for modulation
    if (output?.[0]) {
      this.modulateTo(output[0]);
    }
    
    return true;
  }

  private async handleMessage(event: MessageEvent<WorkletMessage>) {
    const { id, type, data } = event.data;

    try {
      switch (type) {
        case 'configure':
          try {
            this.fskCore.configure(data.config);
            console.log(`[FSKProcessor:${this.instanceName}] FSKCore configured successfully, ready:`, this.fskCore.isReady());
            this.port.postMessage({ id, type: 'result', data: { success: true } });
          } catch (configError) {
            console.error(`[FSKProcessor:${this.instanceName}] Configuration error:`, configError);
            throw configError;
          }
          break;
        case 'reset': {
          console.log(`[FSKProcessor:${this.instanceName}] Resetting FSKProcessor state`);
          await this.reset();
          this.port.postMessage({ id, type: 'result', data: { success: true } });
          break;
        }

        case 'abort': {
          // Handle abort signal
          if (this.abortController) {
            console.warn(`[FSKProcessor:${this.instanceName}] Received abort signal`);
            this.abortController.abort();
            this.abortController = null;
          }
          if (id) this.port.postMessage({ id, type: 'result', data: { success: true } });
          break;
        }

        case 'modulate': {
          this.resetAbortController();
          // console.log(`[FSKProcessor:${this.instanceName}] Modulating ${data.bytes.length} bytes: [${data.bytes.map((b: number) => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
          // @ts-expect-error 
          await this.modulate(new Uint8Array(data.bytes), { signal: this.abortController!.signal });
          // Clear receive buffer after modulation to avoid self-reception
          this.demodulatedBuffer.clear();
          this.port.postMessage({ id, type: 'result', data: { success: true } });
          break;
        }
          
        case 'demodulate': {
          this.resetAbortController();
          // console.log(`[FSKProcessor:${this.instanceName}] Demodulating data request received`);
          // @ts-expect-error 
          const demodulatedBytes = await this.demodulate({ signal: this.abortController!.signal });
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
  

  private hasLoggedAudioInput = false;
  
  private demodulateFrom(inputSamples: Float32Array): void {
    // Check if we're receiving audio data (log only once)
    const hasNonZero = inputSamples.some(sample => Math.abs(sample) > 0.001);
    if (hasNonZero && !this.hasLoggedAudioInput) {
      this.hasLoggedAudioInput = true;
    }
    
    // Direct processing: pass audio samples directly to FSKCore
    // FSKCore handles all buffering and stream processing internally
    this.processDemodulation(inputSamples);
  }
  
  private modulateTo(outputSamples: Float32Array): void {
    // Fill output with zeros first
    outputSamples.fill(0);
    
    // Generate modulated signal directly to output
    if (this.pendingModulation) {
      const result = this.pendingModulation.getNextSamples(outputSamples.length);
      
      if (result) {
        this.samplesGenerated += result.signal.length;
        
        // Copy signal directly to output buffer
        outputSamples.set(result.signal);
        
        // Check if modulation is complete
        if (result.isComplete) {
          this.pendingModulation = null;
          this.samplesGenerated = 0; // Reset for next modulation
          this.modulationWaitCallback();
        }
      }
    }
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
        // Store demodulated data
        for (const byte of demodulated) {
          this.demodulatedBuffer.put(byte);
          
          if (this.awaitingCallback) {
            this.awaitingCallback();
            this.awaitingCallback = null;
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
