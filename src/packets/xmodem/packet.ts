/**
 * XModem packet implementation - Simple and focused
 * 
 * Handles XModem packet creation, serialization, and parsing.
 * No unnecessary abstractions, just what's needed for XModem.
 */

import { CRC16 } from '../../utils/crc16';
import { DataPacket, ControlPacket, ControlType, PacketConstants } from './types';

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
   * Create a control packet
   */
  static createControl(controlType: ControlType): ControlPacket {
    const packet: ControlPacket = {
      soh: PacketConstants.SOH,
      sequence: 0,
      invSequence: 0xFF,
      length: 1,
      control: controlType,
      payload: new Uint8Array([controlType]),
      checksum: 0
    };

    // Calculate CRC
    const crcData = new Uint8Array([
      packet.soh,
      packet.sequence,
      packet.invSequence,
      packet.length,
      packet.control
    ]);
    
    return { ...packet, checksum: CRC16.calculate(crcData) };
  }

  /**
   * Serialize packet to bytes
   */
  static serialize(packet: DataPacket | ControlPacket): Uint8Array {
    if (packet.sequence === 0) {
      // Control packet
      const cp = packet as ControlPacket;
      return new Uint8Array([
        cp.soh,
        cp.sequence,
        cp.invSequence,
        cp.length,
        cp.control,
        (cp.checksum >> 8) & 0xFF,
        cp.checksum & 0xFF
      ]);
    } else {
      // Data packet
      const dp = packet as DataPacket;
      const result = new Uint8Array(4 + dp.payload.length + 2);
      result[0] = dp.soh;
      result[1] = dp.sequence;
      result[2] = dp.invSequence;
      result[3] = dp.length;
      result.set(dp.payload, 4);
      result[4 + dp.payload.length] = (dp.checksum >> 8) & 0xFF;
      result[4 + dp.payload.length + 1] = dp.checksum & 0xFF;
      return result;
    }
  }

  /**
   * Parse packet from bytes
   */
  static parse(data: Uint8Array): { packet?: DataPacket | ControlPacket; error?: string } {
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

    const expectedSize = 4 + length + 2;
    if (data.length < expectedSize) {
      return { error: `Incomplete: need ${expectedSize}, got ${data.length}` };
    }

    if (sequence === 0) {
      // Control packet
      const control = data[4] as ControlType;
      const receivedCrc = (data[5] << 8) | data[6];
      
      if (!Object.values(ControlType).includes(control)) {
        return { error: `Invalid control: 0x${control.toString(16)}` };
      }

      const packet: ControlPacket = {
        soh, sequence, invSequence, length, control, 
        payload: new Uint8Array([control]), checksum: receivedCrc
      };

      if (!XModemPacket.verify(packet)) {
        return { error: 'CRC error' };
      }

      return { packet };
    } else {
      // Data packet
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
  }

  /**
   * Verify packet CRC
   */
  static verify(packet: DataPacket | ControlPacket): boolean {
    if (packet.sequence === 0) {
      // Control packet
      const cp = packet as ControlPacket;
      const crcData = new Uint8Array([
        cp.soh, cp.sequence, cp.invSequence, cp.length, cp.control
      ]);
      return CRC16.calculate(crcData) === cp.checksum;
    } else {
      // Data packet
      const dp = packet as DataPacket;
      const crcData = new Uint8Array(4 + dp.payload.length);
      crcData[0] = dp.soh;
      crcData[1] = dp.sequence;
      crcData[2] = dp.invSequence;
      crcData[3] = dp.length;
      crcData.set(dp.payload, 4);
      return CRC16.calculate(crcData) === dp.checksum;
    }
  }
}