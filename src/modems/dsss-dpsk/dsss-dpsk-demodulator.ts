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
  // Frame structure
  FRAME: {
    PREAMBLE_BITS: 4,            // プリアンブルのビット数
    SYNC_WORD_BITS: 8,           // 同期ワードのビット数
    SYNC_VALIDATION_BITS: 12,    // 同期検証に必要なビット数 (preamble + sync word)
    SYNC_WORD: [1, 0, 1, 1, 0, 1, 0, 0], // 期待する同期ワード (0xB4)
    SYNC_WORD_THRESHOLD: 0.75,   // 同期ワード一致率の閾値
  },
  
  // LLR thresholds for bit quality detection
  LLR: {
    WEAK_THRESHOLD: 20,          // Below this absolute value, bit is considered weak
    STRONG_ZERO_THRESHOLD: 50,   // Strong 0-bit threshold for resync trigger
    QUANTIZATION_MIN: -127,      // LLR量子化の最小値
    QUANTIZATION_MAX: 127,       // LLR量子化の最大値
  },
  
  // Sync management
  SYNC: {
    CONSECUTIVE_WEAK_LIMIT: 3,   // Max weak bits before losing sync
    RESYNC_TRIGGER_COUNT: 8,     // Strong bits needed before resync attempt
    RESYNC_RANGE_CHIPS: 0.5,     // Search range in chips for resync
    RESYNC_THRESHOLD_SCALE: 0.8, // Scale factor for resync thresholds
    MIN_SEARCH_WINDOW_BITS: 1.5, // 同期検索に必要な最小ウィンドウサイズ（ビット単位）
    SEARCH_WINDOW_BITS: 3,       // 同期検索ウィンドウサイズ（ビット単位）
  },
  
  // Processing limits
  LIMITS: {
    MAX_BITS_PER_CALL: 50,       // Max bits to process per getAvailableBits call
    MAX_ITERATIONS: 1000,        // Safety limit for loops
  },
  
  // Buffer sizes
  BUFFER: {
    SAMPLE_BUFFER_BITS: 32,      // Sample buffer size in bits (for sync validation + processing)
    BIT_BUFFER_SIZE: 1024,       // Output bit buffer size
  },
  
  // Debug
  DEBUG: true,
  
  // Noise estimation thresholds
  NOISE_ESTIMATION: {
    STRONG_SIGNAL_THRESHOLD: 0.8,     // 強い信号の閾値
    GOOD_SIGNAL_THRESHOLD: 0.7,       // 良好な信号の閾値
    MODERATE_SIGNAL_THRESHOLD: 0.4,   // 中程度の信号の閾値
    LOW_VARIANCE_THRESHOLD: 0.3,      // 低分散の閾値
    DEFAULT_HIGH_NOISE: 10.0,         // 空入力時のデフォルト高ノイズ
    STRONG_SIGNAL_NOISE: 0.1,         // 強い信号時のノイズレベル
    GOOD_SIGNAL_BASE_NOISE: 1.0,      // 良好な信号のベースノイズ
    MODERATE_SIGNAL_BASE_NOISE: 5.0,  // 中程度の信号のベースノイズ
    WEAK_SIGNAL_BASE_NOISE: 10.0,     // 弱い信号のベースノイズ
    GOOD_SIGNAL_VARIANCE_SCALE: 2.0,  // 良好な信号の分散スケール
    MODERATE_SIGNAL_VARIANCE_SCALE: 5.0, // 中程度の信号の分散スケール
    WEAK_SIGNAL_VARIANCE_SCALE: 20.0, // 弱い信号の分散スケール
  }
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
  
  // 同期状態
  private isLocked: boolean = false;
  private sampleOffset: number = 0;
  private correlation: number = 0;
  
  // 品質管理
  private consecutiveWeakCount: number = 0;
  private resyncCounter: number = 0;
  
  // 処理管理
  private processedCount: number = 0;
  private targetCount: number = 0;
  
  // パフォーマンス最適化用
  private cachedNoiseVariance: number = 1.0;
  private noiseUpdateCounter: number = 0;
  private readonly NOISE_UPDATE_INTERVAL = 10;
  
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
    for (let i = 0; i < samples.length; i++) {
      this.sampleBuffer[this.sampleWriteIndex] = samples[i];
      this.sampleWriteIndex = (this.sampleWriteIndex + 1) % this.sampleBuffer.length;
      if (this.sampleWriteIndex === this.sampleReadIndex) {
        this.sampleReadIndex = (this.sampleReadIndex + 1) % this.sampleBuffer.length;
      }
    }
  }
  
  /**
   * Get available demodulated bits (as LLR values)
   * @param targetBits Optional number of bits requested by upper layer
   */
  getAvailableBits(targetBits?: number): Int8Array {
    // 上位層からの要求ビット数を記録
    if (targetBits !== undefined && targetBits > 0) {
      this.targetCount = targetBits;
    }
    
    // 同期が取れていない場合、同期を試みる
    if (!this.isLocked) {
      // フレーム構造検証に必要なサンプルが揃ってから同期開始
      const requiredSamples = this.samplesPerBit * CONSTANTS.FRAME.SYNC_VALIDATION_BITS;
      if (this._getAvailableSampleCount() >= requiredSamples) {
        this._trySync();
      }
    }
    
    // 同期が取れている場合、ビットを処理
    if (this.isLocked) {
      // 最大処理ビット数を制限（パフォーマンスのため）
      let processedCount = 0;
      
      let iterationCount = 0;
      while (this._getAvailableSampleCount() >= this.samplesPerBit && processedCount < CONSTANTS.LIMITS.MAX_BITS_PER_CALL && iterationCount < CONSTANTS.LIMITS.MAX_ITERATIONS) {
        iterationCount++;
        this._processBit();
        processedCount++;
        
        // 同期を失った場合は中断
        if (!this.isLocked) {
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
    this.processedCount += result.length;
    
    // 要求されたビット数に達したらtargetBitsのみリセット（processedBitsは維持）
    if (this.targetCount > 0 && this.processedCount >= this.targetCount) {
      this.targetCount = 0;
      // processedBits は維持して、その後の弱いビット検出で使用
    }
    
    return result;
  }
  
  /**
   * Get current sync state
   */
  getSyncState(): { locked: boolean; correlation: number } {
    return {
      locked: this.isLocked,
      correlation: this.correlation
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
    this.isLocked = false;
    this.sampleOffset = 0;
    this.correlation = 0;
    this.consecutiveWeakCount = 0;
    this.resyncCounter = 0;
    this.processedCount = 0;
    this.targetCount = 0;
  }

  /**
   * Clear internal buffers while preserving sync state
   * Used for testing and specific operational scenarios
   */
  clearBuffers(): void {
    this.sampleBuffer.fill(0);
    this.sampleWriteIndex = 0;
    this.sampleReadIndex = 0;
    this.bitBuffer.fill(0);
    this.bitBufferIndex = 0;
    // Preserve sync state - only clear buffers
  }
  
  private _trySync(): boolean {
    // 同期検索に必要なサンプル数がバッファにあるか確認
    const minSamplesNeeded = Math.floor(this.samplesPerBit * CONSTANTS.SYNC.MIN_SEARCH_WINDOW_BITS);
    const availableCount = this._getAvailableSampleCount();

    if (availableCount < minSamplesNeeded) {
      return false;
    }

    // Create a linear view of the circular buffer for sync search
    const searchWindowSize = Math.min(availableCount, this.samplesPerBit * CONSTANTS.SYNC.SEARCH_WINDOW_BITS);
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
      // 同期位置を確定（12ビット分のサンプルが揃っていることが保証済み）
      const syncOffset = this.sampleReadIndex + result.bestSampleOffset;
      this.correlation = result.peakCorrelation;
      this.resyncCounter = 0; // Reset resync counter on successful sync
      
      debugLog(`[DsssDpskDemodulator] SYNC FOUND: offset=${syncOffset}, correlation=${result.peakCorrelation.toFixed(4)}`);
      
      // 同期ワード検証を実行
      const validationResult = this._validateSyncAtOffset(syncOffset);
      if (validationResult === 'SUCCESS') {
        // 同期ワード検証成功 → 同期確立
        debugLog(`[DsssDpskDemodulator] SYNC VALIDATION: SUCCESS`);
        this._confirmSyncAtOffset(syncOffset);
        return true;
      } else {
        // 検証失敗 → 次の候補を探索
        debugLog(`[DsssDpskDemodulator] SYNC VALIDATION: FAILED`);
        // この候補位置を消費して次を探索
        this._consumeSamples(result.bestSampleOffset + 1);
        return false;
      }
    } else {
      // If sync not found, consume a small portion to advance and try again
      this._consumeSamples(Math.floor(this.samplesPerBit / 2));
      return false;
    }
  }
  
  private _processBit(): void {
    const availableCount = this._getAvailableSampleCount();
    
    if (availableCount < this.samplesPerBit) {
      return;
    }
    
    // デモジュレーションとデスプレッドをゼロコピーで実行
    const llr = this._demodulateAndDespreadZeroCopy(this.samplesPerBit, 0);
    
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
  }
  
  /**
   * Demodulate and despread bit samples with zero-copy optimization
   * Directly processes samples from circular buffer without memory allocation
   */
  private _demodulateAndDespreadZeroCopy(sampleCount: number, offset: number): number | null {
    try {
      const numPhases = Math.floor(sampleCount / this.config.samplesPerPhase);
      const phases = new Float32Array(numPhases);
      
      // キャリア復調（ゼロコピー）
      this._demodulateCarrierZeroCopy(sampleCount, offset, phases);
      
      // DPSK復調
      const chipLlrs = dpskDemodulate(phases);
      
      // パディング調整
      const adjustedChipLlrs = this._adjustChipPadding(chipLlrs);
      if (!adjustedChipLlrs) {
        return null;
      }
      
      // ノイズ分散をキャッシュで取得（高速化）
      const estimatedNoiseVariance = this._getNoiseVariance(adjustedChipLlrs);
      
      // DSSS逆拡散
      const llrs = dsssDespread(adjustedChipLlrs, this.config.sequenceLength, this.config.seed, estimatedNoiseVariance);
      
      if (llrs && llrs.length > 0) {
        // LLRを量子化してInt8に変換
        const llr = Math.max(CONSTANTS.LLR.QUANTIZATION_MIN, Math.min(CONSTANTS.LLR.QUANTIZATION_MAX, Math.round(llrs[0])));
        return llr;
      } else {
        debugLog(`[DsssDpskDemodulator] Despread failed`);
        return null;
      }
    } catch (error) {
      debugLog(`[DsssDpskDemodulator] Error in _demodulateAndDespreadZeroCopy: ${error}`);
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
      this.processedCount++;
    }
  }
  
  /**
   * Lose sync due to demodulation error
   */
  private _loseSyncDueToError(consumeBitSamples: boolean = false): void {
    debugLog(`[DsssDpskDemodulator] Losing sync due to error`);
    this.isLocked = false;
    this.correlation = 0;
    
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
    debugLog(`[DsssDpskDemodulator] _updateSyncQuality: LLR=${llr}, weakThreshold=${CONSTANTS.LLR.WEAK_THRESHOLD}, consecutive=${this.consecutiveWeakCount}`);
    
    if (Math.abs(llr) < CONSTANTS.LLR.WEAK_THRESHOLD) {
      this.consecutiveWeakCount++;
      debugLog(`[DsssDpskDemodulator] Weak bit detected: LLR=${llr}, consecutive=${this.consecutiveWeakCount}`);
      
      // 上位層から要求されているビット数がある場合は同期を維持
      if (this.targetCount > 0 && this.processedCount < this.targetCount) {
        debugLog(`[DsssDpskDemodulator] Keeping sync for requested bits: ${this.processedCount}/${this.targetCount}`);
      } else if (this.consecutiveWeakCount >= CONSTANTS.SYNC.CONSECUTIVE_WEAK_LIMIT) {
        // 要求がない場合、または要求ビット数に達した後に弱いビットが連続したら同期を失う
        debugLog(`[DsssDpskDemodulator] Too many weak bits, losing sync`);
        this._loseSyncDueToError();
        this.resyncCounter = 0;
      }
    } else {
      this.consecutiveWeakCount = 0; // 強いビットでリセット
      this.resyncCounter++; // 強いビットで再同期カウンタを増やす

      // 0 ビット周辺での再同期を試みる
      if (llr > CONSTANTS.LLR.STRONG_ZERO_THRESHOLD && 
          this.resyncCounter > CONSTANTS.SYNC.RESYNC_TRIGGER_COUNT) {
        debugLog(`[DsssDpskDemodulator] Strong 0-bit detected (LLR=${llr}), attempting resync`);
        this._tryResync();
        this.resyncCounter = 0; // 再同期後はカウンタをリセット
      }
    }
  }
  
  private _getAvailableSampleCount(): number {
    const count = this.sampleWriteIndex >= this.sampleReadIndex
      ? this.sampleWriteIndex - this.sampleReadIndex
      : this.sampleBuffer.length - this.sampleReadIndex + this.sampleWriteIndex;
    return count;
  }
  
  private _consumeSamples(count: number): void {
    const availableCount = this._getAvailableSampleCount();
    const consumeCount = Math.min(count, availableCount);
    this.sampleReadIndex = (this.sampleReadIndex + consumeCount) % this.sampleBuffer.length;
  }

  private _setSampleReadIndex(newIndex: number): void {
    this.sampleReadIndex = newIndex % this.sampleBuffer.length;
  }
  
  /**
   * Process samples from circular buffer without copying (zero-copy)
   * @param count Number of samples to process
   * @param offset Offset from current read position (default: 0)
   * @param processor Callback function to process each sample
   */
  private _processSamplesZeroCopy(
    count: number, 
    offset: number, 
    processor: (sample: number, index: number) => void
  ): void {
    const startIndex = (this.sampleReadIndex + offset) % this.sampleBuffer.length;
    
    if (startIndex + count <= this.sampleBuffer.length) {
      // 連続領域 - 高速処理
      for (let i = 0; i < count; i++) {
        processor(this.sampleBuffer[startIndex + i], i);
      }
    } else {
      // 分割領域 - 2つのセグメントを順次処理
      const firstPartSize = this.sampleBuffer.length - startIndex;
      
      // 第1セグメント
      for (let i = 0; i < firstPartSize; i++) {
        processor(this.sampleBuffer[startIndex + i], i);
      }
      
      // 第2セグメント
      for (let i = 0; i < count - firstPartSize; i++) {
        processor(this.sampleBuffer[i], firstPartSize + i);
      }
    }
  }
  
  /**
   * Extract samples from circular buffer without consuming them
   * Optimized for large sample counts by minimizing modulo operations
   * @param count Number of samples to extract
   * @param offset Offset from current read position (default: 0)
   */
  private _peekSamples(count: number, offset: number = 0): Float32Array {
    const samples = new Float32Array(count);
    const startIndex = (this.sampleReadIndex + offset) % this.sampleBuffer.length;
    
    if (startIndex + count <= this.sampleBuffer.length) {
      // データが連続している場合 - 高速コピー
      samples.set(this.sampleBuffer.subarray(startIndex, startIndex + count));
    } else {
      // データが分割されている場合 - 2つの部分に分けてコピー
      const firstPartSize = this.sampleBuffer.length - startIndex;
      const secondPartSize = count - firstPartSize;
      
      samples.set(this.sampleBuffer.subarray(startIndex, this.sampleBuffer.length), 0);
      samples.set(this.sampleBuffer.subarray(0, secondPartSize), firstPartSize);
    }
    
    return samples;
  }
  
  /**
   * Demodulate carrier with zero-copy sample access (inlined version)
   * @param sampleCount Number of samples to process
   * @param offset Offset from current read position
   * @param outputPhases Output phase array
   * @param startSample Starting sample number for phase continuity
   */
  private _demodulateCarrierZeroCopy(
    sampleCount: number,
    offset: number,
    outputPhases: Float32Array,
    startSample: number = 0
  ): void {
    const omega = 2 * Math.PI * this.config.carrierFreq / this.config.sampleRate;
    const numPhases = Math.floor(sampleCount / this.config.samplesPerPhase);
    
    // 各位相シンボルを個別に処理
    for (let phaseIdx = 0; phaseIdx < numPhases; phaseIdx++) {
      const symbolStart = phaseIdx * this.config.samplesPerPhase;
      let iSum = 0; // In-phase
      let qSum = 0; // Quadrature
      
      // I/Q成分をシンボル期間で積分（ゼロコピー）
      this._processSamplesZeroCopy(
        this.config.samplesPerPhase,
        offset + symbolStart,
        (sample, index) => {
          const sampleIndex = startSample + symbolStart + index;
          const carrierPhase = omega * sampleIndex;
          
          iSum += sample * Math.sin(carrierPhase);
          qSum += sample * Math.cos(carrierPhase);
        }
      );
      
      // シンボル期間で平均化
      const iAvg = iSum / this.config.samplesPerPhase;
      const qAvg = qSum / this.config.samplesPerPhase;
      
      // atan2(Q, I)で位相抽出
      outputPhases[phaseIdx] = Math.atan2(qAvg, iAvg);
    }
  }
  
  /**
   * Get noise variance with caching for performance
   */
  private _getNoiseVariance(chipLlrs: Float32Array): number {
    // キャッシュ更新频度制御（N回に1回のみ更新）
    if (this.noiseUpdateCounter % this.NOISE_UPDATE_INTERVAL === 0) {
      this.cachedNoiseVariance = this._estimateNoiseVariance(chipLlrs);
    }
    this.noiseUpdateCounter++;
    return this.cachedNoiseVariance;
  }
  
  /**
   * Estimate noise variance from chip LLRs using signal statistics
   */
  private _estimateNoiseVariance(chipLlrs: Float32Array): number {
    if (chipLlrs.length === 0) {
      return CONSTANTS.NOISE_ESTIMATION.DEFAULT_HIGH_NOISE; // 空入力時のデフォルト高ノイズ
    }
    
    const stats = this._calculateSignalStats(chipLlrs);
    const noiseVariance = this._calculateNoiseFromStats(stats);
    
    debugLog(`[DsssDpskDemodulator] _estimateNoiseVariance: meanAbs=${stats.meanAbs}, variance=${stats.variance}, estimated=${noiseVariance}`);
    
    return noiseVariance;
  }

  /**
   * Calculate signal statistics efficiently
   */
  private _calculateSignalStats(chipLlrs: Float32Array) {
    let sum = 0, sumSquares = 0, sumAbs = 0;
    
    for (const val of chipLlrs) {
      sum += val;
      sumSquares += val * val;
      sumAbs += Math.abs(val);
    }
    
    const length = chipLlrs.length;
    const mean = sum / length;
    const variance = (sumSquares / length) - (mean * mean);
    const meanAbs = sumAbs / length;
    
    return { mean, variance, meanAbs };
  }

  /**
   * Calculate noise variance from signal statistics using predefined thresholds
   */
  private _calculateNoiseFromStats(stats: { meanAbs: number; variance: number }): number {
    const { meanAbs, variance } = stats;
    const { NOISE_ESTIMATION } = CONSTANTS;
    
    // 信号品質カテゴリでノイズ分散を推定
    if (meanAbs > NOISE_ESTIMATION.STRONG_SIGNAL_THRESHOLD && variance < NOISE_ESTIMATION.LOW_VARIANCE_THRESHOLD) {
      return NOISE_ESTIMATION.STRONG_SIGNAL_NOISE; // 強い、一貫した信号
    } else if (meanAbs > NOISE_ESTIMATION.GOOD_SIGNAL_THRESHOLD) {
      return NOISE_ESTIMATION.GOOD_SIGNAL_BASE_NOISE + variance * NOISE_ESTIMATION.GOOD_SIGNAL_VARIANCE_SCALE; // 良好な信号
    } else if (meanAbs > NOISE_ESTIMATION.MODERATE_SIGNAL_THRESHOLD) {
      return NOISE_ESTIMATION.MODERATE_SIGNAL_BASE_NOISE + variance * NOISE_ESTIMATION.MODERATE_SIGNAL_VARIANCE_SCALE; // 中程度の信号
    } else {
      return NOISE_ESTIMATION.WEAK_SIGNAL_BASE_NOISE + variance * NOISE_ESTIMATION.WEAK_SIGNAL_VARIANCE_SCALE; // 弱い信号
    }
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
      this.sampleOffset = newReadIndex;
      this.correlation = result.peakCorrelation;
      this.resyncCounter = 0;
      
      debugLog(`[DsssDpskDemodulator] Resync successful! Adjustment: ${totalAdjustment} samples, correlation: ${result.peakCorrelation}`);
    } else {
      debugLog(`[DsssDpskDemodulator] Resync failed`);
    }
  }

  /**
   * 指定オフセットで同期ワード検証
   * 指定位置で実際に復調して同期ワードの存在を確認
   */
  private _validateSyncAtOffset(syncOffset: number): 'SUCCESS' | 'FAILED' {
    const bitsToCheck = CONSTANTS.FRAME.SYNC_VALIDATION_BITS;
    const requiredSamples = this.samplesPerBit * bitsToCheck;
    
    debugLog(`[DsssDpskDemodulator] Validating sync at offset ${syncOffset}, required samples: ${requiredSamples}`);
    
    // 指定位置から非破壊的に復調試行
    const offsetFromReadIndex = syncOffset - this.sampleReadIndex;
    const testSamples = this._peekSamples(requiredSamples, offsetFromReadIndex);
    
    try {
      const demodulatedBits = this._demodulateTestSamples(testSamples, bitsToCheck);
      return this._validateSyncWord(demodulatedBits, syncOffset);
    } catch (error) {
      debugLog(`[DsssDpskDemodulator] Sync validation failed: ${error}`);
      return 'FAILED';
    }
  }

  /**
   * テストサンプルから指定ビット数を復調
   */
  private _demodulateTestSamples(testSamples: Float32Array, bitsToCheck: number): number[] {
    const demodulatedBits: number[] = [];
    
    for (let bit = 0; bit < bitsToCheck; bit++) {
      const bitStart = bit * this.samplesPerBit;
      const bitEnd = bitStart + this.samplesPerBit;
      const bitSamples = testSamples.slice(bitStart, bitEnd);
      
      const hardBit = this._demodulateAndConvertToBit(bitSamples);
      if (hardBit !== null) {
        demodulatedBits.push(hardBit);
      }
    }
    
    return demodulatedBits;
  }

  /**
   * 単一ビットサンプルを復調して硬判定ビットに変換（Float32Array版）
   * 同期検証時など、既にサンプルが抽出されている場合に使用
   */
  private _demodulateAndConvertToBit(bitSamples: Float32Array): number | null {
    try {
      // キャリア復調 → DPSK復調 → 逆拡散
      const phases = demodulateCarrier(
        bitSamples,
        this.config.samplesPerPhase,
        this.config.sampleRate,
        this.config.carrierFreq
      );
      
      const chipLlrs = dpskDemodulate(phases);
      if (chipLlrs.length === 0) return null;
      
      const adjustedChipLlrs = this._adjustChipPadding(chipLlrs);
      if (!adjustedChipLlrs) return null;
      
      const noiseVariance = this._getNoiseVariance(adjustedChipLlrs);
      const llrs = dsssDespread(adjustedChipLlrs, this.config.sequenceLength, this.config.seed, noiseVariance);
      
      if (!llrs || llrs.length === 0) return null;
      
      // LLRから硬判定ビット
      return llrs[0] >= 0 ? 0 : 1;
    } catch {
      return null;
    }
  }

  /**
   * 復調されたビットから同期ワードを検証
   */
  private _validateSyncWord(demodulatedBits: number[], syncOffset: number): 'SUCCESS' | 'FAILED' {
    if (demodulatedBits.length < CONSTANTS.FRAME.SYNC_VALIDATION_BITS) {
      debugLog(`[DsssDpskDemodulator] Candidate validation: insufficient bits demodulated (${demodulatedBits.length}, need at least ${CONSTANTS.FRAME.SYNC_VALIDATION_BITS} for sync word)`);
      return 'FAILED';
    }
    
    // 同期ワード検証：プリアンブル後の同期ワードが期待する値か
    const syncWordStart = CONSTANTS.FRAME.PREAMBLE_BITS;
    const receivedSyncWord = demodulatedBits.slice(syncWordStart, syncWordStart + CONSTANTS.FRAME.SYNC_WORD_BITS);
    const expectedSyncWord = CONSTANTS.FRAME.SYNC_WORD;
    
    debugLog(`[DsssDpskDemodulator] Demodulated bits (${demodulatedBits.length}): [${demodulatedBits.join(',')}]`);
    debugLog(`[DsssDpskDemodulator] Received sync word [${syncWordStart}:${syncWordStart + CONSTANTS.FRAME.SYNC_WORD_BITS}]: [${receivedSyncWord.join(',')}]`);
    debugLog(`[DsssDpskDemodulator] Expected sync word: [${expectedSyncWord.join(',')}]`);
    
    // 同期ワードの一致度を計算
    const matches = receivedSyncWord.reduce((count, bit, i) => 
      bit === expectedSyncWord[i] ? count + 1 : count, 0);
    
    const matchRatio = matches / expectedSyncWord.length;
    
    debugLog(`[DsssDpskDemodulator] Sync validation: sync word match ${matches}/${expectedSyncWord.length} (${(matchRatio*100).toFixed(1)}%) at offset ${syncOffset}`);
    
    const isValid = matchRatio >= CONSTANTS.FRAME.SYNC_WORD_THRESHOLD;
    
    if (isValid) {
      debugLog(`[DsssDpskDemodulator] Sync validation: PASSED (sync word detected)`);
      return 'SUCCESS';
    } else {
      debugLog(`[DsssDpskDemodulator] Sync validation: FAILED (sync word not found)`);
      return 'FAILED';
    }
  }

  /**
   * 指定位置で同期確立
   */
  private _confirmSyncAtOffset(syncOffset: number): void {
    // 同期位置までサンプル消費
    const consumeCount = syncOffset - this.sampleReadIndex;
    this._consumeSamples(consumeCount);
    
    // 同期確立
    this.isLocked = true;
    this.sampleOffset = this.sampleReadIndex;
    
    debugLog(`[DsssDpskDemodulator] SYNC CONFIRMED: offset=${this.sampleOffset}, correlation=${this.correlation.toFixed(4)}`);
  }

}
