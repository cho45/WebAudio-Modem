import { describe, it, expect } from 'vitest';
import { LDPC } from '../../src/fec/ldpc.js';
import { LDPCAnalyzer } from '../../src/fec/ldpc-analyzer.js';
import ldpcMatrixN128 from '../../src/fec/ldpc_h_matrix_n128_k64.json';

describe('LDPC Performance Analysis', () => {
    const ldpc = new LDPC(ldpcMatrixN128);
    const analyzer = new LDPCAnalyzer(ldpcMatrixN128);

    describe('構造解析', () => {
        it('基本パラメータが正しいこと', () => {
            const basic = analyzer.getBasicInfo();
            
            expect(basic.codewordLength).toBe(128);  // 新しい行列
            expect(basic.messageLength).toBe(64);   // k = n - m = 128 - 64
            expect(basic.parityChecks).toBe(64);
            expect(basic.codeRate).toBeCloseTo(0.5, 3); // rate 1/2
            
            console.log('基本パラメータ:', basic);
        });

        it('正則性の確認', () => {
            const regularity = analyzer.checkRegularity();
            
            console.log('正則性:', regularity);
            
            // quasi-cyclicなら通常regular
            expect(regularity.columnDegree.length).toBeGreaterThan(0);
            expect(regularity.rowDegree.length).toBeGreaterThan(0);
        });

        it('重み分布の確認', () => {
            const colWeights = analyzer.getColumnWeights();
            const rowWeights = analyzer.getRowWeights();
            
            console.log('列重み統計:', {
                min: Math.min(...colWeights),
                max: Math.max(...colWeights),
                avg: colWeights.reduce((a, b) => a + b, 0) / colWeights.length
            });
            
            console.log('行重み統計:', {
                min: Math.min(...rowWeights),
                max: Math.max(...rowWeights),
                avg: rowWeights.reduce((a, b) => a + b, 0) / rowWeights.length
            });
            
            // 健全性チェック
            expect(Math.min(...colWeights)).toBeGreaterThan(0); // 孤立ビットなし
            expect(Math.min(...rowWeights)).toBeGreaterThan(1); // 有効チェック
        });
    });

    describe('エンコード/デコード基本テスト', () => {
        it('符号化と復号化が正常動作すること', () => {
            // テストメッセージ（128ビット = 16バイト）
            const messageBytes = new Uint8Array(16);
            messageBytes[0] = 0xAB; // テストパターン
            messageBytes[1] = 0xCD;
            
            // エンコード
            const codeword = ldpc.encode(messageBytes);
            expect(codeword.length).toBe(16); // 128ビット = 16バイト
            
            // 理想的な受信（ノイズなし）
            const receivedLlr = new Int8Array(128);
            for (let i = 0; i < 128; i++) {
                const bit = (codeword[Math.floor(i / 8)] >> (7 - (i % 8))) & 1;
                receivedLlr[i] = bit ? -100 : 100; // 確実なLLR
            }
            
            // デコード
            const result = ldpc.decode(receivedLlr);
            
            expect(result.converged).toBe(true);
            expect(result.iterations).toBeLessThan(5); // 収束が早いはず
            
            console.log('デコード結果:', {
                iterations: result.iterations,
                converged: result.converged
            });
        });

        it('ノイズ耐性テスト（軽微なエラー）', () => {
            const messageBytes = new Uint8Array(16);
            messageBytes[0] = 0xFF;
            
            const codeword = ldpc.encode(messageBytes);
            
            // 軽微なノイズを追加
            const receivedLlr = new Int8Array(128);
            let errorCount = 0;
            
            for (let i = 0; i < 128; i++) {
                const bit = (codeword[Math.floor(i / 8)] >> (7 - (i % 8))) & 1;
                let llr = bit ? -80 : 80;
                
                // 5%の位置にノイズ追加
                if (Math.random() < 0.05) {
                    llr = -llr * 0.3; // エラー導入
                    errorCount++;
                }
                
                receivedLlr[i] = Math.max(-127, Math.min(127, llr));
            }
            
            const result = ldpc.decode(receivedLlr);
            
            console.log(`エラー${errorCount}個導入 → 収束: ${result.converged}, 反復: ${result.iterations}`);
            
            // 軽微なエラーなら修正できるはず
            expect(result.iterations).toBeLessThan(20);
        });
    });

    describe('性能ベンチマーク', () => {
        it('エンコード性能測定', () => {
            const messageBytes = new Uint8Array(16);
            const iterations = 1000;
            
            const start = performance.now();
            for (let i = 0; i < iterations; i++) {
                messageBytes[0] = i & 0xFF;
                ldpc.encode(messageBytes);
            }
            const end = performance.now();
            
            const avgTime = (end - start) / iterations;
            console.log(`エンコード平均時間: ${avgTime.toFixed(3)}ms`);
            
            expect(avgTime).toBeLessThan(5); // 5ms以内
        });

        it('デコード性能測定', () => {
            const receivedLlr = new Int8Array(128);
            // 理想的な受信状態
            for (let i = 0; i < 128; i++) {
                receivedLlr[i] = Math.random() > 0.5 ? 100 : -100;
            }
            
            const iterations = 100;
            const start = performance.now();
            
            for (let i = 0; i < iterations; i++) {
                ldpc.decode(receivedLlr, 10); // 最大10反復
            }
            
            const end = performance.now();
            const avgTime = (end - start) / iterations;
            
            console.log(`デコード平均時間: ${avgTime.toFixed(3)}ms`);
            expect(avgTime).toBeLessThan(50); // 50ms以内
        });
    });

    describe('包括レポート', () => {
        it('性能分析レポートの生成', () => {
            const report = analyzer.generateReport();
            console.log(report);
            
            expect(report).toContain('符号化率');
            expect(report).toContain('0.500'); // rate 1/2
        });
    });
});
