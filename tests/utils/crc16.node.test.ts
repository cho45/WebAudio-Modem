/**
 * CRC16 unit tests using known test vectors
 * Tests the CRC-16-CCITT implementation against standard test vectors
 */

import { describe, test, expect } from 'vitest';
import { CRC16 } from '../../src/utils/crc16';

describe('CRC16 - CRC-16-CCITT Implementation', () => {
  
  describe('Standard Test Vectors', () => {
    test('Empty data should return initial value', () => {
      const data = new Uint8Array([]);
      const result = CRC16.calculate(data);
      expect(result).toBe(0xFFFF);
    });

    test('Single byte "A" (0x41)', () => {
      const data = new Uint8Array([0x41]); // "A"
      const result = CRC16.calculate(data);
      expect(result).toBe(0xB915);
    });

    test('ASCII string "123456789"', () => {
      const data = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
      const result = CRC16.calculate(data);
      expect(result).toBe(0x29B1);
    });

  });

  describe('Edge Cases', () => {
    test('Single zero byte', () => {
      const data = new Uint8Array([0x00]);
      const result = CRC16.calculate(data);
      expect(result).toBe(0xE1F0);
    });

    test('Single 0xFF byte', () => {
      const data = new Uint8Array([0xFF]);
      const result = CRC16.calculate(data);
      expect(result).toBe(0xFF00);
    });

    test('Two identical bytes', () => {
      const data = new Uint8Array([0xAA, 0xAA]);
      const result = CRC16.calculate(data);
      expect(result).toBe(0xFB1A);
    });

    test('Maximum length realistic packet (256 bytes)', () => {
      // Create test data pattern
      const data = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        data[i] = i & 0xFF;
      }
      
      const result = CRC16.calculate(data);
      // This is a deterministic result for the pattern 0x00-0xFF
      expect(result).toBe(0x3FBD);
    });
  });

  describe('Data Integrity Verification', () => {
    test('verify() should return true for correct CRC', () => {
      const data = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
      const expectedCrc = 0x29B1;
      
      expect(CRC16.verify(data, expectedCrc)).toBe(true);
    });

    test('verify() should return false for incorrect CRC', () => {
      const data = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
      const incorrectCrc = 0x1234;
      
      expect(CRC16.verify(data, incorrectCrc)).toBe(false);
    });

    test('Single bit error detection', () => {
      const originalData = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35]);
      const corruptedData = new Uint8Array([0x30, 0x32, 0x33, 0x34, 0x35]); // First byte changed
      
      const originalCrc = CRC16.calculate(originalData);
      const corruptedCrc = CRC16.calculate(corruptedData);
      
      expect(originalCrc).not.toBe(corruptedCrc);
    });
  });

  describe('Performance and Consistency', () => {
    test('Consistent results for multiple calls', () => {
      const data = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
      
      const result1 = CRC16.calculate(data);
      const result2 = CRC16.calculate(data);
      const result3 = CRC16.calculate(data);
      
      expect(result1).toBe(result2);
      expect(result2).toBe(result3);
    });

    test('Performance with large data (1KB)', () => {
      const data = new Uint8Array(1024);
      for (let i = 0; i < 1024; i++) {
        data[i] = Math.floor(Math.random() * 256);
      }
      
      const startTime = performance.now();
      const result = CRC16.calculate(data);
      const endTime = performance.now();
      
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(0xFFFF);
      
      // Should complete within reasonable time (< 10ms for 1KB)
      expect(endTime - startTime).toBeLessThan(10);
    });
  });

  describe('Polynomial Verification', () => {
    test('Known polynomial behavior', () => {
      // These test vectors verify we\'re using the correct polynomial (0x1021)
      const testCases = [
        { input: [0x00, 0x00], expected: 0x1D0F },
        { input: [0x01, 0x02], expected: 0x0E7C },
        { input: [0xAB, 0xCD], expected: 0xD46A }
      ];

      testCases.forEach(({ input, expected }) => {
        const data = new Uint8Array(input);
        const result = CRC16.calculate(data);
        expect(result).toBe(expected);
      });
    });
  });
});