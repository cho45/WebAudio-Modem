/**
 * Chunked Modulator - Generates modulated signal samples in WebAudio-compatible chunks
 * 
 * Purpose: WebAudio environment requires audio output in fixed-size chunks (typically 128 samples).
 * This class takes input data bytes, generates the complete modulated signal internally,
 * and then provides it sample-by-sample as requested by WebAudio's process() method.
 * 
 * Design: Instead of chunking the input data (bytes), this class chunks the output signal (samples).
 * This is essential because WebAudio output buffer size is fixed, but FSK signal length varies
 * based on data content and modulation parameters.
 */

import type { IModulator, BaseModulatorConfig } from '../core';

export interface ChunkResult {
  signal: Float32Array;
  isComplete: boolean;
  samplesConsumed: number;
  totalSamples: number;
}

export class ChunkedModulator<TConfig extends BaseModulatorConfig = BaseModulatorConfig> {
  private modulator: IModulator<TConfig>;
  private pendingSignal: Float32Array | null = null;
  private samplePosition = 0;

  constructor(modulator: IModulator<TConfig>) {
    this.modulator = modulator;
  }
  
  async startModulation(data: Uint8Array): Promise<void> {
    if (!data.length) {
      this.reset();
      return;
    }
    
    this.pendingSignal = await this.modulator.modulateData(data);
    this.samplePosition = 0;
  }
  
  getNextSamples(sampleCount: number): ChunkResult | null {
    if (!this.pendingSignal) return null;
    
    const remaining = this.pendingSignal.length - this.samplePosition;
    if (remaining <= 0) return null;
    
    const samplesCount = Math.min(sampleCount, remaining);
    const signal = this.pendingSignal.slice(this.samplePosition, this.samplePosition + samplesCount);
    
    this.samplePosition += samplesCount;
    const isComplete = this.samplePosition >= this.pendingSignal.length;
    
    if (isComplete) {
      const totalSamples = this.pendingSignal.length;
      this.reset();
      return {
        signal,
        isComplete: true,
        samplesConsumed: totalSamples,
        totalSamples
      };
    }
    
    return {
      signal,
      isComplete: false,
      samplesConsumed: this.samplePosition,
      totalSamples: this.pendingSignal.length
    };
  }
  
  isModulating(): boolean {
    return !!this.pendingSignal;
  }
  
  getProgress(): number {
    return this.pendingSignal ? this.samplePosition / this.pendingSignal.length : 0;
  }
  
  cancel(): void {
    this.reset();
  }
  
  private reset(): void {
    this.pendingSignal = null;
    this.samplePosition = 0;
  }
}
