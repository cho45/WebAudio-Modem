/**
 * DSSS-DPSK Demodulator Implementation
 * Streaming demodulator for DSSS+DPSK modulated signals
 */

import {
  demodulateCarrier,
  dpskDemodulate,
  dsssDespread,
  findSyncOffset,
  generateSyncReference
} from './dsss-dpsk';

// Constants for demodulator operation
const CONSTANTS = {
  // LLR thresholds for bit quality detection
  LLR: {
    WEAK_THRESHOLD: 20,          // Below this absolute value, bit is considered weak
    STRONG_ZERO_THRESHOLD: 50,   // Strong 0-bit threshold for resync trigger
  },
  
  // Sync management
  SYNC: {
    CONSECUTIVE_WEAK_LIMIT: 3,  // Max weak bits before losing sync
    RESYNC_TRIGGER_COUNT: 8,    // Strong bits needed before resync attempt
    RESYNC_RANGE_CHIPS: 0.5,     // Search range in chips for resync
    RESYNC_THRESHOLD_SCALE: 0.8, // Scale factor for resync thresholds
  },
  
  // Processing limits
  LIMITS: {
    MAX_BITS_PER_CALL: 50,       // Max bits to process per getAvailableBits call
    MAX_ITERATIONS: 1000,        // Safety limit for loops
  },
  
  // Buffer sizes
  BUFFER: {
    SAMPLE_BUFFER_BITS: 16,      // Sample buffer size in bits
    BIT_BUFFER_SIZE: 1024,       // Output bit buffer size
  },
  
  // Debug
  DEBUG: false
} as const;

// Debug logger helper
const debugLog = (...args: any[]) => {
  if (CONSTANTS.DEBUG) {
    console.log(...args);
  }
};

/**
 * Streaming DSSS-DPSK Demodulator
 * Handles physical layer processing: synchronization, demodulation, and despreading
 */
export class DsssDpskDemodulator {
  private readonly config: {
    sequenceLength: number;
    seed: number;
    samplesPerPhase: number;
    sampleRate: number;
    carrierFreq: number;
    correlationThreshold: number;
    peakToNoiseRatio: number;
  };
  
  private readonly reference: Int8Array;
  private readonly samplesPerBit: number;
  private sampleBuffer: Float32Array;
  private sampleWriteIndex: number = 0;
  private sampleReadIndex: number = 0;
  private bitBuffer: Int8Array; // LLR values
  private bitBufferIndex: number = 0;
  
  // Sync state organized by purpose
  private syncState = {
    // Core sync status
    sync: {
      locked: false,
      sampleOffset: 0,
      lastCorrelation: 0,
    },
    // Bit tracking
    bits: {
      processedCount: 0,      // 復調したビット数
      targetCount: 0,         // 上位層から要求されているビット数
      consecutiveWeakCount: 0,
      resyncCounter: 0,
    }
  };
  
  constructor(config: {
    sequenceLength?: number;
    seed?: number;
    samplesPerPhase?: number;
    sampleRate?: number;
    carrierFreq?: number;
    correlationThreshold?: number;
    peakToNoiseRatio?: number;
  } = {}) {
    this.config = {
      sequenceLength: config.sequenceLength ?? 31,
      seed: config.seed ?? 21,
      samplesPerPhase: config.samplesPerPhase ?? 23,
      sampleRate: config.sampleRate ?? 44100,
      carrierFreq: config.carrierFreq ?? 10000,
      correlationThreshold: config.correlationThreshold ?? 0.5,
      peakToNoiseRatio: config.peakToNoiseRatio ?? 4
    };
    
    this.reference = generateSyncReference(this.config.sequenceLength, this.config.seed);
    this.samplesPerBit = this.config.sequenceLength * this.config.samplesPerPhase;
    
    // バッファサイズは十分なサイズを確保（同期検索＋複数ビット分）
    const bufferSize = Math.floor(this.samplesPerBit * CONSTANTS.BUFFER.SAMPLE_BUFFER_BITS);
    this.sampleBuffer = new Float32Array(bufferSize);
    
    // ビットバッファ
    this.bitBuffer = new Int8Array(CONSTANTS.BUFFER.BIT_BUFFER_SIZE);
  }
  
  /**
   * Add audio samples to the demodulator
   */
  addSamples(samples: Float32Array): void {
    // debugLog(`[DsssDpskDemodulator] addSamples: Adding ${samples.length} samples. Current write: ${this.sampleWriteIndex}, read: ${this.sampleReadIndex}`);
    for (let i = 0; i < samples.length; i++) {
      this.sampleBuffer[this.sampleWriteIndex] = samples[i];
      this.sampleWriteIndex = (this.sampleWriteIndex + 1) % this.sampleBuffer.length;
      if (this.sampleWriteIndex === this.sampleReadIndex) {
        this.sampleReadIndex = (this.sampleReadIndex + 1) % this.sampleBuffer.length;
        // debugLog(`[DsssDpskDemodulator] addSamples: Buffer overflow, read index advanced to ${this.sampleReadIndex}`);
      }
    }
    // debugLog(`[DsssDpskDemodulator] addSamples: Finished. New write: ${this.sampleWriteIndex}, read: ${this.sampleReadIndex}, available: ${this._getAvailableSampleCount()}`);
  }
  
  /**
   * Get available demodulated bits (as LLR values)
   * @param targetBits Optional number of bits requested by upper layer
   */
  getAvailableBits(targetBits?: number): Int8Array {
    // 上位層からの要求ビット数を記録
    if (targetBits !== undefined && targetBits > 0) {
      this.syncState.bits.targetCount = targetBits;
    }
    
    // 同期が取れていない場合、同期を試みる
    if (!this.syncState.sync.locked) {
      // Only try to sync if enough samples are available for at least one bit
      if (this._getAvailableSampleCount() >= this.samplesPerBit) {
        this._trySync();
      }
    }
    
    // 同期が取れている場合、ビットを処理
    if (this.syncState.sync.locked) {
      // 最大処理ビット数を制限（パフォーマンスのため）
      let processedCount = 0;
      
      let iterationCount = 0;
      while (this._getAvailableSampleCount() >= this.samplesPerBit && processedCount < CONSTANTS.LIMITS.MAX_BITS_PER_CALL && iterationCount < CONSTANTS.LIMITS.MAX_ITERATIONS) {
        iterationCount++;
        this._processBit();
        processedCount++;
        
        // 同期を失った場合は中断
        if (!this.syncState.sync.locked) {
          break;
        }
      }
    }
    
    if (this.bitBufferIndex === 0) {
      return new Int8Array(0);
    }
    
    const result = this.bitBuffer.slice(0, this.bitBufferIndex);
    this.bitBufferIndex = 0;
    
    // 処理済みビット数を更新
    this.syncState.bits.processedCount += result.length;
    
    // 要求されたビット数に達したらtargetBitsのみリセット（processedBitsは維持）
    if (this.syncState.bits.targetCount > 0 && this.syncState.bits.processedCount >= this.syncState.bits.targetCount) {
      this.syncState.bits.targetCount = 0;
      // processedBits は維持して、その後の弱いビット検出で使用
    }
    
    return result;
  }
  
  /**
   * Get current sync state
   */
  getSyncState(): { locked: boolean; correlation: number } {
    return {
      locked: this.syncState.sync.locked,
      correlation: this.syncState.sync.lastCorrelation
    };
  }
  
  /**
   * Reset demodulator state
   */
  reset(): void {
    this.sampleBuffer.fill(0);
    this.sampleWriteIndex = 0;
    this.sampleReadIndex = 0;
    this.bitBufferIndex = 0;
    this.syncState = {
      sync: {
        locked: false,
        sampleOffset: 0,
        lastCorrelation: 0,
      },
      bits: {
        processedCount: 0,
        targetCount: 0,
        consecutiveWeakCount: 0,
        resyncCounter: 0,
      }
    };
  }
  
  private _trySync(): boolean {
    console.log(`[DsssDpskDemodulator] Attempting sync...`);
    // 同期検索に必要なサンプル数がバッファにあるか確認
    const minSamplesNeeded = Math.floor(this.samplesPerBit * 1.5);
    const availableCount = this._getAvailableSampleCount();

    if (availableCount < minSamplesNeeded) {
      return false;
    }

    // Create a linear view of the circular buffer for sync search
    const searchWindowSize = Math.min(availableCount, this.samplesPerBit * 3); // Search up to 3 bits worth of samples
    const searchSamples = this._peekSamples(searchWindowSize);

    // Max chip offset for search should be based on the search window size
    const maxChipOffset = Math.floor(searchSamples.length / this.config.samplesPerPhase);

    const result = findSyncOffset(
      searchSamples,
      this.reference,
      {
        samplesPerPhase: this.config.samplesPerPhase,
        sampleRate: this.config.sampleRate,
        carrierFreq: this.config.carrierFreq
      },
      maxChipOffset,
      {
        correlationThreshold: this.config.correlationThreshold,
        peakToNoiseRatio: this.config.peakToNoiseRatio
      }
    );

    if (result.isFound) {
      debugLog(`[DsssDpskDemodulator] Sync found! offset=${result.bestSampleOffset}, correlation=${result.peakCorrelation}`);
      this.syncState.sync.locked = true;
      // result.bestSampleOffset is relative to the `searchSamples` array, which starts at `this.sampleReadIndex`.
      // So, we consume `result.bestSampleOffset` samples to align the buffer.
      this._consumeSamples(result.bestSampleOffset);
      this.syncState.sync.sampleOffset = this.sampleReadIndex; // Update to the new absolute read index
      this.syncState.sync.lastCorrelation = result.peakCorrelation;
      this.syncState.bits.resyncCounter = 0; // Reset resync counter on successful sync
      return true;
    } else {
      // If sync not found, consume a small portion to advance and try again
      this._consumeSamples(Math.floor(this.samplesPerBit / 2));
      return false;
    }
  }
  
  private _processBit(): void {
    const availableCount = this._getAvailableSampleCount();
    
    if (availableCount < this.samplesPerBit) {
      debugLog(`[DsssDpskDemodulator] _processBit: Not enough samples for a bit. Available: ${availableCount}, Needed: ${this.samplesPerBit}`);
      return;
    }
    
    // 1ビット分のサンプルを取得
    const bitSamples = this._peekSamples(this.samplesPerBit);
    
    // デモジュレーションとデスプレッドを実行
    const llr = this._demodulateAndDespread(bitSamples);
    
    if (llr === null) {
      // デモジュレーション失敗、同期を失う
      this._loseSyncDueToError(true); // consumeBitSamples = true
      return;
    }
    
    // LLRをバッファに格納
    this._storeLLR(llr);
    
    // 弱いビットの処理と同期状態の更新
    this._updateSyncQuality(llr);
    
    // 1ビット分のサンプルを消費
    this._consumeSamples(this.samplesPerBit);
    debugLog(`[DsssDpskDemodulator] _processBit: Bit processed. New read: ${this.sampleReadIndex}`);
  }
  
  /**
   * Demodulate and despread bit samples
   */
  private _demodulateAndDespread(bitSamples: Float32Array): number | null {
    try {
      // キャリア復調
      const phases = demodulateCarrier(
        bitSamples,
        this.config.samplesPerPhase,
        this.config.sampleRate,
        this.config.carrierFreq
      );
      
      // DPSK復調
      const chipLlrs = dpskDemodulate(phases);
      
      // パディング調整
      const adjustedChipLlrs = this._adjustChipPadding(chipLlrs);
      if (!adjustedChipLlrs) {
        return null;
      }
      
      // ノイズ分散を推定
      const estimatedNoiseVariance = this._estimateNoiseVariance(adjustedChipLlrs);
      
      // DSSS逆拡散
      const llrs = dsssDespread(adjustedChipLlrs, this.config.sequenceLength, this.config.seed, estimatedNoiseVariance);
      
      if (llrs && llrs.length > 0) {
        // LLRを量子化してInt8に変換
        const llr = Math.max(-127, Math.min(127, Math.round(llrs[0])));
        debugLog(`[DsssDpskDemodulator] _demodulateAndDespread: LLR=${llr}`);
        return llr;
      } else {
        debugLog(`[DsssDpskDemodulator] Despread failed`);
        return null;
      }
    } catch (error) {
      debugLog(`[DsssDpskDemodulator] Error in _demodulateAndDespread: ${error}`);
      return null;
    }
  }
  
  /**
   * Adjust chip padding for DPSK output
   */
  private _adjustChipPadding(chipLlrs: Float32Array): Float32Array | null {
    const expectedLength = this.reference.length;
    const actualLength = chipLlrs.length;
    
    if (actualLength === expectedLength) {
      return chipLlrs;
    }
    
    if (actualLength === expectedLength - 1) {
      // DPSK demodulation produces one less chip - pad with last value
      const padded = new Float32Array(expectedLength);
      padded.set(chipLlrs, 0);
      padded[expectedLength - 1] = chipLlrs[actualLength - 1];
      return padded;
    }
    
    debugLog(`[DsssDpskDemodulator] Chip length mismatch: ${actualLength} vs ${expectedLength}`);
    return null;
  }
  
  /**
   * Store LLR value in bit buffer
   */
  private _storeLLR(llr: number): void {
    if (this.bitBufferIndex < this.bitBuffer.length) {
      this.bitBuffer[this.bitBufferIndex++] = llr;
      this.syncState.bits.processedCount++;
    }
  }
  
  /**
   * Lose sync due to demodulation error
   */
  private _loseSyncDueToError(consumeBitSamples: boolean = false): void {
    debugLog(`[DsssDpskDemodulator] Losing sync due to error`);
    this.syncState.sync.locked = false;
    this.syncState.sync.lastCorrelation = 0;
    
    if (consumeBitSamples) {
      // Move past the bad data by consuming one bit worth of samples
      this._consumeSamples(this.samplesPerBit);
    }
  }
  
  /**
   * Update sync quality based on LLR value
   */
  private _updateSyncQuality(llr: number): void {
    // 弱いビットの検出
    debugLog(`[DsssDpskDemodulator] _updateSyncQuality: LLR=${llr}, weakThreshold=${CONSTANTS.LLR.WEAK_THRESHOLD}, consecutive=${this.syncState.bits.consecutiveWeakCount}`);
    
    if (Math.abs(llr) < CONSTANTS.LLR.WEAK_THRESHOLD) {
      this.syncState.bits.consecutiveWeakCount++;
      debugLog(`[DsssDpskDemodulator] Weak bit detected: LLR=${llr}, consecutive=${this.syncState.bits.consecutiveWeakCount}`);
      
      // 上位層から要求されているビット数がある場合は同期を維持
      if (this.syncState.bits.targetCount > 0 && this.syncState.bits.processedCount < this.syncState.bits.targetCount) {
        debugLog(`[DsssDpskDemodulator] Keeping sync for requested bits: ${this.syncState.bits.processedCount}/${this.syncState.bits.targetCount}`);
      } else if (this.syncState.bits.consecutiveWeakCount >= CONSTANTS.SYNC.CONSECUTIVE_WEAK_LIMIT) {
        // 要求がない場合、または要求ビット数に達した後に弱いビットが連続したら同期を失う
        debugLog(`[DsssDpskDemodulator] Too many weak bits, losing sync`);
        this._loseSyncDueToError();
        this.syncState.bits.resyncCounter = 0;
      }
    } else {
      this.syncState.bits.consecutiveWeakCount = 0; // 強いビットでリセット
      this.syncState.bits.resyncCounter++; // 強いビットで再同期カウンタを増やす

      // 0 ビット周辺での再同期を試みる
      if (llr > CONSTANTS.LLR.STRONG_ZERO_THRESHOLD && 
          this.syncState.bits.resyncCounter > CONSTANTS.SYNC.RESYNC_TRIGGER_COUNT) {
        debugLog(`[DsssDpskDemodulator] Strong 0-bit detected (LLR=${llr}), attempting resync`);
        this._tryResync();
        this.syncState.bits.resyncCounter = 0; // 再同期後はカウンタをリセット
      }
    }
  }
  
  private _getAvailableSampleCount(): number {
    const count = this.sampleWriteIndex >= this.sampleReadIndex
      ? this.sampleWriteIndex - this.sampleReadIndex
      : this.sampleBuffer.length - this.sampleReadIndex + this.sampleWriteIndex;
    debugLog(`[DsssDpskDemodulator] _getAvailableSampleCount: write=${this.sampleWriteIndex}, read=${this.sampleReadIndex}, count=${count}`);
    return count;
  }
  
  private _consumeSamples(count: number): void {
    const availableCount = this._getAvailableSampleCount();
    const consumeCount = Math.min(count, availableCount);
    const oldReadIndex = this.sampleReadIndex;
    this.sampleReadIndex = (this.sampleReadIndex + consumeCount) % this.sampleBuffer.length;
    debugLog(`[DsssDpskDemodulator] _consumeSamples: Requested=${count}, Available=${availableCount}, Consumed=${consumeCount}. Old read: ${oldReadIndex}, New read: ${this.sampleReadIndex}`);
  }

  private _setSampleReadIndex(newIndex: number): void {
    const oldReadIndex = this.sampleReadIndex;
    this.sampleReadIndex = newIndex % this.sampleBuffer.length;
    debugLog(`[DsssDpskDemodulator] _setSampleReadIndex: Old read: ${oldReadIndex}, New read: ${this.sampleReadIndex}`);
  }
  
  /**
   * Extract samples from circular buffer without consuming them
   */
  private _peekSamples(count: number, offset: number = 0): Float32Array {
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      samples[i] = this.sampleBuffer[(this.sampleReadIndex + offset + i) % this.sampleBuffer.length];
    }
    return samples;
  }
  
  /**
   * Estimate noise variance from chip LLRs
   */
  private _estimateNoiseVariance(chipLlrs: Float32Array): number {
    if (chipLlrs.length === 0) {
      return 10.0; // Default high noise for empty input
    }
    
    // Calculate signal statistics
    let sum = 0;
    let sumSquares = 0;
    let sumAbs = 0;
    
    for (let i = 0; i < chipLlrs.length; i++) {
      const val = chipLlrs[i];
      sum += val;
      sumSquares += val * val;
      sumAbs += Math.abs(val);
    }
    
    const mean = sum / chipLlrs.length;
    const variance = (sumSquares / chipLlrs.length) - (mean * mean);
    const meanAbs = sumAbs / chipLlrs.length;
    
    // For strong DPSK signals, we expect chip values near ±1 with low variance
    // For weak/noise signals, values will be smaller and/or more variable
    
    // Base noise estimate on signal strength and consistency
    let noiseVariance;
    
    if (meanAbs > 0.8 && variance < 0.3) {
      // Strong, consistent signal - low noise
      noiseVariance = 0.1;
    } else if (meanAbs > 0.7) {
      // Good signal - moderate noise  
      noiseVariance = 1.0 + variance * 2.0;
    } else if (meanAbs > 0.4) {
      // Moderate signal - higher noise
      noiseVariance = 5.0 + variance * 5.0;
    } else {
      // Weak signal - very high noise
      noiseVariance = 10.0 + variance * 20.0;
    }
    
    // Ensure reasonable bounds
    noiseVariance = Math.max(0.01, Math.min(50.0, noiseVariance));
    
    debugLog(`[DsssDpskDemodulator] _estimateNoiseVariance: meanAbs=${meanAbs}, variance=${variance}, estimated=${noiseVariance}`);
    
    return noiseVariance;
  }
  
  /**
   * Try to resynchronize around the current bit position
   */
  private _tryResync(): void {
    debugLog(`[DsssDpskDemodulator] Attempting resync around current position`);
    
    // Search range: ±0.5 chips around the previous bit
    const searchRangeSamples = Math.floor(this.config.samplesPerPhase * CONSTANTS.SYNC.RESYNC_RANGE_CHIPS);
    const searchWindowSize = this.samplesPerBit + searchRangeSamples * 2;
    
    // Check if we have enough samples
    if (this._getAvailableSampleCount() < searchWindowSize) {
      debugLog(`[DsssDpskDemodulator] Not enough samples for resync`);
      return;
    }
    
    // Get samples centered around the previous bit
    // We go back one bit and then back half the search range
    const offsetFromCurrent = -this.samplesPerBit - searchRangeSamples;
    const searchOffset = (this.sampleBuffer.length + offsetFromCurrent) % this.sampleBuffer.length;
    const searchSamples = this._peekSamples(searchWindowSize, searchOffset);
    
    // Search in limited range (approximately 1 chip)
    const maxChipOffset = Math.ceil(searchRangeSamples * 2 / this.config.samplesPerPhase);
    
    const result = findSyncOffset(
      searchSamples,
      this.reference,
      {
        samplesPerPhase: this.config.samplesPerPhase,
        sampleRate: this.config.sampleRate,
        carrierFreq: this.config.carrierFreq
      },
      maxChipOffset,
      {
        correlationThreshold: this.config.correlationThreshold * CONSTANTS.SYNC.RESYNC_THRESHOLD_SCALE,
        peakToNoiseRatio: this.config.peakToNoiseRatio * CONSTANTS.SYNC.RESYNC_THRESHOLD_SCALE
      }
    );
    
    if (result.isFound) {
      // Adjust read position based on found sync
      const adjustmentFromSearchStart = result.bestSampleOffset;
      const totalAdjustment = offsetFromCurrent + adjustmentFromSearchStart;
      const newReadIndex = (this.sampleReadIndex + totalAdjustment + this.sampleBuffer.length) % this.sampleBuffer.length;
      
      this._setSampleReadIndex(newReadIndex);
      this.syncState.sync.sampleOffset = newReadIndex;
      this.syncState.sync.lastCorrelation = result.peakCorrelation;
      this.syncState.bits.resyncCounter = 0;
      
      debugLog(`[DsssDpskDemodulator] Resync successful! Adjustment: ${totalAdjustment} samples, correlation: ${result.peakCorrelation}`);
    } else {
      debugLog(`[DsssDpskDemodulator] Resync failed`);
    }
  }
}
