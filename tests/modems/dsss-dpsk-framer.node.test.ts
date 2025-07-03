import { describe, test, expect } from 'vitest';
import { DsssDpskFramer, type FrameOptions } from '../../src/modems/dsss-dpsk-framer';

describe('DsssDpskFramer', () => {
  describe('build method', () => {
    const framer = new DsssDpskFramer();

    test('should build a valid data frame with minimum options', () => {
      const userData = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0x12, 0x34, 0x56]); // 7 bytes for BCH_63_57_1
      const options: FrameOptions = {
        sequenceNumber: 0,
        frameType: 0,
        ldpcNType: 0, // n=128
      };

      const frame = framer.build(userData, options);

      // 1. Check header byte generation
      // S=0, T=0, N=0 -> 000 00 00 -> Parity = 0
      expect(frame.headerByte).toBe(0b00000000);

      // 2. Check total bit length
      // Preamble(4) + SW(8) + HB(8) + Payload(128) = 148 bits
      expect(frame.bits.length).toBe(4 + 8 + 8 + 128);

      // 3. Check preamble and sync word
      expect(frame.bits.slice(0, 4)).toEqual(new Uint8Array([0, 0, 0, 0]));
      expect(frame.bits.slice(4, 12)).toEqual(new Uint8Array([1, 0, 1, 1, 0, 1, 0, 0]));
    });

    test('should calculate header parity correctly', () => {
      const userData = new Uint8Array(1);
      const options: FrameOptions = {
        sequenceNumber: 3, // 011
        frameType: 1,      // 01
        ldpcNType: 2,      // 10
      };

      const frame = framer.build(userData, options);

      // S=011, T=01, N=10 -> 011 01 10 -> 4つの1があるので偶数パリティ
      // Header: 01101100
      expect(frame.headerByte).toBe(0b01101100);
    });

    test('should handle different ldpcNTypes and payload sizes', () => {
        const options: FrameOptions = {
            sequenceNumber: 1,
            frameType: 0,
            ldpcNType: 1, // n=256
        };
        const userData = new Uint8Array(15).fill(0xFF); // Max data for BCH(127,120,1) is 15 bytes
        const frame = framer.build(userData, options);

        // Preamble(4) + SW(8) + HB(8) + Payload(256) = 276 bits
        expect(frame.bits.length).toBe(4 + 8 + 8 + 256);
        expect(frame.payload.length).toBe(256); // payload は bit array として返される
    });

    test('should throw an error if user data is too large for BCH encoding', () => {
        const options: FrameOptions = {
            sequenceNumber: 0,
            frameType: 0,
            ldpcNType: 0, // BCH(63,57,1) -> max 7 bytes
        };
        const largeUserData = new Uint8Array(8).fill(0xFF); // 8 bytes > 7 bytes max

        expect(() => framer.build(largeUserData, options)).toThrow('exceeds max length');
    });
  });

  describe('process method', () => {
    let framer: DsssDpskFramer;

    beforeEach(() => {
      framer = new DsssDpskFramer();
    });

    // Helper to create soft bits from hard bits (perfect signal)
    // LLR convention: LLR >= 0 means bit 0, LLR < 0 means bit 1
    const createPerfectSoftBits = (hardBits: number[]): Int8Array => {
      return new Int8Array(hardBits.map(bit => bit === 0 ? 127 : -127));
    };

    test('should decode a perfect frame successfully', () => {
      const userData = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]); // 7 bytes for BCH_63_57_1
      const options: FrameOptions = {
        sequenceNumber: 1,
        frameType: 0,
        ldpcNType: 0, // n=128
      };
      const encodedFrame = framer.build(userData, options);
      const perfectSoftBits = createPerfectSoftBits(Array.from(encodedFrame.bits));

      const decodedFrames = framer.process(perfectSoftBits);

      expect(decodedFrames.length).toBe(1);
      expect(decodedFrames[0].header.sequenceNumber).toBe(options.sequenceNumber);
      expect(decodedFrames[0].header.frameType).toBe(options.frameType);
      expect(decodedFrames[0].header.ldpcNType).toBe(options.ldpcNType);
      expect(decodedFrames[0].userData).toEqual(userData);
      expect(decodedFrames[0].status).toBe('success');
    });

    test('should not decode if not enough bits for preamble', () => {
      const partialPreamble = createPerfectSoftBits([0, 0, 0]); // 3 bits
      const decodedFrames = framer.process(partialPreamble);
      expect(decodedFrames.length).toBe(0);
    });

    test('should not decode if preamble is corrupted', () => {
      const corruptedPreamble = createPerfectSoftBits([0, 0, 1, 0]); // Corrupted
      const decodedFrames = framer.process(corruptedPreamble);
      expect(decodedFrames.length).toBe(0);
    });

    test('should not decode if sync word is corrupted', () => {
      const userData = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
      const options: FrameOptions = { sequenceNumber: 0, frameType: 0, ldpcNType: 0 };
      const encodedFrame = framer.build(userData, options);
      
      const corruptedBits = Array.from(encodedFrame.bits);
      corruptedBits[4] = 0; // Corrupt first bit of sync word
      const perfectSoftBits = createPerfectSoftBits(corruptedBits);

      const decodedFrames = framer.process(perfectSoftBits);
      expect(decodedFrames.length).toBe(0);
    });

    test('should not decode if header parity is incorrect', () => {
      const userData = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
      const options: FrameOptions = { sequenceNumber: 0, frameType: 0, ldpcNType: 0 };
      const encodedFrame = framer.build(userData, options);
      
      const corruptedBits = Array.from(encodedFrame.bits);
      // Corrupt header byte (bit 0, parity bit) to make parity incorrect
      corruptedBits[19] = corruptedBits[19] === 0 ? 1 : 0; 
      const perfectSoftBits = createPerfectSoftBits(corruptedBits);

      const decodedFrames = framer.process(perfectSoftBits);
      expect(decodedFrames.length).toBe(0);
    });

    test('should decode a frame split across multiple process calls', () => {
      const userData = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x11]);
      const options: FrameOptions = { sequenceNumber: 2, frameType: 1, ldpcNType: 0 };
      const encodedFrame = framer.build(userData, options);
      const perfectSoftBits = createPerfectSoftBits(Array.from(encodedFrame.bits));

      // Split the frame into two chunks
      const chunk1 = perfectSoftBits.slice(0, 20); // Preamble + SW + part of Header
      const chunk2 = perfectSoftBits.slice(20);   // Rest of Header + Payload

      let decodedFrames = framer.process(chunk1);
      expect(decodedFrames.length).toBe(0); // Should not decode yet

      decodedFrames = framer.process(chunk2);
      expect(decodedFrames.length).toBe(1);
      expect(decodedFrames[0].userData).toEqual(userData);
    });

    test('should decode multiple consecutive frames', () => {
      const userData1 = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
      const options1: FrameOptions = { sequenceNumber: 0, frameType: 0, ldpcNType: 0 };
      const encodedFrame1 = framer.build(userData1, options1);

      const userData2 = new Uint8Array([0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE]);
      const options2: FrameOptions = { sequenceNumber: 1, frameType: 0, ldpcNType: 0 };
      const encodedFrame2 = framer.build(userData2, options2);

      const combinedSoftBits = createPerfectSoftBits(
        Array.from(encodedFrame1.bits).concat(Array.from(encodedFrame2.bits))
      );

      const decodedFrames = framer.process(combinedSoftBits);

      expect(decodedFrames.length).toBe(2);
      expect(decodedFrames[0].userData).toEqual(userData1);
      expect(decodedFrames[1].userData).toEqual(userData2);
    });

    test('should handle noise in preamble and sync word (threshold test)', () => {
      const userData = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
      const options: FrameOptions = { sequenceNumber: 0, frameType: 0, ldpcNType: 0 };
      const encodedFrame = framer.build(userData, options);
      
      // Introduce some noise (flip LLR signs for some bits)
      const noisySoftBits = createPerfectSoftBits(Array.from(encodedFrame.bits));
      // Corrupt 1 bit in preamble (e.g., 0 -> 1)
      noisySoftBits[0] = 127; // Preamble bit 0 should be -127
      // Corrupt 1 bit in sync word (e.g., 1 -> 0)
      noisySoftBits[4] = -127; // Sync word bit 0 should be 127

      const decodedFrames = framer.process(noisySoftBits);
      // Depending on thresholds, this might still decode or fail.
      // For now, expect failure as thresholds are tight.
      expect(decodedFrames.length).toBe(0);
    });

    test('should return empty array if no frames are decoded', () => {
      const randomSoftBits = new Int8Array(100).fill(0);
      const decodedFrames = framer.process(randomSoftBits);
      expect(decodedFrames.length).toBe(0);
    });
  });
});