import { describe, test, expect } from 'vitest';
import { 
  mseq15Step, 
  mseq31Step, 
  mseq63Step, 
  mseq127Step, 
  mseq255Step,
  mseqOutput,
  calculateAutocorrelation 
} from '../../src/utils/msequence';

describe('M-sequence LFSR Functions', () => {
  const testMSequence = (
    stepFn: (reg: number) => number, 
    expectedPeriod: number, 
    bits: number,
    initialReg: number,
    name: string
  ) => {
    test(`${name} should have correct period`, () => {
      let register = initialReg;
      const startReg = register;
      let period = 0;
      
      do {
        register = stepFn(register);
        period++;
      } while (register !== startReg && period <= expectedPeriod + 10);
      
      expect(period).toBe(expectedPeriod);
    });

    test(`${name} should generate sequence with ideal autocorrelation`, () => {
      let register = initialReg;
      const sequence: number[] = [];
      
      // Generate complete sequence
      for (let i = 0; i < expectedPeriod; i++) {
        sequence.push(mseqOutput(register, bits));
        register = stepFn(register);
      }
      
      // Check autocorrelation
      expect(calculateAutocorrelation(sequence, 0)).toBe(expectedPeriod);
      
      // Test few sidelobes (testing all would be slow for 255)
      const testLags = Math.min(5, expectedPeriod - 1);
      for (let lag = 1; lag <= testLags; lag++) {
        expect(calculateAutocorrelation(sequence, lag)).toBe(-1);
      }
    });

    test(`${name} should have balance property`, () => {
      let register = initialReg;
      let ones = 0;
      
      for (let i = 0; i < expectedPeriod; i++) {
        if (mseqOutput(register, bits) === 1) ones++;
        register = stepFn(register);
      }
      
      const zeros = expectedPeriod - ones;
      expect(Math.abs(ones - zeros)).toBe(1);
    });
  };

  testMSequence(mseq15Step, 15, 4, 0b1000, 'M15 (x⁴+x³+1)');
  testMSequence(mseq31Step, 31, 5, 0b10000, 'M31 (x⁵+x³+1)');
  testMSequence(mseq63Step, 63, 6, 0b100000, 'M63 (x⁶+x⁵+1)');
  testMSequence(mseq127Step, 127, 7, 0b1000000, 'M127 (x⁷+x⁶+1)');
  testMSequence(mseq255Step, 255, 8, 0b10000000, 'M255 (x⁸+x⁶+x⁵+x⁴+1)');

  test('mseqOutput should extract correct bit', () => {
    expect(mseqOutput(0b1000, 4)).toBe(1);
    expect(mseqOutput(0b0100, 4)).toBe(0);
    expect(mseqOutput(0b10000, 5)).toBe(1);
    expect(mseqOutput(0b01000, 5)).toBe(0);
  });
});