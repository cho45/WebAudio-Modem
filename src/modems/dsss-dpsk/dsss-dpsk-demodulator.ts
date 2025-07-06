/**
 * DSSS-DPSK Demodulator Implementation
 * Streaming demodulator for DSSS+DPSK modulated signals
 */

import {
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
  },
  
  // LLR thresholds for bit quality detection
  LLR: {
    WEAK_THRESHOLD: 20,          // Below this absolute value, bit is considered weak
    STRONG_ZERO_THRESHOLD: 70,   // Strong 0-bit threshold for resync trigger (頻度調整)
    QUANTIZATION_MIN: -127,      // LLR量子化の最小値
    QUANTIZATION_MAX: 127,       // LLR量子化の最大値
  },
  
  // Sync management
  SYNC: {
    CONSECUTIVE_WEAK_LIMIT: 3,   // Max weak bits before losing sync
    RESYNC_TRIGGER_COUNT: 32,    // Strong bits needed before resync attempt (理論根拠: 水晶発振器ドリフト~10ppm@44.1kHz→0.44Hz/秒、32ビット=0.52秒観測で十分なドリフト検出精度)
    RESYNC_RANGE_CHIPS: 0.5,     // Search range in chips for resync
    RESYNC_THRESHOLD_SCALE: 1.0, // Scale factor for resync thresholds (正常信号での微調整のため閾値緩和)
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
    LLR_TO_CORRELATION_SCALE: 0.01,   // LLRノイズ推定値を相関値スケールに変換する係数 (理論値: ~0.03/3.0)
  }
} as const;

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
  
  // Instance identification for logging
  private readonly instanceName: string;
  
  private readonly reference: Int8Array;
  private readonly samplesPerBit: number;
  private readonly samplesPerValidation: number;
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
    instanceName?: string;
  } = {}) {
    this.instanceName = config.instanceName || 'unknown';
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
    this.samplesPerValidation = this.samplesPerBit * CONSTANTS.FRAME.SYNC_VALIDATION_BITS;
    
    // バッファサイズは十分なサイズを確保（同期検索＋複数ビット分）
    const bufferSize = Math.floor(this.samplesPerBit * CONSTANTS.BUFFER.SAMPLE_BUFFER_BITS);
    this.sampleBuffer = new Float32Array(bufferSize);
    
    // ビットバッファ
    this.bitBuffer = new Int8Array(CONSTANTS.BUFFER.BIT_BUFFER_SIZE);
  }
  
  /**
   * Instance-specific logging with identification
   */
  private log(message: string): void {
    if (CONSTANTS.DEBUG) {
      console.log(`[DsssDpskDemodulator:${this.instanceName}] ${message}`);
    }
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
      if (this._getAvailableSampleCount() >= this.samplesPerValidation) {
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
    // 呼び出し側で十分なサンプル数は確認済み
    const availableCount = this._getAvailableSampleCount();

    // Create a linear view of the circular buffer for sync search
    const searchWindowSize = Math.min(availableCount, this.samplesPerBit * CONSTANTS.SYNC.SEARCH_WINDOW_BITS);
    const searchSamples = this._peekSamples(searchWindowSize);

    // Max chip offset for search should be based on the search window size
    const maxChipOffset = Math.floor(searchSamples.length / this.config.samplesPerPhase);

    // Use cached noise variance if available (for consistent detection across sync/resync)
    let externalNoiseFloor: number | undefined;
    if (this.cachedNoiseVariance < CONSTANTS.NOISE_ESTIMATION.DEFAULT_HIGH_NOISE) {
      // Valid noise estimate available, convert to correlation scale
      externalNoiseFloor = this.cachedNoiseVariance * CONSTANTS.NOISE_ESTIMATION.LLR_TO_CORRELATION_SCALE;
    }

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
        peakToNoiseRatio: this.config.peakToNoiseRatio,
        externalNoiseFloor
      }
    );

    if (result.isFound) {
      // 同期位置を確定（12ビット分のサンプルが揃っていることが保証済み）
      const syncOffset = this.sampleReadIndex + result.bestSampleOffset;
      this.correlation = result.peakCorrelation;
      this.resyncCounter = 0; // Reset resync counter on successful sync
      
      this.log(`SYNC FOUND: offset=${syncOffset}, correlation=${result.peakCorrelation.toFixed(4)}`);
      
      // 同期ワード検証を実行
      const validationResult = this._validateSyncAtOffset(syncOffset);
      if (validationResult === 'SUCCESS') {
        // 同期ワード検証成功 → 同期確立
        this.log(`SYNC VALIDATION: SUCCESS`);
        this._confirmSyncAtOffset(syncOffset);
        return true;
      } else {
        // 検証失敗 → 次の候補を探索
        this.log(`SYNC VALIDATION: FAILED`);
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
    // 呼び出し側で十分なサンプル数は確認済み
    
    // デモジュレーションとデスプレッドをゼロコピーで実行
    const llr = this._demodulateAndDespreadZeroCopy(this.samplesPerBit, 0);
    
    if (llr === null) {
      // デモジュレーション失敗、同期を失う
      this.log(`Demodulation failed, losing sync`);
      this._loseSyncDueToError(true); // consumeBitSamples = true
      return;
    }
    
    // LLRをバッファに格納
    // this.log(`New Bit LLR: ${llr}`);
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
        this.log(`Despread failed`);
        return null;
      }
    } catch (error) {
      this.log(`Error in _demodulateAndDespreadZeroCopy: ${error}`);
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
    
    this.log(`Chip length mismatch: ${actualLength} vs ${expectedLength}`);
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
    this.log(`Losing sync due to error`);
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
    
    if (Math.abs(llr) < CONSTANTS.LLR.WEAK_THRESHOLD) {
      this.consecutiveWeakCount++;
      this.log(`Weak bit detected: LLR=${llr}, consecutive=${this.consecutiveWeakCount}`);
      
      // 上位層から要求されているビット数がある場合は同期を維持
      if (this.targetCount > 0 && this.processedCount < this.targetCount) {
        this.log(`Keeping sync for requested bits: ${this.processedCount}/${this.targetCount}`);
      } else if (this.consecutiveWeakCount >= CONSTANTS.SYNC.CONSECUTIVE_WEAK_LIMIT) {
        // 要求がない場合、または要求ビット数に達した後に弱いビットが連続したら同期を失う
        this.log(`Too many weak bits, losing sync`);
        this._loseSyncDueToError();
        this.resyncCounter = 0;
      }
    } else {
      this.consecutiveWeakCount = 0; // 強いビットでリセット
      this.resyncCounter++; // 強いビットで再同期カウンタを増やす

      // 0 ビット周辺での再同期を試みる
      if (llr > CONSTANTS.LLR.STRONG_ZERO_THRESHOLD && 
          this.resyncCounter > CONSTANTS.SYNC.RESYNC_TRIGGER_COUNT) {
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
    processor: (_sample: number, _index: number) => void
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
    const startIndex = ((this.sampleReadIndex + offset) % this.sampleBuffer.length + this.sampleBuffer.length) % this.sampleBuffer.length;
    
    if (startIndex + count <= this.sampleBuffer.length) {
      // データが連続している場合 - ゼロコピー
      return this.sampleBuffer.subarray(startIndex, startIndex + count);
    } else {
      // データが分割されている場合 - やむなくコピー
      const samples = new Float32Array(count);
      const firstPartSize = this.sampleBuffer.length - startIndex;
      const secondPartSize = count - firstPartSize;
      
      samples.set(this.sampleBuffer.subarray(startIndex, this.sampleBuffer.length), 0);
      samples.set(this.sampleBuffer.subarray(0, secondPartSize), firstPartSize);
      
      return samples;
    }
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
    
    // Only log noise estimation in debug mode when there are issues
    if (CONSTANTS.DEBUG && noiseVariance > 10) {
      this.log(`_estimateNoiseVariance: estimated=${noiseVariance.toFixed(2)} (high noise detected)`);
    }
    
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
   * 
   * RESYNC機能の目的: うまくいっている(LLRが高い)信号を使って前もってずれを補正する予防的調整
   * 問題が起きる前に先手を打って微調整を行うことで、継続的な同期品質を維持
   * 
   * 重要: 既に正しく同期している強い信号では、resyncによって挙動が変わってはならない
   */
  private _tryResync(): void {
    // Search range: ±0.5 chips around the current bit position
    const totalSearchRangeSamples = this.config.samplesPerPhase; // ±0.5 chip = 1 chip total
    const searchWindowSize = this.samplesPerBit + totalSearchRangeSamples;
    
    // Check if we have enough samples
    const availableSamples = this._getAvailableSampleCount();
    if (availableSamples < searchWindowSize) {
      return; // Silent fail - not enough samples
    }
    
    // Get samples centered around the current bit position
    // Start from 0.5 chip before current position to center the search
    const offsetFromCurrent = -Math.floor(this.config.samplesPerPhase / 2);
    const searchSamples = this._peekSamples(searchWindowSize, offsetFromCurrent);
    
    // Search in limited range (±0.5 chip = 1 chip total)
    const maxChipOffset = Math.ceil(totalSearchRangeSamples / this.config.samplesPerPhase);
    
    // Convert LLR-based noise variance to correlation value scale
    // LLR noise variance (~3.0) needs to be scaled down to correlation noise floor (~0.03)
    // Theoretical scaling factor: typical correlation noise (~0.03) / typical LLR noise (~3.0) ≈ 0.01
    const externalNoiseFloor = this.cachedNoiseVariance * CONSTANTS.NOISE_ESTIMATION.LLR_TO_CORRELATION_SCALE;
    
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
        peakToNoiseRatio: this.config.peakToNoiseRatio * CONSTANTS.SYNC.RESYNC_THRESHOLD_SCALE,
        externalNoiseFloor
      }
    );
    
    if (result.isFound) {
      // Adjust read position based on found sync
      const adjustmentFromSearchStart = result.bestSampleOffset;
      let totalAdjustment = offsetFromCurrent + adjustmentFromSearchStart;
      
      // For forward resync (positive adjustment), limit adjustment to prevent bit boundary crossing
      if (totalAdjustment > 0) {
        const currentAvailable = this._getAvailableSampleCount();
        const remainderSamples = currentAvailable % this.samplesPerBit;
        
        // If we're exactly on bit boundary (remainder = 0), no forward adjustment allowed
        // Otherwise, we can adjust up to the remainder amount
        const maxSafeAdjustment = remainderSamples;
        
        if (totalAdjustment > maxSafeAdjustment) {
          totalAdjustment = maxSafeAdjustment;
        }
      }
      // Backward resync (negative adjustment) is always safe - no limit needed
      
      const newReadIndex = (this.sampleReadIndex + totalAdjustment + this.sampleBuffer.length) % this.sampleBuffer.length;
      
      this._setSampleReadIndex(newReadIndex);
      this.sampleOffset = newReadIndex;
      this.correlation = result.peakCorrelation;
      this.resyncCounter = 0;
      
      // Always log resync success for monitoring
      this.log(`Resync successful! Adjustment: ${totalAdjustment} samples, correlation: ${result.peakCorrelation.toFixed(4)}`);
    } else {
      // Always log resync failures for monitoring
      this.log(`Resync failed: correlation=${result.peakCorrelation.toFixed(4)} < threshold=${(this.config.correlationThreshold * CONSTANTS.SYNC.RESYNC_THRESHOLD_SCALE).toFixed(4)}`);
    
    }
  }

  /**
   * 指定オフセットで同期ワード検証
   * 指定位置で実際に復調して同期ワードの存在を確認
   */
  private _validateSyncAtOffset(syncOffset: number): 'SUCCESS' | 'FAILED' {
    const offsetFromReadIndex = syncOffset - this.sampleReadIndex;
    
    try {
      const softBits = new Int8Array(CONSTANTS.FRAME.SYNC_VALIDATION_BITS);
      for (let bit = 0; bit < CONSTANTS.FRAME.SYNC_VALIDATION_BITS; bit++) {
        const bitOffset = offsetFromReadIndex + bit * this.samplesPerBit;
        const llr = this._demodulateAndDespreadZeroCopy(this.samplesPerBit, bitOffset);
        softBits[bit] = llr !== null ? llr : 0;
      }
      return this._validateSyncWordLLR(softBits, syncOffset);
    } catch (error) {
      this.log(`Sync validation failed: ${error}`);
      return 'FAILED';
    }
  }





  /**
   * LLRベースの同期ワード検証（情報量を最大活用）
   */
  private _validateSyncWordLLR(softBits: Int8Array, _syncOffset: number): 'SUCCESS' | 'FAILED' {
    // 同期ワード部分のLLR値を抽出
    const syncWordStart = CONSTANTS.FRAME.PREAMBLE_BITS;
    const receivedSyncWordLLR = softBits.slice(syncWordStart, syncWordStart + CONSTANTS.FRAME.SYNC_WORD_BITS);
    const expectedSyncWord = CONSTANTS.FRAME.SYNC_WORD;
    
    // LLRベースの相関計算
    let llrCorrelation = 0;
    let totalConfidence = 0;
    
    for (let i = 0; i < CONSTANTS.FRAME.SYNC_WORD_BITS; i++) {
      const llr = receivedSyncWordLLR[i];
      const expectedBit = expectedSyncWord[i];
      const confidence = Math.abs(llr) / 127.0; // 信頼度（0-1）
      
      // 期待するビット値に応じてLLRの貢献度を計算
      // expectedBit=1なら負のLLRが期待される（LLR<0 → bit=1）
      // expectedBit=0なら正のLLRが期待される（LLR>0 → bit=0）
      const contribution = (expectedBit === 1) ? 
        (-llr * confidence) : // bit=1期待時：負のLLRが良い
        (llr * confidence);   // bit=0期待時：正のLLRが良い
      
      llrCorrelation += contribution;
      totalConfidence += confidence;
    }
    
    // 正規化されたLLR相関スコア
    const normalizedLLRScore = totalConfidence > 0 ? llrCorrelation / totalConfidence : 0;
    
    // Hard decision fallback for comparison
    const hardBits = Array.from(receivedSyncWordLLR).map(llr => llr >= 0 ? 0 : 1);
    const hardMatches = hardBits.reduce((count: number, bit, i) => 
      bit === expectedSyncWord[i] ? count + 1 : count, 0);
    const hardMatchRatio = hardMatches / expectedSyncWord.length;
    
    // Debug logging
    if (CONSTANTS.DEBUG && softBits.length <= 20) {
      this.log(`LLR bits (${softBits.length}): [${Array.from(softBits).join(',')}]`);
    }
    this.log(`LLR sync word [${syncWordStart}:${syncWordStart + CONSTANTS.FRAME.SYNC_WORD_BITS}]: [${Array.from(receivedSyncWordLLR).join(',')}]`);
    this.log(`Expected sync word: [${expectedSyncWord.join(',')}]`);
    this.log(`LLR correlation score: ${normalizedLLRScore.toFixed(4)}, Hard match: ${hardMatches}/${expectedSyncWord.length} (${(hardMatchRatio*100).toFixed(1)}%)`);
    
    // LLRベースの判定：正規化スコアが閾値を超える、かつhard decisionも最低限の基準を満たす
    const llrThreshold = 0.5; // LLR相関の閾値
    const minHardThreshold = 0.625; // 5/8 = 62.5% (少し緩める)
    
    const llrValid = normalizedLLRScore >= llrThreshold;
    const hardValid = hardMatchRatio >= minHardThreshold;
    const isValid = llrValid && hardValid;
    
    this.log(`LR validation: LLR_score=${normalizedLLRScore.toFixed(4)}>=${llrThreshold} (${llrValid}), Hard_ratio=${hardMatchRatio.toFixed(3)}>=${minHardThreshold} (${hardValid}) → ${isValid ? 'PASSED' : 'FAILED'}`);
    
    if (isValid) {
      this.log(`LLR sync validation: PASSED (sync word detected with high confidence)`);
      return 'SUCCESS';
    } else {
      this.log(`LLR sync validation: FAILED (insufficient LLR correlation or hard match)`);
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
    
    this.log(`SYNC CONFIRMED: offset=${this.sampleOffset}, correlation=${this.correlation.toFixed(4)}`);
  }

}
