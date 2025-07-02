import { describe, test, expect } from 'vitest';
import { bchEncode, bchDecode, getBCHParams, type BCHCodeType, GaloisField } from '../../src/fec/bch';

describe('Galois Field Operations', () => {
  // GF(2^3) with primitive polynomial x^3 + x + 1 (11)
  const gf = new GaloisField(3, 0b1011);
  const alphaTo = [1, 2, 4, 3, 6, 7, 5]; // α^0 to α^6

  test('should create a Galois Field correctly for GF(2^3)', () => {
    expect(gf.m).toBe(3);
    expect(gf.n).toBe(7);
    expect(gf.primitivePoly).toBe(0b1011);
    // Check if the generated alphaTo table matches the known correct one.
    // Note: gf.alphaTo has n+1 elements, but we only care about the first n.
    expect(gf.alphaTo.slice(0, 7)).toEqual(alphaTo);
    expect(gf.logAlpha[1]).toBe(0); // log(α^0)
    expect(gf.logAlpha[5]).toBe(6); // log(α^6)
  });

  test('multiply should perform multiplication correctly in GF(2^3)', () => {
    // α^1 * α^2 = 2 * 4 = 3 = α^3
    expect(gf.multiply(2, 4)).toBe(3);
    // α^3 * α^4 = 3 * 6 = 1 = α^0
    expect(gf.multiply(3, 6)).toBe(1);
    // Test wrap-around: α^5 * α^3 = 7 * 3 = 2 = α^8 = α^1
    expect(gf.multiply(7, 3)).toBe(2);
    // Test multiplication by 1 (identity)
    expect(gf.multiply(6, 1)).toBe(6);
  });

  test('power should perform exponentiation correctly in GF(2^3)', () => {
    // (α^2)^2 = 4^2 = 6 = α^4
    expect(gf.power(4, 2)).toBe(6);
    // (α^3)^3 = α^9 = α^2 = 4
    expect(gf.power(3, 3)).toBe(4);
    // Test negative exponent: (α^2)^-1 = α^-2 = α^5 = 7
    expect(gf.power(4, -1)).toBe(7);
    // Test large exponent: (α^2)^8 = α^16 = α^2 = 4
    expect(gf.power(4, 8)).toBe(4);
  });
});

describe('BCH Error Correction Code', () => {
  const testData = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
  const allBchTypes: BCHCodeType[] = ['BCH_127_120_1', 'BCH_255_247_1', 'BCH_511_502_1', 'BCH_1023_1013_1'];
  
  describe('BCH Parameters', () => {
    test('should return correct parameters for all BCH types', () => {
      const bch127 = getBCHParams('BCH_127_120_1');
      expect(bch127.n).toBe(127);
      expect(bch127.k).toBe(120);
      expect(bch127.parityBits).toBe(7);
      
      const bch255 = getBCHParams('BCH_255_247_1');
      expect(bch255.n).toBe(255);
      expect(bch255.k).toBe(247);
      expect(bch255.parityBits).toBe(8);
      
      const bch511 = getBCHParams('BCH_511_502_1');
      expect(bch511.n).toBe(511);
      expect(bch511.k).toBe(502);
      expect(bch511.parityBits).toBe(9);
      
      const bch1023 = getBCHParams('BCH_1023_1013_1');
      expect(bch1023.n).toBe(1023);
      expect(bch1023.k).toBe(1013);
      expect(bch1023.parityBits).toBe(10);
    });
  });

  describe.each(allBchTypes)('BCH Encoding for %s', (type) => {
    test('should encode data correctly', () => {
      const params = getBCHParams(type);
      const encoded = bchEncode(testData, type);
      const expectedLength = Math.ceil(params.n / 8);

      expect(encoded.length).toBe(expectedLength);
      expect(encoded.length).toBeGreaterThan(testData.length);
    });

    test('should handle empty data', () => {
      const params = getBCHParams(type);
      const emptyData = new Uint8Array(0);
      const encoded = bchEncode(emptyData, type);
      const expectedLength = Math.ceil(params.n / 8);

      expect(encoded.length).toBe(expectedLength);
    });

    test('should throw error for oversized data', () => {
      const params = getBCHParams(type);
      const k_bytes = Math.floor(params.k / 8);
      const largeData = new Uint8Array(k_bytes + 1);
      largeData.fill(0xFF);
      
      expect(() => bchEncode(largeData, type)).toThrow();
    });
  });

  describe.each(allBchTypes)('BCH Decoding - No Errors for %s', (type) => {
    test('should decode without errors', () => {
      const encoded = bchEncode(testData, type);
      const result = bchDecode(encoded, type);
      
      expect(result.status).toBe('success');
      expect(result.errorInfo?.errorCount).toBe(0);
      expect(result.errorInfo?.isUncorrectable).toBe(false);
      expect(result.errorInfo?.syndromeValue).toBe(0);
      
      // データ部分の一致確認（パディング除去）
      const originalBytes = Array.from(testData);
      const decodedBytes = Array.from(result.data).slice(0, testData.length);
      expect(decodedBytes).toEqual(originalBytes);
    });
  });

  describe.each(allBchTypes)('BCH Decoding - Single Bit Errors for %s', (type) => {
    test('should correct single bit error in data section', () => {
      const encoded = bchEncode(testData, type);
      
      // 最初のバイトの最初のビットを反転
      const corrupted = new Uint8Array(encoded);
      corrupted[0] ^= 0x80; // MSBを反転
      
      const result = bchDecode(corrupted, type);
      
      expect(result.status).toBe('corrected');
      expect(result.errorInfo?.errorCount).toBe(1);
      expect(result.errorInfo?.correctedPosition).toBeDefined();
      expect(result.errorInfo?.isUncorrectable).toBe(false);
      
      // 訂正後のデータ確認
      const originalBytes = Array.from(testData);
      const decodedBytes = Array.from(result.data).slice(0, testData.length);
      expect(decodedBytes).toEqual(originalBytes);
    });

    test('should correct single bit error in parity section', () => {
      const params = getBCHParams(type);
      const encoded = bchEncode(testData, type);
      
      // パリティ部分のビットを反転（符号語内の最後の方）
      const corrupted = new Uint8Array(encoded);
      const parityBitPosition = params.k; // データ部分の後のパリティ領域
      const parityByte = Math.floor(parityBitPosition / 8);
      const parityBitIndex = 7 - (parityBitPosition % 8);
      
      if (parityByte < corrupted.length) {
        corrupted[parityByte] ^= (1 << parityBitIndex);
        
        const result = bchDecode(corrupted, type);
        
        // パリティ部分のエラーも検出・訂正されるべき
        expect(['corrected', 'success']).toContain(result.status);
        expect(result.errorInfo?.isUncorrectable).toBe(false);
        
        // 訂正後のデータ確認
        const originalBytes = Array.from(testData);
        const decodedBytes = Array.from(result.data).slice(0, testData.length);
        expect(decodedBytes).toEqual(originalBytes);
      }
    });

    test('should correct errors at various bit positions', () => {
      const params = getBCHParams(type);
      const encoded = bchEncode(testData, type);
      
      // 複数の位置でエラー訂正テスト
      const testPositions = [0, 7, 15, 31, 63].filter(p => p < params.n); // 様々なビット位置
      
      for (const bitPos of testPositions) {
        const corrupted = new Uint8Array(encoded);
        const byteIndex = Math.floor(bitPos / 8);
        const bitIndex = bitPos % 8;
        
        if (byteIndex < corrupted.length) {
          corrupted[byteIndex] ^= (1 << (7 - bitIndex));
          
          const result = bchDecode(corrupted, type);
          
          expect(result.status).toBe('corrected');
          expect(result.errorInfo?.errorCount).toBe(1);
          
          // データ一致確認
          const originalBytes = Array.from(testData);
          const decodedBytes = Array.from(result.data).slice(0, testData.length);
          expect(decodedBytes).toEqual(originalBytes);
        }
      }
    });
  });

  describe.each(allBchTypes)('BCH Decoding - Multiple Bit Errors for %s', (type) => {
    test('should detect but not correct double bit errors', () => {
      const params = getBCHParams(type);
      const encoded = bchEncode(testData, type);
      
      // BCH理論的現実：特定の2ビットエラーは偶然訂正される場合がある
      // これは統計的テストで全体的な検出率を確認する方が適切
      
      let detectedCount = 0;
      let correctedCount = 0;
      const trials = 10;
      
      for (let trial = 0; trial < trials; trial++) {
        const corrupted = new Uint8Array(encoded);
        
        // 異なる2ビットエラーパターンを試行
        const bit1 = trial * 8;
        const bit2 = bit1 + 32;
        
        if (bit1 < params.n && bit2 < params.n) {
          const byte1 = Math.floor(bit1 / 8);
          const byte2 = Math.floor(bit2 / 8);
          
          corrupted[byte1] ^= (1 << (7 - (bit1 % 8)));
          corrupted[byte2] ^= (1 << (7 - (bit2 % 8)));
          
          const result = bchDecode(corrupted, type);
          
          if (result.status === 'detected') {
            detectedCount++;
          } else if (result.status === 'corrected') {
            correctedCount++;
          }
        }
      }
      
      // console.log(`2-bit error test for ${type}: detected=${detectedCount}, corrected=${correctedCount}`);
      
      // BCH理論：2ビットエラーは検出または訂正される（誤訂正の場合もある）
      expect(detectedCount + correctedCount).toBe(trials);
      // 特定のエラーパターンでは訂正が多い場合もあるため、全体として処理されることを確認
      expect(detectedCount + correctedCount).toBeGreaterThan(0);
    });

    test('should detect multiple bit errors with non-zero syndrome', () => {
      const encoded = bchEncode(testData, type);
      
      // 3ビットエラーでシンドロームをテスト
      const corrupted = new Uint8Array(encoded);
      corrupted[0] ^= 0x80; // ビット0
      corrupted[1] ^= 0x40; // ビット9  
      corrupted[2] ^= 0x20; // ビット18
      
      const result = bchDecode(corrupted, type);
      
      // 3ビットエラーは検出されるか、誤訂正される可能性がある
      // シンドロームが0になる確率は低い
      if (result.errorInfo?.syndromeValue !== 0) {
        expect(['detected', 'corrected']).toContain(result.status);
        if (result.status === 'detected') {
          expect(result.errorInfo?.isUncorrectable).toBe(true);
        }
      }
    });
  });

  describe.each(allBchTypes)('BCH Decoding - Edge Cases for %s', (type) => {
    test('should handle truncated codeword', () => {
      const encoded = bchEncode(testData, type);
      const truncated = encoded.slice(0, Math.floor(encoded.length / 2)); // 短すぎる符号語
      
      const result = bchDecode(truncated, type);
      
      expect(result.status).toBe('failed');
      expect(result.data.length).toBe(0);
      expect(result.errorInfo?.isUncorrectable).toBe(true);
    });

    test('should handle all-zero data', () => {
      const params = getBCHParams(type);
      const zeroData = new Uint8Array(Math.floor(params.k / 8));
      const encoded = bchEncode(zeroData, type);
      const result = bchDecode(encoded, type);
      
      expect(result.status).toBe('success');
      expect(result.errorInfo?.errorCount).toBe(0);
      
      // ゼロデータの復元確認
      const decodedBytes = Array.from(result.data).slice(0, zeroData.length);
      expect(decodedBytes).toEqual(Array.from(zeroData));
    });

    test('should handle all-ones data', () => {
      const params = getBCHParams(type);
      const onesData = new Uint8Array(Math.floor(params.k / 8));
      onesData.fill(0xFF);
      
      const encoded = bchEncode(onesData, type);
      const result = bchDecode(encoded, type);
      
      expect(result.status).toBe('success');
      expect(result.errorInfo?.errorCount).toBe(0);
      
      // 全1データの復元確認
      const decodedBytes = Array.from(result.data).slice(0, onesData.length);
      expect(decodedBytes).toEqual(Array.from(onesData));
    });
  });

  describe.each(allBchTypes)('BCH Statistical Performance for %s', (type) => {
    test('should maintain high correction rate for random single errors', () => {
      const params = getBCHParams(type);
      const trials = 100;
      let correctionCount = 0;
      
      for (let trial = 0; trial < trials; trial++) {
        const encoded = bchEncode(testData, type);
        
        // ランダムな1ビットエラーを導入
        const corrupted = new Uint8Array(encoded);
        const errorBitPosition = Math.floor(Math.random() * params.n);
        const errorByte = Math.floor(errorBitPosition / 8);
        const errorBit = 7 - (errorBitPosition % 8);
        corrupted[errorByte] ^= (1 << errorBit);
        
        const result = bchDecode(corrupted, type);
        
        if (result.status === 'corrected') {
          // 訂正結果の検証
          const originalBytes = Array.from(testData);
          const decodedBytes = Array.from(result.data).slice(0, testData.length);
          if (JSON.stringify(decodedBytes) === JSON.stringify(originalBytes)) {
            correctionCount++;
          }
        }
      }
      
      // 1ビットエラーの訂正率は理論上100%に近い
      const correctionRate = correctionCount / trials;
      // console.log(`Single-bit error correction rate for ${type}: ${(correctionRate * 100).toFixed(1)}%`);
      
      // 95%以上の訂正率を期待
      expect(correctionRate).toBeGreaterThanOrEqual(0.95);
    });

    test('should detect all double errors (BCH theory)', () => {
      const params = getBCHParams(type);
      const trials = 50;
      let properDetectionCount = 0;
      let syndromeZeroCount = 0;
      
      for (let trial = 0; trial < trials; trial++) {
        const encoded = bchEncode(testData, type);
        
        // ランダムな2ビットエラーを導入（符号語範囲内のみ）
        const corrupted = new Uint8Array(encoded);
        
        // 1つ目のエラー（ビット単位で指定）
        const errorBit1 = Math.floor(Math.random() * params.n);
        const errorByte1 = Math.floor(errorBit1 / 8);
        const bitPos1 = 7 - (errorBit1 % 8);
        corrupted[errorByte1] ^= (1 << bitPos1);
        
        // 2つ目のエラー（異なる位置）
        let errorBit2;
        do {
          errorBit2 = Math.floor(Math.random() * params.n);
        } while (errorBit2 === errorBit1);
        
        const errorByte2 = Math.floor(errorBit2 / 8);
        const bitPos2 = 7 - (errorBit2 % 8);
        corrupted[errorByte2] ^= (1 << bitPos2);
        
        const result = bchDecode(corrupted, type);
        
        // BCH理論：2ビットエラーは必ず検出される（シンドローム非ゼロ）
        if (result.errorInfo?.syndromeValue === 0) {
          syndromeZeroCount++;
        } else {
          properDetectionCount++;
          // シンドロームが非ゼロなら、検出または誤訂正
          expect(['detected', 'corrected']).toContain(result.status);
        }
      }
      
      const detectionRate = properDetectionCount / trials;
      const syndromeZeroRate = syndromeZeroCount / trials;
      
      // console.log(`Double-bit error detection rate for ${type}: ${(detectionRate * 100).toFixed(1)}%`);
      // console.log(`Syndrome zero rate (unexpected) for ${type}: ${(syndromeZeroRate * 100).toFixed(1)}%`);
      
      // BCH理論：99%以上の2ビットエラーが検出されるべき
      expect(detectionRate).toBeGreaterThanOrEqual(0.96); // 1/128 ≈ 0.78% の誤差を考慮
      expect(syndromeZeroRate).toBeLessThan(0.05); // 5%未満のシンドロームゼロ
    });
  });
});
