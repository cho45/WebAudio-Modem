import { describe, test, expect, beforeEach } from 'vitest';
import { DsssDpskFramer, type FrameOptions } from '../../src/modems/dsss-dpsk/framer';

describe('DsssDpskFramer', () => {
  describe('build method', () => {
    test('should build a valid data frame with minimum options', () => {
      const userData = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0x12, 0x34, 0x56]); // 7 bytes for BCH_63_57_1
      const options: FrameOptions = {
        sequenceNumber: 0,
        frameType: 0,
        ldpcNType: 0, // n=128
      };

      const frame = DsssDpskFramer.build(userData, options);

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

      const frame = DsssDpskFramer.build(userData, options);

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
        const frame = DsssDpskFramer.build(userData, options);

        // Preamble(4) + SW(8) + HB(8) + Payload(256) = 276 bits
        expect(frame.bits.length).toBe(4 + 8 + 8 + 256);
        
        // Check payload bits separately - payload is encoded part of the frame
        const payloadBits = frame.bits.slice(4 + 8 + 8); // Skip preamble, sync word, and header
        expect(payloadBits.length).toBe(256); // payload is bit array
    });

    test('should throw an error if user data is too large for BCH encoding', () => {
        const options: FrameOptions = {
            sequenceNumber: 0,
            frameType: 0,
            ldpcNType: 0, // BCH(63,57,1) -> max 7 bytes
        };
        const largeUserData = new Uint8Array(8).fill(0xFF); // 8 bytes > 7 bytes max

        expect(() => DsssDpskFramer.build(largeUserData, options)).toThrow('exceeds max length');
    });
  });

  describe('new API methods', () => {
    // Helper to create soft bits from hard bits (perfect signal)
    // LLR convention: LLR >= 0 means bit 0, LLR < 0 means bit 1
    const createPerfectSoftBits = (hardBits: number[]): Int8Array => {
      return new Int8Array(hardBits.map(bit => bit === 0 ? 127 : -127));
    };

    // Helper to extract header byte from frame bits
    const extractHeaderByte = (frameBits: Uint8Array): number => {
      const headerBits = frameBits.slice(4 + 8, 4 + 8 + 8); // Skip preamble + sync word
      let headerByte = 0;
      for (let i = 0; i < 8; i++) {
        headerByte |= (headerBits[i] << (7 - i));
      }
      return headerByte;
    };

    test('should decode a perfect frame successfully with new API', () => {
      const userData = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]); // 7 bytes for BCH_63_57_1
      const options: FrameOptions = {
        sequenceNumber: 1,
        frameType: 0,
        ldpcNType: 0, // n=128
      };
      const encodedFrame = DsssDpskFramer.build(userData, options);
      const perfectSoftBits = createPerfectSoftBits(Array.from(encodedFrame.bits));

      // Extract header byte and payload bits
      const headerByte = extractHeaderByte(encodedFrame.bits);
      const payloadSoftBits = perfectSoftBits.slice(4 + 8 + 8); // Skip preamble + sync word + header

      // Test new API pattern
      const framer = new DsssDpskFramer();
      
      // Step 1: Initialize with header byte
      const initSuccess = framer.initialize(headerByte);
      expect(initSuccess).toBe(true);
      
      // Step 2: Add data bits
      framer.addDataBits(payloadSoftBits);
      
      // Step 3: Finalize and decode
      const decodedFrame = framer.finalize();
      
      expect(decodedFrame).not.toBeNull();
      expect(decodedFrame!.header.sequenceNumber).toBe(options.sequenceNumber);
      expect(decodedFrame!.header.frameType).toBe(options.frameType);
      expect(decodedFrame!.header.ldpcNType).toBe(options.ldpcNType);
      expect(decodedFrame!.userData).toEqual(userData);
      expect(decodedFrame!.status).toBe('success');
    });

    test('should handle initialization failure with corrupted header', () => {
      const framer = new DsssDpskFramer();
      // Create header with wrong parity: 0xFE = 11111110
      // This has 7 ones (odd), so parity bit should be 1, but it's 0
      const corruptedHeaderByte = 0xFE; // Invalid header with wrong parity
      
      const initSuccess = framer.initialize(corruptedHeaderByte);
      expect(initSuccess).toBe(false);
    });

    test('should throw error when calling methods in wrong state', () => {
      const framer = new DsssDpskFramer();
      
      // Should throw when calling addDataBits before initialize
      expect(() => framer.addDataBits(new Int8Array(10))).toThrow('can only be called in WAITING_DATA state');
      
      // Should throw when calling finalize before initialize
      expect(() => framer.finalize()).toThrow('can only be called in WAITING_DATA state');
      
      // After successful initialization, should throw when calling initialize again
      const validHeader = 0b00000000; // Valid header with correct parity
      framer.initialize(validHeader);
      expect(() => framer.initialize(validHeader)).toThrow('can only be called in WAITING_HEADER state');
    });

    test('should handle incremental data addition', () => {
      const userData = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
      const options: FrameOptions = { sequenceNumber: 0, frameType: 0, ldpcNType: 0 };
      const encodedFrame = DsssDpskFramer.build(userData, options);
      
      const headerByte = extractHeaderByte(encodedFrame.bits);
      const payloadSoftBits = createPerfectSoftBits(Array.from(encodedFrame.bits.slice(4 + 8 + 8)));
      
      const framer = new DsssDpskFramer();
      framer.initialize(headerByte);
      
      // Add data bits in chunks
      const chunkSize = 32;
      for (let i = 0; i < payloadSoftBits.length; i += chunkSize) {
        const chunk = payloadSoftBits.slice(i, i + chunkSize);
        framer.addDataBits(chunk);
        
        // Check remaining bits
        const remaining = framer.remainingBits;
        expect(remaining).toBe(Math.max(0, payloadSoftBits.length - i - chunk.length));
      }
      
      // Should be able to finalize after all data is added
      const decodedFrame = framer.finalize();
      expect(decodedFrame).not.toBeNull();
      expect(decodedFrame!.userData).toEqual(userData);
    });

    test('should handle incomplete data and throw error on finalize', () => {
      const userData = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
      const options: FrameOptions = { sequenceNumber: 0, frameType: 0, ldpcNType: 0 };
      const encodedFrame = DsssDpskFramer.build(userData, options);
      
      const headerByte = extractHeaderByte(encodedFrame.bits);
      const payloadSoftBits = createPerfectSoftBits(Array.from(encodedFrame.bits.slice(4 + 8 + 8)));
      
      const framer = new DsssDpskFramer();
      framer.initialize(headerByte);
      
      // Add only partial data
      const partialData = payloadSoftBits.slice(0, 64); // Only half the data
      framer.addDataBits(partialData);
      
      // Should throw error when trying to finalize incomplete data
      expect(() => framer.finalize()).toThrow('Incomplete data');
      
      // Should still report remaining bits correctly
      expect(framer.remainingBits).toBe(payloadSoftBits.length - 64);
    });

    test('should handle different LDPC N types', () => {
      const testCases = [
        { ldpcNType: 0, userData: new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]) }, // 7 bytes max
        { ldpcNType: 1, userData: new Uint8Array(15).fill(0xAA) }, // 15 bytes max
      ];
      
      testCases.forEach(({ ldpcNType, userData }) => {
        const options: FrameOptions = { sequenceNumber: 2, frameType: 1, ldpcNType };
        const encodedFrame = DsssDpskFramer.build(userData, options);
        
        const headerByte = extractHeaderByte(encodedFrame.bits);
        const payloadSoftBits = createPerfectSoftBits(Array.from(encodedFrame.bits.slice(4 + 8 + 8)));
        
        const framer = new DsssDpskFramer();
        framer.initialize(headerByte);
        framer.addDataBits(payloadSoftBits);
        
        const decodedFrame = framer.finalize();
        
        expect(decodedFrame).not.toBeNull();
        expect(decodedFrame!.header.ldpcNType).toBe(ldpcNType);
        expect(decodedFrame!.userData).toEqual(userData);
      });
    });

    test('should report correct state and status', () => {
      const framer = new DsssDpskFramer();
      
      // Initial state
      let status = framer.getState();
      expect(status.state).toBe('WAITING_HEADER');
      expect(status.isHealthy).toBe(true);
      expect(status.remainingBits).toBe(0);
      
      // After initialization
      const validHeader = 0b00000000; // Valid header with correct parity
      framer.initialize(validHeader);
      
      status = framer.getState();
      expect(status.state).toBe('WAITING_DATA');
      expect(status.isHealthy).toBe(true);
      expect(status.remainingBits).toBe(128); // For ldpcNType 0
      
      // After adding some data
      const someData = new Int8Array(64).fill(127);
      framer.addDataBits(someData);
      
      status = framer.getState();
      expect(status.state).toBe('WAITING_DATA');
      expect(status.remainingBits).toBe(64);
      
      // After adding all data and finalizing
      const remainingData = new Int8Array(64).fill(127);
      framer.addDataBits(remainingData);
      framer.finalize();
      
      status = framer.getState();
      expect(status.state).toBe('COMPLETED');
      expect(status.isHealthy).toBe(false); // Completed means not healthy for further operations
    });

    test('should handle data length property correctly', () => {
      const framer = new DsssDpskFramer();
      
      // Should throw before initialization
      expect(() => framer.dataLength).toThrow('can only be accessed after successful initialize');
      
      // After successful initialization should return correct length
      const validHeader = 0b00000000; // ldpcNType = 0, which means 128 bits
      framer.initialize(validHeader);
      expect(framer.dataLength).toBe(128);
      
      // Test with different ldpcNType
      const framer2 = new DsssDpskFramer();
      const headerWithType1 = 0b00000011; // ldpcNType = 1, seqNum = 0, frameType = 0, parity = 1 (odd parity)
      const initSuccess = framer2.initialize(headerWithType1);
      expect(initSuccess).toBe(true);
      expect(framer2.dataLength).toBe(256);
    });

    test('should handle LDPC/BCH decoding errors', () => {
      // Test with heavily corrupted payload that would cause LDPC decode failure
      const userData = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
      const options: FrameOptions = { sequenceNumber: 0, frameType: 0, ldpcNType: 0 };
      const encodedFrame = DsssDpskFramer.build(userData, options);
      
      const headerByte = extractHeaderByte(encodedFrame.bits);
      const payloadSoftBits = createPerfectSoftBits(Array.from(encodedFrame.bits.slice(4 + 8 + 8)));
      
      // Heavily corrupt the payload - flip many bits
      for (let i = 0; i < payloadSoftBits.length; i += 4) {
        payloadSoftBits[i] = -payloadSoftBits[i]; // Flip every 4th bit
      }
      
      const framer = new DsssDpskFramer();
      framer.initialize(headerByte);
      framer.addDataBits(payloadSoftBits);
      
      // Should throw error due to decoding failure
      expect(() => framer.finalize()).toThrow();
    });

    test('should handle invalid ldpcNType during initialization', () => {
      const framer = new DsssDpskFramer();
      
      // Create header with invalid ldpcNType (should be 0-3, but higher values are invalid)
      // This would require manually crafting a header byte, but since we validate in build(),
      // let's test the edge case where ldpcNType is out of bounds
      const invalidHeader = 0b00001110; // ldpcNType = 3, frameType = 3, seqNum = 0, parity = 0
      
      // This should fail during initialization
      const initSuccess = framer.initialize(invalidHeader);
      expect(initSuccess).toBe(false);
    });
  });
});
