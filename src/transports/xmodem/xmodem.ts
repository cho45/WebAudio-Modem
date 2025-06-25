/**
 * XModem transport protocol implementation - Half-duplex protocol
 * 
 * Simple state machine following standard XModem protocol:
 * - Half-duplex communication (send OR receive, not both)
 * - Receiver initiates with NAK
 * - Block-by-block transmission with ACK/NAK responses
 * - Proper CRC16 and sequence number validation
 */

import { BaseTransport, IDataChannel, Event } from '../../core';
import { XModemPacket } from './packet';
import { DataPacket, ControlType } from './types';
import { CRC16 } from '@/utils/crc16';

export interface XModemConfig {
  timeoutMs: number;
  maxRetries: number;
  maxPayloadSize: number;
}

enum State {
  IDLE,
  // Sending states
  SENDING_WAIT_NAK,      // 送信: 初回NAK待ち
  SENDING_WAIT_ACK,      // 送信: ACK待ち
  SENDING_WAIT_FINAL_ACK, // 送信: EOT後の最終ACK待ち
  // Receiving states
  RECEIVING_SEND_NAK,    // 受信: 最初のNAK送信
  RECEIVING_WAIT_BLOCK,  // 受信: ブロック待ち
  RECEIVING_SEND_ACK     // 受信: ACK/NAK送信後、次ブロック待ち
}

export class XModemTransport extends BaseTransport {
  readonly transportName = 'XModem';

  private config: XModemConfig = {
    timeoutMs: 3000,
    maxRetries: 10,
    maxPayloadSize: 128
  };

  private state = State.IDLE;
  private sequence = 1;
  private fragments: Uint8Array[] = [];
  private fragmentIndex = 0;
  private retries = 0;
  private receivedData: Uint8Array[] = [];
  private expectedSequence = 1;
  private timeout?: ReturnType<typeof setTimeout>;
  
  // Simple receive buffer for byte-by-byte assembly
  private receiveBuffer: number[] = [];

  // Promise resolvers
  private sendResolve?: () => void;
  private sendReject?: (error: Error) => void;
  private receiveResolve?: (data: Uint8Array) => void;
  private receiveReject?: (error: Error) => void;
  private loopRunning = false;

  constructor(dataChannel: IDataChannel) {
    super(dataChannel);
  }

  configure(config: Partial<XModemConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): XModemConfig {
    return { ...this.config };
  }

  async sendData(data: Uint8Array, options?: {signal?: AbortSignal}): Promise<void> {
    if (this.state !== State.IDLE) {
      throw new Error('Transport busy');
    }
    
    const externalSignal = options?.signal;

    this.state = State.SENDING_WAIT_NAK;
    this.sequence = 1;
    this.fragmentIndex = 0;
    this.retries = 0;
    this.fragments = this.createFragments(data);
    
    let totalBytesSent = 0;
    
    try {
      console.log(`[XModemTransport] Created ${this.fragments.length} fragments for ${data.length} bytes`);
      
      // Wait for initial NAK only once (optional for standalone operation)
      try {
        await this.waitAndSkipForControl(ControlType.NAK, { signal: this.createTimeoutSignal(externalSignal) });
        console.log(`[XModemTransport] Initial NAK received`);
      } catch (error) {
        console.warn(`[XModemTransport] No initial NAK received (standalone mode): ${error}`);
        // Continue without initial NAK for standalone operation
      }
    
    console.log(`[XModemTransport] Starting fragment loop: fragmentIndex=${this.fragmentIndex}, fragmentsLength=${this.fragments.length}`);
    fragment: while (this.fragmentIndex < this.fragments.length) {
      console.log(`[XModemTransport] Processing fragment ${this.fragmentIndex + 1}/${this.fragments.length}`);

      const fragment = this.fragments[this.fragmentIndex];
      const packet = XModemPacket.createData(this.sequence, fragment);
      const serialized = XModemPacket.serialize(packet);
      console.log(`[XModemTransport] Sending fragment ${this.fragmentIndex + 1}/${this.fragments.length}, sequence: ${this.sequence}`);
      await this.dataChannel.modulate(serialized);
      this.statistics.packetsSent++;
      
      // Clear receive buffer after modulation to avoid self-reception
      await this.dataChannel.reset();
      
      this.state = State.SENDING_WAIT_ACK;
      
      try {
        for (;;) {
          if (externalSignal?.aborted) throw new Error('Operation aborted at sendData');
          const byte = await this.waitForControlByte({ signal: this.createTimeoutSignal(externalSignal) });
          
          if (byte === ControlType.ACK) {
            this.retries = 0;
            this.fragmentIndex++;
            this.sequence = (this.sequence % 255) + 1;  // Update sequence number
            continue fragment;
          } else
          if (byte === ControlType.NAK) {
            if (++this.retries > this.config.maxRetries) throw new Error('Max retries exceeded');
            this.statistics.packetsRetransmitted++;
            console.warn(`[XModemTransport] Retransmitting fragment ${this.fragmentIndex + 1}`);
            continue fragment;
          } else {
            continue;
          }
        }
      } catch (error: any) {
        console.warn(`[XModemTransport] Error waiting for ACK/NAK: ${error}`);
        if (++this.retries > this.config.maxRetries) {
          console.warn(`[XModemTransport] Max retries (${this.config.maxRetries}) exceeded, retries=${this.retries}`);
          throw new Error('Timeout - max retries exceeded');
        }
        if (error?.message?.includes('Operation aborted')) {
          // Timeout occurred, retry the same fragment
          this.statistics.packetsRetransmitted++;
          console.warn(`[XModemTransport] Timeout, retrying fragment ${this.fragmentIndex + 1}, retries=${this.retries}`);
          continue;
        }
      }
    }

    console.log(`[XModemTransport] Exited fragment loop: fragmentIndex=${this.fragmentIndex}, fragmentsLength=${this.fragments.length}`);
    // Reset retries for EOT phase
    this.retries = 0;
    
    for (;;) {
      if (externalSignal?.aborted) throw new Error('Operation aborted at sendData');
      console.log(`[XModemTransport] Sending EOT, waiting for final ACK`);
      await this.sendControl('EOT');
      // Clear receive buffer after EOT to avoid self-reception
      await this.dataChannel.reset();
      this.state = State.SENDING_WAIT_FINAL_ACK;

      try {
        const byte = await this.waitForControlByte({ signal: this.createTimeoutSignal(externalSignal) });
        
        if (byte === ControlType.ACK) {
          console.log(`[XModemTransport] Final ACK received`);
          // Success - will update statistics in finally block
          totalBytesSent = data.length;
          break;
        } else {
          if (++this.retries > this.config.maxRetries) throw new Error('Max retries exceeded for final ACK');
          continue;
        }
      } catch (error) {
        if (++this.retries > this.config.maxRetries) {
          console.warn(`[XModemTransport] Final ACK max retries (${this.config.maxRetries}) exceeded, retries=${this.retries}`);
          throw new Error(`Final ACK timeout after max retries: ${error}`);
        }
        // Timeout occurred, retry EOT
        console.warn(`[XModemTransport] Final ACK timeout, retrying EOT, retries=${this.retries}`);
        continue;
      }
    }
    } finally {
      // Always restore state to IDLE, regardless of success or failure
      this.state = State.IDLE;
      
      // Update statistics only on successful completion
      if (totalBytesSent > 0) {
        this.statistics.bytesTransferred += totalBytesSent;
      }
    }
  }

  async receiveData(options?: {signal?: AbortSignal}): Promise<Uint8Array> {
    if (this.state !== State.IDLE) {
      throw new Error('Transport busy');
    }
    
    const externalSignal = options?.signal;

    this.state = State.RECEIVING_SEND_NAK;
    this.expectedSequence = 1;
    this.receivedData = [];
    this.retries = 0;
    
    let totalBytesReceived = 0;
    
    try {
      // Send initial NAK to start transfer
      await this.sendControl('NAK');
      this.state = State.RECEIVING_WAIT_BLOCK;

    // Receive data packets loop
    fragment: for (;;) {
      if (externalSignal?.aborted) throw new Error('Operation aborted at receiveData');

      // Note: Don't reset here as it may clear test data
      // this.dataChannel.reset();
      try {
        for (;;) {
          if (externalSignal?.aborted) throw new Error('Operation aborted at receiveData');
          const byte = await this.waitForByte({ signal: this.createTimeoutSignal(externalSignal) });
          if (byte === ControlType.EOT) {
            console.log(`[XModemTransport] EOT Received byte: ${byte}`);
            this.state = State.RECEIVING_SEND_ACK;
            await this.sendControl('ACK'); // Send final ACK for EOT
            break fragment;
          } else 
          if (byte === ControlType.SOH) {
            console.log(`[XModemTransport] SOH Received byte: ${byte}`);
            break;
          } else {
            console.log(`[XModemTransport] receiveData/received byte ignored: ${byte}`);
            continue; // Ignore any other byte
          }
        }

        const bytes = await this.waitForBytes(3, { signal: this.createTimeoutSignal(externalSignal) });
        const [seq, nseq, len] = [bytes[0], bytes[1], bytes[2]];
        if ((seq + nseq) !== 255) {
          this.statistics.packetsDropped++;
          throw new Error('Invalid sequence number');
        }
        console.log(`[XModemTransport] Received packet: seq=${seq}, nseq=${nseq}, len=${len}`);
        if (seq === this.expectedSequence) {
          const payloadWithCRC = await this.waitForBytes(len + 2, { signal: this.createTimeoutSignal(externalSignal) }); // Wait for payload + CRC
          this.statistics.packetsReceived++;

          const payload = payloadWithCRC.slice(0, len);
          const crc = (payloadWithCRC[len] << 8) | payloadWithCRC[len + 1];
          console.log(`[XModemTransport] Received payload with CRC: seq=${seq}, len=${len}, crc=${crc} (== ${CRC16.calculate(payload)})`);

          if (CRC16.calculate(payload) !== crc) {
            this.statistics.packetsDropped++;
            throw new Error('Invalid CRC');
          }
          this.receivedData.push(payload);

          // Emit fragment received event
          this.emit('fragmentReceived', new Event({
            seqNum: seq,
            fragment: payload,
            totalFragments: this.receivedData.length,
            totalBytesReceived: this.receivedData.reduce((sum, data) => sum + data.length, 0),
            timestamp: Date.now()
          }));

          this.expectedSequence = (this.expectedSequence % 255) + 1;
          this.retries = 0; // Reset retries after successful packet
          this.state = State.RECEIVING_SEND_ACK;
          console.log(`[XModemTransport] Sending ACK for seq=${seq}`);
          await this.sendControl('ACK');
          this.state = State.RECEIVING_WAIT_BLOCK; // Wait for next block
        } else
        if (this.isPreviousSequence(seq, this.expectedSequence)) {
          // Duplicate packet - ACK and ignore
          this.statistics.packetsDropped++;
          await this.sendControl('ACK');
          continue;
        } else {
          // Unexpected sequence - cannot recover
          this.statistics.packetsDropped++;
          throw new Error(`Unexpected sequence number: expected ${this.expectedSequence}, got ${seq}`);
        }
      } catch (error) {
        console.log(`[XModemTransport] Error during receiveData: ${error}`);
        if (++this.retries > this.config.maxRetries) {
          throw new Error(`Receive failed after max retries: ${error}`);
        }
        // Send NAK to request retransmission
        await this.sendControl('NAK');
      }
    }

      // Reassemble received data
      const totalLength = this.receivedData.reduce((sum, d) => sum + d.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      
      for (const data of this.receivedData) {
        result.set(data, offset);
        offset += data.length;
      }

      console.log(`[XModemTransport] Received total data length: ${result.length} bytes`);
      
      // Success - will update statistics in finally block
      totalBytesReceived = result.length;
      
      return result;
    } finally {
      // Always restore state to IDLE, regardless of success or failure
      this.state = State.IDLE;
      
      // Update statistics only on successful completion
      if (totalBytesReceived > 0) {
        this.statistics.bytesTransferred += totalBytesReceived;
      }
    }
  }
  
  async sendControl(command: string): Promise<void> {
    const controlType = this.parseControlCommand(command);
    const serialized = XModemPacket.serializeControl(controlType);
    await this.dataChannel.modulate(serialized);
    this.statistics.packetsSent++;
  }

  isReady(): boolean {
    return this.state === State.IDLE;
  }

  reset(): void {
    console.warn(`[XModemTransport] RESET called!`);
    this.state = State.IDLE;
    this.loopRunning = false;
    this.sequence = 1;
    this.fragmentIndex = 0;
    this.retries = 0;
    this.fragments = [];
    this.receivedData = [];
    this.expectedSequence = 1;
    this.receiveBuffer = [];
    
    if (this.sendReject) {
      this.sendReject(new Error('Transport reset'));
      this.sendResolve = undefined;
      this.sendReject = undefined;
    }
    
    if (this.receiveReject) {
      this.receiveReject(new Error('Transport reset'));
      this.receiveResolve = undefined;
      this.receiveReject = undefined;
    }
    
    super.reset();
  }

  dispose(): void {
    this.state = State.IDLE;
    this.loopRunning = false;
    
    this.sendResolve = undefined;
    this.sendReject = undefined;
    this.receiveResolve = undefined;
    this.receiveReject = undefined;
    this.removeAllListeners();
  }

  private async waitAndSkipForControl(controlType: ControlType, options: {signal: AbortSignal }): Promise<void> {
    for (;;) {
      if (options.signal.aborted) throw new Error('Operation aborted at waitForControl');
      const byte = await this.waitForControlByte(options)
      if (byte === controlType)
        return;
    }
  }

  private async waitForControlByte(options: {signal: AbortSignal}): Promise<number> {
    for (;;) {
      if (options.signal.aborted) throw new Error('Operation aborted at waitForControlByte');
      
      try {
        const data = await this.dataChannel.demodulate({ signal: options.signal });
        for (const byte of data) {
          // Only accept control bytes
          if (byte === ControlType.ACK || byte === ControlType.NAK || byte === ControlType.EOT) {
            console.log(`[XModemTransport] Control byte received: ${byte}`);
            return byte;
          } else {
            console.log(`[XModemTransport] Non-control byte ignored: ${byte}`);
            // Ignore non-control bytes (like SOH, data bytes from self-transmission)
          }
        }
      } catch (error) {
        // Handle demodulate() timeout/error - check AbortSignal to prevent infinite retry
        if (options.signal.aborted) {
          throw new Error('Operation aborted at waitForControlByte');
        }
        // If it's a timeout from MockDataChannel, we should propagate it as timeout
        if (error instanceof Error && (error.message.includes('timeout') || error.message.includes('aborted'))) {
          throw new Error('Operation aborted at waitForControlByte');
        }
        // For other errors, continue the loop (but this might lead to infinite retry)
        console.warn(`[XModemTransport] demodulate() error in waitForControlByte: ${error}`);
      }
    }
  }

  private async waitForByte(options: {signal: AbortSignal }): Promise<number> {
    const bytes = await this.waitForBytes(1, options);
    return bytes[0];
  }

  private async waitForBytes(count: number, options: {signal: AbortSignal }): Promise<Uint8Array> {
    while (this.receiveBuffer.length < count) {
      const data = await this.dataChannel.demodulate({ signal: options.signal });
      if (options.signal.aborted) throw new Error('Operation aborted at waitForBytes');
      for (const byte of data) {
        this.receiveBuffer.push(byte);
      }
    }
    const result = this.receiveBuffer.slice(0, count);
    this.receiveBuffer = this.receiveBuffer.slice(count);
    return new Uint8Array(result);
  }

  private createFragments(data: Uint8Array): Uint8Array[] {
    const fragments: Uint8Array[] = [];
    const { maxPayloadSize } = this.config;
    
    for (let offset = 0; offset < data.length; offset += maxPayloadSize) {
      const size = Math.min(maxPayloadSize, data.length - offset);
      fragments.push(data.slice(offset, offset + size));
    }
    
    return fragments.length > 0 ? fragments : [new Uint8Array(0)];
  }

  private parseControlCommand(command: string): ControlType {
    switch (command.toUpperCase()) {
      case 'ACK': return ControlType.ACK;
      case 'NAK': return ControlType.NAK;
      case 'EOT': return ControlType.EOT;
      default: throw new Error(`Unknown control command: ${command}`);
    }
  }

  private isPreviousSequence(receivedSeq: number, expectedSeq: number): boolean {
    // XModem sequence numbers are 1-255, wrapping around
    // Check if receivedSeq is the previous sequence number (already received)
    const prevSeq = expectedSeq === 1 ? 255 : expectedSeq - 1;
    return receivedSeq === prevSeq;
  }

  /**
   * Create a combined signal with timeout for wait operations
   */
  private createTimeoutSignal(externalSignal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
    return externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
  }


}
