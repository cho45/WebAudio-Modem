/**
 * XModem packet implementation - Simple and focused
 * 
 * Handles XModem packet creation, serialization, and parsing.
 * No unnecessary abstractions, just what's needed for XModem.
 */

import { CRC16 } from '../../utils/crc16';
import { DataPacket, ControlType, PacketConstants } from './types';

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

    return { ...packet, checksum: CRC16.calculate(payload) };
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
   * Verify data packet CRC
   */
  static verify(packet: DataPacket): boolean {
    return CRC16.calculate(packet.payload) === packet.checksum;
  }

  static serializeControl(controlType: ControlType): Uint8Array {
    return new Uint8Array([controlType]);
  }
}
