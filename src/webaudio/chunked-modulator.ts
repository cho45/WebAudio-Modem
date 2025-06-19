/**
 * Chunked Modulator - Handles large data modulation in small chunks
 * Separated from AudioWorklet for easier testing
 */

import type { FSKCore } from '../modems/fsk.js';

export interface ChunkResult {
  signal: Float32Array;
  isComplete: boolean;
  position: number;
  totalLength: number;
}

export class ChunkedModulator {
  private pendingData: Uint8Array | null = null;
  private position = 0;
  private chunkSize: number;
  
  constructor(
    private fskCore: FSKCore,
    options: { chunkSize?: number } = {}
  ) {
    this.chunkSize = options.chunkSize || 32;
  }
  
  /**
   * Start modulation of large data
   */
  startModulation(data: Uint8Array): void {
    if (data.length === 0) {
      this.pendingData = null;
      this.position = 0;
      return;
    }
    this.pendingData = data;
    this.position = 0;
  }
  
  /**
   * Process next chunk if available
   */
  async processNextChunk(): Promise<ChunkResult | null> {
    if (!this.pendingData) {
      return null;
    }
    
    const remaining = this.pendingData.length - this.position;
    if (remaining <= 0) {
      return null;
    }
    
    const chunkSize = Math.min(this.chunkSize, remaining);
    const chunk = this.pendingData.subarray(this.position, this.position + chunkSize);
    
    const signal = await this.fskCore.modulateData(chunk);
    this.position += chunkSize;
    
    const isComplete = this.position >= this.pendingData.length;
    const currentPosition = this.position;
    const totalLength = this.pendingData.length;
    
    if (isComplete) {
      this.pendingData = null;
      this.position = 0;
    }
    
    return {
      signal,
      isComplete,
      position: currentPosition,
      totalLength
    };
  }
  
  /**
   * Check if modulation is in progress
   */
  isModulating(): boolean {
    return this.pendingData !== null;
  }
  
  /**
   * Get current progress (0-1)
   */
  getProgress(): number {
    if (!this.pendingData) return 0;
    return this.position / this.pendingData.length;
  }
  
  /**
   * Cancel current modulation
   */
  cancel(): void {
    this.pendingData = null;
    this.position = 0;
  }
}