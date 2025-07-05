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
     * 重み（各ノードの次数）を計算する共通メソッド
     */
    private calculateWeights(field: 'bit' | 'check'): number[] {
        const size = field === 'bit' ? this.hMatrix.width : this.hMatrix.height;
        const weights = new Array(size).fill(0);
        for (const connection of this.hMatrix.connections) {
            weights[connection[field]]++;
        }
        return weights;
    }

    /**
     * 列重み（各ビットノードの次数）を計算
     */
    public getColumnWeights(): number[] {
        return this.calculateWeights('bit');
    }

    /**
     * 行重み（各チェックノードの次数）を計算
     */
    public getRowWeights(): number[] {
        return this.calculateWeights('check');
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
     * 二部グラフの隣接リストを構築
     */
    private buildBipartiteGraph(): { bitToChecks: number[][], checkToBits: number[][] } {
        const numBitNodes = this.hMatrix.width;
        const numCheckNodes = this.hMatrix.height;
        
        const bitToChecks: number[][] = Array(numBitNodes).fill(0).map(() => []);
        const checkToBits: number[][] = Array(numCheckNodes).fill(0).map(() => []);

        for (const connection of this.hMatrix.connections) {
            bitToChecks[connection.bit].push(connection.check);
            checkToBits[connection.check].push(connection.bit);
        }

        return { bitToChecks, checkToBits };
    }

    /**
     * 指定されたスタートノードからBFSを実行して最短サイクルを検索
     */
    private performBFS(
        startNodeIdx: number,
        isStartNodeBit: boolean,
        graph: { bitToChecks: number[][], checkToBits: number[][] },
        currentMinGirth: number
    ): number {
        const queue: { nodeIdx: number, isBitNode: boolean, dist: number, parentKey: string | null }[] = [];
        const visited: Map<string, { dist: number, parentKey: string | null }> = new Map();

        // スタートノードでキューを初期化
        const startKey = isStartNodeBit ? `b${startNodeIdx}` : `c${startNodeIdx}`;
        queue.push({ nodeIdx: startNodeIdx, isBitNode: isStartNodeBit, dist: 0, parentKey: null });
        visited.set(startKey, { dist: 0, parentKey: null });

        let minCycleLength = Infinity;
        let head = 0;

        while (head < queue.length) {
            const { nodeIdx, isBitNode, dist, parentKey } = queue[head++];

            // 最適化: 現在のパスが既に最短サイクルより長い場合はスキップ
            if (dist >= Math.min(currentMinGirth, minCycleLength)) continue;

            const neighbors = isBitNode ? graph.bitToChecks[nodeIdx] : graph.checkToBits[nodeIdx];
            const nextIsBitNode = !isBitNode;

            for (const neighborIdx of neighbors) {
                const neighborKey = nextIsBitNode ? `b${neighborIdx}` : `c${neighborIdx}`;
                const currentNodeKey = isBitNode ? `b${nodeIdx}` : `c${nodeIdx}`;

                // 直接の親ノードへの逆行を防ぐ
                if (neighborKey === parentKey) {
                    continue;
                }

                if (visited.has(neighborKey)) {
                    // サイクル検出
                    const existingPath = visited.get(neighborKey)!;
                    const cycleLength = dist + existingPath.dist + 1;
                    minCycleLength = Math.min(minCycleLength, cycleLength);
                } else {
                    // 未訪問のノードをキューに追加
                    queue.push({ nodeIdx: neighborIdx, isBitNode: nextIsBitNode, dist: dist + 1, parentKey: currentNodeKey });
                    visited.set(neighborKey, { dist: dist + 1, parentKey: currentNodeKey });
                }
            }
        }

        return minCycleLength;
    }

    /**
     * H行列の最小サイクル長（girth）を厳密に計算（BFS）
     * 返り値: girth（最小サイクル長, サイクルがなければInfinity）
     */
    public exactGirth(): number {
        const graph = this.buildBipartiteGraph();
        const numBitNodes = this.hMatrix.width;
        const numCheckNodes = this.hMatrix.height;
        
        let minGirth = Infinity;

        // 各ノードをスタートポイントとしてBFSを実行
        for (let startNodeIdx = 0; startNodeIdx < numBitNodes + numCheckNodes; startNodeIdx++) {
            const isStartNodeBit = startNodeIdx < numBitNodes;
            const actualStartIdx = isStartNodeBit ? startNodeIdx : startNodeIdx - numBitNodes;

            const cycleLength = this.performBFS(actualStartIdx, isStartNodeBit, graph, minGirth);
            minGirth = Math.min(minGirth, cycleLength);
        }

        return minGirth === Infinity ? Infinity : minGirth;
    }

    /**
     * 基本パラメータセクションを生成
     */
    private generateBasicSection(): string {
        const basic = this.getBasicInfo();
        return `### 基本パラメータ
- 符号長 (n): ${basic.codewordLength}
- 情報長 (k): ${basic.messageLength}  
- パリティ数 (m): ${basic.parityChecks}
- 符号化率 (R): ${basic.codeRate.toFixed(3)}
- 総接続数: ${basic.totalConnections}`;
    }

    /**
     * 構造特性セクションを生成
     */
    private generateStructureSection(): string {
        const regularity = this.checkRegularity();
        const density = this.getDensity();
        const colWeights = this.getColumnWeights();
        const rowWeights = this.getRowWeights();
        
        return `### 構造特性
- 正則性: ${regularity.isRegular ? 'Regular' : 'Irregular'}
- 列重み範囲: [${Math.min(...colWeights)}, ${Math.max(...colWeights)}]
- 行重み範囲: [${Math.min(...rowWeights)}, ${Math.max(...rowWeights)}]
- 密度: ${(density * 100).toFixed(3)}%`;
    }

    /**
     * 性能指標セクションを生成
     */
    private generatePerformanceSection(): string {
        const girth = this.exactGirth();
        const rank = this.exactRank();
        const basic = this.getBasicInfo();
        
        return `### 性能指標
- 厳密Girth: ${girth === Infinity ? 'サイクルなし' : girth}
- ランク状態: ${rank.isFullRank ? 'フルランク' : 'ランク不足'} (rank=${rank.rank}, m=${basic.parityChecks})`;
    }

    /**
     * 推奨事項セクションを生成
     */
    private generateRecommendationsSection(): string {
        const girth = this.exactGirth();
        const rank = this.exactRank();
        const density = this.getDensity();
        
        return `### 推奨事項
${rank.isFullRank ? '✅ 構造的に良好' : '⚠️ ランク確認が必要'}
${girth >= 6 ? '✅ 十分なgirth' : '⚠️ girth不足の可能性'}
${density < 0.1 ? '✅ 適切な疎密度' : '⚠️ 密度が高い'}`;
    }

    /**
     * 包括的な性能レポート
     */
    public generateReport(): string {
        const sections = [
            '## LDPC H行列 性能分析レポート',
            '',
            this.generateBasicSection(),
            '',
            this.generateStructureSection(),
            '',
            this.generatePerformanceSection(),
            '',
            this.generateRecommendationsSection()
        ];
        
        return sections.join('\n');
    }
}