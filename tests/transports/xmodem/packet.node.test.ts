/**
 * XModem packet tests - Simple and focused
 */

import { describe, test, expect } from 'vitest';
import { XModemPacket } from '../../../src/transports/xmodem/packet';
import { ControlType } from '../../../src/transports/xmodem/types';

describe('XModem Packet', () => {
  
  describe('Data Packet Creation', () => {
    test('Create valid data packet', () => {
      const payload = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
      const packet = XModemPacket.createData(1, payload);

      expect(packet.soh).toBe(0x01);
      expect(packet.sequence).toBe(1);
      expect(packet.invSequence).toBe(0xFE); // ~1
      expect(packet.length).toBe(5);
      expect(packet.payload).toEqual(payload);
      expect(packet.checksum).toBeGreaterThan(0);
    });

    test('Create packet with empty payload', () => {
      const payload = new Uint8Array([]);
      const packet = XModemPacket.createData(42, payload);

      expect(packet.sequence).toBe(42);
      expect(packet.invSequence).toBe(0xD5); // ~42
      expect(packet.length).toBe(0);
      expect(packet.payload).toEqual(payload);
    });

    test('Create packet with maximum payload', () => {
      const payload = new Uint8Array(255).fill(0xAA);
      const packet = XModemPacket.createData(255, payload);

      expect(packet.sequence).toBe(255);
      expect(packet.invSequence).toBe(0x00); // ~255
      expect(packet.length).toBe(255);
      expect(packet.payload).toEqual(payload);
    });

    test('Reject invalid sequence numbers', () => {
      const payload = new Uint8Array([0x01]);
      
      expect(() => XModemPacket.createData(0, payload)).toThrow('Invalid sequence');
      expect(() => XModemPacket.createData(256, payload)).toThrow('Invalid sequence');
      expect(() => XModemPacket.createData(-1, payload)).toThrow('Invalid sequence');
    });

    test('Reject oversized payload', () => {
      const payload = new Uint8Array(256); // Too large
      
      expect(() => XModemPacket.createData(1, payload)).toThrow('Payload too large');
    });

    test('Payload isolation (no mutation)', () => {
      const originalPayload = new Uint8Array([0x01, 0x02, 0x03]);
      const packet = XModemPacket.createData(1, originalPayload);
      
      // Modify original
      originalPayload[0] = 0xFF;
      
      // Packet should be unchanged
      expect(packet.payload[0]).toBe(0x01);
    });
  });

  describe('Control Character Handling', () => {
    test('Serialize control characters as single bytes', () => {
      const ackBytes = XModemPacket.serializeControl(ControlType.ACK);
      expect(ackBytes.length).toBe(1);
      expect(ackBytes[0]).toBe(ControlType.ACK);

      const nakBytes = XModemPacket.serializeControl(ControlType.NAK);
      expect(nakBytes.length).toBe(1);
      expect(nakBytes[0]).toBe(ControlType.NAK);

      const eotBytes = XModemPacket.serializeControl(ControlType.EOT);
      expect(eotBytes.length).toBe(1);
      expect(eotBytes[0]).toBe(ControlType.EOT);
    });

    test('Parse control characters from single bytes', () => {
      const ackResult = XModemPacket.parseControl(new Uint8Array([ControlType.ACK]));
      expect(ackResult.isControl).toBe(true);
      expect(ackResult.controlType).toBe(ControlType.ACK);

      const nakResult = XModemPacket.parseControl(new Uint8Array([ControlType.NAK]));
      expect(nakResult.isControl).toBe(true);
      expect(nakResult.controlType).toBe(ControlType.NAK);

      const eotResult = XModemPacket.parseControl(new Uint8Array([ControlType.EOT]));
      expect(eotResult.isControl).toBe(true);
      expect(eotResult.controlType).toBe(ControlType.EOT);
    });

    test('Reject invalid control bytes', () => {
      const invalidResult = XModemPacket.parseControl(new Uint8Array([0xFF]));
      expect(invalidResult.isControl).toBe(false);
      expect(invalidResult.controlType).toBeUndefined();

      const multiByteResult = XModemPacket.parseControl(new Uint8Array([ControlType.ACK, 0x00]));
      expect(multiByteResult.isControl).toBe(false);
    });
  });

  describe('Packet Serialization', () => {
    test('Serialize data packet correctly', () => {
      const payload = new Uint8Array([0x41, 0x42]); // "AB"
      const packet = XModemPacket.createData(5, payload);
      const serialized = XModemPacket.serialize(packet);

      expect(serialized[0]).toBe(0x01); // SOH
      expect(serialized[1]).toBe(5);    // SEQ
      expect(serialized[2]).toBe(0xFA); // ~SEQ
      expect(serialized[3]).toBe(2);    // LEN
      expect(serialized[4]).toBe(0x41); // Payload[0]
      expect(serialized[5]).toBe(0x42); // Payload[1]
      expect(serialized[6]).toBe((packet.checksum >> 8) & 0xFF); // CRC high
      expect(serialized[7]).toBe(packet.checksum & 0xFF);        // CRC low
      
      expect(serialized.length).toBe(8); // 4 + 2 + 2
    });

    // Control characters are now serialized as single bytes, not packets

    test('Serialize empty payload packet', () => {
      const packet = XModemPacket.createData(1, new Uint8Array([]));
      const serialized = XModemPacket.serialize(packet);

      expect(serialized.length).toBe(6); // 4 + 0 + 2
      expect(serialized[3]).toBe(0); // LEN = 0
    });
  });

  describe('Packet Parsing', () => {
    test('Parse valid data packet', () => {
      // Create and serialize a packet
      const originalPayload = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]);
      const originalPacket = XModemPacket.createData(10, originalPayload);
      const serialized = XModemPacket.serialize(originalPacket);

      // Parse it back
      const result = XModemPacket.parse(serialized);

      expect(result.error).toBeUndefined();
      expect(result.packet).toBeDefined();
      
      const parsedPacket = result.packet!;
      expect(parsedPacket.sequence).toBe(10);
      expect(parsedPacket.length).toBe(5);
      expect((parsedPacket as any).payload).toEqual(originalPayload);
    });

    // Control characters are now handled separately, not as packets

    test('Detect packet too short', () => {
      const tooShort = new Uint8Array([0x01, 0x05]); // Only 2 bytes
      const result = XModemPacket.parse(tooShort);

      expect(result.packet).toBeUndefined();
      expect(result.error).toContain('Too short');
    });

    test('Detect invalid SOH', () => {
      const invalidSOH = new Uint8Array([0x02, 0x01, 0xFE, 0x00, 0x12, 0x34]);
      const result = XModemPacket.parse(invalidSOH);

      expect(result.packet).toBeUndefined();
      expect(result.error).toContain('Invalid SOH');
    });

    test('Detect sequence complement error', () => {
      const badComplement = new Uint8Array([0x01, 0x05, 0x05, 0x00, 0x12, 0x34]); // ~5 should be 0xFA, not 0x05
      const result = XModemPacket.parse(badComplement);

      expect(result.packet).toBeUndefined();
      expect(result.error).toContain('sequence complement');
    });

    test('Detect incomplete packet', () => {
      const incomplete = new Uint8Array([0x01, 0x01, 0xFE, 0x05, 0x41, 0x42]); // Says 5-byte payload but only has 2 bytes + no CRC
      const result = XModemPacket.parse(incomplete);

      expect(result.packet).toBeUndefined();
      expect(result.error).toContain('Incomplete');
    });

    test('Detect CRC mismatch', () => {
      // Create valid packet and corrupt CRC
      const packet = XModemPacket.createData(1, new Uint8Array([0x41]));
      const serialized = XModemPacket.serialize(packet);
      serialized[serialized.length - 1] ^= 0x01; // Flip last bit of CRC

      const result = XModemPacket.parse(serialized);

      expect(result.packet).toBeUndefined();
      expect(result.error).toContain('CRC error');
    });

    test('Detect sequence 0 (reserved for old control packets)', () => {
      // Sequence 0 is now invalid since control characters are sent as single bytes
      const seq0packet = new Uint8Array([0x01, 0x00, 0xFF, 0x01, 0xFF, 0x00, 0x00]);
      const result = XModemPacket.parse(seq0packet);

      expect(result.packet).toBeUndefined();
      expect(result.error).toContain('Invalid sequence 0');
    });
  });

  describe('Packet Verification', () => {
    test('Verify valid data packet', () => {
      const packet = XModemPacket.createData(5, new Uint8Array([0x01, 0x02]));
      expect(XModemPacket.verify(packet)).toBe(true);
    });

    // Control characters don't use CRC verification - they are single bytes

    test('Reject packet with wrong CRC', () => {
      const packet = XModemPacket.createData(1, new Uint8Array([0x01]));
      const corruptedPacket = { ...packet, checksum: 0x1234 }; // Wrong CRC
      expect(XModemPacket.verify(corruptedPacket)).toBe(false);
    });
  });

  describe('Round-trip Consistency', () => {
    test('Data packet round-trip', () => {
      const testCases = [
        { seq: 1, data: new Uint8Array([]) },
        { seq: 42, data: new Uint8Array([0x00, 0xFF, 0xAA, 0x55]) },
        { seq: 255, data: new Uint8Array(255).fill(0x42) }
      ];

      testCases.forEach(({ seq, data }) => {
        const packet = XModemPacket.createData(seq, data);
        const serialized = XModemPacket.serialize(packet);
        const result = XModemPacket.parse(serialized);

        expect(result.error).toBeUndefined();
        const parsed = result.packet!;
        expect(parsed.sequence).toBe(seq);
        expect((parsed as any).payload).toEqual(data);
      });
    });

    test('Control character round-trip', () => {
      const controlTypes = [ControlType.ACK, ControlType.NAK, ControlType.EOT, ControlType.ENQ, ControlType.CAN];

      controlTypes.forEach(controlType => {
        const serialized = XModemPacket.serializeControl(controlType);
        const result = XModemPacket.parseControl(serialized);

        expect(result.isControl).toBe(true);
        expect(result.controlType).toBe(controlType);
      });
    });
  });

  describe('Performance and Edge Cases', () => {
    test('Large packet handling', () => {
      const largePayload = new Uint8Array(255);
      for (let i = 0; i < 255; i++) {
        largePayload[i] = i & 0xFF;
      }

      const packet = XModemPacket.createData(100, largePayload);
      const serialized = XModemPacket.serialize(packet);
      const result = XModemPacket.parse(serialized);

      expect(result.error).toBeUndefined();
      expect((result.packet! as any).payload).toEqual(largePayload);
    });

    test('All sequence numbers', () => {
      // Test all valid sequence numbers
      for (let seq = 1; seq <= 255; seq++) {
        const packet = XModemPacket.createData(seq, new Uint8Array([seq & 0xFF]));
        expect(packet.sequence).toBe(seq);
        expect(packet.invSequence).toBe((~seq) & 0xFF);
      }
    });

    test('CRC uniqueness', () => {
      // Different payloads should produce different CRCs
      const packet1 = XModemPacket.createData(1, new Uint8Array([0x01]));
      const packet2 = XModemPacket.createData(1, new Uint8Array([0x02]));
      const packet3 = XModemPacket.createData(2, new Uint8Array([0x01]));

      expect(packet1.checksum).not.toBe(packet2.checksum);
      expect(packet1.checksum).not.toBe(packet3.checksum);
      expect(packet2.checksum).not.toBe(packet3.checksum);
    });
  });
});