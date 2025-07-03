import { HMatrixData, convertToSystematicForm } from './ldpc.js';

/**
 * LDPC H行列の性能分析ツール
 */
export class LDPCAnalyzer {
    private readonly hMatrix: HMatrixData;
    
    constructor(hMatrix: HMatrixData) {
        this.hMatrix = hMatrix;
    }

    /**
     * H行列の基本構造情報を取得
     */
    public getBasicInfo() {
        const n = this.hMatrix.width;   // 符号長
        const m = this.hMatrix.height;  // チェック数
        const k = n - m;               // 情報ビット長
        const rate = k / n;            // 符号化率
        
        return {
            codewordLength: n,
            messageLength: k,
            parityChecks: m,
            codeRate: rate,
            totalConnections: this.hMatrix.connections.length
        };
    }

    /**
     * 列重み（各ビットノードの次数）を計算
     */
    public getColumnWeights(): number[] {
        const weights = new Array(this.hMatrix.width).fill(0);
        for (const conn of this.hMatrix.connections) {
            weights[conn.bit]++;
        }
        return weights;
    }

    /**
     * 行重み（各チェックノードの次数）を計算
     */
    public getRowWeights(): number[] {
        const weights = new Array(this.hMatrix.height).fill(0);
        for (const conn of this.hMatrix.connections) {
            weights[conn.check]++;
        }
        return weights;
    }

    /**
     * 正則性の確認（regular/irregular）
     */
    public checkRegularity() {
        const columnWeights = this.getColumnWeights();
        const rowWeights = this.getRowWeights();
        
        const uniqueColWeights = [...new Set(columnWeights)];
        const uniqueRowWeights = [...new Set(rowWeights)];
        
        return {
            isRegular: uniqueColWeights.length === 1 && uniqueRowWeights.length === 1,
            columnDegree: uniqueColWeights,
            rowDegree: uniqueRowWeights,
            isColumnRegular: uniqueColWeights.length === 1,
            isRowRegular: uniqueRowWeights.length === 1
        };
    }

    /**
     * 密度（sparsity）の計算
     */
    public getDensity(): number {
        const totalElements = this.hMatrix.height * this.hMatrix.width;
        return this.hMatrix.connections.length / totalElements;
    }

    /**
     * H行列のランク推定（フルランクかどうか）
     * 注意: 実際のランク計算ではなく構造的推定
     */
    public exactRank(): { rank: number, isFullRank: boolean } {
        const { rank } = convertToSystematicForm(this.hMatrix);
        return {
            rank,
            isFullRank: rank === this.hMatrix.height
        };
    }

    /**
     * H行列の最小サイクル長（girth）を厳密に計算（BFS）
     * 返り値: girth（最小サイクル長, サイクルがなければInfinity）
     */
    public exactGirth(): number {
        const m = this.hMatrix.height; // Number of check nodes
        const n = this.hMatrix.width;  // Number of bit nodes

        // Build adjacency lists for the bipartite graph
        // bitToChecks[bit_idx] = [check_idx1, check_idx2, ...]
        // checkToBits[check_idx] = [bit_idx1, bit_idx2, ...]
        const bitToChecks: number[][] = Array(n).fill(0).map(() => []);
        const checkToBits: number[][] = Array(m).fill(0).map(() => []);

        for (const conn of this.hMatrix.connections) {
            bitToChecks[conn.bit].push(conn.check);
            checkToBits[conn.check].push(conn.bit);
        }

        let minGirth = Infinity;

        // Iterate through each node (bit and check) as a starting point for BFS
        // This ensures finding the shortest cycle regardless of where it starts.
        for (let startNodeIdx = 0; startNodeIdx < n + m; startNodeIdx++) {
            const isStartNodeBit = startNodeIdx < n;
            const actualStartIdx = isStartNodeBit ? startNodeIdx : startNodeIdx - n; // Adjust index for check nodes

            const q: { nodeIdx: number, isBitNode: boolean, dist: number, parentKey: string | null }[] = [];
            // visited: Map<key, { dist: number, parentKey: string | null }>
            // key: "bX" for bit node X, "cX" for check node X
            const visited: Map<string, { dist: number, parentKey: string | null }> = new Map();

            // Initialize queue with start node
            const startKey = isStartNodeBit ? `b${actualStartIdx}` : `c${actualStartIdx}`;
            q.push({ nodeIdx: actualStartIdx, isBitNode: isStartNodeBit, dist: 0, parentKey: null });
            visited.set(startKey, { dist: 0, parentKey: null });

            let head = 0;
            while (head < q.length) {
                const { nodeIdx, isBitNode, dist, parentKey } = q[head++];

                // Optimization: if current path already longer than minGirth, skip
                if (dist >= minGirth) continue;

                const neighbors = isBitNode ? bitToChecks[nodeIdx] : checkToBits[nodeIdx];
                const nextIsBitNode = !isBitNode;

                for (const neighborIdx of neighbors) {
                    const neighborKey = nextIsBitNode ? `b${neighborIdx}` : `c${neighborIdx}`;
                    const currentNodeKey = isBitNode ? `b${nodeIdx}` : `c${nodeIdx}`;

                    // Check if neighbor is the immediate parent (prevents going back and forth on the same edge)
                    if (neighborKey === parentKey) {
                        continue;
                    }

                    if (visited.has(neighborKey)) {
                        // Cycle detected!
                        const existingPath = visited.get(neighborKey)!;
                        // Cycle length = distance from start to current node + distance from start to neighbor + 1 (for the edge between them)
                        minGirth = Math.min(minGirth, dist + existingPath.dist + 1);
                    } else {
                        // Not visited, add to queue
                        q.push({ nodeIdx: neighborIdx, isBitNode: nextIsBitNode, dist: dist + 1, parentKey: currentNodeKey });
                        visited.set(neighborKey, { dist: dist + 1, parentKey: currentNodeKey });
                    }
                }
            }
        }
        return minGirth === Infinity ? Infinity : minGirth;
    }

    /**
     * 包括的な性能レポート
     */
    public generateReport(): string {
        const basic = this.getBasicInfo();
        const regularity = this.checkRegularity();
        const girth = this.exactGirth();
        const rank = this.exactRank();
        const density = this.getDensity();
        const colWeights = this.getColumnWeights();
        const rowWeights = this.getRowWeights();
        
        return `
## LDPC H行列 性能分析レポート

### 基本パラメータ
- 符号長 (n): ${basic.codewordLength}
- 情報長 (k): ${basic.messageLength}  
- パリティ数 (m): ${basic.parityChecks}
- 符号化率 (R): ${basic.codeRate.toFixed(3)}
- 総接続数: ${basic.totalConnections}

### 構造特性
- 正則性: ${regularity.isRegular ? 'Regular' : 'Irregular'}
- 列重み範囲: [${Math.min(...colWeights)}, ${Math.max(...colWeights)}]
- 行重み範囲: [${Math.min(...rowWeights)}, ${Math.max(...rowWeights)}]
- 密度: ${(density * 100).toFixed(3)}%

### 性能指標
- 厳密Girth: ${girth === Infinity ? 'サイクルなし' : girth}
- ランク状態: ${rank.isFullRank ? 'フルランク' : 'ランク不足'} (rank=${rank.rank}, m=${basic.parityChecks})

### 推奨事項
${rank.isFullRank ? '✅ 構造的に良好' : '⚠️ ランク確認が必要'}
${girth >= 6 ? '✅ 十分なgirth' : '⚠️ girth不足の可能性'}
${density < 0.1 ? '✅ 適切な疎密度' : '⚠️ 密度が高い'}
`;
    }
}