/**
 * CRC-16-CCITT implementation for packet error detection
 * 
 * Polynomial: 0x1021 (x^16 + x^12 + x^5 + 1)
 * Initial value: 0xFFFF
 * Final XOR: 0x0000
 * 
 * Compatible with ITU-T V.41 and commonly used in modem protocols
 */

export class CRC16 {
  private static readonly POLYNOMIAL = 0x1021;
  private static readonly INITIAL_VALUE = 0xFFFF;
  private static readonly FINAL_XOR = 0x0000;

  /**
   * Calculate CRC-16-CCITT for given data
   * @param data Input data as Uint8Array
   * @returns 16-bit CRC value
   */
  static calculate(data: Uint8Array): number {
    let crc = CRC16.INITIAL_VALUE;

    for (const byte of data) {
      crc ^= (byte << 8);
      
      for (let i = 0; i < 8; i++) {
        if (crc & 0x8000) {
          crc = (crc << 1) ^ CRC16.POLYNOMIAL;
        } else {
          crc <<= 1;
        }
        crc &= 0xFFFF; // Keep 16-bit
      }
    }

    return crc ^ CRC16.FINAL_XOR;
  }


  /**
   * Verify data integrity using CRC
   * @param data Original data
   * @param expectedCrc Expected CRC value
   * @returns true if CRC matches
   */
  static verify(data: Uint8Array, expectedCrc: number): boolean {
    const actualCrc = CRC16.calculate(data);
    return actualCrc === expectedCrc;
  }
}