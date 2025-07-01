/**
 * H行列の非ゼロ要素（1が立つ位置）を表すインターフェース
 */
export interface HMatrixConnection {
    check: number; // チェックノードのインデックス (行番号)
    bit: number;   // ビットノードのインデックス (列番号)
}

/**
 * H行列の全体構造を表すインターフェース
 */
export interface HMatrixData {
    height: number;      // H行列の行数 (チェックノードの数)
    width: number;       // H行列の列数 (ビットノードの数、符号長 n)
    connections: HMatrixConnection[]; // 非ゼロ要素のリスト
}

/**
 * Systematic形式に変換されたH行列の情報
 */
interface SystematicHMatrix {
    systematicH: Uint8Array[];      // [I | P] 形式のH行列 (密行列)
    columnPermutation: number[];    // 元の列インデックスへの逆置換
    rank: number;                   // H行列のランク
    isFullRank: boolean;           // フルランクかどうか
}

/**
 * H行列をSystematic形式 [I | P] に変換する (正しいGaussian Elimination)
 * @param hMatrixData 元のH行列データ
 * @returns 変換されたSystematic H行列の情報
 */
function convertToSystematicForm(hMatrixData: HMatrixData): SystematicHMatrix {
    const m = hMatrixData.height;  // パリティビット数
    const n = hMatrixData.width;   // 符号長
    
    // 1. 疎行列から密行列に変換
    const H: Uint8Array[] = Array(m).fill(0).map(() => new Uint8Array(n));
    for (const conn of hMatrixData.connections) {
        H[conn.check][conn.bit] = 1;
    }
    
    // 2. 列置換を記録 (systematic形式の位置 i → 元の列番号)
    const columnPermutation: number[] = Array(n).fill(0).map((_, i) => i);
    
    // 3. Gaussian Elimination with column pivoting
    let rank = 0;
    const pivotCols: number[] = [];
    
    for (let targetRow = 0; targetRow < m; targetRow++) {
        // 現在の行でピボットを探す（まだ使われていない列から）
        let pivotCol = -1;
        for (let col = rank; col < n; col++) {
            if (H[targetRow][col] === 1) {
                pivotCol = col;
                break;
            }
        }
        
        // ピボットが見つからない場合、下の行から探す
        if (pivotCol === -1) {
            for (let col = rank; col < n; col++) {
                for (let row = targetRow + 1; row < m; row++) {
                    if (H[row][col] === 1) {
                        // 行を交換
                        [H[targetRow], H[row]] = [H[row], H[targetRow]];
                        pivotCol = col;
                        break;
                    }
                }
                if (pivotCol !== -1) break;
            }
        }
        
        // ピボットが見つからない場合、この行はスキップ
        if (pivotCol === -1) {
            continue;
        }
        
        // 列を先頭に移動（rank番目の位置に）
        if (pivotCol !== rank) {
            // 列を交換
            for (let row = 0; row < m; row++) {
                [H[row][rank], H[row][pivotCol]] = [H[row][pivotCol], H[row][rank]];
            }
            // 置換も更新
            [columnPermutation[rank], columnPermutation[pivotCol]] = [columnPermutation[pivotCol], columnPermutation[rank]];
        }
        
        pivotCols.push(rank);
        
        // この列の他の行の1を消去
        for (let row = 0; row < m; row++) {
            if (row !== targetRow && H[row][rank] === 1) {
                // H[row] = H[row] XOR H[targetRow] (GF(2))
                for (let col = 0; col < n; col++) {
                    H[row][col] ^= H[targetRow][col];
                }
            }
        }
        
        rank++;
    }
    
    // 4. 行を並び替えて単位行列を作成
    const finalH: Uint8Array[] = Array(m).fill(0).map(() => new Uint8Array(n));
    let filledRows = 0;
    
    // rank個のピボット行を先頭に配置
    for (let i = 0; i < rank; i++) {
        // i番目の列にピボットを持つ行を探す
        for (let row = 0; row < m; row++) {
            if (H[row][i] === 1) {
                finalH[filledRows] = new Uint8Array(H[row]);
                filledRows++;
                // この行を無効化（重複を避ける）
                H[row].fill(0);
                break;
            }
        }
    }
    
    // 残りのゼロ行を追加
    for (let row = 0; row < m; row++) {
        if (filledRows >= m) break;
        let isZeroRow = true;
        for (let col = 0; col < n; col++) {
            if (H[row][col] === 1) {
                isZeroRow = false;
                break;
            }
        }
        if (isZeroRow) {
            finalH[filledRows] = new Uint8Array(n);
            filledRows++;
        }
    }
    
    return {
        systematicH: finalH,
        columnPermutation,
        rank,
        isFullRank: rank === m
    };
}

/**
 * LDPC (Low-Density Parity-Check) 符号のエンコーダおよびデコーダ
 */
export class LDPC {
    private readonly H_height: number; // H行列の高さ (m, パリティビット数)
    private readonly H_width: number;  // H行列の幅 (n, 符号長)
    private readonly K_message_length: number; // 情報ビット長 (k = n - m)

    // H行列の内部表現 (例: 隣接リスト、疎行列など)
    // sum-productアルゴリズムの実装に適した形式を選択
    private readonly checkNodeConnections: number[][]; // checkNodeConnections[i] は i番目のチェックノードに接続するビットノードのリスト
    private readonly bitNodeConnections: number[][];   // bitNodeConnections[j] は j番目のビットノードに接続するチェックノードのリスト

    // Systematic エンコーディング用の内部データ
    private readonly systematicMatrix: SystematicHMatrix; // 変換されたSystematic形式のH行列

    private readonly defaultMaxIterations: number; // デコードのデフォルト最大反復回数

    /**
     * LDPCクラスのコンストラクタ
     * @param hMatrixData H行列のデータ (JSONファイルから読み込んだもの)
     * @param defaultMaxIterations デコードのデフォルト最大反復回数 (aec-plan.md に基づき10を推奨)
     */
    constructor(hMatrixData: HMatrixData, defaultMaxIterations: number = 10) {
        this.H_height = hMatrixData.height;
        this.H_width = hMatrixData.width;
        this.defaultMaxIterations = defaultMaxIterations;

        // Systematic形式への変換
        this.systematicMatrix = convertToSystematicForm(hMatrixData);
        
        // フルランクチェック（一時的に警告のみ）
        if (!this.systematicMatrix.isFullRank) {
            console.warn(`Warning: H matrix is not full rank (rank=${this.systematicMatrix.rank}, expected=${this.H_height}). Attempting encoding with reduced rank.`);
        }
        
        // 情報ビット長の計算（正確には k = n - rank）
        this.K_message_length = this.H_width - this.systematicMatrix.rank;

        // H行列の接続情報を内部表現に変換（復号に使用）
        // sum-productアルゴリズムでは、チェックノードとビットノードの両方からの接続情報が必要
        this.checkNodeConnections = Array(this.H_height).fill(0).map(() => []);
        this.bitNodeConnections = Array(this.H_width).fill(0).map(() => []);

        for (const conn of hMatrixData.connections) {
            this.checkNodeConnections[conn.check].push(conn.bit);
            this.bitNodeConnections[conn.bit].push(conn.check);
        }
    }

    /**
     * packed bit形式のバイト配列から指定ビット位置の値を取得
     * @param bytes バイト配列
     * @param bitIndex ビット位置 (0から開始)
     * @returns ビット値 (0 または 1)
     */
    private getBit(bytes: Uint8Array, bitIndex: number): number {
        const byteIndex = Math.floor(bitIndex / 8);
        if (byteIndex >= bytes.length) {
            return 0; // 範囲外は0として扱う
        }
        const bitOffset = bitIndex % 8;
        return (bytes[byteIndex] >> (7 - bitOffset)) & 1;
    }

    /**
     * packed bit形式のバイト配列の指定ビット位置に値を設定
     * @param bytes バイト配列
     * @param bitIndex ビット位置 (0から開始)
     * @param value ビット値 (0 または 1)
     */
    private setBit(bytes: Uint8Array, bitIndex: number, value: number): void {
        const byteIndex = Math.floor(bitIndex / 8);
        if (byteIndex >= bytes.length) {
            return; // 範囲外は無視
        }
        const bitOffset = bitIndex % 8;
        if (value) {
            bytes[byteIndex] |= (1 << (7 - bitOffset));
        } else {
            bytes[byteIndex] &= ~(1 << (7 - bitOffset));
        }
    }

    /**
     * メッセージビットをLDPC符号化する (Systematic Encoding - Packed Bit形式)
     * @param messageBytes packed bit形式の情報ビット (K_message_lengthビットを含むバイト配列)
     * @returns packed bit形式の符号化されたワード (符号長ビットを含むバイト配列)
     */
    public encode(messageBytes: Uint8Array): Uint8Array {
        const n = this.H_width;   // 符号長
        const k = this.K_message_length; // 情報ビット長
        const rank = this.systematicMatrix.rank;

        // 出力用packed bit配列を確保 (符号長分のバイト数)
        const outputByteLength = Math.ceil(n / 8);
        const systematicCodewordBytes = new Uint8Array(outputByteLength);

        // 1. Systematic形式でエンコード [I | P] c = [p | m]
        // メッセージビット部分を配置（systematic形式の右側、rank位置以降）
        for (let i = 0; i < k; i++) {
            const msgBit = this.getBit(messageBytes, i);
            this.setBit(systematicCodewordBytes, rank + i, msgBit);
        }

        // 2. パリティビット計算 p^T = P * m^T (mod 2)
        // P行列は systematic H行列の[rank:rank+k]列部分
        for (let row = 0; row < rank; row++) {
            let paritySum = 0;
            for (let col = 0; col < k; col++) {
                if (rank + col < n) {
                    const pElement = this.systematicMatrix.systematicH[row][rank + col];
                    const msgBit = this.getBit(messageBytes, col);
                    paritySum ^= (pElement & msgBit);
                }
            }
            this.setBit(systematicCodewordBytes, row, paritySum);
        }

        // 3. 元の列順序に戻す（逆置換）
        const originalCodewordBytes = new Uint8Array(outputByteLength);
        
        // systematic形式から元の形式に戻す (packed bit直接処理)
        for (let systematicPos = 0; systematicPos < n; systematicPos++) {
            const originalCol = this.systematicMatrix.columnPermutation[systematicPos];
            const bit = this.getBit(systematicCodewordBytes, systematicPos);
            this.setBit(originalCodewordBytes, originalCol, bit);
        }

        return originalCodewordBytes;
    }

    /**
     * 受信したソフト値 (LLR) をLDPC復号する (Sum-Productアルゴリズム)
     * @param receivedLlr 受信したLLR値 (nビット長, int8_t [-128, +127] スケール)
     * @param maxIterations 最大反復回数 (省略された場合はコンストラクタで指定されたデフォルト値を使用)
     * @returns 復号結果オブジェクト
     *          - decodedCodeword: 復号された符号語 (packed bit形式のバイト配列)
     *          - iterations: 実際に実行された反復回数
     *          - converged: 収束したかどうか (H * decodedCodeword^T = 0 が満たされたか)
     */
    public decode(receivedLlr: Int8Array, maxIterations?: number): { decodedCodeword: Uint8Array, iterations: number, converged: boolean } {
        if (receivedLlr.length !== this.H_width) {
            throw new Error(`Received LLR length must be ${this.H_width}, but got ${receivedLlr.length}`);
        }

        const currentMaxIterations = maxIterations ?? this.defaultMaxIterations;

        // 1. LLRの初期化
        // L_c: 受信LLR (floatに変換)
        const L_c: Float32Array = new Float32Array(this.H_width);
        for (let i = 0; i < this.H_width; i++) {
            L_c[i] = receivedLlr[i]; // int8_t を float に変換
        }

        // L_q: ビットノードからチェックノードへのメッセージ (LLR)
        // L_q[bit_idx][check_idx] の形式でアクセスできるようにする
        // 各ビットノードに接続するチェックノードの数に応じて初期化
        const L_q: Float32Array[] = Array(this.H_width).fill(0).map((_, bitIdx) => {
            const connectedChecks = this.bitNodeConnections[bitIdx];
            return new Float32Array(connectedChecks.length);
        });

        // L_r: チェックノードからビットノードへのメッセージ (LLR)
        // L_r[check_idx][bit_idx] の形式でアクセスできるようにする
        // 各チェックノードに接続するビットノードの数に応じて初期化
        const L_r: Float32Array[] = Array(this.H_height).fill(0).map((_, checkIdx) => {
            const connectedBits = this.checkNodeConnections[checkIdx];
            return new Float32Array(connectedBits.length);
        });

        // L_Q: 各ビットの事後LLR
        const L_Q: Float32Array = new Float32Array(this.H_width);

        let iterations = 0;
        let converged = false;
        const decodedCodeword = new Uint8Array(Math.ceil(this.H_width / 8));

        // Min-Sumアルゴリズムの初期化
        // 各ビットノードから接続するチェックノードへの初期メッセージは、受信LLR L_c(n)
        for (let n = 0; n < this.H_width; n++) { // 各ビットノード n
            const connectedChecks = this.bitNodeConnections[n];
            for (let i = 0; i < connectedChecks.length; i++) {
                L_q[n][i] = L_c[n];
            }
        }

        // 2. 反復ループ
        for (iterations = 0; iterations < currentMaxIterations; iterations++) {
            // a. チェックノード更新 (Min-Sum)
            for (let m = 0; m < this.H_height; m++) { // 各チェックノード m
                const connectedBits = this.checkNodeConnections[m];
                // このチェックノードに接続するすべてのビットノードからのメッセージの積と最小値を計算
                const signs: number[] = [];
                const absValues: number[] = [];
                for (let i = 0; i < connectedBits.length; i++) {
                    const n = connectedBits[i];
                    // L_q[n][idx_in_bitNodeConnections_for_m] を取得する必要がある
                    // bitNodeConnections[n] の中で m が何番目にあるかを探す
                    const idxInBitNodeConnectionsForM = this.bitNodeConnections[n].indexOf(m);
                    const message_L_q_nm = L_q[n][idxInBitNodeConnectionsForM];

                    signs.push(Math.sign(message_L_q_nm));
                    absValues.push(Math.abs(message_L_q_nm));
                }

                for (let i = 0; i < connectedBits.length; i++) {
                    const n = connectedBits[i];
                    // L_r(m,n) を計算
                    let productOfSigns = 1;
                    let minAbsValue = Infinity;

                    for (let j = 0; j < connectedBits.length; j++) {
                        if (i === j) continue; // 自分自身を除く

                        productOfSigns *= signs[j];
                        minAbsValue = Math.min(minAbsValue, absValues[j]);
                    }
                    // L_r[m][idx_in_checkNodeConnections_for_n] を設定
                    // checkNodeConnections[m] の中で n が何番目にあるかを探す
                    const idxInCheckNodeConnectionsForN = this.checkNodeConnections[m].indexOf(n);
                    L_r[m][idxInCheckNodeConnectionsForN] = productOfSigns * minAbsValue;
                }
            }

            // b. ビットノード更新
            for (let n = 0; n < this.H_width; n++) { // 各ビットノード n
                const connectedChecks = this.bitNodeConnections[n];
                for (let i = 0; i < connectedChecks.length; i++) {
                    const m = connectedChecks[i];
                    // L_q(n,m) を計算
                    let sumOfL_r_messages = 0;
                    for (let j = 0; j < connectedChecks.length; j++) {
                        if (i === j) continue; // 自分自身を除く

                        const m_prime = connectedChecks[j];
                        // L_r[m_prime][idx_in_checkNodeConnections_for_n] を取得
                        const idxInCheckNodeConnectionsForN = this.checkNodeConnections[m_prime].indexOf(n);
                        sumOfL_r_messages += L_r[m_prime][idxInCheckNodeConnectionsForN];
                    }
                    // L_q[n][idx_in_bitNodeConnections_for_m] を設定
                    const idxInBitNodeConnectionsForM = this.bitNodeConnections[n].indexOf(m);
                    L_q[n][idxInBitNodeConnectionsForM] = L_c[n] + sumOfL_r_messages;
                }
            }

            // c. 暫定的な復号結果の計算
            for (let n = 0; n < this.H_width; n++) { // 各ビットノード n
                let sumOfL_r_messages = 0;
                const connectedChecks = this.bitNodeConnections[n];
                for (let i = 0; i < connectedChecks.length; i++) {
                    const m = connectedChecks[i];
                    // L_r[m][idx_in_checkNodeConnections_for_n] を取得
                    const idxInCheckNodeConnectionsForN = this.checkNodeConnections[m].indexOf(n);
                    sumOfL_r_messages += L_r[m][idxInCheckNodeConnectionsForN];
                }
                L_Q[n] = L_c[n] + sumOfL_r_messages;

                const bitValue = L_Q[n] < 0 ? 1 : 0; // LLR < 0 なら 1, LLR >= 0 なら 0
                this.setBit(decodedCodeword, n, bitValue);
            }

            // d. パリティチェック (H * x_hat^T = 0) - packed bit形式
            let allChecksPass = true;
            for (let m = 0; m < this.H_height; m++) { // 各チェックノード m
                let sum = 0;
                const connectedBits = this.checkNodeConnections[m];
                for (const n of connectedBits) {
                    sum += this.getBit(decodedCodeword, n);
                }
                if (sum % 2 !== 0) { // パリティチェック失敗
                    allChecksPass = false;
                    break;
                }
            }

            // e. 収束判定
            if (allChecksPass) {
                converged = true;
                break; // 収束したのでループを抜ける
            }
        }

        return {
            decodedCodeword: decodedCodeword,
            iterations: iterations + 1, // 0から始まるので+1
            converged: converged
        };
    }

    /**
     * 符号長 n を取得する
     */
    public getCodewordLength(): number {
        return this.H_width;
    }

    /**
     * 情報ビット長 k を取得する
     */
    public getMessageLength(): number {
        return this.K_message_length;
    }

    /**
     * 符号化率 (k/n) を取得する
     */
    public getCodeRate(): number {
        return this.K_message_length / this.H_width;
    }
}
