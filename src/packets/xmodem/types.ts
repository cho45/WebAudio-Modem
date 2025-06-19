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
 * XModem control packet structure
 * Format: SOH | 0x00 | 0xFF | 0x01 | CONTROL | CRC-16
 */
export interface ControlPacket {
  readonly soh: 0x01;           // Start of Header (fixed)
  readonly sequence: 0x00;      // Control packet identifier
  readonly invSequence: 0xFF;   // Complement of 0x00
  readonly length: 0x01;        // Control data length (fixed 1 byte)
  readonly control: ControlType; // Control command
  readonly payload: Uint8Array; // Control type as single-byte payload
  readonly checksum: number;    // CRC-16-CCITT checksum
}

/**
 * Control packet types based on ASCII control characters
 */
export enum ControlType {
  ACK = 0x06,  // Acknowledge - positive response
  NAK = 0x15,  // Negative Acknowledge - request retransmission
  EOT = 0x04,  // End of Transmission - end of data stream
  ENQ = 0x05,  // Enquiry - request for status
  CAN = 0x18   // Cancel - abort transmission
}

/**
 * Union type for all packet types
 */
export type Packet = DataPacket | ControlPacket;

/**
 * Packet parsing result
 */
export interface PacketParseResult {
  readonly success: boolean;
  readonly packet?: Packet;
  readonly error?: string;
  readonly bytesConsumed: number;
}

/**
 * Raw packet format constants
 */
export const PacketConstants = {
  SOH: 0x01,
  CONTROL_SEQUENCE: 0x00,
  CONTROL_INV_SEQUENCE: 0xFF,
  CONTROL_LENGTH: 0x01,
  
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