/**
 * DSSS-DPSK Framer Implementation
 * 
 * フレーマーの責務とライフサイクル：
 * - デモデュレータが同期確立後、ヘッダバイトからフレーム解析・構築を行う
 * - プリアンブル・同期ワード検出はデモデュレータが担当（重複排除）
 * - 各フレームごとに新しいインスタンスを作成（状態管理の簡素化）
 * 
 * フレーマー状態遷移：
 * 1. 初期状態: WAITING_HEADER
 *    - demodulatorからheaderByteを受信待ち
 * 
 * 2. initialize(headerByte)呼び出し
 *    - ヘッダバイト解析（シーケンス番号、フレームタイプ、LDPC Nタイプ）
 *    - パリティチェック実行
 *    - データ長決定（LDPC Nタイプに基づく）
 *    - 状態: WAITING_HEADER → WAITING_DATA
 * 
 * 3. addDataBits(bits)連続呼び出し
 *    - LLRビットをpacked Uint8Arrayに蓄積
 *    - remainingBitsが0になるまで継続
 * 
 * 4. finalize()呼び出し
 *    - LDPC復号 → BCH復号の順で実行
 *    - 完全なDataFrame復元
 *    - 状態: WAITING_DATA → COMPLETED
 * 
 * 5. インスタンス破棄
 *    - COMPLETED後は新しいインスタンス作成
 *    - 状態バグの防止
 */

import { bchEncode, bchDecode, type BCHCodeType } from '../../fec/bch';
import { LDPC, type HMatrixData } from '../../fec/ldpc';

// 正しく生成されたLDPC H行列データを読み込み
import ldpcMatrix128 from '../../fec/ldpc_h_matrix_n128_k64.json';
import ldpcMatrix256 from '../../fec/ldpc_h_matrix_n256_k128.json';
import ldpcMatrix512 from '../../fec/ldpc_h_matrix_n512_k256.json';
import ldpcMatrix1024 from '../../fec/ldpc_h_matrix_n1024_k512.json';

// フレーム構造定数
const HEADER_BITS = 8;
const DEFAULT_LDPC_ITERATIONS = 10;

// ヘッダビットマスク
const SEQUENCE_NUMBER_MASK = 0x7;  // 3-bit mask
const FRAME_TYPE_MASK = 0x3;       // 2-bit mask
const LDPC_N_TYPE_MASK = 0x3;      // 2-bit mask
const PARITY_BIT_MASK = 0x01;      // 1-bit mask for parity

// ヘッダビットシフト量
const SEQUENCE_NUMBER_SHIFT = 5;    // シーケンス番号のシフト量
const FRAME_TYPE_SHIFT = 3;         // フレームタイプのシフト量
const LDPC_N_TYPE_SHIFT = 1;        // LDPC Nタイプのシフト量

// フレーム構築オプション
export interface FrameOptions {
  sequenceNumber: number; // 3-bit (0-7)
  frameType: number;      // 2-bit (0-3)
  ldpcNType: number;      // 2-bit (0-3)
}

// デコードされたフレーム
export interface DecodedFrame {
  header: FrameOptions;   // 解析されたヘッダ
  userData: Uint8Array;   // 最終的に復元されたユーザーデータ
  status: 'success' | 'bch_corrected'; // 復元ステータス
}

// フレーマーの状態
// eslint-disable-next-line no-unused-vars
export enum FramerState {
  // eslint-disable-next-line no-unused-vars
  WAITING_HEADER,  // ヘッダバイト待ち
  // eslint-disable-next-line no-unused-vars
  WAITING_DATA,    // データビット蓄積中
  // eslint-disable-next-line no-unused-vars
  COMPLETED        // フレーム完成（新しいインスタンス作成が必要）
}

// フレーマーステータス
export interface FramerStatus {
  state: string;
  remainingBits: number;
  isHealthy: boolean;
}

// LDPCとBCHのパラメータを管理するテーブル
const FEC_PARAMS = {
  0: { ldpcN: 128,  bchType: 'BCH_63_56_1' as BCHCodeType,    payloadBytes: 7,   matrix: ldpcMatrix128 },
  1: { ldpcN: 256,  bchType: 'BCH_127_120_1' as BCHCodeType,  payloadBytes: 15,  matrix: ldpcMatrix256 },
  2: { ldpcN: 512,  bchType: 'BCH_255_247_1' as BCHCodeType,  payloadBytes: 30,  matrix: ldpcMatrix512 },
  3: { ldpcN: 1024, bchType: 'BCH_511_502_1' as BCHCodeType,  payloadBytes: 62,  matrix: ldpcMatrix1024 },
};

// ビット操作ユーティリティ
export const BIT_MANIPULATION = {
  /**
   * 単一バイトを8ビットの配列に効率的に展開
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

/**
 * 効率的なデータフレームクラス
 */
export class DataFrame {
  constructor(
    private readonly _bits: Uint8Array,
    private readonly _headerByte: number
  ) {}

  get bits(): Uint8Array {
    return this._bits;
  }

  get headerByte(): number {
    return this._headerByte;
  }

  get length(): number {
    return this._bits.length;
  }
}

/**
 * DSSS-DPSK Framer
 * 
 * 各フレームごとに新しいインスタンスを作成
 * 状態遷移：WAITING_HEADER → WAITING_DATA → COMPLETED
 */
const ldpcInstances: Map<number, LDPC> = new Map();
export class DsssDpskFramer {
  private state: FramerState = FramerState.WAITING_HEADER;
  
  // フレーム情報
  private header: FrameOptions | null = null;
  private fecParams: typeof FEC_PARAMS[keyof typeof FEC_PARAMS] | null = null;
  
  // データ蓄積
  private payloadSoftBits: Int8Array | null = null;
  private currentBitIndex: number = 0;

  constructor() {
    // 各LDPCタイプに対応するLDPCインスタンスを生成
    for (const key in FEC_PARAMS) {
      const type = parseInt(key) as keyof typeof FEC_PARAMS;
      const params = FEC_PARAMS[type];
      
      // パンクチャリング設定
      const puncturedBitIndices: number[] = [];
      for (let i = params.ldpcN; i < params.matrix.width; i++) {
        puncturedBitIndices.push(i);
      }
      
      if (!ldpcInstances.has(type)) {
        ldpcInstances.set(type, new LDPC(params.matrix as HMatrixData, DEFAULT_LDPC_ITERATIONS, new Set(puncturedBitIndices)));
      }
    }
  }

  /**
   * ヘッダバイトを解析してフレーム情報を設定
   * @param headerByte ヘッダバイト値
   * @returns 解析成功時true
   * @throws WAITING_HEADER状態以外で呼び出した場合
   */
  public initialize(headerByte: number): boolean {
    if (this.state !== FramerState.WAITING_HEADER) {
      throw new Error('initialize() can only be called in WAITING_HEADER state');
    }

    // ヘッダ解析
    const parsedHeader = this._decodeHeader(headerByte);
    // console.log(`[Framer Debug] headerByte=0x${headerByte.toString(16)}, parsedHeader=${JSON.stringify(parsedHeader)}`);
    if (!parsedHeader) {
      // console.log(`[Framer Debug] Header decode failed for 0x${headerByte.toString(16)}`);
      return false; // パリティエラーなど
    }

    // FECパラメータ取得
    const fecParams = FEC_PARAMS[parsedHeader.ldpcNType as keyof typeof FEC_PARAMS];
    if (!fecParams) {
      // console.log(`[Framer Debug] Invalid LDPC N type: ${parsedHeader.ldpcNType}`);
      return false; // 無効なLDPC Nタイプ
    }

    // フレーム情報設定
    this.header = parsedHeader;
    this.fecParams = fecParams;
    
    // データビット蓄積用バッファ初期化
    this.payloadSoftBits = new Int8Array(fecParams.ldpcN);
    this.currentBitIndex = 0;
    
    // 状態遷移
    this.state = FramerState.WAITING_DATA;
    
    return true;
  }

  /**
   * データビットを蓄積
   * @param bits LLRビット配列
   * @throws WAITING_DATA状態以外で呼び出した場合
   */
  public addDataBits(bits: Int8Array): void {
    if (this.state !== FramerState.WAITING_DATA) {
      throw new Error('addDataBits() can only be called in WAITING_DATA state');
    }

    if (!this.payloadSoftBits || !this.fecParams) {
      throw new Error('Internal error: payloadSoftBits or fecParams not initialized');
    }

    // 蓄積可能なビット数を計算
    const remainingCapacity = this.payloadSoftBits.length - this.currentBitIndex;
    const bitsToAdd = Math.min(bits.length, remainingCapacity);

    // ビット蓄積
    for (let i = 0; i < bitsToAdd; i++) {
      this.payloadSoftBits[this.currentBitIndex++] = bits[i];
    }
  }

  /**
   * フレーム完成・FEC復号実行
   * @returns 復号されたフレーム
   * @throws WAITING_DATA状態以外で呼び出した場合、データが不完全な場合、またはFEC復号失敗時
   */
  public finalize(): DecodedFrame {
    if (this.state !== FramerState.WAITING_DATA) {
      throw new Error('finalize() can only be called in WAITING_DATA state');
    }

    if (!this.header || !this.fecParams || !this.payloadSoftBits) {
      throw new Error('Internal error: frame data not properly initialized');
    }

    if (this.currentBitIndex < this.payloadSoftBits.length) {
      throw new Error(`Incomplete data: ${this.currentBitIndex}/${this.payloadSoftBits.length} bits received`);
    }

    // FEC復号実行（エラーは呼び出し元でハンドリング）
    const decodedPayload = this._decodePayload(this.payloadSoftBits, this.header.ldpcNType);
    
    // 状態遷移
    this.state = FramerState.COMPLETED;

    return {
      header: this.header,
      userData: decodedPayload.userData,
      status: decodedPayload.status
    };
  }

  /**
   * 必要なデータ長（ビット数）を取得
   */
  public get dataLength(): number {
    if (!this.fecParams) {
      throw new Error('dataLength can only be accessed after successful initialize()');
    }
    return this.fecParams.ldpcN;
  }

  /**
   * 残り必要ビット数を取得
   */
  public get remainingBits(): number {
    if (this.state === FramerState.WAITING_HEADER) {
      return 0; // ヘッダ待ちなので不明
    }
    if (!this.fecParams) {
      return 0;
    }
    // 負の値を防ぐため、最低0を返す
    return Math.max(0, this.fecParams.ldpcN - this.currentBitIndex);
  }

  /**
   * 現在の状態を取得
   */
  public getState(): FramerStatus {
    return {
      state: FramerState[this.state],
      remainingBits: this.remainingBits,
      isHealthy: this.state !== FramerState.COMPLETED
    };
  }

  // === フレーム構築メソッド（送信用） ===

  /**
   * ユーザーデータとオプションからデータフレームを構築
   */
  public static build(userData: Uint8Array, options: FrameOptions): DataFrame {
    const builder = new DsssDpskFramer();
    return builder._buildFrame(userData, options);
  }

  private _buildFrame(userData: Uint8Array, options: FrameOptions): DataFrame {
    // ヘッダ本体生成
    const headerByte = this._buildHeaderByte(options);

    // ペイロード符号化
    const payload = this._encodePayload(userData, options.ldpcNType);

    // プリアンブル + 同期ワード + ヘッダ + ペイロードを結合
    const PREAMBLE = [0, 0, 0, 0];
    const SYNC_WORD = [1, 0, 1, 1, 0, 1, 0, 0];
    
    const totalBits = PREAMBLE.length + SYNC_WORD.length + HEADER_BITS + payload.length;
    const bits = new Uint8Array(totalBits);
    
    let offset = 0;
    
    // プリアンブル設定
    bits.set(PREAMBLE, offset);
    offset += PREAMBLE.length;
    
    // 同期ワード設定
    bits.set(SYNC_WORD, offset);
    offset += SYNC_WORD.length;
    
    // ヘッダビット設定
    BIT_MANIPULATION.expandByte(headerByte, bits.subarray(offset, offset + HEADER_BITS));
    offset += HEADER_BITS;
    
    // ペイロード設定
    bits.set(payload, offset);

    return new DataFrame(bits, headerByte);
  }

  // === プライベートメソッド ===

  private _buildHeaderByte(options: FrameOptions): number {
    let header = 0;
    header |= (options.sequenceNumber & SEQUENCE_NUMBER_MASK) << SEQUENCE_NUMBER_SHIFT;
    header |= (options.frameType & FRAME_TYPE_MASK) << FRAME_TYPE_SHIFT;
    header |= (options.ldpcNType & LDPC_N_TYPE_MASK) << LDPC_N_TYPE_SHIFT;

    // パリティ計算（偶数パリティ）
    let parity = 0;
    for (let i = 1; i < HEADER_BITS; i++) {
      if ((header >> i) & 1) {
        parity++;
      }
    }
    if (parity % 2 !== 0) {
      header |= PARITY_BIT_MASK;
    }

    return header;
  }

  private _decodeHeader(headerByte: number): FrameOptions | null {
    // パリティチェック
    let calculatedParity = 0;
    for (let i = 1; i < HEADER_BITS; i++) {
      if ((headerByte >> i) & 1) {
        calculatedParity++;
      }
    }
    const receivedParity = headerByte & PARITY_BIT_MASK;
    
    if ((calculatedParity % 2) !== receivedParity) {
      return null; // パリティエラー
    }

    // フィールド抽出
    const sequenceNumber = (headerByte >> SEQUENCE_NUMBER_SHIFT) & SEQUENCE_NUMBER_MASK;
    const frameType = (headerByte >> FRAME_TYPE_SHIFT) & FRAME_TYPE_MASK;
    const ldpcNType = (headerByte >> LDPC_N_TYPE_SHIFT) & LDPC_N_TYPE_MASK;

    return { sequenceNumber, frameType, ldpcNType };
  }

  private _encodePayload(userData: Uint8Array, ldpcNType: number): Uint8Array {
    const params = FEC_PARAMS[ldpcNType as keyof typeof FEC_PARAMS];
    const ldpc = ldpcInstances.get(ldpcNType);
    if (!params || !ldpc) {
      throw new Error(`Invalid ldpcNType: ${ldpcNType}`);
    }

    // BCH符号化
    const maxDataBytes = params.payloadBytes;
    if (userData.length > maxDataBytes) {
      throw new Error(`User data (${userData.length} bytes) exceeds max length for ${params.bchType} (${maxDataBytes} bytes)`);
    }
    
    const paddedUserData = new Uint8Array(maxDataBytes);
    paddedUserData.set(userData);
    
    const bchEncoded = bchEncode(paddedUserData, params.bchType);

    // LDPC符号化
    const ldpcInfoBytes = params.ldpcN / 2 / 8;
    const ldpcInputBytes = new Uint8Array(ldpcInfoBytes);
    const copyLength = Math.min(bchEncoded.length, ldpcInfoBytes);
    ldpcInputBytes.set(bchEncoded.slice(0, copyLength));

    const ldpcEncoded = ldpc.encode(ldpcInputBytes);

    // ビット配列に展開
    const ldpcBits = new Uint8Array(ldpcEncoded.length * HEADER_BITS);
    BIT_MANIPULATION.expandBytes(ldpcEncoded, ldpcBits);

    return ldpcBits;
  }

  private _decodePayload(payloadSoftBits: Int8Array, ldpcNType: number): { userData: Uint8Array; status: 'success' | 'bch_corrected' } {
    const params = FEC_PARAMS[ldpcNType as keyof typeof FEC_PARAMS];
    const ldpc = ldpcInstances.get(ldpcNType);
    if (!params) {
      throw new Error(`Invalid ldpcNType: ${ldpcNType}`);
    }
    if (!ldpc) {
      throw new Error(`Invalid ldpcNType: ${ldpcNType} (LDPC instance not found)`);
    }

    // LDPC復号
    const ldpcDecodeResult = ldpc.decode(payloadSoftBits, DEFAULT_LDPC_ITERATIONS);
    if (!ldpcDecodeResult.converged) {
      throw new Error(`LDPC decode failed (not converged) for type ${params.ldpcN}`);
    }

    // BCH復号
    const bchDecodeResult = bchDecode(ldpcDecodeResult.decodedMessage, params.bchType);
    if (bchDecodeResult.status === 'failed') {
      throw new Error(`BCH decode failed for type ${params.bchType}`);
    }

    const status: 'success' | 'bch_corrected' = 
      bchDecodeResult.status === 'corrected' ? 'bch_corrected' : 'success';

    const userData = bchDecodeResult.data.slice(0, params.payloadBytes);

    return { userData, status };
  }
}
