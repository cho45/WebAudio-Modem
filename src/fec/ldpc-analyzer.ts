import { HMatrixData } from './ldpc.js';

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
     * Girth（最小サイクル長）の下限推定
     * 実際のgirth計算は複雑なので、構造的特徴から推定
     */
    public estimateGirth(): { minPossible: number, analysis: string } {
        const regularity = this.checkRegularity();
        const basic = this.getBasicInfo();
        
        if (regularity.isRegular && regularity.columnDegree.length === 1) {
            const dc = regularity.columnDegree[0]; // 列重み
            const dr = regularity.rowDegree[0];   // 行重み
            
            // Regular LDPCの場合、girthの理論下限
            if (dc === 3) {
                return {
                    minPossible: 6,
                    analysis: `Regular (${dc},${dr}) LDPC: 理論最小girth=6`
                };
            } else if (dc === 2) {
                return {
                    minPossible: 4,
                    analysis: `Regular (${dc},${dr}) LDPC: 理論最小girth=4（性能劣化の可能性）`
                };
            }
        }
        
        return {
            minPossible: 4,
            analysis: "Irregular LDPC: girth分析には詳細計算が必要"
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
    public estimateRank(): { estimatedRank: number, isLikelyFullRank: boolean, note: string } {
        const basic = this.getBasicInfo();
        const regularity = this.checkRegularity();
        
        // 構造的にフルランクの可能性が高いかを判定
        const minRowWeight = Math.min(...this.getRowWeights());
        const maxColWeight = Math.max(...this.getColumnWeights());
        
        let isLikelyFullRank = true;
        let note = "";
        
        if (minRowWeight < 2) {
            isLikelyFullRank = false;
            note = "重み1の行が存在: ランク不足の可能性";
        } else if (maxColWeight === 1) {
            isLikelyFullRank = false;
            note = "重み1の列が存在: ランク不足の可能性";
        } else if (regularity.isRegular) {
            note = "Regular構造: 通常フルランク";
        } else {
            note = "Irregular構造: ランク確認推奨";
        }
        
        return {
            estimatedRank: basic.parityChecks,
            isLikelyFullRank,
            note
        };
    }

    /**
     * 包括的な性能レポート
     */
    public generateReport(): string {
        const basic = this.getBasicInfo();
        const regularity = this.checkRegularity();
        const girth = this.estimateGirth();
        const rank = this.estimateRank();
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
- 推定Girth: ${girth.minPossible} (${girth.analysis})
- ランク状態: ${rank.isLikelyFullRank ? 'フルランク推定' : 'ランク不足懸念'} (${rank.note})

### 推奨事項
${rank.isLikelyFullRank ? '✅ 構造的に良好' : '⚠️ ランク確認が必要'}
${girth.minPossible >= 6 ? '✅ 十分なgirth' : '⚠️ girth不足の可能性'}
${density < 0.1 ? '✅ 適切な疎密度' : '⚠️ 密度が高い'}
`;
    }
}