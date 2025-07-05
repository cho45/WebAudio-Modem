import { describe, it, expect } from 'vitest';
import { HMatrixData } from '../../src/fec/ldpc.js';

// SparseGaussianEliminator は convertToSystematicForm 内の private クラスなので、
// テスト用に convertToSystematicForm 経由でテストします
import { convertToSystematicForm } from '../../src/fec/ldpc.js';

describe('SparseGaussianEliminator', () => {
    describe('基本的なGaussian elimination', () => {
        it('3x5の手計算可能な行列で正確な変換を実行', () => {
            // 元のH行列:
            // [1 1 0 1 0]  <- Row 0
            // [0 1 1 0 1]  <- Row 1  
            // [1 0 1 0 0]  <- Row 2
            const hMatrix: HMatrixData = {
                height: 3,
                width: 5,
                connections: [
                    // Row 0: [1 1 0 1 0]
                    { check: 0, bit: 0 }, { check: 0, bit: 1 }, { check: 0, bit: 3 },
                    // Row 1: [0 1 1 0 1]
                    { check: 1, bit: 1 }, { check: 1, bit: 2 }, { check: 1, bit: 4 },
                    // Row 2: [1 0 1 0 0]
                    { check: 2, bit: 0 }, { check: 2, bit: 2 }
                ]
            };

            const result = convertToSystematicForm(hMatrix);
            
            console.log('手計算検証用H行列:');
            console.log('元の行列:');
            console.log('[1 1 0 1 0]');
            console.log('[0 1 1 0 1]');
            console.log('[1 0 1 0 0]');
            
            console.log('結果:');
            console.log(`Rank: ${result.rank}`);
            console.log(`Column permutation: [${result.columnPermutation.join(', ')}]`);
            
            for (let i = 0; i < result.systematicH.length; i++) {
                const row = Array.from(result.systematicH[i]).join(' ');
                console.log(`Row ${i}: [${row}]`);
            }

            // 基本的な検証
            expect(result.rank).toBe(3); // フルランク
            expect(result.isFullRank).toBe(true);
            expect(result.columnPermutation.length).toBe(5);
            
            // 左側3x3が単位行列であることを確認
            for (let i = 0; i < result.rank; i++) {
                for (let j = 0; j < result.rank; j++) {
                    const expected = i === j ? 1 : 0;
                    expect(result.systematicH[i][j]).toBe(expected);
                }
            }
        });

        it('ランク不足行列を正しく処理', () => {
            // ランク不足行列のテスト
            // [1 1 0]
            // [1 1 0]  <- Row 0と同じ（線形従属）
            // [0 0 1]
            const rankDeficientMatrix: HMatrixData = {
                height: 3,
                width: 3,
                connections: [
                    // Row 0: [1 1 0]
                    { check: 0, bit: 0 }, { check: 0, bit: 1 },
                    // Row 1: [1 1 0] (Row 0と同じ)
                    { check: 1, bit: 0 }, { check: 1, bit: 1 },
                    // Row 2: [0 0 1]
                    { check: 2, bit: 2 }
                ]
            };

            const result = convertToSystematicForm(rankDeficientMatrix);
            
            console.log('ランク不足行列テスト:');
            console.log(`期待ランク: 2, 実際ランク: ${result.rank}`);
            console.log(`フルランク: ${result.isFullRank}`);
            
            expect(result.rank).toBe(2); // ランク2
            expect(result.isFullRank).toBe(false);
        });
    });

    describe('複雑なケースの処理', () => {
        it('ピボット選択が必要な行列を正しく処理', () => {
            // ピボット選択が必要で、かつフルランクの行列
            // [0 1 0 1]  <- 最初の要素が0なのでピボット選択必要
            // [1 0 1 0]
            // [0 0 1 1]
            const pivotMatrix: HMatrixData = {
                height: 3,
                width: 4,
                connections: [
                    // Row 0: [0 1 0 1]
                    { check: 0, bit: 1 }, { check: 0, bit: 3 },
                    // Row 1: [1 0 1 0]
                    { check: 1, bit: 0 }, { check: 1, bit: 2 },
                    // Row 2: [0 0 1 1]
                    { check: 2, bit: 2 }, { check: 2, bit: 3 }
                ]
            };

            const result = convertToSystematicForm(pivotMatrix);
            
            console.log('ピボット選択テスト:');
            console.log('元の行列:');
            console.log('[0 1 0 1]');
            console.log('[1 0 1 0]');
            console.log('[0 0 1 1]');
            console.log(`Rank: ${result.rank}`);
            console.log(`Column permutation: [${result.columnPermutation.join(', ')}]`);
            
            // フルランクであることを確認
            expect(result.rank).toBe(3);
            expect(result.isFullRank).toBe(true);
            
            // 単位行列部分の確認
            for (let i = 0; i < result.rank; i++) {
                for (let j = 0; j < result.rank; j++) {
                    const expected = i === j ? 1 : 0;
                    expect(result.systematicH[i][j]).toBe(expected);
                }
            }
        });

        it('大きな疎行列でも効率的に処理', () => {
            // 10x20の疎行列（各行に3つの1）
            const connections: { check: number, bit: number }[] = [];
            for (let row = 0; row < 10; row++) {
                // 各行に3つの1を配置（疎行列）
                connections.push({ check: row, bit: row });
                connections.push({ check: row, bit: (row + 5) % 20 });
                connections.push({ check: row, bit: (row + 10) % 20 });
            }

            const largeMatrix: HMatrixData = {
                height: 10,
                width: 20,
                connections: connections
            };

            console.log('大規模疎行列テスト開始...');
            const startTime = performance.now();
            const result = convertToSystematicForm(largeMatrix);
            const endTime = performance.now();
            
            console.log(`処理時間: ${(endTime - startTime).toFixed(2)}ms`);
            console.log(`Rank: ${result.rank}`);
            console.log(`密度: ${(connections.length / (10 * 20) * 100).toFixed(1)}%`);
            
            // 基本的な検証
            expect(result.rank).toBeGreaterThan(0);
            expect(result.rank).toBeLessThanOrEqual(10);
            expect(endTime - startTime).toBeLessThan(10); // 10ms以内で完了
        });
    });

    describe('列置換の正確性', () => {
        it('列置換が可逆であることを確認', () => {
            const testMatrix: HMatrixData = {
                height: 3,
                width: 5,
                connections: [
                    { check: 0, bit: 0 }, { check: 0, bit: 2 }, { check: 0, bit: 4 },
                    { check: 1, bit: 1 }, { check: 1, bit: 3 }, { check: 1, bit: 4 },
                    { check: 2, bit: 0 }, { check: 2, bit: 1 }, { check: 2, bit: 2 }
                ]
            };

            const result = convertToSystematicForm(testMatrix);
            
            console.log('列置換可逆性テスト:');
            console.log(`Column permutation: [${result.columnPermutation.join(', ')}]`);
            
            // 置換が1対1対応であることを確認
            const uniqueColumns = new Set(result.columnPermutation);
            expect(uniqueColumns.size).toBe(result.columnPermutation.length);
            
            // すべての列インデックスが含まれることを確認
            for (let i = 0; i < testMatrix.width; i++) {
                expect(result.columnPermutation).toContain(i);
            }
            
            // 逆置換を構築して検証
            const inversePermutation = new Array(testMatrix.width);
            for (let i = 0; i < testMatrix.width; i++) {
                inversePermutation[result.columnPermutation[i]] = i;
            }
            
            // 逆置換が正しいことを確認
            for (let i = 0; i < testMatrix.width; i++) {
                const original = i;
                const permuted = result.columnPermutation[i];
                const restored = inversePermutation[permuted];
                expect(restored).toBe(original);
            }
        });
    });

    describe('数学的正確性の検証', () => {
        it('変換後もH*c=0の関係が保たれることを確認', () => {
            const testMatrix: HMatrixData = {
                height: 4,
                width: 7,
                connections: [
                    { check: 0, bit: 0 }, { check: 0, bit: 3 }, { check: 0, bit: 4 },
                    { check: 1, bit: 1 }, { check: 1, bit: 3 }, { check: 1, bit: 5 },
                    { check: 2, bit: 2 }, { check: 2, bit: 4 }, { check: 2, bit: 5 },
                    { check: 3, bit: 0 }, { check: 3, bit: 1 }, { check: 3, bit: 2 }, { check: 3, bit: 6 }
                ]
            };

            const result = convertToSystematicForm(testMatrix);
            
            console.log('数学的正確性テスト:');
            console.log(`結果のランク: ${result.rank}`);
            
            if (result.isFullRank) {
                // テストベクトルでH*c=0を検証
                const testCodeword = new Uint8Array(Math.ceil(testMatrix.width / 8));
                
                // 情報ビット部分に1を設定（systematic形式のk番目以降）
                const k = testMatrix.width - result.rank;
                if (k > 0) {
                    // 最初の情報ビットを1に設定
                    const informationBitIndex = result.rank;
                    const byteIndex = Math.floor(informationBitIndex / 8);
                    const bitOffset = informationBitIndex % 8;
                    testCodeword[byteIndex] |= (1 << (7 - bitOffset));
                    
                    // パリティビットを計算
                    for (let row = 0; row < result.rank; row++) {
                        let paritySum = 0;
                        for (let col = result.rank; col < testMatrix.width; col++) {
                            const informationBit = (testCodeword[Math.floor(col / 8)] >> (7 - (col % 8))) & 1;
                            paritySum ^= (result.systematicH[row][col] & informationBit);
                        }
                        
                        // パリティビットを設定
                        const parityByteIndex = Math.floor(row / 8);
                        const parityBitOffset = row % 8;
                        if (paritySum) {
                            testCodeword[parityByteIndex] |= (1 << (7 - parityBitOffset));
                        }
                    }
                    
                    // H*c=0を検証
                    let allParitiesZero = true;
                    for (let row = 0; row < result.systematicH.length; row++) {
                        let parity = 0;
                        for (let col = 0; col < testMatrix.width; col++) {
                            const bit = (testCodeword[Math.floor(col / 8)] >> (7 - (col % 8))) & 1;
                            parity ^= (result.systematicH[row][col] & bit);
                        }
                        if (parity !== 0) {
                            allParitiesZero = false;
                            break;
                        }
                    }
                    
                    expect(allParitiesZero).toBe(true);
                    console.log('✅ H*c=0の関係が保たれています');
                }
            }
        });

        it('エッジケース: 全ゼロ行列', () => {
            const zeroMatrix: HMatrixData = {
                height: 2,
                width: 3,
                connections: [] // 接続なし = 全ゼロ行列
            };

            const result = convertToSystematicForm(zeroMatrix);
            
            console.log('全ゼロ行列テスト:');
            console.log(`Rank: ${result.rank}`);
            
            expect(result.rank).toBe(0);
            expect(result.isFullRank).toBe(false);
        });

        it('エッジケース: 単一要素行列', () => {
            const singleElementMatrix: HMatrixData = {
                height: 1,
                width: 1,
                connections: [{ check: 0, bit: 0 }]
            };

            const result = convertToSystematicForm(singleElementMatrix);
            
            console.log('単一要素行列テスト:');
            console.log(`Rank: ${result.rank}`);
            
            expect(result.rank).toBe(1);
            expect(result.isFullRank).toBe(true);
            expect(result.systematicH[0][0]).toBe(1);
        });
    });

    describe('性能とメモリ効率', () => {
        it('大規模行列での性能測定', () => {
            // 50x100の疎行列（密度約3%）
            const connections: { check: number, bit: number }[] = [];
            for (let row = 0; row < 50; row++) {
                // 各行に3つの1をランダム配置
                const positions = new Set<number>();
                while (positions.size < 3) {
                    positions.add(Math.floor(Math.random() * 100));
                }
                for (const pos of positions) {
                    connections.push({ check: row, bit: pos });
                }
            }

            const largeMatrix: HMatrixData = {
                height: 50,
                width: 100,
                connections: connections
            };

            console.log('大規模性能テスト:');
            console.log(`行列サイズ: ${largeMatrix.height}x${largeMatrix.width}`);
            console.log(`非ゼロ要素数: ${connections.length}`);
            console.log(`密度: ${(connections.length / (50 * 100) * 100).toFixed(1)}%`);
            
            const startTime = performance.now();
            const result = convertToSystematicForm(largeMatrix);
            const endTime = performance.now();
            
            const processingTime = endTime - startTime;
            console.log(`処理時間: ${processingTime.toFixed(2)}ms`);
            console.log(`結果ランク: ${result.rank}`);
            
            // 性能要件
            expect(processingTime).toBeLessThan(50); // 50ms以内
            expect(result.rank).toBeGreaterThan(0);
        });
    });
});