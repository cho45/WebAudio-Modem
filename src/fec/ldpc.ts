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
 * 疎行列用のGaussian Eliminationを実行するクラス
 * メモリ効率を最大化して疎行列のまま処理
 */
class SparseGaussianEliminator {
    private readonly m: number;
    private readonly n: number;
    private readonly rows: Set<number>[];  // 各行の非ゼロ要素の列インデックス
    private readonly columnPermutation: number[];
    
    constructor(hMatrixData: HMatrixData) {
        this.m = hMatrixData.height;
        this.n = hMatrixData.width;
        this.columnPermutation = Array(this.n).fill(0).map((_, i) => i);
        
        // 疎行列をSetで表現（メモリ効率最大）
        this.rows = Array(this.m).fill(0).map(() => new Set<number>());
        for (const conn of hMatrixData.connections) {
            this.rows[conn.check].add(conn.bit);
        }
    }
    
    /**
     * 疎行列でのGaussian Eliminationを実行
     */
    public performGaussianElimination(): { rank: number, pivotColumns: number[] } {
        const pivotColumns: number[] = [];
        let rank = 0;
        
        for (let targetRow = 0; targetRow < this.m; targetRow++) {
            const pivotCol = this.findAndSwapPivot(targetRow, rank);
            if (pivotCol === -1) continue;
            
            this.swapColumns(pivotCol, rank);
            pivotColumns.push(rank);
            this.eliminateColumn(targetRow, rank);
            rank++;
        }
        
        return { rank, pivotColumns };
    }
    
    /**
     * ピボットを検索し、必要に応じて行を交換
     */
    private findAndSwapPivot(targetRow: number, rank: number): number {
        // 現在の行からピボットを探す
        for (let col = rank; col < this.n; col++) {
            if (this.rows[targetRow].has(col)) {
                return col;
            }
        }
        
        // 下の行からピボットを探し、行を交換
        for (let col = rank; col < this.n; col++) {
            for (let row = targetRow + 1; row < this.m; row++) {
                if (this.rows[row].has(col)) {
                    [this.rows[targetRow], this.rows[row]] = [this.rows[row], this.rows[targetRow]];
                    return col;
                }
            }
        }
        
        return -1; // ピボットが見つからない
    }
    
    /**
     * 列を交換
     */
    private swapColumns(col1: number, col2: number): void {
        if (col1 === col2) return;
        
        // すべての行で列を交換
        for (const row of this.rows) {
            const hasCol1 = row.has(col1);
            const hasCol2 = row.has(col2);
            
            if (hasCol1 && !hasCol2) {
                row.delete(col1);
                row.add(col2);
            } else if (!hasCol1 && hasCol2) {
                row.delete(col2);
                row.add(col1);
            }
        }
        
        // 置換情報を更新
        [this.columnPermutation[col1], this.columnPermutation[col2]] = 
            [this.columnPermutation[col2], this.columnPermutation[col1]];
    }
    
    /**
     * 指定列での消去操作
     */
    private eliminateColumn(pivotRow: number, col: number): void {
        const pivotRowSet = this.rows[pivotRow];
        
        for (let row = 0; row < this.m; row++) {
            if (row !== pivotRow && this.rows[row].has(col)) {
                // 行のXOR操作：対称差分で実現
                this.xorRows(this.rows[row], pivotRowSet);
            }
        }
    }
    
    /**
     * 2つのSetの対称差分 (XOR)
     */
    private xorRows(targetRow: Set<number>, pivotRow: Set<number>): void {
        for (const col of pivotRow) {
            if (targetRow.has(col)) {
                targetRow.delete(col);
            } else {
                targetRow.add(col);
            }
        }
    }
    
    /**
     * 結果を密行列形式に変換（最終結果のみ）
     */
    public buildSystematicMatrix(rank: number): Uint8Array[] {
        const systematicH: Uint8Array[] = Array(this.m).fill(0).map(() => new Uint8Array(this.n));
        
        // rank行を先頭に配置
        let filledRows = 0;
        for (let i = 0; i < rank; i++) {
            for (let row = 0; row < this.m; row++) {
                if (this.rows[row].has(i)) {
                    for (const col of this.rows[row]) {
                        systematicH[filledRows][col] = 1;
                    }
                    this.rows[row].clear(); // 重複防止
                    filledRows++;
                    break;
                }
            }
        }
        
        return systematicH;
    }
    
    public getColumnPermutation(): number[] {
        return this.columnPermutation;
    }
}

/**
 * H行列をSystematic形式 [I | P] に変換する (高効率疎行列処理)
 * @param hMatrixData 元のH行列データ
 * @returns 変換されたSystematic H行列の情報
 */
export function convertToSystematicForm(hMatrixData: HMatrixData): SystematicHMatrix {
    const eliminator = new SparseGaussianEliminator(hMatrixData);
    const { rank } = eliminator.performGaussianElimination();
    const systematicH = eliminator.buildSystematicMatrix(rank);
    const columnPermutation = eliminator.getColumnPermutation();
    
    return {
        systematicH,
        columnPermutation,
        rank,
        isFullRank: rank === hMatrixData.height
    };
}

/**
 * Sum-Product Algorithm用のデコーディング状態
 */
interface DecodingState {
    channelLLR: Float32Array;           // L_c: チャネルLLR
    bitToCheckMessages: Float32Array[]; // L_q: Variable-to-Check メッセージ
    checkToBitMessages: Float32Array[]; // L_r: Check-to-Variable メッセージ
    posteriorLLR: Float32Array;        // L_Q: 事後確率
    decodedCodeword: Uint8Array;
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
    
    // 高速インデックス検索用のマップ (O(1)検索)
    private readonly bitToCheckIndexMap: Map<number, Map<number, number>>;
    private readonly checkToBitIndexMap: Map<number, Map<number, number>>;

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
        
        // 高速インデックス検索用マップを初期化
        this.bitToCheckIndexMap = new Map();
        this.checkToBitIndexMap = new Map();

        // 接続情報を構築
        for (const conn of hMatrixData.connections) {
            this.checkNodeConnections[conn.check].push(conn.bit);
            this.bitNodeConnections[conn.bit].push(conn.check);
        }
        
        // O(1)インデックス検索マップを事前構築
        this.buildIndexMaps();
    }
    
    /**
     * 高速インデックス検索用マップを構築
     * indexOf()のO(n)検索をO(1)に最適化
     */
    private buildIndexMaps(): void {
        // bit → check のインデックスマップ
        for (let bit = 0; bit < this.H_width; bit++) {
            const checkMap = new Map<number, number>();
            for (let i = 0; i < this.bitNodeConnections[bit].length; i++) {
                const check = this.bitNodeConnections[bit][i];
                checkMap.set(check, i);
            }
            this.bitToCheckIndexMap.set(bit, checkMap);
        }
        
        // check → bit のインデックスマップ
        for (let check = 0; check < this.H_height; check++) {
            const bitMap = new Map<number, number>();
            for (let i = 0; i < this.checkNodeConnections[check].length; i++) {
                const bit = this.checkNodeConnections[check][i];
                bitMap.set(bit, i);
            }
            this.checkToBitIndexMap.set(check, bitMap);
        }
    }
    
    /**
     * O(1)インデックス検索: bitNodeConnections[bit] 内でのcheckのインデックス
     */
    private getBitToCheckIndex(bit: number, check: number): number {
        return this.bitToCheckIndexMap.get(bit)?.get(check) ?? -1;
    }
    
    /**
     * O(1)インデックス検索: checkNodeConnections[check] 内でのbitのインデックス
     */
    private getCheckToBitIndex(check: number, bit: number): number {
        return this.checkToBitIndexMap.get(check)?.get(bit) ?? -1;
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

        for (let row = 0; row < rank; row++) {
            let paritySum = 0;
            for (let col = 0; col < k; col++) {
                if (rank + col < n_unpunctured) {
                    const pElement = this.systematicMatrix.systematicH[row][rank + col];
                    const msgBit = this.getBit(messageBytes, col);
                    paritySum ^= (pElement & msgBit);
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

    /**
     * デコーディング状態を初期化
     */
    private initializeDecodingState(receivedLlr: Int8Array): DecodingState {
        // チャネルLLRを構築（パンクチャ処理を含む）
        const channelLLR = new Float32Array(this.H_width);
        let receivedLlrIndex = 0;
        for (let i = 0; i < this.H_width; i++) {
            if (this.puncturedBitIndices.has(i)) {
                channelLLR[i] = 0;
            } else {
                channelLLR[i] = receivedLlr[receivedLlrIndex];
                receivedLlrIndex++;
            }
        }
        
        // メッセージ配列を初期化
        const bitToCheckMessages: Float32Array[] = Array(this.H_width).fill(0).map((_, bitIdx) => {
            const connectedChecks = this.bitNodeConnections[bitIdx];
            const messages = new Float32Array(connectedChecks.length);
            // 初期メッセージをチャネルLLRに設定
            for (let i = 0; i < messages.length; i++) {
                messages[i] = channelLLR[bitIdx];
            }
            return messages;
        });
        
        const checkToBitMessages: Float32Array[] = Array(this.H_height).fill(0).map((_, checkIdx) => {
            const connectedBits = this.checkNodeConnections[checkIdx];
            return new Float32Array(connectedBits.length);
        });
        
        return {
            channelLLR,
            bitToCheckMessages,
            checkToBitMessages,
            posteriorLLR: new Float32Array(this.H_width),
            decodedCodeword: new Uint8Array(Math.ceil(this.H_width / 8))
        };
    }
    
    /**
     * Check-to-Bit メッセージ更新 (メモリ効率最適化版)
     * 一時配列を使わず直接計算でメモリとCPUキャッシュ効率を向上
     */
    private updateCheckToBitMessages(state: DecodingState): void {
        for (let checkIdx = 0; checkIdx < this.H_height; checkIdx++) {
            const connectedBits = this.checkNodeConnections[checkIdx];
            const numConnectedBits = connectedBits.length;
            
            if (numConnectedBits <= 1) continue; // 度数1以下はスキップ
            
            // 各ビットノードへのメッセージを直接計算
            for (let i = 0; i < numConnectedBits; i++) {
                const targetBitIdx = connectedBits[i];
                let productOfSigns = 1;
                let minAbsValue = Infinity;
                let secondMinAbsValue = Infinity;
                let minIndex = -1;
                
                // 他のすべてのビットノードからのメッセージを直接処理
                for (let j = 0; j < numConnectedBits; j++) {
                    if (i === j) continue;
                    
                    const bitIdx = connectedBits[j];
                    const messageIndex = this.getBitToCheckIndex(bitIdx, checkIdx);
                    const message = state.bitToCheckMessages[bitIdx][messageIndex];
                    
                    const absMessage = Math.abs(message);
                    productOfSigns *= Math.sign(message);
                    
                    // 最小値と第2最小値を効率的に追跡
                    if (absMessage < minAbsValue) {
                        secondMinAbsValue = minAbsValue;
                        minAbsValue = absMessage;
                        minIndex = j;
                    } else if (absMessage < secondMinAbsValue) {
                        secondMinAbsValue = absMessage;
                    }
                }
                
                const messageIndex = this.getCheckToBitIndex(checkIdx, targetBitIdx);
                state.checkToBitMessages[checkIdx][messageIndex] = productOfSigns * minAbsValue;
            }
        }
    }
    
    /**
     * Bit-to-Check メッセージ更新 (Sum-Product Algorithm の第2ステップ)
     * 各ビットノードから接続されたチェックノードへのメッセージを計算
     */
    private updateBitToCheckMessages(state: DecodingState): void {
        for (let bitIdx = 0; bitIdx < this.H_width; bitIdx++) {
            const connectedChecks = this.bitNodeConnections[bitIdx];
            
            for (let i = 0; i < connectedChecks.length; i++) {
                const checkIdx = connectedChecks[i];
                let sumOfCheckMessages = 0;
                
                // 他のすべてのチェックノードからのメッセージを組み合わせ
                for (let j = 0; j < connectedChecks.length; j++) {
                    if (i === j) continue;
                    
                    const otherCheckIdx = connectedChecks[j];
                    const messageIndex = this.getCheckToBitIndex(otherCheckIdx, bitIdx);
                    sumOfCheckMessages += state.checkToBitMessages[otherCheckIdx][messageIndex];
                }
                
                const messageIndex = this.getBitToCheckIndex(bitIdx, checkIdx);
                state.bitToCheckMessages[bitIdx][messageIndex] = state.channelLLR[bitIdx] + sumOfCheckMessages;
            }
        }
    }
    
    /**
     * 事後確率計算とハード決定 (Sum-Product Algorithm の第3ステップ)
     * 最終的なビット判定を実行
     */
    private computePosteriorAndHardDecision(state: DecodingState): void {
        for (let bitIdx = 0; bitIdx < this.H_width; bitIdx++) {
            let sumOfCheckMessages = 0;
            const connectedChecks = this.bitNodeConnections[bitIdx];
            
            // すべてのチェックノードからのメッセージを組み合わせ
            for (let i = 0; i < connectedChecks.length; i++) {
                const checkIdx = connectedChecks[i];
                const messageIndex = this.getCheckToBitIndex(checkIdx, bitIdx);
                sumOfCheckMessages += state.checkToBitMessages[checkIdx][messageIndex];
            }
            
            // 事後確率とハード決定
            state.posteriorLLR[bitIdx] = state.channelLLR[bitIdx] + sumOfCheckMessages;
            const bitValue = state.posteriorLLR[bitIdx] < 0 ? 1 : 0;
            this.setBit(state.decodedCodeword, bitIdx, bitValue);
        }
    }
    
    /**
     * パリティ制約のチェック (収束判定)
     * すべてのパリティ制約が満たされた場合にtrueを返す
     */
    private checkParityConstraints(decodedCodeword: Uint8Array): boolean {
        for (let checkIdx = 0; checkIdx < this.H_height; checkIdx++) {
            let paritySum = 0;
            const connectedBits = this.checkNodeConnections[checkIdx];
            
            for (const bitIdx of connectedBits) {
                paritySum += this.getBit(decodedCodeword, bitIdx);
            }
            
            if (paritySum % 2 !== 0) {
                return false; // パリティ制約違反
            }
        }
        
        return true; // すべてのパリティ制約が満たされた
    }
    
    public decodeCodeword(receivedLlr: Int8Array, maxIterations?: number): { decodedCodeword: Uint8Array, iterations: number, converged: boolean } {
        if (receivedLlr.length !== this.H_punctured_width) {
            throw new Error(`Received LLR length must be ${this.H_punctured_width}, but got ${receivedLlr.length}`);
        }

        const currentMaxIterations = maxIterations ?? this.defaultMaxIterations;
        const state = this.initializeDecodingState(receivedLlr);
        
        let iterations = 0;
        let converged = false;

        for (iterations = 0; iterations < currentMaxIterations; iterations++) {
            this.updateCheckToBitMessages(state);

            this.updateBitToCheckMessages(state);

            this.computePosteriorAndHardDecision(state);

            if (this.checkParityConstraints(state.decodedCodeword)) {
                converged = true;
                break;
            }
        }

        return {
            decodedCodeword: state.decodedCodeword,
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
