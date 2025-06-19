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
  private sampleCount = 0;
  private lastDemodSampleCount = 0;
  private demodIntervalSamples = 96000; // Process demodulation every ~2 seconds at 48kHz
  
  constructor() {
    super();
    // Create FSKCore without config initially
    const defaultConfig = {
      sampleRate: 48000,
      baudRate: 300,
      markFrequency: 1200,
      spaceFrequency: 2200
    };
    this.fskCore = new FSKCore(defaultConfig);
    this.fskCore.configure(defaultConfig); // Configure to set ready flag
    this.inputBuffer = new RingBuffer(8192);
    this.outputBuffer = new RingBuffer(8192);
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
      this.sampleCount += input[0].length;
      
      // Debug: Log audio level info periodically
      if (this.sampleCount % 48000 === 0) { // Every second
        const level = this.calculateAudioLevel(input[0]);
        const gain  = this.fskCore.agc.currentGain;
        const maxSample = Math.max(...Array.from(input[0]));
        const minSample = Math.min(...Array.from(input[0]));
        console.log(`[FSKProcessor] Audio: level=${level.toFixed(4)}, gain=${gain}, max=${maxSample.toFixed(4)}, min=${minSample.toFixed(4)}, buffer=${this.inputBuffer.length}`);
      }
      
      // Try demodulation periodically (every 2 seconds)
      if (this.sampleCount - this.lastDemodSampleCount > this.demodIntervalSamples) {
        this.tryDemodulation();
        this.lastDemodSampleCount = this.sampleCount;
      }
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
  
  private calculateAudioLevel(samples: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }
  
  private async tryDemodulation(): Promise<void> {
    if (this.inputBuffer.length < 8000) {
      console.log(`[FSKProcessor] Buffer too small: ${this.inputBuffer.length} < 8000`);
      return;
    }
    
    try {
      // Get samples from input buffer
      const samples = this.inputBuffer.toArray();
      
      // Calculate signal statistics
      const level = this.calculateAudioLevel(samples);
      const maxSample = Math.max(...Array.from(samples));
      const minSample = Math.min(...Array.from(samples));
      
      console.log(`[FSKProcessor] Demodulation attempt: ${samples.length} samples, level=${level.toFixed(4)}, range=[${minSample.toFixed(4)}, ${maxSample.toFixed(4)}]`);
      
      // Try to demodulate
      const demodulated = await this.fskCore.demodulateData(samples);
      
      console.log(`[FSKProcessor] Demodulation result: ${demodulated?.length || 0} bytes`);
      
      if (demodulated && demodulated.length > 0) {
        // Log the received bytes
        const bytesHex = Array.from(demodulated).map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`[FSKProcessor] 🎵 Decoded bytes: ${bytesHex}`);
        
        // Send demodulated data to main thread
        this.port.postMessage({
          id: 'realtime-demod',
          type: 'demodulated',
          data: { bytes: Array.from(demodulated) }
        });
        
        // Clear processed samples but keep some overlap
        this.inputBuffer.clear();
        this.inputBuffer.writeArray(samples.slice(-4096));
      } else {
        // Keep half the buffer for continuous processing
        const halfLength = Math.floor(samples.length / 2);
        this.inputBuffer.clear();
        this.inputBuffer.writeArray(samples.slice(halfLength));
      }
    } catch (error) {
      console.error(`[FSKProcessor] Demodulation error:`, error);
    }
  }
}

// Register the processor
registerProcessor('fsk-processor', FSKProcessor);
