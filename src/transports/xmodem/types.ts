/**
 * Packet structure definitions for XModem-like protocol
 * 
 * Simple, well-defined interfaces for packet creation and parsing
 */

/**
 * XModem data packet structure
 * Format: SOH | SEQ | ~SEQ | LEN | PAYLOAD | CRC-16
 */
export interface DataPacket {
  readonly soh: 0x01;           // Start of Header (fixed)
  readonly sequence: number;    // Sequence number (1-255, 0 reserved for control)
  readonly invSequence: number; // Bitwise complement of sequence (error detection)
  readonly length: number;      // Payload length (0-255 bytes)
  readonly payload: Uint8Array; // Actual data (0-255 bytes)
  readonly checksum: number;    // CRC-16-CCITT checksum
}

/**
 * Control characters are sent as single bytes (standard XModem protocol)
 * No packet structure for control characters
 */

/**
 * Control packet types (minimal set for XModem protocol)
 */
export enum ControlType {
  ACK = 0x06,  // Acknowledge - positive response
  NAK = 0x15,  // Negative Acknowledge - request retransmission
  EOT = 0x04   // End of Transmission - end of data stream
}

/**
 * Only data packets use packet structure
 * Control characters are sent as single bytes
 */
export type Packet = DataPacket;

/**
 * Packet parsing result (for data packets only)
 */
export interface PacketParseResult {
  readonly success: boolean;
  readonly packet?: DataPacket;
  readonly error?: string;
  readonly bytesConsumed: number;
}

/**
 * Control character recognition result
 */
export interface ControlParseResult {
  readonly isControl: boolean;
  readonly controlType?: ControlType;
}

/**
 * Data packet format constants
 */
export const PacketConstants = {
  SOH: 0x01,
  
  // Size calculations
  HEADER_SIZE: 4,        // SOH + SEQ + ~SEQ + LEN
  CRC_SIZE: 2,           // CRC-16
  MIN_PACKET_SIZE: 6,    // Header + CRC (no payload)
  MAX_PACKET_SIZE: 261,  // Header + 255 bytes payload + CRC
  
  // Limits
  MAX_PAYLOAD_SIZE: 255,
  MAX_SEQUENCE: 255,
  MIN_DATA_SEQUENCE: 1
} as const;