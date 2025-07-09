/**
 * DSSS-DPSK Demodulator Implementation
 * Streaming demodulator for DSSS+DPSK modulated signals
 */

import {
  dpskDemodulate,
  dsssDespread,
  generateSyncReference,
  decimatedMatchedFilter,
  detectSynchronizationPeak,
  generateModulatedReference,
  estimateNoiseFromCorrelations,
} from './dsss-dpsk';
import { DsssDpskFramer, type DecodedFrame, BIT_MANIPULATION } from './framer';

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
    MAX_BITS_PER_CALL: 50,       // Max bits to process per _getAvailableBits call
    MAX_ITERATIONS: 1000,        // Safety limit for loops
  },
  
  // Buffer sizes
  BUFFER: {
    SAMPLE_BUFFER_BITS: 32,      // Sample buffer size in bits (for sync validation + processing)
    BIT_BUFFER_SIZE: 1024,       // Output bit buffer size
  },
  
  // Debug  
  DEBUG: false, // デバッグ再開: データビット処理確認
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
  private readonly referenceSamples: Float32Array;
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
  
  // ノイズフロア推定用（correlationベース）
  private cachedNoiseFloor: number = 0.01;
  private correlationBuffer: Float32Array[] = [];
  private readonly CORRELATION_BUFFER_MAX_SIZE = 10;
  
  
  // フレーム処理
  private currentFramer: DsssDpskFramer | null = null;
  
  
  // データ受信進捗監視（偽ピーク検出用）
  // 偽ピーク修正を一時的に無効化
  // private dataProgressTracker: {
  //   remainingBits: number;
  //   stagnantCount: number;
  // } | null = null;
  
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
    this.referenceSamples = generateModulatedReference(this.reference, {
      samplesPerPhase: this.config.samplesPerPhase,
      sampleRate: this.config.sampleRate,
      carrierFreq: this.config.carrierFreq
    });
    this.samplesPerBit = this.config.sequenceLength * this.config.samplesPerPhase;
    this.samplesPerValidation = this.samplesPerBit * CONSTANTS.FRAME.SYNC_VALIDATION_BITS;
    
    // バッファサイズは十分なサイズを確保（同期検索＋複数ビット分）
    const bufferSize = Math.floor(this.samplesPerBit * CONSTANTS.BUFFER.SAMPLE_BUFFER_BITS);
    this.sampleBuffer = new Float32Array(bufferSize);
    
    // バッファサイズ確認ログ
    const maxMoveDistance = this.samplesPerBit * CONSTANTS.SYNC.SEARCH_WINDOW_BITS;
    const minRequiredSamples = this.samplesPerValidation + maxMoveDistance;
    console.log(`[Buffer Debug] bufferSize=${bufferSize}, minRequiredSamples=${minRequiredSamples}, sufficient=${bufferSize >= minRequiredSamples}`);
    
    // ビットバッファ
    this.bitBuffer = new Int8Array(CONSTANTS.BUFFER.BIT_BUFFER_SIZE);
  }
  
  /**
   * Instance-specific logging with identification
   */
  private log(message: string): void {
    if (CONSTANTS.DEBUG ) {
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
  /**
   * フレーム処理統合管理（状態機械）
   * 同期処理・フレーマー管理・品質判定を統合
   */
  public getAvailableFrames(): DecodedFrame[] {
    const result: DecodedFrame[] = [];
    let processingCount = 0;
    const maxFramesPerCall = 50; // 偽ピーク処理デバッグのため一時的に増加
    
    // 複数フレームを連続処理するループ
    while (processingCount < maxFramesPerCall) {
      processingCount++;
      let frameProcessingProgress = false;
      
      // 状態1: フレーマーなし → 新しいフレーム開始処理
      if (!this.currentFramer) {
        // 同期処理（新しいフレーム開始時のみ）
        if (!this.isLocked) {
          const availableCount = this._getAvailableSampleCount();
          
          // 最大可能な移動分を考慮した要求量でチェック（保守的だが延期を最小化）
          const maxMoveDistance = this.samplesPerBit * CONSTANTS.SYNC.SEARCH_WINDOW_BITS;
          const minRequiredSamples = this.samplesPerValidation + maxMoveDistance;
          
          if (availableCount >= minRequiredSamples) {
            this._trySync();
          }
          if (!this.isLocked) {
            break; // 同期未確立なら終了
          }
        }
        
        // 同期確立済み → 新しいフレーマー作成
        this.currentFramer = new DsssDpskFramer();
        this.log(`New framer created for next frame`);
        frameProcessingProgress = true;
      }
      
      // 状態2: フレーマー存在 → フレーム構築継続（isLocked無関係）
      // this.log(`[Framer Check] currentFramer=${this.currentFramer ? 'exists' : 'null'}`);
      if (this.currentFramer) {
        const framerState = this.currentFramer.getState();
        // this.log(`[Framer State] currentFramer exists, state=${framerState.state}, remainingBits=${framerState.remainingBits}`);
        
        if (framerState.state === 'WAITING_HEADER') {
          // ストリーム処理：利用可能ビットを段階的に蓄積
          const availableBits = this._getAvailableBits(8);
          this.log(`[Header Debug] Available bits for header: ${availableBits.length}/8, bits=[${Array.from(availableBits).join(',')}]`);
          if (availableBits.length > 0) {
            frameProcessingProgress = true; // ビット進捗があれば継続
          }
          
          // 8ビット完成時にヘッダ処理
          if (availableBits.length >= 8) {
            const headerByte = BIT_MANIPULATION.reconstructByte(availableBits);
            this.log(`Header: 0x${headerByte.toString(16)}`);
            this.log(`[Header Debug] Calling framer.initialize() with headerByte=0x${headerByte.toString(16)}`);
            if (!this.currentFramer.initialize(headerByte)) {
              this.log(`Header failed (likely false peak)`);
              this.currentFramer = null;
              this.isLocked = false;
            } else {
              this.log(`[Header Debug] Framer initialization successful!`);
            }
          } else {
            this.log(`[Header Debug] Waiting for more header bits: need 8, have ${availableBits.length}`);
          }
        }
        
        if (this.currentFramer?.getState().state === 'WAITING_DATA') {
          const needed = this.currentFramer.remainingBits;
          
          // remainingBitsが0以下の場合は処理をスキップ
          if (needed <= 0) {
            this.log(`[Data Debug] No more bits needed (remaining=${needed}), skipping data processing`);
          } else {
            const dataBits = this._getAvailableBits(needed);
            
            // ストリーム処理：利用可能ビットを段階的に蓄積
            if (dataBits.length > 0) {
              this.log(`[Data Debug] Need ${needed} bits, got ${dataBits.length} bits, remaining=${this.currentFramer.remainingBits}`);
              frameProcessingProgress = true; // ビット進捗があれば継続
              this.currentFramer.addDataBits(dataBits);
              this.log(`[Data Debug] Added ${dataBits.length} bits, new remaining=${this.currentFramer.remainingBits}`);
            }
          }
          
          // 全データ完成時にフレーム完了
          if (this.currentFramer && this.currentFramer.remainingBits === 0) {
            try {
              const frame = this.currentFramer.finalize();
              this.log(`[Data Debug] All data received! Finalizing frame...`);
              this.log(`Frame received! seq=${frame.header.sequenceNumber}`);
              result.push(frame);
            } catch (error) {
              this.log(`Frame finalization error: ${error}`);
              // 復号失敗はログを出して処理継続（フレームを破棄）
            }
            
            this.log(`Frame processing completed, destroying framer for next frame`);
            this.log(`After frame completion: isLocked=${this.isLocked}, correlation=${this.correlation.toFixed(3)}`);
            
            // **重要**: 連続フレーム処理のため同期状態をリセット
            // 次のフレーム検出のため、同期を再確立する必要がある
            this.isLocked = false;
            this.correlation = 0;
            this.log(`Reset sync state for next frame detection: isLocked=${this.isLocked}`);
            
            this.currentFramer = null; // フレーム完成・次のフレーム処理準備
          }
        }
      }
      
      // 進捗がない場合は処理終了（データ不足など）
      if (!frameProcessingProgress) {
        break;
      }
    }
    
    return result;
  }


  private _getAvailableBits(targetBits: number): Int8Array {
    if (targetBits <= 0) {
      throw new Error('targetBits must be positive');
    }
    
    // フレーム処理用に拡張された制限値でビット収集
    let iterationCount = 0;
    const maxIterationsForFrame = Math.max(
      CONSTANTS.LIMITS.MAX_ITERATIONS,
      targetBits * 2 // 最低限必要ビット数の2倍まで処理
    );
    
    while (this.bitBufferIndex < targetBits && 
           iterationCount < maxIterationsForFrame) {
      const availableSamples = this._getAvailableSampleCount();
      
      // 十分なサンプルがある場合のみ処理
      if (availableSamples >= this.samplesPerBit) {
        iterationCount++;
        this._processBit();
        // フレーム構築中はロック失敗でも継続（弱いLLR値として処理）
      } else {
        // サンプル不足の場合は処理終了し、次回の呼び出しを待つ
        // AudioWorklet環境では段階的にサンプルが到着するため、蓄積を待つ
        break;
      }
    }
    
    // AudioWorklet環境対応：フレーム処理開始時にサンプル不足をログ
    if (this.bitBufferIndex < targetBits && iterationCount >= maxIterationsForFrame) {
      this.log(`[Frame Processing] Reached max iterations ${maxIterationsForFrame}, got ${this.bitBufferIndex}/${targetBits} bits`);
    }
    
    // 要求された分があれば返す  
    if (this.bitBufferIndex >= targetBits) {
      const result = this.bitBuffer.slice(0, targetBits);
      console.log(`[Bit Buffer Debug] Available bits: ${this.bitBufferIndex}/${targetBits}, processedCount=${this.processedCount}, iterations=${iterationCount} ${result}`);
      
      // バッファを詰める
      this.bitBuffer.set(this.bitBuffer.subarray(targetBits, this.bitBufferIndex), 0);
      this.bitBufferIndex -= targetBits;
      this.processedCount += targetBits;
      
      return result;
    }
    
    // デバッグ情報: データ不足の詳細
    if (CONSTANTS.DEBUG && this.bitBufferIndex > 0) {
      this.log(`_getAvailableBits: partial data available ${this.bitBufferIndex}/${targetBits}, samples=${this._getAvailableSampleCount()}, iterations=${iterationCount}`);
    }
    
    // 要求されたビット数が揃わない場合は空を返す
    return new Int8Array(0);
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
    
    
    // フレーマーインスタンス破棄
    this.currentFramer = null;
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

    // Use cached noise floor if available (for consistent detection across sync/resync)
    let externalNoiseFloor: number | undefined;
    if (this.cachedNoiseFloor > 1e-6) {
      // Valid noise floor estimate available
      externalNoiseFloor = this.cachedNoiseFloor;
    }

    const result = this.findSyncOffset(
      searchSamples,
      maxChipOffset,
      {
        correlationThreshold: this.config.correlationThreshold,
        peakToNoiseRatio: this.config.peakToNoiseRatio,
        externalNoiseFloor
      }
    );

    if (result.isFound) {
      const syncOffset = (this.sampleReadIndex + result.bestSampleOffset) % this.sampleBuffer.length;
      this.correlation = result.peakCorrelation;
      this.resyncCounter = 0; // Reset resync counter on successful sync
      
      this.log(`SYNC FOUND: offset=${result.bestSampleOffset}, correlation=${result.peakCorrelation.toFixed(4)} ${externalNoiseFloor}`);
      this.log(`Sync: Available samples: ${availableCount}, searchWindowSize: ${searchWindowSize}, maxChipOffset: ${maxChipOffset}, externalNoiseFloor: ${externalNoiseFloor}`);
      
      // 同期確認に必要なサンプル数を正確に計算
      const consumeCount = result.bestSampleOffset; // 検出位置までの相対距離
      const syncValidationSamples = CONSTANTS.FRAME.SYNC_VALIDATION_BITS * this.samplesPerBit;
      const totalRequiredSamples = consumeCount + syncValidationSamples;
      
      if (availableCount < totalRequiredSamples) {
        // 理論的にここは到達しないはず（最適化された事前チェックにより）
        this.log(`INTERNAL ERROR: Insufficient samples despite optimized pre-checks! need=${totalRequiredSamples}, available=${availableCount}`);
        return false;
      }
      
      // 同期ワード検証を実行
      const validationResult = this._validateSyncAtOffset(syncOffset);
      if (validationResult === 'SUCCESS') {
        // 同期ワード検証成功 → 同期確立
        this.log(`SYNC VALIDATION: SUCCESS`);
        const confirmed = this._confirmSyncAtOffset(syncOffset);
        if (confirmed) {
          return true;
        } else {
          // 理論的にはここは到達しないはず（事前チェック済み）
          this.log(`INTERNAL ERROR: sync confirmation failed after pre-check - this should be impossible!`);
          return false;
        }
      } else {
        // 検証失敗 → 次の候補を探索
        this.log(`SYNC VALIDATION: FAILED at offset ${syncOffset}`);
        
        // デバッグ: 偽ピーク前の状態を記録
        const beforeAdvance = {
          sampleReadIndex: this.sampleReadIndex,
          sampleWriteIndex: this.sampleWriteIndex,
          availableSamples: this._getAvailableSampleCount(),
          syncOffset: syncOffset
        };
        this.log(`[False Peak Debug] Before advance: readIdx=${beforeAdvance.sampleReadIndex}, writeIdx=${beforeAdvance.sampleWriteIndex}, available=${beforeAdvance.availableSamples}, syncOffset=${syncOffset}`);
        
        // 偽ピーク後のクリーンアップ：内部状態を完全リセット
        this.bitBufferIndex = 0;
        this.bitBuffer.fill(0);
        this.correlation = 0;
        this.consecutiveWeakCount = 0;
        this.resyncCounter = 0;
        this.processedCount = 0;
        this.targetCount = 0;
        this.log(`[False Peak Cleanup] Reset internal state after failed sync validation`);
        
        // 偽ピーク処理: 0.5ビット分進める（次の候補探索のため）
        const advance = Math.min(Math.floor(this.samplesPerBit * 0.5), this._getAvailableSampleCount());
        if (advance > 0) {
          this._consumeSamples(advance);
          const afterAdvance = {
            sampleReadIndex: this.sampleReadIndex,
            availableSamples: this._getAvailableSampleCount()
          };
          this.log(`[False Peak] Advanced ${advance} samples (${(advance/this.samplesPerBit).toFixed(2)} bits). After: readIdx=${afterAdvance.sampleReadIndex}, available=${afterAdvance.availableSamples}`);
        } else {
          this.log(`Cannot advance - insufficient data: need=${advance}, available=${this._getAvailableSampleCount()}`);
        }
        return false;
      }
    } else {
      // If sync not found, consume a small portion to advance and try again
      const consumeCount = Math.floor(this.samplesPerBit / 2);
      if (this._getAvailableSampleCount() >= consumeCount) {
        this._consumeSamples(consumeCount);
      } else {
        this.log(`Cannot consume ${consumeCount} samples for advancement - insufficient data`);
      }
      return false;
    }
  }
  
  private _processBit(): void {
    // 呼び出し側で十分なサンプル数は確認済み
    if (!(this._getAvailableSampleCount() >= this.samplesPerBit)) {
      this.log(`Cannot consume ${this.samplesPerBit} samples in _processBit - insufficient data`);
    }
    
    // デモジュレーションとデスプレッドをゼロコピーで実行（常に有効なLLR値を返す）
    const llr = this._demodulateAndDespreadZeroCopy(this.samplesPerBit, 0);
    
    // LLRをバッファに格納
    this.log(`[LLR Debug] Generated LLR: ${llr}, buffer: ${this.bitBufferIndex}/${this.bitBuffer.length}`);
    this._storeLLR(llr);
    
    // ヘッダー受信中のLLRビット列を記録
    if (this.bitBufferIndex <= 8) {
      const currentBits = Array.from(this.bitBuffer.slice(0, this.bitBufferIndex)).join(',');
      this.log(`[LLR Debug] Current header bits [${this.bitBufferIndex}/8]: [${currentBits}]`);
    }
    
    // 品質評価（同期失敗判定は上位層で実行）
    this._updateSyncQuality(llr);
    
    this._consumeSamples(this.samplesPerBit);
  }
  
  /**
   * Demodulate and despread bit samples with zero-copy optimization
   * Directly processes samples from circular buffer without memory allocation
   */
  private _demodulateAndDespreadZeroCopy(sampleCount: number, offset: number): number {
    const numPhases = Math.floor(sampleCount / this.config.samplesPerPhase);
    const phases = new Float32Array(numPhases+1)
    
    // キャリア復調（ゼロコピー）
//     this._demodulateCarrierZeroCopy(sampleCount, offset, phases.subarray(1));
//     phases[0] = Math.cos(phases[1]); // 最初の位相はキャリアの初期位相（0度）
    this._demodulateCarrierZeroCopy(sampleCount, offset, phases);
    
    // DPSK復調
    const chipLlrs = dpskDemodulate(phases);
    
    // デバッグ: チップLLR値の確認
    /*
    if (CONSTANTS.DEBUG && this.bitBufferIndex < 10) {
      const chipStr = Array.from(chipLlrs.slice(0, Math.min(5, chipLlrs.length)))
        .map(c => c.toFixed(2)).join(',');
      this.log(`[LLR Debug] ChipLLRs[${chipLlrs.length}]: [${chipStr}]`);
    }
      */
    
    // ノイズ分散を理論的変換で推定
    let estimatedNoiseVariance: number;
    if (this.correlation > 0 && this.cachedNoiseFloor > 1e-6) {
      // 同期確立済み: correlation値から理論的に変換
      estimatedNoiseVariance = this._estimateChipNoiseVariance(chipLlrs);
    } else {
      // 同期未確立: フォールバック値
      estimatedNoiseVariance = 1.0;
    }
    
    // デバッグ: ノイズ分散の確認
    if (CONSTANTS.DEBUG && this.bitBufferIndex < 10) {
      // this.log(`[LLR Debug] NoiseVariance: ${estimatedNoiseVariance.toFixed(3)} (theoretical from corr=${this.correlation.toFixed(4)}, floor=${this.cachedNoiseFloor.toFixed(6)})`);
    }
    
    // DSSS逆拡散
    const llrs = dsssDespread(chipLlrs, this.config.sequenceLength, this.config.seed, estimatedNoiseVariance);
    
    if (llrs && llrs.length > 0) {
      // LLRを量子化してInt8に変換
      const llr = Math.max(CONSTANTS.LLR.QUANTIZATION_MIN, Math.min(CONSTANTS.LLR.QUANTIZATION_MAX, Math.round(llrs[0])));
      return llr;
    } else {
      // DSSS逆拡散が失敗した場合でも、弱い信号として0を返す（ノイズ）
      this.log(`[LLR Debug] Despread failed, returning neutral LLR`);
      return 0;
    }
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
   * @param repositionToNextCandidate Whether to reposition to next sync candidate
   * @param consumeHeaderSize If true, consume header-sized samples for false peak avoidance
   */
  private _loseSyncDueToError(repositionToNextCandidate: boolean = false): void {
    this.log(`Losing sync due to error - performing complete demodulator reset`);
    
    // 完全な状態リセット
    this.isLocked = false;
    this.correlation = 0;
    this.sampleOffset = 0;
    
    // フレーマーインスタンス破棄
    this.currentFramer = null;
    
    // ビットバッファ完全クリア
    this.bitBuffer.fill(0);
    this.bitBufferIndex = 0;
    
    // 品質管理カウンタリセット
    this.consecutiveWeakCount = 0;
    this.resyncCounter = 0;
    this.processedCount = 0;
    this.targetCount = 0;
    
    // ノイズフロアリセット
    this.cachedNoiseFloor = 0.01;
    this.correlationBuffer = [];
    
    this.log(`Complete demodulator reset: buffers cleared, counters reset, ready for new sync`);
    
    if (repositionToNextCandidate) {
      // 次の同期候補のために1ビット分戻る
      const currentAvailable = this._getAvailableSampleCount();
      if (currentAvailable >= this.samplesPerBit) {
        this.sampleReadIndex = (this.sampleReadIndex - this.samplesPerBit + this.sampleBuffer.length) % this.sampleBuffer.length;
        this.log(`Repositioned back by 1 bit (${this.samplesPerBit} samples) for next sync candidate search`);
      }
    }
  }
  
  /**
   * Update sync quality based on LLR value
   */
  private _updateSyncQuality(llr: number): void {
    // 品質指標の更新（同期失敗判定は上位層に移行）
    
    if (Math.abs(llr) < CONSTANTS.LLR.WEAK_THRESHOLD) {
      this.consecutiveWeakCount++;
      // this.log(`Weak bit detected: LLR=${llr}, consecutive=${this.consecutiveWeakCount}`);
    } else {
      this.consecutiveWeakCount = 0; // 強いビットでリセット
      this.resyncCounter++; // 強いビットで再同期カウンタを増やす

      // 物理層内での再同期最適化（0ビット周辺での位置調整）
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
    // this.log(`[Sample Consumption] Consuming ${count} samples from circular buffer`);
    const availableCount = this._getAvailableSampleCount();
    if (availableCount < count) {
      throw new Error(`INTERNAL ERROR: Insufficient samples for consumption - need ${count}, available ${availableCount}`);
    }
    this.sampleReadIndex = (this.sampleReadIndex + count) % this.sampleBuffer.length;
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
    
    // Use cached noise floor directly (no conversion needed)
    const externalNoiseFloor = this.cachedNoiseFloor;
    
    const result = this.findSyncOffset(
      searchSamples,
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
    
    // デバッグ：同期検出位置の詳細ログ
    // this.log(`[Sync Position Debug] syncOffset=${syncOffset}, readIndex=${this.sampleReadIndex}, offsetFromReadIndex=${offsetFromReadIndex}`);
    // this.log(`[Sync Position Debug] samplesPerBit=${this.samplesPerBit}, validationBits=${CONSTANTS.FRAME.SYNC_VALIDATION_BITS}`);
    
    try {
      const softBits = new Int8Array(CONSTANTS.FRAME.SYNC_VALIDATION_BITS);
      for (let bit = 0; bit < CONSTANTS.FRAME.SYNC_VALIDATION_BITS; bit++) {
        const bitOffset = offsetFromReadIndex + bit * this.samplesPerBit;
        // this.log(`[Sync Position Debug] bit=${bit}, bitOffset=${bitOffset}, absolutePosition=${this.sampleReadIndex + bitOffset}`);
        const llr = this._demodulateAndDespreadZeroCopy(this.samplesPerBit, bitOffset);
        softBits[bit] = llr; // 常に有効なLLR値が返される
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
    
    // 正規化されたLLR相関スコア ±1
    const normalizedLLRScore = (totalConfidence > 0 ? llrCorrelation / totalConfidence : 0) / 127;
    
    // Hard decision fallback for comparison
    const hardBits = Array.from(receivedSyncWordLLR).map(llr => llr >= 0 ? 0 : 1);
    const hardMatches = hardBits.reduce((count: number, bit, i) => 
      bit === expectedSyncWord[i] ? count + 1 : count, 0);
    const hardMatchRatio = hardMatches / expectedSyncWord.length;
    
    // Debug logging - 詳細分析
    this.log(`=== 同期検証詳細分析 ===`);
    this.log(`LLR bits (${softBits.length}): [${Array.from(softBits).join(',')}]`);
    
    // プリアンブル部分の確認
    const preambleLLR = softBits.slice(0, CONSTANTS.FRAME.PREAMBLE_BITS);
    const preambleHard = Array.from(preambleLLR).map(llr => llr >= 0 ? 0 : 1);
    this.log(`プリアンブル[0-3] LLR: [${Array.from(preambleLLR).join(',')}] → Hard: [${preambleHard.join(',')}] (期待: [0,0,0,0])`);
    
    // 同期ワード部分の確認
    this.log(`同期ワード[4-11] LLR: [${Array.from(receivedSyncWordLLR).join(',')}] → Hard: [${hardBits.join(',')}]`);
    this.log(`期待される同期ワード: [${expectedSyncWord.join(',')}]`);
    this.log(`LLR correlation score: ${normalizedLLRScore.toFixed(4)}, Hard match: ${hardMatches}/${expectedSyncWord.length} (${(hardMatchRatio*100).toFixed(1)}%)`);
    
    // LLRベースの判定：正規化スコアが閾値を超える、かつhard decisionも最低限の基準を満たす
    const llrThreshold = 0.7; // LLR相関の閾値
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
  private _confirmSyncAtOffset(syncOffset: number): boolean {
    // 同期位置までの相対距離を計算（_trySyncで既に計算済みの値を使用）
    const consumeCount = syncOffset - this.sampleReadIndex;
    
    // ヘッダ開始位置を正確に計算：同期検証と同じビット境界を使用
    const headerStartSamples = CONSTANTS.FRAME.SYNC_VALIDATION_BITS * this.samplesPerBit;
    this.log(`[Sync Debug] SYNC_VALIDATION_BITS=${CONSTANTS.FRAME.SYNC_VALIDATION_BITS}, samplesPerBit=${this.samplesPerBit}, headerStartSamples=${headerStartSamples}`);
    const totalRequiredSamples = consumeCount + headerStartSamples;
    
    // 必要なサンプル数が利用可能かチェック
    const availableCount = this._getAvailableSampleCount();
    if (availableCount < totalRequiredSamples) {
      this.log(`Insufficient samples for sync confirmation: need ${totalRequiredSamples}, available ${availableCount} - deferring`);
      return false; // 同期確認延期
    }
    
    // 同期位置まで移動
    this.log(`[Sync Confirm] Before consume: readIndex=${this.sampleReadIndex}, available=${this._getAvailableSampleCount()}`);
    this._consumeSamples(consumeCount);
    this.log(`[Sync Confirm] After sync consume: readIndex=${this.sampleReadIndex}, consumed=${consumeCount}`);
    
    // ヘッダ開始位置を正確に設定：同期検証時の計算と一致させる
    // 同期検証では bit=12 のときのオフセットが: offsetFromReadIndex + 12 * samplesPerBit
    // 同じ位置にreadIndexを設定
    const headerOffset = headerStartSamples;
    this._consumeSamples(headerOffset);
    this.log(`[Sync Confirm] After header offset: readIndex=${this.sampleReadIndex}, consumed=${headerOffset}, total=${consumeCount + headerOffset}`);
    
    // 同期検証で蓄積されたbitBufferを完全にクリア（ヘッダから新規開始）
    this.log(`[Sync Confirm] Clearing bit buffer: ${this.bitBufferIndex} → 0`);
    this.bitBufferIndex = 0;
    this.bitBuffer.fill(0);
    
    // 同期確立（ヘッダ開始位置を記録）
    this.isLocked = true;
    this.sampleOffset = this.sampleReadIndex;
    
    this.log(`SYNC CONFIRMED: offset=${this.sampleOffset}, correlation=${this.correlation.toFixed(4)}, skipped ${CONSTANTS.FRAME.SYNC_VALIDATION_BITS} bits`);
    this.log(`Buffer state after sync: writeIndex=${this.sampleWriteIndex}, readIndex=${this.sampleReadIndex}, available=${this._getAvailableSampleCount()}`);
    return true;
  }

  /**
   * Find synchronization offset using decimated matched filter
   * @param receivedSamples Received sample sequence
   * @param maxChipOffset Maximum chip offset to search
   * @param detectionThresholds Detection parameters
   * @returns Object with best offsets, correlation peak, and detection metrics
   */
  findSyncOffset(
    receivedSamples: Float32Array,
    maxChipOffset: number,
    detectionThresholds: {
      correlationThreshold: number;
      peakToNoiseRatio: number;
      externalNoiseFloor?: number;
    }
  ): {
    bestSampleOffset: number;
    bestChipOffset: number;
    peakCorrelation: number;
    isFound: boolean;
    peakRatio: number;
  } {
    const { samplesPerPhase } = this.config;
    
    // Step 1: Calculate maximum search range in samples
    const maxSampleOffset = maxChipOffset * samplesPerPhase;
    const minSamplesNeeded = this.referenceSamples.length;
    
    if (receivedSamples.length < minSamplesNeeded) {
      return {
        bestSampleOffset: -1,
        bestChipOffset: -1,
        peakCorrelation: 0,
        isFound: false,
        peakRatio: 0
      };
    }
    
    // Step 2: Perform efficient decimated matched filtering for fast synchronization.
    // A decimation factor of 2 provides a good balance of speed and accuracy.
    const decimationFactor = 2;
    const { correlations, sampleOffsets } = decimatedMatchedFilter(
      receivedSamples,
      this.referenceSamples,
      maxSampleOffset,
      decimationFactor
    );
    
    // Step 3: Accumulate correlations for noise floor estimation
    this._accumulateCorrelations(correlations);
    
    // Step 4: Detect synchronization peak using externally provided thresholds
    const result = detectSynchronizationPeak(correlations, sampleOffsets, samplesPerPhase, detectionThresholds);
    
    // Step 5: Update noise floor estimation if sync is found
    if (result.isFound) {
      this._updateNoiseFloorFromCorrelations();
    }
    
    return result;
  }

  /**
   * Accumulate correlations for noise floor estimation
   * @param correlations Correlation values from decimated matched filter
   */
  private _accumulateCorrelations(correlations: Float32Array): void {
    // Add to buffer (circular buffer with maximum size)
    if (this.correlationBuffer.length >= this.CORRELATION_BUFFER_MAX_SIZE) {
      this.correlationBuffer.shift(); // Remove oldest
    }
    this.correlationBuffer.push(correlations); // Add new
  }

  /**
   * Update noise floor estimation from accumulated correlations
   */
  private _updateNoiseFloorFromCorrelations(): void {
    if (this.correlationBuffer.length === 0) {
      return;
    }

    // Flatten all accumulated correlations
    const totalLength = this.correlationBuffer.reduce((sum, arr) => sum + arr.length, 0);
    const allCorrelations = new Float32Array(totalLength);
    let offset = 0;
    for (const correlations of this.correlationBuffer) {
      allCorrelations.set(correlations, offset);
      offset += correlations.length;
    }

    const estimatedNoiseFloor = estimateNoiseFromCorrelations(allCorrelations);
    this.cachedNoiseFloor = estimatedNoiseFloor;
    
    this.log(`Updated noise floor from ${this.correlationBuffer.length} correlation buffers: ${estimatedNoiseFloor.toFixed(6)}`);
  }


  /**
   * Estimate chip noise variance directly from chip LLRs using statistical analysis
   * Alternative method for comparison and fallback scenarios
   * @param chipLlrs Chip LLR values from DPSK demodulation
   * @returns Estimated noise variance based on chip statistics
   */
  private _estimateChipNoiseVariance(chipLlrs: Float32Array): number {
    if (chipLlrs.length === 0) return 1.0;
    let sum = 0, sumSquares = 0;
    for (const chip of chipLlrs) {
      sum += chip;
      sumSquares += chip * chip;
    }
    const mean = sum / chipLlrs.length;
    const variance = (sumSquares / chipLlrs.length) - (mean * mean);
    return Math.max(variance, 0.1);
  }

}
