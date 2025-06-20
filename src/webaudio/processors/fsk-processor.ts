/**
 * FSK AudioWorklet Processor - Thin wrapper for FSK operations
 */

/// <reference path="./types.d.ts" />

// AudioWorkletGlobalScope provides sampleRate as a global variable
declare const sampleRate: number;

import { FSKCore } from '../../modems/fsk';
import { ChunkedModulator } from '../chunked-modulator';
import { RingBuffer } from '../../utils';

interface WorkletMessage {
  id: string;
  type: 'configure' | 'modulate' | 'demodulate';
  data?: any;
}

export class FSKProcessor extends AudioWorkletProcessor {
  private fskCore: FSKCore;
  private inputBuffer: RingBuffer<Float32Array>;
  private outputBuffer: RingBuffer<Float32Array>;
  private demodulatedBuffer: RingBuffer<Uint8Array>;
  private pendingModulation: ChunkedModulator | null = null;
  
  constructor() {
    super();
    
    // Initialize FSK core (will be configured via message)
    this.fskCore = new FSKCore();
    
    // Create simple buffers for audio streaming
    this.inputBuffer = new RingBuffer(Float32Array, 8192);
    this.outputBuffer = new RingBuffer(Float32Array, 8192);
    this.demodulatedBuffer = new RingBuffer(Uint8Array, 1024);
    
    this.port.onmessage = this.handleMessage.bind(this);
  }
  
  private async handleMessage(event: MessageEvent<WorkletMessage>) {
    const { id, type, data } = event.data;
    
    try {
      switch (type) {
        case 'configure':
          this.fskCore.configure(data.config);
          this.port.postMessage({ id, type: 'result', data: { success: true } });
          break;
          
        case 'modulate': {
          // Create ChunkedModulator for streaming modulation
          this.pendingModulation = new ChunkedModulator(this.fskCore, data.bytes);
          this.port.postMessage({ id, type: 'result', data: { success: true } });
          break;
        }
          
        case 'demodulate': {
          // Process any pending input data
          await this.processDemodulation();
          
          // Return currently buffered demodulated data
          const availableBytes = this.demodulatedBuffer.length;
          const demodulatedBytes = new Uint8Array(availableBytes);
          for (let i = 0; i < availableBytes; i++) {
            demodulatedBytes[i] = this.demodulatedBuffer.remove();
          }
          this.port.postMessage({ id, type: 'result', data: { bytes: Array.from(demodulatedBytes) } });
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
      this.outputBuffer.writeArray(result.signal);
      
      // Check if modulation is complete
      if (result.isComplete) {
        this.pendingModulation = null;
      }
    }
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

  /**
   * Process incoming audio samples for demodulation
   */
  private demodulateFrom(inputSamples: Float32Array): void {
    // Simply buffer incoming samples - FSKCore handles the complex processing
    this.inputBuffer.writeArray(inputSamples);
  }

  /**
   * Generate outgoing audio samples for modulation
   */
  private modulateTo(outputSamples: Float32Array): void {
    // Continue processing queued modulation if available
    if (this.pendingModulation) {
      this.processChunk().catch(error => {
        console.error('Chunk processing error:', error);
      });
    }
    
    // Stream modulated audio data to output
    this.outputBuffer.readArray(outputSamples);
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
          }
          
          // Send real-time notification
          this.port.postMessage({
            id: 'realtime-demod',
            type: 'demodulated', 
            data: { bytes: Array.from(demodulated) }
          });
          
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
