import { describe, it, expect } from 'vitest';
import { LDPC } from '../../src/fec/ldpc.js';
import { LDPCAnalyzer } from '../../src/fec/ldpc-analyzer.js';

// 全符号長のH行列を読み込み
import ldpcMatrix128 from '../../src/fec/ldpc_h_matrix_n128_k64.json';
import ldpcMatrix256 from '../../src/fec/ldpc_h_matrix_n256_k128.json';
import ldpcMatrix512 from '../../src/fec/ldpc_h_matrix_n512_k256.json';
import ldpcMatrix1024 from '../../src/fec/ldpc_h_matrix_n1024_k512.json';

interface LDPCTestCase {
    name: string;
    matrix: any;
    expectedN: number;
    expectedK: number;
    messageBytesLength: number;
    codewordBytesLength: number;
}

const testCases: LDPCTestCase[] = [
    {
        name: 'n128_k64',
        matrix: ldpcMatrix128,
        expectedN: 128,
        expectedK: 64,
        messageBytesLength: 8,
        codewordBytesLength: 16
    },
    {
        name: 'n256_k128',
        matrix: ldpcMatrix256,
        expectedN: 256,
        expectedK: 128,
        messageBytesLength: 16,
        codewordBytesLength: 32
    },
    {
        name: 'n512_k256',
        matrix: ldpcMatrix512,
        expectedN: 512,
        expectedK: 256,
        messageBytesLength: 32,
        codewordBytesLength: 64
    },
    {
        name: 'n1024_k512',
        matrix: ldpcMatrix1024,
        expectedN: 1024,
        expectedK: 512,
        messageBytesLength: 64,
        codewordBytesLength: 128
    }
];

describe('LDPC 全符号長包括テスト', () => {
    describe.each(testCases)('$name の検証', (testCase) => {
        const puncturedBitIndices: number[] = [];
        for (let i = testCase.expectedN; i < testCase.matrix.width; i++) {
            puncturedBitIndices.push(i);
        }
        const ldpc = new LDPC(testCase.matrix, 10, puncturedBitIndices);
        const analyzer = new LDPCAnalyzer(testCase.matrix);

        it('基本パラメータが正しいこと', () => {
            const basic = analyzer.getBasicInfo();
            
            expect(basic.codewordLength).toBe(testCase.matrix.width);
            expect(basic.messageLength).toBe(testCase.expectedK);
            expect(basic.codeRate).toBeCloseTo(testCase.expectedK / testCase.matrix.width, 3);
            
            console.log(`${testCase.name} - 基本パラメータ:`, {
                n: basic.codewordLength,
                k: basic.messageLength,
                rate: basic.codeRate,
                connections: basic.totalConnections
            });
        });

        it('構造的特性が良好であること', () => {
            const regularity = analyzer.checkRegularity();
            const rank = analyzer.exactRank();
            const girth = analyzer.exactGirth();
            
            console.log(`${testCase.name} - 構造特性:`, {
                regular: regularity.isRegular,
                columnDegree: regularity.columnDegree,
                rowDegree: regularity.rowDegree,
                exactGirth: girth,
                fullRank: rank.isFullRank
            });
            
            expect(rank.isFullRank).toBe(true); // フルランク
            expect(girth).toBeGreaterThanOrEqual(6); // 十分なgirth
        });

        it('エンコード/デコードが正常動作すること', () => {
            // テストメッセージ生成
            const messageBytes = new Uint8Array(testCase.messageBytesLength);
            messageBytes.fill(0xAA); // テストパターン
            
            // エンコード
            const codeword = ldpc.encode(messageBytes);
            expect(codeword.length).toBe(testCase.codewordBytesLength);
            
            // 理想的な受信（ノイズなし）
            const receivedLlr = new Int8Array(testCase.expectedN);
            for (let i = 0; i < testCase.expectedN; i++) {
                const bit = (codeword[Math.floor(i / 8)] >> (7 - (i % 8))) & 1;
                receivedLlr[i] = bit ? -100 : 100;
            }
            
            // デコード
            const result = ldpc.decode(receivedLlr);
            
            expect(result.converged).toBe(true);
            expect(result.iterations).toBeLessThan(5);
            
            console.log(`${testCase.name} - デコード:`, {
                iterations: result.iterations,
                converged: result.converged
            });
        });

        it('軽微なノイズに対する耐性があること', () => {
            const messageBytes = new Uint8Array(testCase.messageBytesLength);
            messageBytes[0] = 0xFF;
            
            const codeword = ldpc.encode(messageBytes);
            const receivedLlr = new Int8Array(testCase.expectedN);
            let errorCount = 0;
            
            for (let i = 0; i < testCase.expectedN; i++) {
                const bit = (codeword[Math.floor(i / 8)] >> (7 - (i % 8))) & 1;
                let llr = bit ? -80 : 80;
                
                // 3%の位置にノイズ追加（符号長が大きいほど多くのエラーを許容）
                if (Math.random() < 0.03) {
                    llr = -llr * 0.4;
                    errorCount++;
                }
                
                receivedLlr[i] = Math.max(-127, Math.min(127, llr));
            }
            
            const result = ldpc.decode(receivedLlr, 20); // 最大20反復
            
            console.log(`${testCase.name} - ノイズ耐性: ${errorCount}エラー → 収束:${result.converged}, 反復:${result.iterations}`);
            
            // 3%程度のエラーなら修正できるはず
            expect(result.iterations).toBeLessThan(20);
        });
    });

    describe('性能比較分析', () => {
        const performanceResults: Array<{
            name: string;
            n: number;
            k: number;
            encodeTime: number;
            decodeTime: number;
            density: number;
            regular: boolean;
        }> = [];

        testCases.forEach((testCase) => {
            it(`${testCase.name}の性能測定`, () => {
                const puncturedBitIndices: number[] = [];
                for (let i = testCase.expectedN; i < testCase.matrix.width; i++) {
                    puncturedBitIndices.push(i);
                }
                const ldpc = new LDPC(testCase.matrix, 10, puncturedBitIndices);
                const analyzer = new LDPCAnalyzer(testCase.matrix);
                
                // エンコード性能測定
                const messageBytes = new Uint8Array(testCase.messageBytesLength);
                const encodeIterations = 100;
                
                const encodeStart = performance.now();
                for (let i = 0; i < encodeIterations; i++) {
                    messageBytes[0] = i & 0xFF;
                    ldpc.encode(messageBytes);
                }
                const encodeEnd = performance.now();
                const avgEncodeTime = (encodeEnd - encodeStart) / encodeIterations;
                
                // デコード性能測定
                const receivedLlr = new Int8Array(testCase.expectedN);
                for (let i = 0; i < testCase.expectedN; i++) {
                    receivedLlr[i] = Math.random() > 0.5 ? 100 : -100;
                }
                
                const decodeIterations = 50;
                const decodeStart = performance.now();
                for (let i = 0; i < decodeIterations; i++) {
                    ldpc.decode(receivedLlr, 5);
                }
                const decodeEnd = performance.now();
                const avgDecodeTime = (decodeEnd - decodeStart) / decodeIterations;
                
                // 分析結果
                const basic = analyzer.getBasicInfo();
                const regularity = analyzer.checkRegularity();
                const density = analyzer.getDensity();
                
                const result = {
                    name: testCase.name,
                    n: basic.codewordLength,
                    k: basic.messageLength,
                    encodeTime: avgEncodeTime,
                    decodeTime: avgDecodeTime,
                    density: density * 100,
                    regular: regularity.isRegular
                };
                
                performanceResults.push(result);
                
                console.log(`${testCase.name} 性能:`, {
                    encode: `${avgEncodeTime.toFixed(3)}ms`,
                    decode: `${avgDecodeTime.toFixed(3)}ms`,
                    density: `${(density * 100).toFixed(3)}%`
                });
                
                // 性能期待値
                expect(avgEncodeTime).toBeLessThan(10);  // 10ms以内
                expect(avgDecodeTime).toBeLessThan(100); // 100ms以内
            });
        });

        it('全符号長性能サマリー', () => {
            console.log('\n=== LDPC 性能比較サマリー ===');
            console.table(performanceResults);
            
            // スケーラビリティチェック
            const sortedResults = performanceResults.sort((a, b) => a.n - b.n);
            
            for (let i = 1; i < sortedResults.length; i++) {
                const prev = sortedResults[i - 1];
                const curr = sortedResults[i];
                
                const encodeRatio = curr.encodeTime / prev.encodeTime;
                const decodeRatio = curr.decodeTime / prev.decodeTime;
                const sizeRatio = curr.n / prev.n;
                
                console.log(`${prev.name} → ${curr.name}: サイズ${sizeRatio}x, エンコード${encodeRatio.toFixed(2)}x, デコード${decodeRatio.toFixed(2)}x`);
                
                // 計算量の増加が合理的範囲内であることを確認
                expect(encodeRatio).toBeLessThan(sizeRatio * 2.8); // エンコードは概ね線形（実測調整）
                expect(decodeRatio).toBeLessThan(sizeRatio * 3); // デコードは若干非線形
            }
        });
    });

    describe('包括品質レポート', () => {
        it('全符号長の品質レポート生成', () => {
            console.log('\n=== 全符号長 品質分析レポート ===\n');
            
            testCases.forEach((testCase) => {
                const analyzer = new LDPCAnalyzer(testCase.matrix);
                const report = analyzer.generateReport();
                
                console.log(`## ${testCase.name.toUpperCase()}`);
                console.log(report);
                console.log('---\n');
            });
        });
    });
});
