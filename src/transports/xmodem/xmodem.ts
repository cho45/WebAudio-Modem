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

  async sendData(data: Uint8Array): Promise<void> {
    if (this.state !== State.IDLE) {
      throw new Error('Transport busy');
    }

    const abortController = new AbortController();
    const signal = abortController.signal;

    this.state = State.SENDING_WAIT_NAK;
    this.sequence = 1;
    this.fragmentIndex = 0;
    this.retries = 0;
    this.fragments = this.createFragments(data);
    console.log(`[XModemTransport] Created ${this.fragments.length} fragments for ${data.length} bytes`);
    
    // Wait for initial NAK only once
    this.setTimeout(abortController);
    try {
      await this.waitAndSkipForControl(ControlType.NAK, { signal });
      this.clearTimeout();
    } catch (error) {
      this.clearTimeout();
      throw new Error(`Failed to receive initial NAK: ${error}`);
    }
    
    console.log(`[XModemTransport] Starting fragment loop: fragmentIndex=${this.fragmentIndex}, fragmentsLength=${this.fragments.length}`);
    while (this.fragmentIndex < this.fragments.length) {
      if (signal.aborted) throw new Error('Operation aborted at sendData');
      console.log(`[XModemTransport] Processing fragment ${this.fragmentIndex + 1}/${this.fragments.length}`);

      const fragment = this.fragments[this.fragmentIndex];
      const packet = XModemPacket.createData(this.sequence, fragment);
      const serialized = XModemPacket.serialize(packet);
      console.log(`[XModemTransport] Sending fragment ${this.fragmentIndex + 1}/${this.fragments.length}, sequence: ${this.sequence}`);
      await this.dataChannel.modulate(serialized);
      this.statistics.packetsSent++;

      this.state = State.SENDING_WAIT_ACK;
      this.setTimeout(abortController);
      
      try {
        this.dataChannel.reset();
        const byte = await this.waitForByte({ signal });
        this.clearTimeout();
        
        if (byte === ControlType.ACK) {
          this.retries = 0;
          this.fragmentIndex++;
          this.sequence = (this.sequence % 255) + 1;  // Update sequence number
          continue;
        } else
        if (byte === ControlType.NAK) {
          if (++this.retries > this.config.maxRetries) throw new Error('Max retries exceeded');
          this.statistics.packetsRetransmitted++;
          console.warn(`[XModemTransport] Retransmitting fragment ${this.fragmentIndex + 1}`);
          continue;
        } else {
          throw new Error(`Unexpected byte received: ${byte}`);
        }
      } catch (error: any) {
        this.clearTimeout();
        console.warn(`[XModemTransport] Error waiting for ACK/NAK: ${error}`);
        if (++this.retries > this.config.maxRetries) {
          console.warn(`[XModemTransport] Max retries (${this.config.maxRetries}) exceeded, retries=${this.retries}`);
          throw new Error(`Send failed after max retries: ${error}`);
        }
        if (error?.message === 'Operation aborted at sendData') {
          // Timeout occurred, retry the same fragment
          console.warn(`[XModemTransport] Timeout, retrying fragment ${this.fragmentIndex + 1}, retries=${this.retries}`);
          continue;
        }
      }
    }

    console.log(`[XModemTransport] Exited fragment loop: fragmentIndex=${this.fragmentIndex}, fragmentsLength=${this.fragments.length}`);
    // Reset retries for EOT phase
    this.retries = 0;
    
    for (;;) {
      if (signal.aborted) throw new Error('Operation aborted at sendData');
      await this.sendControl('EOT');
      this.state = State.SENDING_WAIT_FINAL_ACK;

      this.setTimeout(abortController);
      
      try {
        const byte = await this.waitForByte({ signal });
        this.clearTimeout();
        
        if (byte === ControlType.ACK) {
          this.state = State.IDLE;
          break;
        } else {
          if (++this.retries > this.config.maxRetries) throw new Error('Max retries exceeded for final ACK');
          continue;
        }
      } catch (error) {
        this.clearTimeout();
        if (++this.retries > this.config.maxRetries) {
          console.warn(`[XModemTransport] Final ACK max retries (${this.config.maxRetries}) exceeded, retries=${this.retries}`);
          throw new Error(`Final ACK timeout after max retries: ${error}`);
        }
        // Timeout occurred, retry EOT
        console.warn(`[XModemTransport] Final ACK timeout, retrying EOT, retries=${this.retries}`);
        continue;
      }
    }
  }

  async receiveData(): Promise<Uint8Array> {
    if (this.state !== State.IDLE) {
      throw new Error('Transport busy');
    }

    const abortController = new AbortController();
    const signal = abortController.signal;

    this.state = State.RECEIVING_SEND_NAK;
    this.expectedSequence = 1;
    this.receivedData = [];
    this.retries = 0;

    // Send initial NAK to start transfer
    await this.sendControl('NAK');
    this.state = State.RECEIVING_WAIT_BLOCK;
    this.setTimeout(abortController); // Set timeout for initial response

    // Receive data packets loop
    fragment: for (;;) {
      if (signal.aborted) throw new Error('Operation aborted at receiveData');

      try {
        for (;;) {
          if (signal.aborted) throw new Error('Operation aborted at receiveData');
          this.setTimeout(abortController);
          const byte = await this.waitForByte({ signal });
          this.clearTimeout();
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

        const bytes = await this.waitForBytes(3, { signal });
        const [seq, nseq, len] = [bytes[0], bytes[1], bytes[2]];
        if ((seq + nseq) !== 255) throw new Error('Invalid sequence number');
        if (seq === this.expectedSequence) {
          const payloadWithCRC = await this.waitForBytes(len + 2, { signal }); // Wait for payload + CRC
          this.statistics.packetsReceived++;

          const payload = payloadWithCRC.slice(0, len);
          const crc = (payloadWithCRC[len] << 8) | payloadWithCRC[len + 1];

          if (CRC16.calculate(payload) !== crc) throw new Error('Invalid CRC');
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
          await this.sendControl('ACK');
          this.state = State.RECEIVING_WAIT_BLOCK; // Wait for next block
        } else
        if (this.isPreviousSequence(seq, this.expectedSequence)) {
          // Duplicate packet - ACK and ignore
          await this.sendControl('ACK');
          continue;
        } else {
          // Unexpected sequence - cannot recover
          throw new Error(`Unexpected sequence number: expected ${this.expectedSequence}, got ${seq}`);
        }
      } catch (error) {
        this.clearTimeout();
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
    
    return result;
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
    console.trace();
    this.state = State.IDLE;
    this.loopRunning = false;
    this.sequence = 1;
    this.fragmentIndex = 0;
    this.retries = 0;
    this.fragments = [];
    this.receivedData = [];
    this.expectedSequence = 1;
    this.receiveBuffer = [];
    
    // Clear any pending timeout
    this.clearTimeout();
    
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
    
    // Clear any pending timeout
    this.clearTimeout();
    
    this.sendResolve = undefined;
    this.sendReject = undefined;
    this.receiveResolve = undefined;
    this.receiveReject = undefined;
    this.removeAllListeners();
  }

  private async waitAndSkipForControl(controlType: ControlType, options: {signal: AbortSignal }): Promise<void> {
    for (;;) {
      if (options.signal.aborted) throw new Error('Operation aborted at waitForControl');
      const byte = await this.waitForByte(options)
      if (byte === controlType)
        return;
    }
  }

  private async waitForByte(options: {signal: AbortSignal }): Promise<number> {
    const bytes = await this.waitForBytes(1, options);
    return bytes[0];
  }

  private async waitForBytes(count: number, options: {signal: AbortSignal }): Promise<Uint8Array> {
    while (this.receiveBuffer.length < count) {
      const data = await this.dataChannel.demodulate();
      if (options.signal.aborted) throw new Error('Operation aborted at waitForBytes');
      for (const byte of data) {
        this.receiveBuffer.push(byte);
      }
    }
    const result = this.receiveBuffer.slice(0, count);
    this.receiveBuffer = this.receiveBuffer.slice(count);
    return new Uint8Array(result);
  }

  private setTimeout(abortController: AbortController): void {
    this.clearTimeout();
    this.timeout = setTimeout(() => {
      abortController.abort("timeout");
    }, this.config.timeoutMs);
  }
  
  private clearTimeout(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
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


}
