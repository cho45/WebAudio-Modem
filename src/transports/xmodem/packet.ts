/**
 * XModem packet implementation - Simple and focused
 * 
 * Handles XModem packet creation, serialization, and parsing.
 * No unnecessary abstractions, just what's needed for XModem.
 */

import { CRC16 } from '../../utils/crc16';
import { DataPacket, ControlType, ControlParseResult, PacketConstants } from './types';

/**
 * XModem packet handler - Simple and focused
 * 
 * Handles XModem-style packet creation, serialization, and parsing.
 * Pure static methods for packet operations.
 */
export class XModemPacket {
  /**
   * Create a data packet
   */
  static createData(sequence: number, payload: Uint8Array): DataPacket {
    if (sequence < 1 || sequence > 255) {
      throw new Error(`Invalid sequence: ${sequence}. Must be 1-255.`);
    }
    if (payload.length > 255) {
      throw new Error(`Payload too large: ${payload.length}. Max 255 bytes.`);
    }

    const packet: DataPacket = {
      soh: PacketConstants.SOH,
      sequence,
      invSequence: (~sequence) & 0xFF,
      length: payload.length,
      payload: new Uint8Array(payload),
      checksum: 0
    };

    // Calculate CRC
    const crcData = new Uint8Array(4 + payload.length);
    crcData[0] = packet.soh;
    crcData[1] = packet.sequence;
    crcData[2] = packet.invSequence;
    crcData[3] = packet.length;
    crcData.set(payload, 4);
    
    return { ...packet, checksum: CRC16.calculate(crcData) };
  }

  /**
   * Check if a single byte is a control character
   */
  static parseControl(data: Uint8Array): ControlParseResult {
    if (data.length !== 1) {
      return { isControl: false };
    }

    const byte = data[0];
    if (Object.values(ControlType).includes(byte as ControlType)) {
      return { isControl: true, controlType: byte as ControlType };
    }

    return { isControl: false };
  }

  /**
   * Serialize data packet to bytes
   */
  static serialize(packet: DataPacket): Uint8Array {
    const result = new Uint8Array(4 + packet.payload.length + 2);
    result[0] = packet.soh;
    result[1] = packet.sequence;
    result[2] = packet.invSequence;
    result[3] = packet.length;
    result.set(packet.payload, 4);
    result[4 + packet.payload.length] = (packet.checksum >> 8) & 0xFF;
    result[4 + packet.payload.length + 1] = packet.checksum & 0xFF;
    return result;
  }

  /**
   * Serialize control character to single byte
   */
  static serializeControl(controlType: ControlType): Uint8Array {
    return new Uint8Array([controlType]);
  }

  /**
   * Parse data packet from bytes
   */
  static parse(data: Uint8Array): { packet?: DataPacket; error?: string } {
    if (data.length < 6) {
      return { error: `Too short: ${data.length} bytes` };
    }

    const soh = data[0];
    const sequence = data[1];
    const invSequence = data[2];
    const length = data[3];

    if (soh !== 0x01) {
      return { error: `Invalid SOH: 0x${soh.toString(16)}` };
    }

    if (invSequence !== ((~sequence) & 0xFF)) {
      return { error: `Bad sequence complement` };
    }

    if (sequence === 0) {
      return { error: `Invalid sequence 0 - reserved for control packets in old format` };
    }

    const expectedSize = 4 + length + 2;
    if (data.length < expectedSize) {
      return { error: `Incomplete: need ${expectedSize}, got ${data.length}` };
    }

    const payload = data.slice(4, 4 + length);
    const receivedCrc = (data[4 + length] << 8) | data[4 + length + 1];
    
    const packet: DataPacket = {
      soh, sequence, invSequence, length, payload, checksum: receivedCrc
    };

    if (!XModemPacket.verify(packet)) {
      return { error: 'CRC error' };
    }

    return { packet };
  }

  /**
   * Verify data packet CRC
   */
  static verify(packet: DataPacket): boolean {
    const crcData = new Uint8Array(4 + packet.payload.length);
    crcData[0] = packet.soh;
    crcData[1] = packet.sequence;
    crcData[2] = packet.invSequence;
    crcData[3] = packet.length;
    crcData.set(packet.payload, 4);
    return CRC16.calculate(crcData) === packet.checksum;
  }
}