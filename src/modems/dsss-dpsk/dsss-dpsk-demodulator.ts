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
  
  private syncState: {
    locked: boolean;
    sampleOffset: number;
    chipOffset: number;
    lastCorrelation: number;
    consecutiveWeakBits: number;
    processedBits: number; // 復調したビット数
    targetBits: number; // 上位層から要求されているビット数
    resyncCounter: number;
  } = {
    locked: false,
    sampleOffset: 0,
    chipOffset: 0,
    lastCorrelation: 0,
    consecutiveWeakBits: 0,
    processedBits: 0,
    targetBits: 0,
    resyncCounter: 0
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
    const bufferSize = Math.floor(this.samplesPerBit * 16); // 約16ビット分
    this.sampleBuffer = new Float32Array(bufferSize);
    
    // ビットバッファは適当なサイズで
    this.bitBuffer = new Int8Array(1024);
  }
  
  /**
   * Add audio samples to the demodulator
   */
  addSamples(samples: Float32Array): void {
    // console.log(`[DsssDpskDemodulator] addSamples: Adding ${samples.length} samples. Current write: ${this.sampleWriteIndex}, read: ${this.sampleReadIndex}`);
    for (let i = 0; i < samples.length; i++) {
      this.sampleBuffer[this.sampleWriteIndex] = samples[i];
      this.sampleWriteIndex = (this.sampleWriteIndex + 1) % this.sampleBuffer.length;
      if (this.sampleWriteIndex === this.sampleReadIndex) {
        this.sampleReadIndex = (this.sampleReadIndex + 1) % this.sampleBuffer.length;
        // console.log(`[DsssDpskDemodulator] addSamples: Buffer overflow, read index advanced to ${this.sampleReadIndex}`);
      }
    }
    // console.log(`[DsssDpskDemodulator] addSamples: Finished. New write: ${this.sampleWriteIndex}, read: ${this.sampleReadIndex}, available: ${this._getAvailableSampleCount()}`);
  }
  
  /**
   * Get available demodulated bits (as LLR values)
   * @param targetBits Optional number of bits requested by upper layer
   */
  getAvailableBits(targetBits?: number): Int8Array {
    // 上位層からの要求ビット数を記録
    if (targetBits !== undefined && targetBits > 0) {
      this.syncState.targetBits = targetBits;
    }
    
    // 同期が取れていない場合、同期を試みる
    if (!this.syncState.locked) {
      // Only try to sync if enough samples are available for at least one bit
      if (this._getAvailableSampleCount() >= this.samplesPerBit) {
        this._trySync();
      }
    }
    
    // 同期が取れている場合、ビットを処理
    if (this.syncState.locked) {
      // 最大処理ビット数を制限（パフォーマンスのため）
      let processedCount = 0;
      const maxBitsPerCall = 50; // 一度の呼び出しで最大50ビット
      
      const maxIterations = 1000; // Hard limit to prevent infinite loops during debugging
      let iterationCount = 0;
      while (this._getAvailableSampleCount() >= this.samplesPerBit && processedCount < maxBitsPerCall && iterationCount < maxIterations) {
        iterationCount++;
        this._processBit();
        processedCount++;
        
        // 同期を失った場合は中断
        if (!this.syncState.locked) {
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
    this.syncState.processedBits += result.length;
    
    // 要求されたビット数に達したらtargetBitsのみリセット（processedBitsは維持）
    if (this.syncState.targetBits > 0 && this.syncState.processedBits >= this.syncState.targetBits) {
      this.syncState.targetBits = 0;
      // processedBits は維持して、その後の弱いビット検出で使用
    }
    
    return result;
  }
  
  /**
   * Get current sync state
   */
  getSyncState(): { locked: boolean; correlation: number } {
    return {
      locked: this.syncState.locked,
      correlation: this.syncState.lastCorrelation
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
      locked: false,
      sampleOffset: 0,
      chipOffset: 0,
      lastCorrelation: 0,
      consecutiveWeakBits: 0,
      processedBits: 0,
      targetBits: 0,
      resyncCounter: 0
    };
  }
  
  private _trySync(): boolean {
    // 同期検索に必要なサンプル数がバッファにあるか確認
    const minSamplesNeeded = Math.floor(this.samplesPerBit * 1.5);
    const availableCount = this._getAvailableSampleCount();

    if (availableCount < minSamplesNeeded) {
      return false;
    }

    // Create a linear view of the circular buffer for sync search
    const searchWindowSize = Math.min(availableCount, this.samplesPerBit * 3); // Search up to 3 bits worth of samples
    const searchSamples = new Float32Array(searchWindowSize);
    for (let i = 0; i < searchWindowSize; i++) {
      searchSamples[i] = this.sampleBuffer[(this.sampleReadIndex + i) % this.sampleBuffer.length];
    }

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
      console.log(`[DsssDpskDemodulator] Sync found! offset=${result.bestSampleOffset}, correlation=${result.peakCorrelation}`);
      this.syncState.locked = true;
      // result.bestSampleOffset is relative to the `searchSamples` array, which starts at `this.sampleReadIndex`.
      // So, we consume `result.bestSampleOffset` samples to align the buffer.
      this._consumeSamples(result.bestSampleOffset);
      this.syncState.sampleOffset = this.sampleReadIndex; // Update to the new absolute read index
      this.syncState.chipOffset = Math.round(this.syncState.sampleOffset / this.config.samplesPerPhase);
      this.syncState.lastCorrelation = result.peakCorrelation;
      this.syncState.resyncCounter = 0; // Reset resync counter on successful sync
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
      console.log(`[DsssDpskDemodulator] _processBit: Not enough samples for a bit. Available: ${availableCount}, Needed: ${this.samplesPerBit}`);
      return;
    }
    
    // 1ビット分のサンプルを取得
    const bitSamples = new Float32Array(this.samplesPerBit);
    for (let i = 0; i < this.samplesPerBit; i++) {
      bitSamples[i] = this.sampleBuffer[(this.sampleReadIndex + i) % this.sampleBuffer.length];
    }
    
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
      let adjustedChipLlrs: Float32Array;
      if (chipLlrs.length === this.reference.length - 1) {
        adjustedChipLlrs = new Float32Array(this.reference.length);
        adjustedChipLlrs.set(chipLlrs, 0);
        // The last chip LLR should be the same as the previous one if it's a padding.
        // Or, more robustly, it should be treated as a weak LLR.
        // For now, let's assume it's a repetition of the last valid LLR.
        adjustedChipLlrs[this.reference.length - 1] = chipLlrs[chipLlrs.length - 2];
      } else if (chipLlrs.length === this.reference.length) {
        adjustedChipLlrs = chipLlrs;
      } else {
        console.log(`[DsssDpskDemodulator] Chip length mismatch: ${chipLlrs.length} vs ${this.reference.length}. Losing sync.`);
        // 長さが合わない場合は同期をリセットし、このビット分のサンプルを消費して次に進む
        this.syncState.locked = false;
        this.syncState.lastCorrelation = 0; // 相関値もリセット
        this._consumeSamples(this.samplesPerBit); // このビット分のサンプルを消費
        return;
      }
      
      // DSSS逆拡散
      const llrs = dsssDespread(adjustedChipLlrs, this.config.sequenceLength, this.config.seed, 0.1);
      
      if (llrs && llrs.length > 0) {
        // LLRを量子化してInt8Arrayに変換
        const llr = Math.max(-127, Math.min(127, Math.round(llrs[0])));
        console.log(`[DsssDpskDemodulator] _processBit: LLR=${llr}`);
        if (this.bitBufferIndex < this.bitBuffer.length) {
          this.bitBuffer[this.bitBufferIndex++] = llr;
          
          // 処理済みビット数を更新
          this.syncState.processedBits++; // Always increment processedBits

          // 弱いビットの検出
          const weakThreshold = 10; // 適切な閾値 (以前の30から10に調整)
          console.log(`[DsssDpskDemodulator] _processBit: LLR=${llr}, weakThreshold=${weakThreshold}, abs(LLR)<weakThreshold=${Math.abs(llr) < weakThreshold}, consecutiveWeakBits=${this.syncState.consecutiveWeakBits}`);
          if (Math.abs(llr) < weakThreshold) {
            this.syncState.consecutiveWeakBits++;
            console.log(`[DsssDpskDemodulator] Weak bit detected: LLR=${llr}, consecutive=${this.syncState.consecutiveWeakBits}`);
            
            // 上位層から要求されているビット数がある場合は同期を維持
            if (this.syncState.targetBits > 0 && this.syncState.processedBits < this.syncState.targetBits) {
              // If targetBits are set and not yet reached, maintain sync regardless of weak bits
              console.log(`[DsssDpskDemodulator] Keeping sync for requested bits: ${this.syncState.processedBits}/${this.syncState.targetBits}`);
            } else if (this.syncState.consecutiveWeakBits >= 10) {
              // 要求がない場合、または要求ビット数に達した後に弱いビットが連続したら同期を失う
              console.log(`[DsssDpskDemodulator] Too many weak bits without target or after target, losing sync`);
              this.syncState.locked = false;
              this.syncState.lastCorrelation = 0;
              // Don't reset consecutiveWeakBits - keep it to show why sync was lost
              this.syncState.resyncCounter = 0;
              return;
            }
          } else {
            this.syncState.consecutiveWeakBits = 0; // 強いビットでリセット
            this.syncState.resyncCounter++; // 強いビットで再同期カウンタを増やす

            // 0 ビット周辺での再同期を試みる
             if (llr > 50 && this.syncState.resyncCounter > 10) {
               console.log(`[DsssDpskDemodulator] Strong 0-bit detected (LLR=${llr}), attempting resync after ${this.syncState.resyncCounter} strong bits`);
               this._tryResync();
             }
          }
        }
        
        // 1ビット分のサンプルを消費
        this._consumeSamples(this.samplesPerBit);
        console.log(`[DsssDpskDemodulator] _processBit: Bit processed. New read: ${this.sampleReadIndex}`);
      } else {
        console.log(`[DsssDpskDemodulator] Despread failed, losing sync`);
        // 復調失敗、同期をリセット
        this.syncState.locked = false;
        this.syncState.lastCorrelation = 0; // 相関値もリセット
        this._consumeSamples(this.samplesPerBit); // Consume a full bit to move past bad data
      }
    } catch (error) {
      console.log(`[DsssDpskDemodulator] Error in _processBit: ${error}`);
      // エラー時は同期をリセット
      this.syncState.locked = false;
      this.syncState.lastCorrelation = 0; // 相関値もリセット
      this._consumeSamples(this.samplesPerBit); // Consume a full bit to move past bad data
    }
  }
  
  private _getAvailableSampleCount(): number {
    let count;
    if (this.sampleWriteIndex >= this.sampleReadIndex) {
      count = this.sampleWriteIndex - this.sampleReadIndex;
    } else {
      count = this.sampleBuffer.length - this.sampleReadIndex + this.sampleWriteIndex;
    }
    console.log(`[DsssDpskDemodulator] _getAvailableSampleCount: write=${this.sampleWriteIndex}, read=${this.sampleReadIndex}, count=${count}`);
    return count;
  }
  
  private _consumeSamples(count: number): void {
    const availableCount = this._getAvailableSampleCount();
    const consumeCount = Math.min(count, availableCount);
    const oldReadIndex = this.sampleReadIndex;
    this.sampleReadIndex = (this.sampleReadIndex + consumeCount) % this.sampleBuffer.length;
    console.log(`[DsssDpskDemodulator] _consumeSamples: Requested=${count}, Available=${availableCount}, Consumed=${consumeCount}. Old read: ${oldReadIndex}, New read: ${this.sampleReadIndex}`);
  }

  private _setSampleReadIndex(newIndex: number): void {
    const oldReadIndex = this.sampleReadIndex;
    this.sampleReadIndex = newIndex % this.sampleBuffer.length;
    console.log(`[DsssDpskDemodulator] _setSampleReadIndex: Old read: ${oldReadIndex}, New read: ${this.sampleReadIndex}`);
  }
  
  /**
   * 再同期を試みる（0ビット周辺で相関を取り直す）
   */
  private _tryResync(): void {
    console.log(`[DsssDpskDemodulator] Attempting resync around current position`);
    
    // 直前のビット開始位置を計算（現在の読み取り位置から1ビット分戻る）
    const currentReadIndex = this.sampleReadIndex;
    const bitStartIndex = (currentReadIndex - this.samplesPerBit + this.sampleBuffer.length) % this.sampleBuffer.length;
    
    // 検索範囲を設定（前後0.5チップ = 約11.5サンプル）
    const searchRange = Math.floor(this.config.samplesPerPhase * 0.5);
    const searchStartOffset = -searchRange;
    
    // 検索に必要なサンプル数（1ビット分 + 前後の検索範囲）
    const samplesNeeded = this.samplesPerBit + searchRange * 2;
    const availableCount = this._getAvailableSampleCount();
    
    // バッファに十分なサンプルがあるか確認
    if (availableCount < samplesNeeded) {
      console.log(`[DsssDpskDemodulator] Not enough samples for resync. Available: ${availableCount}, Needed: ${samplesNeeded}`);
      return;
    }
    
    // 検索開始位置を計算（ビット開始位置の前searchRangeサンプル）
    const searchStartIndex = (bitStartIndex + searchStartOffset + this.sampleBuffer.length) % this.sampleBuffer.length;
    
    // 検索範囲のサンプルを取得
    const searchWindowSize = this.samplesPerBit + searchRange * 2;
    const searchSamples = new Float32Array(searchWindowSize);
    for (let i = 0; i < searchWindowSize; i++) {
      searchSamples[i] = this.sampleBuffer[(searchStartIndex + i) % this.sampleBuffer.length];
    }
    
    // 限定的な範囲で同期を検索
    const maxChipOffsetForSearch = Math.floor(searchRange * 2 / this.config.samplesPerPhase) + 1; // 約1チップ分
    
    const result = findSyncOffset(
      searchSamples,
      this.reference,
      {
        samplesPerPhase: this.config.samplesPerPhase,
        sampleRate: this.config.sampleRate,
        carrierFreq: this.config.carrierFreq
      },
      maxChipOffsetForSearch,
      {
        correlationThreshold: this.config.correlationThreshold * 0.8, // 再同期では閾値を少し下げる
        peakToNoiseRatio: this.config.peakToNoiseRatio * 0.8
      }
    );
    
    if (result.isFound) {
      // 新しい同期位置を計算
      const newSyncOffset = searchStartOffset + result.bestSampleOffset;
      
      // 読み取り位置を調整
      const newReadIndex = (bitStartIndex + newSyncOffset + this.sampleBuffer.length) % this.sampleBuffer.length;
      this._setSampleReadIndex(newReadIndex);
      
      // 同期状態を更新
      this.syncState.sampleOffset = newReadIndex;
      this.syncState.chipOffset = Math.round(this.syncState.sampleOffset / this.config.samplesPerPhase);
      this.syncState.lastCorrelation = result.peakCorrelation;
      this.syncState.resyncCounter = 0; // 成功したらカウンタをリセット
      
      console.log(`[DsssDpskDemodulator] Resync successful! Offset adjustment: ${newSyncOffset}, New correlation: ${result.peakCorrelation}`);
    } else {
      console.log(`[DsssDpskDemodulator] Resync failed. No valid sync found in search range.`);
    }
  }
}