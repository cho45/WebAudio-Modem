/**
 * FSK AudioWorklet Processor - Simplified using separated components
 */

/// <reference path="./types.d.ts" />

import { FSKCore } from '../../modems/fsk.js';
import { ChunkedModulator } from '../chunked-modulator.js';
import { RingBuffer } from '../../utils.js';

interface WorkletMessage {
  id: string;
  type: 'configure' | 'modulate' | 'demodulate';
  data?: any;
}

interface PendingModulation {
  id: string;
  modulator: ChunkedModulator;
}

export class FSKProcessor extends AudioWorkletProcessor {
  private fskCore: FSKCore;
  private inputBuffer: RingBuffer;
  private outputBuffer: RingBuffer;
  private pendingModulation: PendingModulation | null = null;
  private minOutputSpace = 1000;
  
  constructor() {
    super();
    this.fskCore = new FSKCore({
      sampleRate: 48000,
      baudRate: 300,
      markFreq: 1200,
      spaceFreq: 2200
    });
    this.inputBuffer = new RingBuffer(8192);
    this.outputBuffer = new RingBuffer(8192);
    this.port.onmessage = this.handleMessage.bind(this);
  }
  
  private async handleMessage(event: MessageEvent<WorkletMessage>) {
    const { id, type, data } = event.data;
    
    try {
      switch (type) {
        case 'configure':
          await this.fskCore.configure(data.config);
          this.port.postMessage({ id, type: 'result', data: { success: true } });
          break;
          
        case 'modulate':
          // For demo purposes, do direct modulation instead of chunked
          const signal = await this.fskCore.modulateData(data.bytes);
          this.port.postMessage({ id, type: 'result', data: { signal } });
          break;
          
        case 'demodulate':
          // Use provided samples for demodulation
          const samples = new Float32Array(data.samples);
          const bytes = await this.fskCore.demodulateData(samples);
          this.port.postMessage({ id, type: 'result', data: { bytes } });
          break;
          
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
    
    const { id, modulator } = this.pendingModulation;
    const result = await modulator.processNextChunk();
    
    if (result) {
      // Add modulated signal to output buffer
      this.outputBuffer.writeArray(result.signal);
      
      // Check if modulation is complete
      if (result.isComplete) {
        this.port.postMessage({ id, type: 'result', data: { success: true } });
        this.pendingModulation = null;
      }
    }
  }
  
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const input = inputs[0];
    
    // Handle input (for demodulation)
    if (input && input[0]) {
      this.inputBuffer.writeArray(input[0]);
    }
    
    // Process pending modulation chunk if buffer has space
    if (this.pendingModulation && this.outputBuffer.hasSpace(this.minOutputSpace)) {
      // Process chunk asynchronously (fire and forget)
      this.processChunk().catch(error => {
        console.error('Chunk processing error:', error);
      });
    }
    
    // Handle output (from ring buffer)
    if (output && output[0]) {
      this.outputBuffer.readArray(output[0]);
    }
    
    return true;
  }
}

// Register the processor
registerProcessor('fsk-processor', FSKProcessor);