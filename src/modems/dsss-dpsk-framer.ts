import { bchEncode, bchDecode, getBCHParams, type BCHCodeType } from '../fec/bch';
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
enum FramerState {
  SEARCHING_PREAMBLE,
  SEARCHING_SYNC_WORD,
  READING_HEADER,
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

  // Parameters for detection thresholds (tuned for LLR range -127 to +127)
  // Preamble: 4 bits, all 0s. Expected LLRs are -127. Max correlation = 4 * 127 = 508.
  private preambleCorrelationThreshold: number = 400; // Needs tuning, e.g., 80% of max
  // Sync Word: 8 bits, mixed 0s and 1s. Max correlation = 8 * 127 = 1016.
  private syncWordCorrelationThreshold: number = 800; // Needs tuning, e.g., 80% of max

  // 状態管理用変数
  private processedBitsCount: number = 0;
  private lastCorrelationValue: number = 0;
  private errorCount: number = 0;

  constructor(bufferSize: number = 4096) {
    this.softBitBuffer = new RingBuffer(Int8Array, bufferSize);
    
    // 各LDPCタイプに対応するLDPCインスタンスを生成（パンクチャリング対応）
    for (const key in FEC_PARAMS) {
        const type = parseInt(key) as keyof typeof FEC_PARAMS;
        const params = FEC_PARAMS[type];
        
        // パンクチャリング設定: 実際のH行列は仕様より大きいため、末尾をパンクチャ
        const puncturedBitIndices: number[] = [];
        for (let i = params.ldpcN; i < params.matrix.width; i++) {
            puncturedBitIndices.push(i);
        }
        
        this.ldpcInstances.set(type, new LDPC(params.matrix as HMatrixData, 10, puncturedBitIndices));
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
    this.softBitBuffer.writeArray(softBits); // Direct Int8Array input
    this.processedBitsCount += softBits.length; // 処理ビット数を更新

    // Main processing loop
    // eslint-disable-next-line no-constant-condition
    while (true) {
      switch (this.state) {
        case FramerState.SEARCHING_PREAMBLE: {
          const preambleIndex = this._findPreamble();
          if (preambleIndex !== -1) {
            const consumeData = new Int8Array(preambleIndex + PREAMBLE.length);
            this.softBitBuffer.readArray(consumeData); // Consume preamble bits
            this.state = FramerState.SEARCHING_SYNC_WORD;
          } else {
            // No preamble found, consume some bits to avoid getting stuck
            // Keep enough bits to potentially find a preamble in the next chunk
            const consumeCount = this.softBitBuffer.length - Math.max(0, this.softBitBuffer.length - PREAMBLE.length - SYNC_WORD.length - 8);
            if (consumeCount > 0) {
              const consumeData = new Int8Array(consumeCount);
              this.softBitBuffer.readArray(consumeData);
            } 
            return decodedFrames; // No more processing possible in this state
          }
          break;
        }

        case FramerState.SEARCHING_SYNC_WORD: {
          const syncWordIndex = this._findSyncWord();
          if (syncWordIndex !== -1) {
            const consumeData = new Int8Array(syncWordIndex + SYNC_WORD.length);
            this.softBitBuffer.readArray(consumeData); // Consume sync word bits
            this.state = FramerState.READING_HEADER;
          } else {
            // No sync word found, consume some bits and go back to searching preamble
            // Keep enough bits to potentially find a sync word in the next chunk
            const consumeCount = this.softBitBuffer.length - Math.max(0, this.softBitBuffer.length - SYNC_WORD.length - 8);
            if (consumeCount > 0) {
              const consumeData = new Int8Array(consumeCount);
              this.softBitBuffer.readArray(consumeData);
            } 
            this.state = FramerState.SEARCHING_PREAMBLE; // Go back to searching preamble
            return decodedFrames;
          }
          break;
        }

        case FramerState.READING_HEADER: {
          if (this.softBitBuffer.length < 8) { // Need 8 bits for header
            return decodedFrames;
          }
          const headerSoftBits = new Int8Array(8);
          for (let i = 0; i < 8 && i < this.softBitBuffer.length; i++) {
            headerSoftBits[i] = this.softBitBuffer.get(i);
          }
          const decodedHeader = this._decodeHeader(headerSoftBits);
          if (decodedHeader) {
            const consumeData = new Int8Array(8);
            this.softBitBuffer.readArray(consumeData); // Consume header bits
            this.currentHeader = decodedHeader; // Store for payload processing
            this.state = FramerState.READING_PAYLOAD;
          } else {
            this.errorCount++; // エラーカウント増加
            const consumeData = new Int8Array(1);
            this.softBitBuffer.readArray(consumeData); // Consume 1 bit and try again (sliding window)
            this.state = FramerState.SEARCHING_PREAMBLE; // Go back to searching preamble
          }
          break;
        }

        case FramerState.READING_PAYLOAD: {
          // Check if we have enough bits for the full payload
          if (!this.currentHeader) {
            this.state = FramerState.SEARCHING_PREAMBLE;
            return decodedFrames;
          }

          const fecParams = FEC_PARAMS[this.currentHeader.ldpcNType as keyof typeof FEC_PARAMS];
          if (!fecParams) {
            this.state = FramerState.SEARCHING_PREAMBLE;
            return decodedFrames;
          }

          const payloadBitLength = fecParams.ldpcN;
          if (this.softBitBuffer.length < payloadBitLength) {
            return decodedFrames; // Not enough data for full payload
          }

          const payloadSoftBits = new Int8Array(payloadBitLength);
          for (let i = 0; i < payloadBitLength && i < this.softBitBuffer.length; i++) {
            payloadSoftBits[i] = this.softBitBuffer.get(i);
          }
          const decodedPayload = this._decodePayload(payloadSoftBits, this.currentHeader.ldpcNType);

          if (decodedPayload) {
            decodedFrames.push({ header: this.currentHeader, userData: decodedPayload.userData, status: decodedPayload.status });
            const consumeData = new Int8Array(payloadBitLength);
            this.softBitBuffer.readArray(consumeData); // Consume payload bits
          } else {
            this.errorCount++; // エラーカウント増加
            const consumeData = new Int8Array(1);
            this.softBitBuffer.readArray(consumeData); // Consume 1 bit and try again (sliding window)
          }
          // After processing payload (success or failure), go back to searching for the next frame
          this.state = FramerState.SEARCHING_PREAMBLE;
          this.currentHeader = null; // Clear current header
          break;
        }
      }

      // If we processed a frame or changed state, and there's still data, continue loop
      // Otherwise, break to wait for more data
      if (this.state === FramerState.SEARCHING_PREAMBLE && this.softBitBuffer.length < (PREAMBLE.length + SYNC_WORD.length + 8)) {
        break; // Not enough data to start new search cycle
      }
    }
    return decodedFrames;
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
      isHealthy: this.errorCount < 10 // 10回未満のエラーなら健全
    };
  }

  private _buildHeaderByte(options: FrameOptions): number {
    let header = 0;
    header |= (options.sequenceNumber & 0x7) << 5; // S (bit 7-5)
    header |= (options.frameType & 0x3) << 3;    // T (bit 4-3)
    header |= (options.ldpcNType & 0x3) << 1;    // N (bit 2-1)

    // Calculate parity for bit 7-1
    let parity = 0;
    for (let i = 1; i < 8; i++) {
      if ((header >> i) & 1) {
        parity++;
      }
    }
    // 偶数パリティにする
    if (parity % 2 !== 0) {
      header |= 1; // P (bit 0)
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
    const ldpcBits = new Uint8Array(ldpcEncoded.length * 8);
    for (let i = 0; i < ldpcEncoded.length; i++) {
      for (let j = 0; j < 8; j++) {
        ldpcBits[i * 8 + j] = (ldpcEncoded[i] >> (7 - j)) & 1;
      }
    }

    return ldpcBits; // フレーム構成用にビット配列を返す
  }

  private _correlate(softBits: Int8Array, pattern: number[]): number {
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

  private _findPreamble(): number {
    if (this.softBitBuffer.length < PREAMBLE.length) {
      return -1;
    }
    // Search for preamble using sliding window correlation
    for (let i = 0; i <= this.softBitBuffer.length - PREAMBLE.length; i++) {
      const window = new Int8Array(PREAMBLE.length);
      for (let j = 0; j < PREAMBLE.length; j++) {
        window[j] = this.softBitBuffer.get(i + j);
      }
      const correlation = this._correlate(window, PREAMBLE);
      if (correlation > this.preambleCorrelationThreshold) {
        return i; // Preamble found
      }
    }
    return -1; // Not found
  }

  private _findSyncWord(): number {
    if (this.softBitBuffer.length < SYNC_WORD.length) {
      return -1;
    }
    // Search for sync word using sliding window correlation
    for (let i = 0; i <= this.softBitBuffer.length - SYNC_WORD.length; i++) {
      const window = new Int8Array(SYNC_WORD.length);
      for (let j = 0; j < SYNC_WORD.length; j++) {
        window[j] = this.softBitBuffer.get(i + j);
      }
      const correlation = this._correlate(window, SYNC_WORD);
      if (correlation > this.syncWordCorrelationThreshold) {
        return i; // Sync word found
      }
    }
    return -1; // Not found
  }

  private _decodeHeader(headerSoftBits: Int8Array): FrameOptions | null {
    if (headerSoftBits.length < 8) {
      return null;
    }

    let headerByte = 0;
    let receivedParity = 0;
    let calculatedParity = 0;

    // Convert soft bits to hard bits and reconstruct header byte
    for (let i = 0; i < 8; i++) {
      // LLR >= 0 means 0, LLR < 0 means 1 (DSSS despread convention)
      // This is based on the assumption that 0 is represented by positive LLR and 1 by negative LLR.
      // If the convention is reversed, this logic needs to be flipped.
      const bit = headerSoftBits[i] >= 0 ? 0 : 1; 
      if (bit === 1) {
        headerByte |= (1 << (7 - i));
      }
    }

    // Extract received parity bit (bit 0)
    receivedParity = (headerByte & 0x01);

    // Calculate parity for bit 7-1
    for (let i = 1; i < 8; i++) { // bit 7 から bit 1 までをチェック
      if ((headerByte >> i) & 1) {
        calculatedParity++;
      }
    }

    // Check parity (even parity)
    // If calculated parity (sum of 1s in bits 7-1) is odd, receivedParity should be 1.
    // If calculated parity is even, receivedParity should be 0.
    if ((calculatedParity % 2) !== receivedParity) { 
      return null; // Parity check failed
    }

    // Decode FrameOptions
    const sequenceNumber = (headerByte >> 5) & 0x7;
    const frameType = (headerByte >> 3) & 0x3;
    const ldpcNType = (headerByte >> 1) & 0x3;

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
    const ldpcDecodeResult = ldpc.decode(payloadSoftBits, 10); // Max 10 iterations

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
      const bits = new Uint8Array(8);
      for (let i = 0; i < 8; i++) {
          bits[i] = (byte >> (7 - i)) & 1;
      }
      return bits;
  }

}