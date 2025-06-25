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

import type { FSKCore } from './fsk-core';

export interface ChunkResult {
  signal: Float32Array;
  isComplete: boolean;
  samplesConsumed: number;
  totalSamples: number;
}

export class ChunkedModulator {
  private fskCore: FSKCore;
  private pendingSignal: Float32Array | null = null;
  private samplePosition = 0;
  
  constructor(fskCore: FSKCore) {
    this.fskCore = fskCore;
  }
  
  /**
   * Start modulation process by generating the complete signal
   * This method generates the entire modulated signal at once and stores it internally
   */
  async startModulation(data: Uint8Array): Promise<void> {
    if (data.length === 0) {
      this.pendingSignal = null;
      this.samplePosition = 0;
      return;
    }
    
    // Generate the complete modulated signal at once
    this.pendingSignal = await this.fskCore.modulateData(data);
    this.samplePosition = 0;
  }
  
  /**
   * Get the next N samples for WebAudio output
   * This is the core method that WebAudio process() will call to get chunks
   * 
   * @param sampleCount Number of samples to retrieve (typically 128 for WebAudio)
   * @returns ChunkResult with the requested samples and completion status
   */
  getNextSamples(sampleCount: number): ChunkResult | null {
    if (!this.pendingSignal) {
      return null;
    }
    
    const remaining = this.pendingSignal.length - this.samplePosition;
    if (remaining <= 0) {
      return null;
    }
    
    // Get the requested number of samples (or remaining samples if less)
    const actualSampleCount = Math.min(sampleCount, remaining);
    const signal = this.pendingSignal.slice(this.samplePosition, this.samplePosition + actualSampleCount);
    
    this.samplePosition += actualSampleCount;
    const isComplete = this.samplePosition >= this.pendingSignal.length;
    
    // Clean up when complete
    if (isComplete) {
      const totalSamples = this.pendingSignal.length;
      this.pendingSignal = null;
      this.samplePosition = 0;
      
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
  
  /**
   * Check if modulation is in progress
   */
  isModulating(): boolean {
    return this.pendingSignal !== null;
  }
  
  /**
   * Get current progress (0-1)
   */
  getProgress(): number {
    if (!this.pendingSignal) {
      return 0;
    }
    return this.samplePosition / this.pendingSignal.length;
  }
  
  /**
   * Cancel current modulation
   */
  cancel(): void {
    this.pendingSignal = null;
    this.samplePosition = 0;
  }
}
