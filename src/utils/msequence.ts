/**
 * M-sequence LFSR Step Functions
 * Each function takes current register state and returns next state
 */

/**
 * M15: x⁴+x³+1 polynomial step
 */
export function mseq15Step(register: number): number {
  const feedback = ((register >> 3) ^ (register >> 2)) & 1;
  return ((register << 1) | feedback) & 0xF;
}

/**
 * M31: x⁵+x³+1 polynomial step  
 */
export function mseq31Step(register: number): number {
  const feedback = ((register >> 4) ^ (register >> 2)) & 1;
  return ((register << 1) | feedback) & 0x1F;
}

/**
 * M63: x⁶+x⁵+1 polynomial step
 */
export function mseq63Step(register: number): number {
  const feedback = ((register >> 5) ^ (register >> 4)) & 1;
  return ((register << 1) | feedback) & 0x3F;
}

/**
 * M127: x⁷+x⁶+1 polynomial step
 */
export function mseq127Step(register: number): number {
  const feedback = ((register >> 6) ^ (register >> 5)) & 1;
  return ((register << 1) | feedback) & 0x7F;
}

/**
 * M255: x⁸+x⁶+x⁵+x⁴+1 polynomial step
 */
export function mseq255Step(register: number): number {
  const feedback = ((register >> 7) ^ (register >> 5) ^ (register >> 4) ^ (register >> 3)) & 1;
  return ((register << 1) | feedback) & 0xFF;
}

/**
 * Extract output bit from register (MSB)
 */
export function mseqOutput(register: number, bits: number): number {
  return (register >> (bits - 1)) & 1;
}

/**
 * Calculate autocorrelation at given lag
 */
export function calculateAutocorrelation(sequence: readonly number[], lag: number): number {
  let correlation = 0;
  
  for (let i = 0; i < sequence.length; i++) {
    const bit1 = sequence[i] === 0 ? -1 : 1;
    const bit2 = sequence[(i + lag) % sequence.length] === 0 ? -1 : 1;
    correlation += bit1 * bit2;
  }
  
  return correlation;
}