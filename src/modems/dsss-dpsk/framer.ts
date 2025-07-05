import { bchEncode, bchDecode, type BCHCodeType } from '../../fec/bch';
import { LDPC, type HMatrixData } from '../../fec/ldpc';
import { RingBuffer } from '../../utils';

// 正しく生成されたLDPC H行列データを読み込み
import ldpcMatrix128 from '../../fec/ldpc_h_matrix_n128_k64.json';
import ldpcMatrix256 from '../../fec/ldpc_h_matrix_n256_k128.json';
import ldpcMatrix512 from '../../fec/ldpc_h_matrix_n512_k256.json';
import ldpcMatrix1024 from '../../fec/ldpc_h_matrix_n1024_k512.json';

// 定数
const PREAMBLE = [0, 0, 0, 0]; // 4-bit Preamble
const SYNC_WORD = [1, 0, 1, 1, 0, 1, 0, 0]; // 8-bit Sync Word (0xB4)

// フレーム構造定数
const HEADER_BITS = 8;
const LLR_MAX_VALUE = 127;
const DEFAULT_BUFFER_SIZE = 4096;

// 処理パラメータ
const DEFAULT_LDPC_ITERATIONS = 10;
const ERROR_COUNT_THRESHOLD = 10;

// ヘッダビットマスク
const SEQUENCE_NUMBER_MASK = 0x7;  // 3-bit mask
const FRAME_TYPE_MASK = 0x3;       // 2-bit mask
const LDPC_N_TYPE_MASK = 0x3;      // 2-bit mask
const PARITY_BIT_MASK = 0x01;      // 1-bit mask for parity

// ヘッダビットシフト量
const SEQUENCE_NUMBER_SHIFT = 5;    // シーケンス番号のシフト量
const FRAME_TYPE_SHIFT = 3;         // フレームタイプのシフト量
const LDPC_N_TYPE_SHIFT = 1;        // LDPC Nタイプのシフト量

// 相関閾値（LLRスケール基準）
const PREAMBLE_CORRELATION_THRESHOLD_RATIO = 0.8; // 80% of theoretical max
const SYNC_WORD_CORRELATION_THRESHOLD_RATIO = 0.6; // 実際の相関値508に基づいて調整

// ビット操作最適化ユーティリティ
const BIT_MANIPULATION = {
  /**
   * 単一バイトを8ビットの配列に効率的に展開
   * @param byte 展開するバイト値
   * @param output 出力先配列（再利用可能）
   */
  expandByte(byte: number, output: Uint8Array): void {
    output[0] = (byte >> 7) & 1;
    output[1] = (byte >> 6) & 1;
    output[2] = (byte >> 5) & 1;
    output[3] = (byte >> 4) & 1;
    output[4] = (byte >> 3) & 1;
    output[5] = (byte >> 2) & 1;
    output[6] = (byte >> 1) & 1;
    output[7] = byte & 1;
  },

  /**
   * バイト配列をビット配列に効率的に展開
   * @param bytes 入力バイト配列
   * @param output 出力先ビット配列
   */
  expandBytes(bytes: Uint8Array, output: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) {
      const baseIndex = i * 8;
      const byte = bytes[i];
      output[baseIndex] = (byte >> 7) & 1;
      output[baseIndex + 1] = (byte >> 6) & 1;
      output[baseIndex + 2] = (byte >> 5) & 1;
      output[baseIndex + 3] = (byte >> 4) & 1;
      output[baseIndex + 4] = (byte >> 3) & 1;
      output[baseIndex + 5] = (byte >> 2) & 1;
      output[baseIndex + 6] = (byte >> 1) & 1;
      output[baseIndex + 7] = byte & 1;
    }
  },

  /**
   * ソフトビット配列から単一バイトを効率的に再構築
   * @param softBits LLR値の配列（8要素）
   * @returns 再構築されたバイト値
   */
  reconstructByte(softBits: Int8Array): number {
    let byte = 0;
    for (let i = 0; i < 8; i++) {
      if (softBits[i] < 0) { // LLR < 0 means bit 1
        byte |= (1 << (7 - i));
      }
    }
    return byte;
  }
} as const;

// フレーム構築オプション
export interface FrameOptions {
  sequenceNumber: number; // 3-bit (0-7)
  frameType: number;      // 2-bit (0-3)
  ldpcNType: number;      // 2-bit (0-3)
}

// フレーム構造統合定数（レイアウト情報を一元管理）
const FRAME_LAYOUT = {
  // 各部分の長さ
  PREAMBLE_LENGTH: 4,   // 4-bit
  SYNC_WORD_LENGTH: 8,  // 8-bit  
  HEADER_LENGTH: 8,     // 8-bit
  
  // オフセット位置（効率的なアクセス用）
  OFFSETS: {
    PREAMBLE_START: 0,
    PREAMBLE_END: 4,
    SYNC_WORD_START: 4,
    SYNC_WORD_END: 12,
    HEADER_START: 12,
    HEADER_END: 20,
    PAYLOAD_START: 20,
  },
  
  // 計算済みの基本構造サイズ
  FIXED_HEADER_SIZE: 4 + 8 + 8, // preamble + sync + header = 20 bits
} as const;

/**
 * 効率的なデータフレームクラス - メモリ重複を排除
 * bits配列のみを保持し、各部分はスライスで提供
 */
export class DataFrame {
  constructor(
    private readonly _bits: Uint8Array,
    private readonly _headerByte: number
  ) {}

  /** 完全なビット配列を取得 */
  get bits(): Uint8Array {
    return this._bits;
  }

  /** ヘッダバイト値を取得 */
  get headerByte(): number {
    return this._headerByte;
  }

  /** プリアンブル部分を取得（4ビット）*/
  get preamble(): Uint8Array {
    return this._bits.slice(FRAME_LAYOUT.OFFSETS.PREAMBLE_START, FRAME_LAYOUT.OFFSETS.PREAMBLE_END);
  }

  /** 同期ワード部分を取得（8ビット）*/
  get syncWord(): Uint8Array {
    return this._bits.slice(FRAME_LAYOUT.OFFSETS.SYNC_WORD_START, FRAME_LAYOUT.OFFSETS.SYNC_WORD_END);
  }

  /** ヘッダビット部分を取得（8ビット）*/
  getHeaderBits(): Uint8Array {
    return this._bits.slice(FRAME_LAYOUT.OFFSETS.HEADER_START, FRAME_LAYOUT.OFFSETS.HEADER_END);
  }

  /** ペイロード部分を取得（可変長）*/
  get payload(): Uint8Array {
    return this._bits.slice(FRAME_LAYOUT.OFFSETS.PAYLOAD_START);
  }

  /** フレーム全体の長さを取得 */
  get length(): number {
    return this._bits.length;
  }
}

// デコードされたフレーム
export interface DecodedFrame {
  header: FrameOptions;   // 解析されたヘッダ
  userData: Uint8Array;   // 最終的に復元されたユーザーデータ
  status: 'success' | 'bch_corrected'; // 復元ステータス
}

// フレーマーの状態
export interface FramerStatus {
  state: string;
  bufferLength: number;
  processedBits: number;
  lastCorrelation: number;
  isHealthy: boolean;
}

// LDPCとBCHのパラメータを管理するテーブル（数学的整合性確保）
const FEC_PARAMS = {
  0: { ldpcN: 128,  bchType: 'BCH_63_56_1' as BCHCodeType,    payloadBytes: 7,   matrix: ldpcMatrix128 },
  1: { ldpcN: 256,  bchType: 'BCH_127_120_1' as BCHCodeType,  payloadBytes: 15,  matrix: ldpcMatrix256 },
  2: { ldpcN: 512,  bchType: 'BCH_255_247_1' as BCHCodeType,  payloadBytes: 30,  matrix: ldpcMatrix512 },
  3: { ldpcN: 1024, bchType: 'BCH_511_502_1' as BCHCodeType,  payloadBytes: 62,  matrix: ldpcMatrix1024 },
};

// 内部状態定義
// eslint-disable-next-line no-unused-vars
enum FramerState {
  // eslint-disable-next-line no-unused-vars
  SEARCHING_PREAMBLE,
  // eslint-disable-next-line no-unused-vars
  SEARCHING_SYNC_WORD,
  // eslint-disable-next-line no-unused-vars
  READING_HEADER,
  // eslint-disable-next-line no-unused-vars
  READING_PAYLOAD,
}

/**
 * データフレームの構築と再構築を管理するクラス
 */
export class DsssDpskFramer {
  private ldpcInstances: Map<number, LDPC> = new Map();
  private softBitBuffer: RingBuffer<Int8Array>; // Stores received soft bits
  private state: FramerState = FramerState.SEARCHING_PREAMBLE;
  private currentHeader: FrameOptions | null = null; // Store header for payload processing

  // 相関閾値（理論最大値から計算）
  private readonly preambleCorrelationThreshold: number;
  private readonly syncWordCorrelationThreshold: number;

  // 状態管理用変数
  private processedBitsCount: number = 0;
  private lastCorrelationValue: number = 0;
  private errorCount: number = 0;

  // 効率化のための再利用可能バッファ
  private readonly maxPatternWindow: Int8Array;
  private readonly maxRangeReadBuffer: Int8Array;

  constructor(bufferSize: number = DEFAULT_BUFFER_SIZE) {
    this.softBitBuffer = new RingBuffer(Int8Array, bufferSize);
    
    // 相関閾値を理論最大値から計算
    this.preambleCorrelationThreshold = PREAMBLE.length * LLR_MAX_VALUE * PREAMBLE_CORRELATION_THRESHOLD_RATIO;
    this.syncWordCorrelationThreshold = SYNC_WORD.length * LLR_MAX_VALUE * SYNC_WORD_CORRELATION_THRESHOLD_RATIO;
    
    // 効率化のための再利用可能バッファを初期化
    const maxPatternLength = Math.max(PREAMBLE.length, SYNC_WORD.length);
    this.maxPatternWindow = new Int8Array(maxPatternLength);
    // 最大読み取り範囲はペイロード長（最大1024ビット）
    this.maxRangeReadBuffer = new Int8Array(1024);
    
    // 各LDPCタイプに対応するLDPCインスタンスを生成（パンクチャリング対応）
    for (const key in FEC_PARAMS) {
        const type = parseInt(key) as keyof typeof FEC_PARAMS;
        const params = FEC_PARAMS[type];
        
        // パンクチャリング設定: 実際のH行列は仕様より大きいため、末尾をパンクチャ
        const puncturedBitIndices: number[] = [];
        for (let i = params.ldpcN; i < params.matrix.width; i++) {
            puncturedBitIndices.push(i);
        }
        
        this.ldpcInstances.set(type, new LDPC(params.matrix as HMatrixData, DEFAULT_LDPC_ITERATIONS, new Set(puncturedBitIndices)));
    }
  }

  /**
   * ユーザーデータとオプションからデータフレームを構築する
   * @param userData 送信するユーザーデータ
   * @param options フレームのオプション
   * @returns 構築されたデータフレームオブジェクト
   */
  public build(userData: Uint8Array, options: FrameOptions): DataFrame {
    // 1. ヘッダ本体(HB)を生成
    const headerByte = this._buildHeaderByte(options);

    // 2. ペイロードを符号化
    const payload = this._encodePayload(userData, options.ldpcNType);

    // 3. 全ビットを最大効率で結合（構造化定数使用、中間配列完全排除）
    // フレーム長を効率的に事前計算
    const totalBits = FRAME_LAYOUT.FIXED_HEADER_SIZE + payload.length;
    const bits = new Uint8Array(totalBits);
    
    // 高速な構造化設定（統合定数基準）
    let offset = 0;
    
    // プリアンブル設定（高速配列コピー）
    bits.set(PREAMBLE, offset);
    offset += FRAME_LAYOUT.PREAMBLE_LENGTH;
    
    // 同期ワード設定（高速配列コピー）
    bits.set(SYNC_WORD, offset);
    offset += FRAME_LAYOUT.SYNC_WORD_LENGTH;
    
    // ヘッダビット設定（直接展開、中間配列なし）
    BIT_MANIPULATION.expandByte(headerByte, bits.subarray(offset, offset + FRAME_LAYOUT.HEADER_LENGTH));
    offset += FRAME_LAYOUT.HEADER_LENGTH;
    
    // ペイロード設定
    bits.set(payload, offset);

    // Debug: 構築されたフレームのログ出力
    // console.log(`[Framer] Frame built: preamble=[${Array.from(bits.slice(0,4)).join(',')}], syncWord=[${Array.from(bits.slice(4,12)).join(',')}], header=[${Array.from(bits.slice(12,20)).join(',')}]`);
    
    // 新しいDataFrameクラスを返す（メモリ効率向上）
    return new DataFrame(bits, headerByte);
  }

  /**
   * Processes a chunk of received soft bits.
   * @param softBits A chunk of soft bits (Int8Array) from DSSS despreading.
   * @returns An array of successfully decoded frames.
   */
  public process(softBits: Int8Array): DecodedFrame[] {
    const decodedFrames: DecodedFrame[] = [];
    this.softBitBuffer.writeArray(softBits);
    this.processedBitsCount += softBits.length;

    // Main processing loop with safety limit
    const maxIterations = this.softBitBuffer.length * 2; // 最大でバッファサイズの2倍まで
    let iterations = 0;
    
    // eslint-disable-next-line no-constant-condition
    while (true) {
      iterations++;
      if (iterations > maxIterations) {
        console.warn(`[DsssDpskFramer] Processing hit iteration limit (${maxIterations}), breaking. State: ${FramerState[this.state]}, Buffer length: ${this.softBitBuffer.length}`);
        break;
      }
      
      const initialBufferLength = this.softBitBuffer.length;
      const processResult = this._processCurrentState(decodedFrames);
      
      // Debug: log processing progress (commented out for normal operation)
      // if (iterations % 100 === 0) {
      //   console.log(`[DsssDpskFramer] Iteration ${iterations}: State=${FramerState[this.state]}, Buffer=${this.softBitBuffer.length}, Frames=${decodedFrames.length}`);
      // }

      if (processResult === 'exit') {
        break;
      }

      // If no progress was made (buffer length is the same and no frames decoded),
      // and the state handler returned 'return', then we need more data.
      // Break the loop to wait for more input.
      if (processResult === 'return' && this.softBitBuffer.length === initialBufferLength && decodedFrames.length === 0) {
          break;
      }
      // If progress was made (buffer consumed or frame decoded) or result is 'continue',
      // continue the loop to process more.
    }
    return decodedFrames;
  }

  /**
   * 現在の状態に基づいて処理を実行
   * @param decodedFrames デコードされたフレームの配列
   * @returns 処理結果（'continue' | 'return' | 'exit'）
   */
  private _processCurrentState(decodedFrames: DecodedFrame[]): 'continue' | 'return' | 'exit' {
    switch (this.state) {
      case FramerState.SEARCHING_PREAMBLE:
        return this._handlePreambleSearch();
      case FramerState.SEARCHING_SYNC_WORD:
        return this._handleSyncWordSearch();
      case FramerState.READING_HEADER:
        return this._handleHeaderReading();
      case FramerState.READING_PAYLOAD:
        return this._handlePayloadReading(decodedFrames);
      default:
        return 'exit';
    }
  }

  private _handlePreambleSearch(): 'continue' | 'return' {
    if (this.softBitBuffer.length < PREAMBLE.length) {
      return 'return'; // Not enough data to even check for preamble
    }

    const preambleIndex = this._findPreamble();
    if (preambleIndex !== -1) {
      this._consumeBufferBits(preambleIndex + PREAMBLE.length);
      this.state = FramerState.SEARCHING_SYNC_WORD;
      return 'continue';
    } else {
      // If preamble not found, consume only 1 bit to slide the window
      this._consumeBufferBits(1);
      return 'continue';
    }
  }

  private _handleSyncWordSearch(): 'continue' | 'return' {
    if (this.softBitBuffer.length < SYNC_WORD.length) {
      return 'return'; // Not enough data to even check for sync word
    }

    const syncWordIndex = this._findSyncWord();
    if (syncWordIndex !== -1) {
      this._consumeBufferBits(syncWordIndex + SYNC_WORD.length);
      this.state = FramerState.READING_HEADER;
      return 'continue';
    } else {
      // If sync word not found, consume only 1 bit to slide the window
      this._consumeBufferBits(1);
      this.state = FramerState.SEARCHING_PREAMBLE; // Go back to searching preamble
      return 'continue';
    }
  }

  private _handleHeaderReading(): 'continue' | 'return' {
    if (this.softBitBuffer.length < HEADER_BITS) {
      return 'return';
    }
    
    const headerSoftBits = this._readBufferRange(0, HEADER_BITS);
    const decodedHeader = this._decodeHeader(headerSoftBits);
    
    if (decodedHeader) {
      this._consumeBufferBits(HEADER_BITS);
      this.currentHeader = decodedHeader;
      this.state = FramerState.READING_PAYLOAD;
    } else {
      this.errorCount++;
      this._consumeBufferBits(1);
      this.state = FramerState.SEARCHING_PREAMBLE;
    }
    return 'continue';
  }

  private _handlePayloadReading(decodedFrames: DecodedFrame[]): 'continue' | 'return' {
    if (!this.currentHeader) {
      this.state = FramerState.SEARCHING_PREAMBLE;
      return 'return';
    }

    const fecParams = FEC_PARAMS[this.currentHeader.ldpcNType as keyof typeof FEC_PARAMS];
    if (!fecParams) {
      this.state = FramerState.SEARCHING_PREAMBLE;
      return 'return';
    }

    const payloadBitLength = fecParams.ldpcN;
    if (this.softBitBuffer.length < payloadBitLength) {
      return 'return';
    }

    const payloadSoftBits = this._readBufferRange(0, payloadBitLength);
    const decodedPayload = this._decodePayload(payloadSoftBits, this.currentHeader.ldpcNType);

    if (decodedPayload) {
      decodedFrames.push({ 
        header: this.currentHeader, 
        userData: decodedPayload.userData, 
        status: decodedPayload.status 
      });
      this._consumeBufferBits(payloadBitLength);
    } else {
      this.errorCount++;
      this._consumeBufferBits(1);
    }
    
    this.state = FramerState.SEARCHING_PREAMBLE;
    this.currentHeader = null;
    return 'continue';
  }

  /**
   * 状態をリセットする
   */
  public reset(): void {
    this.state = FramerState.SEARCHING_PREAMBLE;
    this.currentHeader = null;
    this.softBitBuffer.clear();
  }

  /**
   * 現在の状態を取得する（デバッグ用）
   */
  public getState(): FramerStatus {
    return {
      state: FramerState[this.state],
      bufferLength: this.softBitBuffer.length,
      processedBits: this.processedBitsCount,
      lastCorrelation: this.lastCorrelationValue,
      isHealthy: this.errorCount < ERROR_COUNT_THRESHOLD
    };
  }

  private _buildHeaderByte(options: FrameOptions): number {
    let header = 0;
    header |= (options.sequenceNumber & SEQUENCE_NUMBER_MASK) << SEQUENCE_NUMBER_SHIFT; // S (bit 7-5)
    header |= (options.frameType & FRAME_TYPE_MASK) << FRAME_TYPE_SHIFT;              // T (bit 4-3)
    header |= (options.ldpcNType & LDPC_N_TYPE_MASK) << LDPC_N_TYPE_SHIFT;            // N (bit 2-1)

    // Calculate parity for bit 7-1
    let parity = 0;
    for (let i = 1; i < HEADER_BITS; i++) {
      if ((header >> i) & 1) {
        parity++;
      }
    }
    // 偶数パリティにする
    if (parity % 2 !== 0) {
      header |= PARITY_BIT_MASK; // P (bit 0)
    }

    return header;
  }

  private _encodePayload(userData: Uint8Array, ldpcNType: number): Uint8Array {
    const params = FEC_PARAMS[ldpcNType as keyof typeof FEC_PARAMS];
    const ldpc = this.ldpcInstances.get(ldpcNType);
    if (!params || !ldpc) {
      throw new Error(`Invalid ldpcNType: ${ldpcNType}`);
    }

    // 1. BCH符号化
    const maxDataBytes = params.payloadBytes; // FEC_PARAMSで定義された正確なサイズ
    if (userData.length > maxDataBytes) {
        throw new Error(`User data (${userData.length} bytes) exceeds max length for ${params.bchType} (${maxDataBytes} bytes)`);
    }
    
    // ユーザーデータをBCH情報長に合わせてパディング
    const paddedUserData = new Uint8Array(maxDataBytes);
    paddedUserData.set(userData);
    
    const bchEncoded = bchEncode(paddedUserData, params.bchType);

    // LDPC情報バイト数（k/8）に合わせてリサイズ
    const ldpcInfoBytes = params.ldpcN / 2 / 8; // n=128 → k=64 → 8 bytes
    const ldpcInputBytes = new Uint8Array(ldpcInfoBytes);
    const copyLength = Math.min(bchEncoded.length, ldpcInfoBytes);
    ldpcInputBytes.set(bchEncoded.slice(0, copyLength));

    // 2. LDPC符号化（Uint8Array → Uint8Array）
    const ldpcEncoded = ldpc.encode(ldpcInputBytes);

    // パックされたバイトをビット配列に効率的に展開（最適化されたユーティリティ使用）
    const ldpcBits = new Uint8Array(ldpcEncoded.length * HEADER_BITS);
    BIT_MANIPULATION.expandBytes(ldpcEncoded, ldpcBits);

    return ldpcBits; // フレーム構成用にビット配列を返す
  }

  private _correlate(softBits: Int8Array, pattern: readonly number[]): number {
    if (softBits.length < pattern.length) {
      return -Infinity; // Not enough data
    }
    let correlation = 0;
    for (let i = 0; i < pattern.length; i++) {
      // LLR convention: LLR >= 0 means bit 0, LLR < 0 means bit 1
      // For correlation, we want high positive values when pattern matches
      if (pattern[i] === 0) {
        // We expect LLR >= 0 (positive) for bit 0
        correlation += softBits[i];
      } else {
        // We expect LLR < 0 (negative) for bit 1, so negate it for positive correlation
        correlation += -softBits[i];
      }
    }
    this.lastCorrelationValue = correlation; // 状態管理用に保存
    
    // Debug: 同期ワード検出時のログ（簡略版）
    // if (pattern.length === 8 && pattern[0] === 1 && correlation > this.syncWordCorrelationThreshold) {
    //   console.log(`[Framer] Sync word detected: correlation=${correlation.toFixed(1)}, threshold=${this.syncWordCorrelationThreshold.toFixed(1)}`);
    // }
    
    return correlation;
  }

  /**
   * 指定されたパターンをバッファ内で検索する汎用メソッド（効率化版）
   * @param pattern 検索するビットパターン
   * @param threshold 相関閾値
   * @returns パターンが見つかった位置（見つからない場合は-1）
   */
  private _findPattern(pattern: readonly number[], threshold: number): number {
    if (this.softBitBuffer.length < pattern.length) {
      return -1;
    }
    
    // 再利用可能バッファを使用（メモリアロケーション削減）
    const window = this.maxPatternWindow.subarray(0, pattern.length);
    
    for (let i = 0; i <= this.softBitBuffer.length - pattern.length; i++) {
      // ウィンドウデータをコピー
      for (let j = 0; j < pattern.length; j++) {
        window[j] = this.softBitBuffer.get(i + j);
      }
      
      const correlation = this._correlate(window, pattern);
      if (correlation > threshold) {
        return i;
      }
    }
    return -1;
  }

  private _findPreamble(): number {
    return this._findPattern(PREAMBLE, this.preambleCorrelationThreshold);
  }

  private _findSyncWord(): number {
    return this._findPattern(SYNC_WORD, this.syncWordCorrelationThreshold);
  }

  /**
   * バッファから指定されたバイト数を効率的に消費する
   * @param count 消費するバイト数
   */
  private _consumeBufferBits(count: number): void {
    if (count > 0) {
      // 最適化: 不要な配列割り当てを排除し、直接消費
      // 注: RingBufferに効率的な消費メソッドがある場合は利用すべき
      for (let i = 0; i < count; i++) {
        this.softBitBuffer.read();
      }
    }
  }

  /**
   * バッファから指定された範囲のデータを効率的に読み取る（消費はしない）
   * @param start 開始位置
   * @param length 読み取り長
   * @returns 読み取ったデータ
   */
  private _readBufferRange(start: number, length: number): Int8Array {
    // 小さなデータ（ヘッダ等）は直接作成、大きなデータは再利用バッファ使用
    if (length <= HEADER_BITS) {
      // 小さなケース: 直接作成（ヘッダ読み取り等）
      const data = new Int8Array(length);
      for (let i = 0; i < length && (start + i) < this.softBitBuffer.length; i++) {
        data[i] = this.softBitBuffer.get(start + i);
      }
      return data;
    } else {
      // 大きなケース: 再利用バッファ使用（ペイロード読み取り等）
      const data = this.maxRangeReadBuffer.subarray(0, length);
      for (let i = 0; i < length && (start + i) < this.softBitBuffer.length; i++) {
        data[i] = this.softBitBuffer.get(start + i);
      }
      // 実際に使用したサイズでコピーを返す（安全性確保）
      return data.slice(0, length);
    }
  }

  private _decodeHeader(headerSoftBits: Int8Array): FrameOptions | null {
    if (headerSoftBits.length < HEADER_BITS) {
      return null;
    }

    let headerByte = 0;
    let receivedParity = 0;
    let calculatedParity = 0;

    // 最適化されたビット再構築ユーティリティを使用
    headerByte = BIT_MANIPULATION.reconstructByte(headerSoftBits);

    // Extract received parity bit (bit 0)
    receivedParity = (headerByte & PARITY_BIT_MASK);

    // Calculate parity for bit 7-1
    for (let i = 1; i < HEADER_BITS; i++) {
      if ((headerByte >> i) & 1) {
        calculatedParity++;
      }
    }

    // Check parity (even parity)
    if ((calculatedParity % 2) !== receivedParity) { 
      return null; // Parity check failed
    }

    // Decode FrameOptions
    const sequenceNumber = (headerByte >> SEQUENCE_NUMBER_SHIFT) & SEQUENCE_NUMBER_MASK;
    const frameType = (headerByte >> FRAME_TYPE_SHIFT) & FRAME_TYPE_MASK;
    const ldpcNType = (headerByte >> LDPC_N_TYPE_SHIFT) & LDPC_N_TYPE_MASK;

    return { sequenceNumber, frameType, ldpcNType };
  }

  private _decodePayload(payloadSoftBits: Int8Array, ldpcNType: number): { userData: Uint8Array; status: 'success' | 'bch_corrected' } | null {
    const params = FEC_PARAMS[ldpcNType as keyof typeof FEC_PARAMS];
    const ldpc = this.ldpcInstances.get(ldpcNType);
    if (!params || !ldpc) {
      return null;
    }

    // 1. LDPC復号 - decodeメソッドを使用して情報ビットを直接取得
    // payloadSoftBits は既にInt8Array（LLR soft values）
    const ldpcDecodeResult = ldpc.decode(payloadSoftBits, DEFAULT_LDPC_ITERATIONS);

    if (!ldpcDecodeResult.converged) {
      // Even if not converged, we can still try BCH, but for now, consider it a failure
      return null; 
    }

    // 2. BCH復号 - LDPC復号で得られた情報ビット（メッセージ）をBCH復号にかける
    const bchDecodeResult = bchDecode(ldpcDecodeResult.decodedMessage, params.bchType);

    if (bchDecodeResult.status === 'failed') {
      return null;
    }

    // BCHのステータスをDSSS-DPSKフレーマーのステータスにマッピング
    const status: 'success' | 'bch_corrected' = 
      bchDecodeResult.status === 'corrected' ? 'bch_corrected' : 'success';

    // ユーザーデータサイズを元のpayloadBytesに制限（FEC_PARAMSで指定されたサイズ）
    const maxUserDataBytes = params.payloadBytes;
    const userData = bchDecodeResult.data.slice(0, maxUserDataBytes);

    return { userData, status };
  }


}