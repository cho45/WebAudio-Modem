import { bchEncode, bchDecode, type BCHCodeType } from '../fec/bch';
import { LDPC, type HMatrixData } from '../fec/ldpc';
import { RingBuffer } from '../utils';

// 正しく生成されたLDPC H行列データを読み込み
import ldpcMatrix128 from '../fec/ldpc_h_matrix_n128_k64.json';
import ldpcMatrix256 from '../fec/ldpc_h_matrix_n256_k128.json';
import ldpcMatrix512 from '../fec/ldpc_h_matrix_n512_k256.json';
import ldpcMatrix1024 from '../fec/ldpc_h_matrix_n1024_k512.json';

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
const SYNC_WORD_CORRELATION_THRESHOLD_RATIO = 0.8; // 80% of theoretical max

// フレーム構築オプション
export interface FrameOptions {
  sequenceNumber: number; // 3-bit (0-7)
  frameType: number;      // 2-bit (0-3)
  ldpcNType: number;      // 2-bit (0-3)
}

// 構築されたデータフレーム
export interface DataFrame {
  preamble: Uint8Array;
  syncWord: Uint8Array;
  headerByte: number;
  payload: Uint8Array; // LDPC符号化済みのペイロード
  bits: Uint8Array;    // 全体を結合したビット配列
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
  private readonly headerBitsBuffer: Uint8Array;
  private readonly maxRangeReadBuffer: Int8Array;

  constructor(bufferSize: number = DEFAULT_BUFFER_SIZE) {
    this.softBitBuffer = new RingBuffer(Int8Array, bufferSize);
    
    // 相関閾値を理論最大値から計算
    this.preambleCorrelationThreshold = PREAMBLE.length * LLR_MAX_VALUE * PREAMBLE_CORRELATION_THRESHOLD_RATIO;
    this.syncWordCorrelationThreshold = SYNC_WORD.length * LLR_MAX_VALUE * SYNC_WORD_CORRELATION_THRESHOLD_RATIO;
    
    // 効率化のための再利用可能バッファを初期化
    const maxPatternLength = Math.max(PREAMBLE.length, SYNC_WORD.length);
    this.maxPatternWindow = new Int8Array(maxPatternLength);
    this.headerBitsBuffer = new Uint8Array(HEADER_BITS);
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

    // 3. 全ビットを結合
    const headerBits = this._byteToBits(headerByte);
    const preambleBits = new Uint8Array(PREAMBLE);
    const syncWordBits = new Uint8Array(SYNC_WORD);
    
    // LDPC符号化結果は既にビット配列（各要素は0または1）
    const payloadBits = payload;

    const totalBits = preambleBits.length + syncWordBits.length + headerBits.length + payloadBits.length;
    
    const bits = new Uint8Array(totalBits);
    bits.set(preambleBits, 0);
    bits.set(syncWordBits, preambleBits.length);
    bits.set(headerBits, preambleBits.length + syncWordBits.length);
    bits.set(payloadBits, preambleBits.length + syncWordBits.length + headerBits.length);

    return {
      preamble: preambleBits,
      syncWord: syncWordBits,
      headerByte: headerByte,
      payload: payload,
      bits: bits,
    };
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

    // Main processing loop
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const processResult = this._processCurrentState(decodedFrames);
      if (processResult === 'exit') {
        break;
      } else if (processResult === 'return') {
        return decodedFrames;
      }
      
      // Check if we have enough data to continue
      if (this.state === FramerState.SEARCHING_PREAMBLE && 
          this.softBitBuffer.length < (PREAMBLE.length + SYNC_WORD.length + HEADER_BITS)) {
        break;
      }
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
    const preambleIndex = this._findPreamble();
    if (preambleIndex !== -1) {
      this._consumeBufferBits(preambleIndex + PREAMBLE.length);
      this.state = FramerState.SEARCHING_SYNC_WORD;
      return 'continue';
    } else {
      const minKeepBits = PREAMBLE.length + SYNC_WORD.length + HEADER_BITS;
      const consumeCount = this.softBitBuffer.length - Math.max(0, this.softBitBuffer.length - minKeepBits);
      this._consumeBufferBits(consumeCount);
      return 'return';
    }
  }

  private _handleSyncWordSearch(): 'continue' | 'return' {
    const syncWordIndex = this._findSyncWord();
    if (syncWordIndex !== -1) {
      this._consumeBufferBits(syncWordIndex + SYNC_WORD.length);
      this.state = FramerState.READING_HEADER;
      return 'continue';
    } else {
      const minKeepBits = SYNC_WORD.length + HEADER_BITS;
      const consumeCount = this.softBitBuffer.length - Math.max(0, this.softBitBuffer.length - minKeepBits);
      this._consumeBufferBits(consumeCount);
      this.state = FramerState.SEARCHING_PREAMBLE;
      return 'return';
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

    // パックされたバイトをビット配列に展開（フレーム構成用）
    const ldpcBits = new Uint8Array(ldpcEncoded.length * HEADER_BITS);
    for (let i = 0; i < ldpcEncoded.length; i++) {
      const byte = ldpcEncoded[i];
      const baseIndex = i * HEADER_BITS;
      // ビット展開を最適化
      ldpcBits[baseIndex] = (byte >> 7) & 1;
      ldpcBits[baseIndex + 1] = (byte >> 6) & 1;
      ldpcBits[baseIndex + 2] = (byte >> 5) & 1;
      ldpcBits[baseIndex + 3] = (byte >> 4) & 1;
      ldpcBits[baseIndex + 4] = (byte >> 3) & 1;
      ldpcBits[baseIndex + 5] = (byte >> 2) & 1;
      ldpcBits[baseIndex + 6] = (byte >> 1) & 1;
      ldpcBits[baseIndex + 7] = byte & 1;
    }

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
   * バッファから指定されたバイト数を消費する
   * @param count 消費するバイト数
   */
  private _consumeBufferBits(count: number): void {
    if (count > 0) {
      const consumeData = new Int8Array(count);
      this.softBitBuffer.readArray(consumeData);
    }
  }

  /**
   * バッファから指定された範囲のデータを読み取る（消費はしない）
   * @param start 開始位置
   * @param length 読み取り長
   * @returns 読み取ったデータ
   */
  private _readBufferRange(start: number, length: number): Int8Array {
    // 再利用可能バッファを使用（効率化）
    const data = this.maxRangeReadBuffer.subarray(0, length);
    for (let i = 0; i < length && (start + i) < this.softBitBuffer.length; i++) {
      data[i] = this.softBitBuffer.get(start + i);
    }
    // 実際に使用したサイズでコピーを返す（安全性確保）
    return data.slice(0, length);
  }

  private _decodeHeader(headerSoftBits: Int8Array): FrameOptions | null {
    if (headerSoftBits.length < HEADER_BITS) {
      return null;
    }

    let headerByte = 0;
    let receivedParity = 0;
    let calculatedParity = 0;

    // Convert soft bits to hard bits and reconstruct header byte
    for (let i = 0; i < HEADER_BITS; i++) {
      // LLR >= 0 means 0, LLR < 0 means 1 (DSSS despread convention)
      const bit = headerSoftBits[i] >= 0 ? 0 : 1; 
      if (bit === 1) {
        headerByte |= (1 << (HEADER_BITS - 1 - i));
      }
    }

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

  private _byteToBits(byte: number): Uint8Array {
      // 再利用可能バッファを使用（効率化）
      for (let i = 0; i < HEADER_BITS; i++) {
          this.headerBitsBuffer[i] = (byte >> (HEADER_BITS - 1 - i)) & 1;
      }
      // 安全性のためコピーを返す（呼び出し側の変更が内部バッファに影響しないよう）
      return this.headerBitsBuffer.slice();
  }

}