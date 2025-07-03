import { describe, it, expect } from 'vitest';
import { LDPCAnalyzer } from '../../src/fec/ldpc-analyzer';
import { HMatrixData } from '../../src/fec/ldpc';

describe('LDPCAnalyzer', () => {
    // Helper function to create a simple HMatrixData
    const createHMatrix = (width: number, height: number, connections: { bit: number; check: number; }[]): HMatrixData => ({
        width,
        height,
        connections,
    });

    describe('getBasicInfo', () => {
        it('should return correct basic info for a given H matrix', () => {
            const hMatrix = createHMatrix(8, 4, [
                { bit: 0, check: 0 }, { bit: 1, check: 0 }, { bit: 2, check: 0 },
                { bit: 3, check: 1 }, { bit: 4, check: 1 }, { bit: 5, check: 1 },
                { bit: 6, check: 2 }, { bit: 7, check: 2 }, { bit: 0, check: 3 },
                { bit: 1, check: 3 }, { bit: 2, check: 3 }, { bit: 3, check: 3 },
            ]);
            const analyzer = new LDPCAnalyzer(hMatrix);
            const info = analyzer.getBasicInfo();

            expect(info.codewordLength).toBe(8);
            expect(info.parityChecks).toBe(4);
            expect(info.messageLength).toBe(4); // n - m = 8 - 4 = 4
            expect(info.codeRate).toBe(0.5);
            expect(info.totalConnections).toBe(12);
        });
    });

    describe('getColumnWeights', () => {
        it('should calculate correct column weights', () => {
            const hMatrix = createHMatrix(4, 2, [
                { bit: 0, check: 0 }, { bit: 1, check: 0 },
                { bit: 1, check: 1 }, { bit: 2, check: 1 }, { bit: 3, check: 1 },
            ]);
            const analyzer = new LDPCAnalyzer(hMatrix);
            expect(analyzer.getColumnWeights()).toEqual([1, 2, 1, 1]);
        });
    });

    describe('getRowWeights', () => {
        it('should calculate correct row weights', () => {
            const hMatrix = createHMatrix(4, 2, [
                { bit: 0, check: 0 }, { bit: 1, check: 0 },
                { bit: 1, check: 1 }, { bit: 2, check: 1 }, { bit: 3, check: 1 },
            ]);
            const analyzer = new LDPCAnalyzer(hMatrix);
            expect(analyzer.getRowWeights()).toEqual([2, 3]);
        });
    });

    describe('checkRegularity', () => {
        it('should identify a regular matrix', () => {
            // Example of a (6,3) regular LDPC code (column weight 2, row weight 4)
            const hMatrix = createHMatrix(6, 3, [
                { bit: 0, check: 0 }, { bit: 1, check: 0 }, { bit: 2, check: 0 }, { bit: 3, check: 0 },
                { bit: 0, check: 1 }, { bit: 1, check: 1 }, { bit: 4, check: 1 }, { bit: 5, check: 1 },
                { bit: 2, check: 2 }, { bit: 3, check: 2 }, { bit: 4, check: 2 }, { bit: 5, check: 2 },
            ]);
            const analyzer = new LDPCAnalyzer(hMatrix);
            const regularity = analyzer.checkRegularity();
            expect(regularity.isRegular).toBe(true);
            expect(regularity.columnDegree).toEqual([2]);
            expect(regularity.rowDegree).toEqual([4]);
        });

        it('should identify an irregular matrix', () => {
            const hMatrix = createHMatrix(4, 2, [
                { bit: 0, check: 0 }, { bit: 1, check: 0 },
                { bit: 1, check: 1 }, { bit: 2, check: 1 }, { bit: 3, check: 1 },
            ]);
            const analyzer = new LDPCAnalyzer(hMatrix);
            const regularity = analyzer.checkRegularity();
            expect(regularity.isRegular).toBe(false);
            expect(regularity.isColumnRegular).toBe(false);
            expect(regularity.isRowRegular).toBe(false);
        });
    });

    describe('getDensity', () => {
        it('should calculate the correct density', () => {
            const hMatrix = createHMatrix(4, 2, [
                { bit: 0, check: 0 }, { bit: 1, check: 0 },
                { bit: 1, check: 1 }, { bit: 2, check: 1 }, { bit: 3, check: 1 },
            ]);
            const analyzer = new LDPCAnalyzer(hMatrix);
            // 5 connections / (4 * 2) total elements = 5/8 = 0.625
            expect(analyzer.getDensity()).toBe(5 / 8);
        });
    });

    // Mock convertToSystematicForm for exactRank test
    // In a real scenario, you might mock the entire ldpc.js module
    // For simplicity, we'll assume convertToSystematicForm works as expected
    // and focus on the analyzer's usage of its output.
    describe('exactRank', () => {
        it('should return correct rank info', () => {
            // This test relies on the mocked behavior of convertToSystematicForm
            // which is outside the scope of LDPCAnalyzer's direct logic.
            // We're testing that LDPCAnalyzer correctly uses the rank returned.
            const hMatrix = createHMatrix(8, 4, [
                { bit: 0, check: 0 }, { bit: 1, check: 0 }, { bit: 2, check: 0 },
                { bit: 3, check: 1 }, { bit: 4, check: 1 }, { bit: 5, check: 1 },
                { bit: 6, check: 2 }, { bit: 7, check: 2 }, { bit: 0, check: 3 },
                { bit: 1, check: 3 }, { bit: 2, check: 3 }, { bit: 3, check: 3 },
            ]);
            const analyzer = new LDPCAnalyzer(hMatrix);
            // Mocking the internal call to convertToSystematicForm
            // @ts-ignore
            analyzer['convertToSystematicForm'] = (h: HMatrixData) => ({ rank: h.height });

            const rankInfo = analyzer.exactRank();
            expect(rankInfo.rank).toBe(hMatrix.height);
            expect(rankInfo.isFullRank).toBe(true);
        });
    });

    describe('exactGirth', () => {
        it('should return Infinity for a graph with no cycles', () => {
            // A simple tree-like graph
            const hMatrix = createHMatrix(4, 3, [
                { bit: 0, check: 0 },
                { bit: 1, check: 0 },
                { bit: 1, check: 1 },
                { bit: 2, check: 1 },
                { bit: 3, check: 2 },
            ]);
            const analyzer = new LDPCAnalyzer(hMatrix);
            expect(analyzer.exactGirth()).toBe(Infinity);
        });

        it('should return 4 for a simple 4-cycle', () => {
            // b0-c0-b1-c1-b0
            const hMatrix = createHMatrix(2, 2, [
                { bit: 0, check: 0 },
                { bit: 1, check: 0 },
                { bit: 0, check: 1 },
                { bit: 1, check: 1 },
            ]);
            const analyzer = new LDPCAnalyzer(hMatrix);
            expect(analyzer.exactGirth()).toBe(4);
        });

        it('should return 6 for a simple 6-cycle', () => {
            // b0-c0-b1-c1-b2-c2-b0
            const hMatrix = createHMatrix(3, 3, [
                { bit: 0, check: 0 }, { bit: 1, check: 0 },
                { bit: 1, check: 1 }, { bit: 2, check: 1 },
                { bit: 2, check: 2 }, { bit: 0, check: 2 },
            ]);
            const analyzer = new LDPCAnalyzer(hMatrix);
            expect(analyzer.exactGirth()).toBe(6);
        });

        it('should return the minimum girth when multiple cycles exist', () => {
            // Contains a 4-cycle (b0-c0-b1-c1-b0) and a 6-cycle
            const hMatrix = createHMatrix(3, 3, [
                { bit: 0, check: 0 }, { bit: 1, check: 0 }, // b0-c0-b1
                { bit: 0, check: 1 }, { bit: 1, check: 1 }, // b0-c1-b1 (forms 4-cycle with c0)
                { bit: 1, check: 2 }, { bit: 2, check: 2 }, // b1-c2-b2
                { bit: 2, check: 0 }, // b2-c0 (forms 6-cycle b0-c0-b2-c2-b1-c1-b0)
            ]);
            const analyzer = new LDPCAnalyzer(hMatrix);
            expect(analyzer.exactGirth()).toBe(4);
        });

        it('should handle disconnected components', () => {
            // Two disconnected 4-cycles
            const hMatrix = createHMatrix(4, 4, [
                { bit: 0, check: 0 }, { bit: 1, check: 0 },
                { bit: 0, check: 1 }, { bit: 1, check: 1 },

                { bit: 2, check: 2 }, { bit: 3, check: 2 },
                { bit: 2, check: 3 }, { bit: 3, check: 3 },
            ]);
            const analyzer = new LDPCAnalyzer(hMatrix);
            expect(analyzer.exactGirth()).toBe(4);
        });

        it('should handle a larger, more complex matrix with a known girth', () => {
            // Example from a research paper or known LDPC code with girth 6
            // This is a simplified representation, actual matrices are larger.
            const hMatrix = createHMatrix(6, 3, [
                { bit: 0, check: 0 }, { bit: 1, check: 0 }, { bit: 2, check: 0 },
                { bit: 1, check: 1 }, { bit: 2, check: 1 }, { bit: 3, check: 1 },
                { bit: 0, check: 2 }, { bit: 3, check: 2 }, { bit: 4, check: 2 },
                { bit: 5, check: 0 }, { bit: 4, check: 1 }, { bit: 5, check: 2 },
            ]);
            const analyzer = new LDPCAnalyzer(hMatrix);
            // This specific matrix might have a girth of 4 or 6 depending on exact connections.
            // For this example, let's assume it's constructed to have girth 6.
            // b0-c0-b1-c1-b2-c2-b0 is a 6-cycle
            // b0-c0-b5-c2-b0 is a 4-cycle
            // So the girth should be 4
            expect(analyzer.exactGirth()).toBe(4);
        });
    });

    describe('generateReport', () => {
        it('should generate a comprehensive report string', () => {
            const hMatrix = createHMatrix(8, 4, [
                { bit: 0, check: 0 }, { bit: 1, check: 0 }, { bit: 2, check: 0 },
                { bit: 3, check: 1 }, { bit: 4, check: 1 }, { bit: 5, check: 1 },
                { bit: 6, check: 2 }, { bit: 7, check: 2 }, { bit: 0, check: 3 },
                { bit: 1, check: 3 }, { bit: 2, check: 3 }, { bit: 3, check: 3 },
            ]);
            const analyzer = new LDPCAnalyzer(hMatrix);
            const report = analyzer.generateReport();

            expect(report).toContain('## LDPC H行列 性能分析レポート');
            expect(report).toContain('符号長 (n): 8');
            expect(report).toContain('情報長 (k): 4');
            expect(report).toContain('パリティ数 (m): 4');
            expect(report).toContain('符号化率 (R): 0.500');
            expect(report).toContain('総接続数: 12');
            // Depending on the exactGirth implementation, this might change
            expect(report).toContain('厳密Girth:'); 
            expect(report).toContain('ランク状態:');
            expect(report).toContain('密度:');
        });
    });
});
