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
export function convertToSystematicForm(hMatrixData: HMatrixData): SystematicHMatrix {
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

    private readonly puncturedBitIndices: Set<number>; // パンクチャされたビットのインデックスのセット
    private readonly H_punctured_width: number; // パンクチャ後の符号長

    private readonly checkNodeConnections: number[][];
    private readonly bitNodeConnections: number[][];
    private readonly systematicMatrix: SystematicHMatrix;
    private readonly defaultMaxIterations: number;

    constructor(hMatrixData: HMatrixData, defaultMaxIterations: number = 10, puncturedBitIndices?: Set<number>) {
        this.H_height = hMatrixData.height;
        this.H_width = hMatrixData.width;
        this.defaultMaxIterations = defaultMaxIterations;

        this.puncturedBitIndices = new Set(puncturedBitIndices || []);
        this.H_punctured_width = this.H_width - this.puncturedBitIndices.size;

        this.systematicMatrix = convertToSystematicForm(hMatrixData);

        if (!this.systematicMatrix.isFullRank) {
            console.warn(`Warning: H matrix is not full rank (rank=${this.systematicMatrix.rank}, expected=${this.H_height}). Attempting encoding with reduced rank.`);
        }

        this.K_message_length = this.H_width - this.systematicMatrix.rank;

        this.checkNodeConnections = Array(this.H_height).fill(0).map(() => []);
        this.bitNodeConnections = Array(this.H_width).fill(0).map(() => []);

        for (const conn of hMatrixData.connections) {
            this.checkNodeConnections[conn.check].push(conn.bit);
            this.bitNodeConnections[conn.bit].push(conn.check);
        }
    }

    private getBit(bytes: Uint8Array, bitIndex: number): number {
        const byteIndex = Math.floor(bitIndex / 8);
        if (byteIndex >= bytes.length) {
            return 0;
        }
        const bitOffset = bitIndex % 8;
        return (bytes[byteIndex] >> (7 - bitOffset)) & 1;
    }

    private setBit(bytes: Uint8Array, bitIndex: number, value: number): void {
        const byteIndex = Math.floor(bitIndex / 8);
        if (byteIndex >= bytes.length) {
            return;
        }
        const bitOffset = bitIndex % 8;
        if (value) {
            bytes[byteIndex] |= (1 << (7 - bitOffset));
        } else {
            bytes[byteIndex] &= ~(1 << (7 - bitOffset));
        }
    }

    public encode(messageBytes: Uint8Array): Uint8Array {
        const n_unpunctured = this.H_width;
        const k = this.K_message_length;
        const rank = this.systematicMatrix.rank;

        const unpuncturedCodewordBytes = new Uint8Array(Math.ceil(n_unpunctured / 8));

        for (let i = 0; i < k; i++) {
            const msgBit = this.getBit(messageBytes, i);
            this.setBit(unpuncturedCodewordBytes, rank + i, msgBit);
        }

        // パリティ計算最適化: 非ゼロ要素のみ処理 + バイト単位最適化
        for (let row = 0; row < rank; row++) {
            let paritySum = 0;
            
            // 最適化1: 非ゼロ要素のみ処理（疎行列特性活用）
            const systematicRow = this.systematicMatrix.systematicH[row];
            
            // 最適化2: バイト単位処理でgetBit呼び出し削減
            for (let byteIdx = 0; byteIdx < messageBytes.length; byteIdx++) {
                const msgByte = messageBytes[byteIdx];
                if (msgByte === 0) continue; // ゼロバイトスキップ
                
                for (let bitOffset = 0; bitOffset < 8; bitOffset++) {
                    const col = byteIdx * 8 + bitOffset;
                    if (col >= k) break; // メッセージ長超過チェック
                    
                    const matrixCol = rank + col;
                    if (matrixCol < n_unpunctured && systematicRow[matrixCol] === 1) {
                        const msgBit = (msgByte >> (7 - bitOffset)) & 1;
                        paritySum ^= msgBit;
                    }
                }
            }
            this.setBit(unpuncturedCodewordBytes, row, paritySum);
        }

        const permutedCodewordBytes = new Uint8Array(Math.ceil(n_unpunctured / 8));
        for (let systematicPos = 0; systematicPos < n_unpunctured; systematicPos++) {
            const originalCol = this.systematicMatrix.columnPermutation[systematicPos];
            const bit = this.getBit(unpuncturedCodewordBytes, systematicPos);
            this.setBit(permutedCodewordBytes, originalCol, bit);
        }

        if (this.puncturedBitIndices.size > 0) {
            const puncturedCodewordBytes = new Uint8Array(Math.ceil(this.H_punctured_width / 8));
            let currentPuncturedBitIndex = 0;
            for (let i = 0; i < n_unpunctured; i++) {
                if (!this.puncturedBitIndices.has(i)) {
                    const bit = this.getBit(permutedCodewordBytes, i);
                    this.setBit(puncturedCodewordBytes, currentPuncturedBitIndex, bit);
                    currentPuncturedBitIndex++;
                }
            }
            return puncturedCodewordBytes;
        } else {
            return permutedCodewordBytes;
        }
    }

    public decodeCodeword(receivedLlr: Int8Array, maxIterations?: number): { decodedCodeword: Uint8Array, iterations: number, converged: boolean } {
        if (receivedLlr.length !== this.H_punctured_width) {
            throw new Error(`Received LLR length must be ${this.H_punctured_width}, but got ${receivedLlr.length}`);
        }

        const currentMaxIterations = maxIterations ?? this.defaultMaxIterations;

        const L_c: Float32Array = new Float32Array(this.H_width);
        let receivedLlrIndex = 0;
        for (let i = 0; i < this.H_width; i++) {
            if (this.puncturedBitIndices.has(i)) {
                L_c[i] = 0;
            } else {
                L_c[i] = receivedLlr[receivedLlrIndex];
                receivedLlrIndex++;
            }
        }

        const L_q: Float32Array[] = Array(this.H_width).fill(0).map((_, bitIdx) => {
            const connectedChecks = this.bitNodeConnections[bitIdx];
            return new Float32Array(connectedChecks.length);
        });

        const L_r: Float32Array[] = Array(this.H_height).fill(0).map((_, checkIdx) => {
            const connectedBits = this.checkNodeConnections[checkIdx];
            return new Float32Array(connectedBits.length);
        });

        const L_Q: Float32Array = new Float32Array(this.H_width);

        let iterations = 0;
        let converged = false;
        const decodedCodeword = new Uint8Array(Math.ceil(this.H_width / 8));

        for (let n = 0; n < this.H_width; n++) {
            const connectedChecks = this.bitNodeConnections[n];
            for (let i = 0; i < connectedChecks.length; i++) {
                L_q[n][i] = L_c[n];
            }
        }

        for (iterations = 0; iterations < currentMaxIterations; iterations++) {
            for (let m = 0; m < this.H_height; m++) {
                const connectedBits = this.checkNodeConnections[m];
                const signs: number[] = [];
                const absValues: number[] = [];
                for (let i = 0; i < connectedBits.length; i++) {
                    const n = connectedBits[i];
                    const idxInBitNodeConnectionsForM = this.bitNodeConnections[n].indexOf(m);
                    const message_L_q_nm = L_q[n][idxInBitNodeConnectionsForM];

                    signs.push(Math.sign(message_L_q_nm));
                    absValues.push(Math.abs(message_L_q_nm));
                }

                for (let i = 0; i < connectedBits.length; i++) {
                    const n = connectedBits[i];
                    let productOfSigns = 1;
                    let minAbsValue = Infinity;

                    for (let j = 0; j < connectedBits.length; j++) {
                        if (i === j) continue;

                        productOfSigns *= signs[j];
                        minAbsValue = Math.min(minAbsValue, absValues[j]);
                    }
                    const idxInCheckNodeConnectionsForN = this.checkNodeConnections[m].indexOf(n);
                    L_r[m][idxInCheckNodeConnectionsForN] = productOfSigns * minAbsValue;
                }
            }

            for (let n = 0; n < this.H_width; n++) {
                const connectedChecks = this.bitNodeConnections[n];
                for (let i = 0; i < connectedChecks.length; i++) {
                    const m = connectedChecks[i];
                    let sumOfL_r_messages = 0;
                    for (let j = 0; j < connectedChecks.length; j++) {
                        if (i === j) continue;

                        const m_prime = connectedChecks[j];
                        const idxInCheckNodeConnectionsForN = this.checkNodeConnections[m_prime].indexOf(n);
                        sumOfL_r_messages += L_r[m_prime][idxInCheckNodeConnectionsForN];
                    }
                    const idxInBitNodeConnectionsForM = this.bitNodeConnections[n].indexOf(m);
                    L_q[n][idxInBitNodeConnectionsForM] = L_c[n] + sumOfL_r_messages;
                }
            }

            for (let n = 0; n < this.H_width; n++) {
                let sumOfL_r_messages = 0;
                const connectedChecks = this.bitNodeConnections[n];
                for (let i = 0; i < connectedChecks.length; i++) {
                    const m = connectedChecks[i];
                    const idxInCheckNodeConnectionsForN = this.checkNodeConnections[m].indexOf(n);
                    sumOfL_r_messages += L_r[m][idxInCheckNodeConnectionsForN];
                }
                L_Q[n] = L_c[n] + sumOfL_r_messages;

                const bitValue = L_Q[n] < 0 ? 1 : 0;
                this.setBit(decodedCodeword, n, bitValue);
            }

            let allChecksPass = true;
            for (let m = 0; m < this.H_height; m++) {
                let sum = 0;
                const connectedBits = this.checkNodeConnections[m];
                for (const n of connectedBits) {
                    sum += this.getBit(decodedCodeword, n);
                }
                if (sum % 2 !== 0) {
                    allChecksPass = false;
                    break;
                }
            }

            if (allChecksPass) {
                converged = true;
                break;
            }
        }

        return {
            decodedCodeword: decodedCodeword,
            iterations: iterations + 1,
            converged: converged
        };
    }

    public decode(receivedLlr: Int8Array, maxIterations?: number): { decodedMessage: Uint8Array, iterations: number, converged: boolean } {
        const { decodedCodeword, iterations, converged } = this.decodeCodeword(receivedLlr, maxIterations);
        const decodedMessage = this._extractInformationBits(decodedCodeword);
        return { decodedMessage, iterations, converged };
    }

    public getCodewordLength(): number {
        return this.H_punctured_width;
    }

    public getMessageLength(): number {
        return this.K_message_length;
    }

    public _extractInformationBits(codewordBytes: Uint8Array): Uint8Array {
        const n_unpunctured = this.H_width;
        const k = this.K_message_length;

        // decodedCodeword (codewordBytes) は既に元の列順序になっている
        // これを systematic 形式に変換するために逆置換を適用する
        const systematicCodewordBytes = new Uint8Array(Math.ceil(n_unpunctured / 8));
        const inversePermutation: number[] = Array(n_unpunctured);
        for (let i = 0; i < n_unpunctured; i++) {
            inversePermutation[this.systematicMatrix.columnPermutation[i]] = i;
        }

        for (let i = 0; i < n_unpunctured; i++) {
            const bit = this.getBit(codewordBytes, i); // codewordBytes は元の列順序
            this.setBit(systematicCodewordBytes, inversePermutation[i], bit);
        }

        // 最初の k ビットが情報ビット
        const messageBytes = new Uint8Array(Math.ceil(k / 8));
        for (let i = 0; i < k; i++) {
            const bit = this.getBit(systematicCodewordBytes, this.systematicMatrix.rank + i);
            this.setBit(messageBytes, i, bit);
        }
        return messageBytes;
    }

    public getCodeRate(): number {
        return this.K_message_length / this.H_punctured_width;
    }
}
