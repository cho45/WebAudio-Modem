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
import { ControlType } from './types';
import { CRC16 } from '@/utils/crc16';

export interface XModemConfig {
  name: string; // Name of the transport, can be used for identification
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

export interface StateChangeEvent {
  oldState: string;
  newState: string;
  context: string;
  timestamp: number;
}


export class XModemTransport extends BaseTransport {
  readonly transportName = 'XModem';

  private config: XModemConfig = {
    name: "none",
    timeoutMs: 3000,
    maxRetries: 10,
    maxPayloadSize: 128
  };

  // Grouped state management for better organization
  private readonly protocol = { state: State.IDLE };
  private readonly send = { sequence: 1, fragments: [] as Uint8Array[], fragmentIndex: 0, retries: 0 };
  private readonly receive = { expectedSequence: 1, data: [] as Uint8Array[], buffer: [] as number[] };
  private readonly operation = { controller: undefined as AbortController | undefined };

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
    this.ensureIdle('sendData');
    
    // Create operation controller for this send operation
    this.operation.controller = new AbortController();
    const externalSignal = options?.signal;

    // Check if operation was aborted before starting
    if (this.operation.controller.signal.aborted || externalSignal?.aborted) {
      throw new Error('Operation aborted before start');
    }
    
    let totalBytesSent = 0;
    
    try {
      this.initializeSend(data);
      await this.waitForInitialNAK(externalSignal);
      await this.sendAllFragments(externalSignal);
      await this.sendEOTAndConfirm(externalSignal);
      totalBytesSent = data.length;
    } finally {
      // Clear operation controller
      this.operation.controller = undefined;
      
      // Always restore state to IDLE, regardless of success or failure
      this.stateChanged(State.IDLE, totalBytesSent > 0 ? `Send completed: ${totalBytesSent} bytes` : 'Send failed or aborted');
      
      // Update statistics only on successful completion
      if (totalBytesSent > 0) {
        this.statistics.bytesTransferred += totalBytesSent;
      }
    }
  }

  private initializeSend(data: Uint8Array): void {
    this.stateChanged(State.SENDING_WAIT_NAK, `Starting transmission of ${data.length} bytes`);
    Object.assign(this.send, { sequence: 1, fragmentIndex: 0, retries: 0, fragments: this.createFragments(data) });
    console.log(`[XModemTransport:${this.config.name}] Created ${this.send.fragments.length} fragments for ${data.length} bytes`);
  }

  private async waitForInitialNAK(externalSignal?: AbortSignal): Promise<void> {
    try {
      await this.waitAndSkipForControl(ControlType.NAK, { signal: this.createTimeoutSignal(externalSignal) });
      console.log(`[XModemTransport:${this.config.name}] Initial NAK received`);
    } catch (error) {
      // Check if it's an abort error first
      if (error instanceof Error && this.isAbortError(error)) {
        throw new Error('Operation aborted at sendData');
      }
      console.warn(`[XModemTransport:${this.config.name}] No initial NAK received (standalone mode): ${error}`);
      // Continue without initial NAK for standalone operation
    }
  }

  private async sendAllFragments(externalSignal?: AbortSignal): Promise<void> {
    while (this.send.fragmentIndex < this.send.fragments.length) {
      await this.withRetry(
        async () => {
          console.log(`[XModemTransport:${this.config.name}] Processing fragment ${this.send.fragmentIndex + 1}/${this.send.fragments.length}`);

          const fragment = this.send.fragments[this.send.fragmentIndex];
          const packet = XModemPacket.createData(this.send.sequence, fragment);
          const serialized = XModemPacket.serialize(packet);
          console.log(`[XModemTransport:${this.config.name}] Sending fragment ${this.send.fragmentIndex + 1}/${this.send.fragments.length}, sequence: ${this.send.sequence}`);
          await this.dataChannel.modulate(serialized);
          this.statistics.packetsSent++;
          
          this.stateChanged(State.SENDING_WAIT_ACK, `Waiting for ACK for fragment ${this.send.fragmentIndex + 1}/${this.send.fragments.length}`);
          for (;;) {
            const byte = await this.waitForControlByte({ signal: this.createTimeoutSignal(externalSignal) });
            
            if (byte === ControlType.ACK) {
              this.send.retries = 0;
              this.send.fragmentIndex++;
              this.send.sequence = (this.send.sequence % 255) + 1;
              return; // Success, exit retry loop
            } else if (byte === ControlType.NAK) {
              this.statistics.packetsRetransmitted++;
              console.warn(`[XModemTransport] Retransmitting fragment ${this.send.fragmentIndex + 1}`);
              throw new Error('NAK received, retry fragment');
            }
            // Continue for other bytes
          }
        },
        this.config.maxRetries,
        (_retryCount) => {
          this.statistics.packetsRetransmitted++;
          console.warn(`[XModemTransport:${this.config.name}] Timeout, retrying fragment ${this.send.fragmentIndex + 1}, retries=${_retryCount}`);
        },
        externalSignal
      );
    }
    console.log(`[XModemTransport:${this.config.name}] Exited fragment loop: fragmentIndex=${this.send.fragmentIndex}, fragmentsLength=${this.send.fragments.length}`);
  }

  private async sendEOTAndConfirm(externalSignal?: AbortSignal): Promise<void> {
    // Reset retries for EOT phase
    this.send.retries = 0;
    
    await this.withRetry(
      async () => {
        this.stateChanged(State.SENDING_WAIT_FINAL_ACK, 'Sending EOT, waiting for final ACK');
        await this.sendControl('EOT');
        
        // Use ACK-specific wait to avoid echo-back of our own EOT
        await this.waitForACK({ signal: this.createTimeoutSignal(externalSignal) });
        console.log(`[XModemTransport:${this.config.name}] Final ACK received`);
        return; // Success
      },
      this.config.maxRetries,
      (_retryCount) => {
        console.warn(`[XModemTransport:${this.config.name}] Final ACK timeout, retrying EOT, retries=${_retryCount}`);
      },
      externalSignal
    );
  }

  async receiveData(options?: {signal?: AbortSignal}): Promise<Uint8Array> {
    console.log(`[XModemTransport:${this.config.name}] 🔍 DEBUG: receiveData started`);
    this.ensureIdle('receiveData');
    
    // Create operation controller for this receive operation
    this.operation.controller = new AbortController();
    const externalSignal = options?.signal;

    // Check if operation was aborted before starting
    if (this.operation.controller.signal.aborted || externalSignal?.aborted) {
      throw new Error('Operation aborted before start');
    }
    
    let totalBytesReceived = 0;
    
    try {
      this.initializeReceive();
      await this.sendInitialNAK();
      const packets = await this.receiveAllPackets(externalSignal);
      const result = this.assembleData(packets);
      totalBytesReceived = result.length;
      return result;
    } finally {
      // Clear operation controller
      this.operation.controller = undefined;
      
      // Always restore state to IDLE, regardless of success or failure
      this.stateChanged(State.IDLE, totalBytesReceived > 0 ? `Receive completed: ${totalBytesReceived} bytes` : 'Receive failed or aborted');
      
      // Update statistics only on successful completion
      if (totalBytesReceived > 0) {
        this.statistics.bytesTransferred += totalBytesReceived;
      }
    }
  }

  private initializeReceive(): void {
    this.stateChanged(State.RECEIVING_SEND_NAK, 'Starting receive, sending initial NAK');
    Object.assign(this.receive, { expectedSequence: 1, data: [], buffer: [] });
    this.send.retries = 0;
  }

  private async sendInitialNAK(): Promise<void> {
    await this.sendControl('NAK');
    this.stateChanged(State.RECEIVING_WAIT_BLOCK, 'Waiting for data blocks');
  }

  private async receiveAllPackets(externalSignal?: AbortSignal): Promise<Uint8Array[]> {
    console.log(`[XModemTransport:${this.config.name}] 🔍 DEBUG: Starting receiveAllPackets`);
    fragment: for (;;) {
      this.checkAbort(externalSignal);

      try {
        // Read first byte to determine if it's EOT or SOH
        console.log(`[XModemTransport:${this.config.name}] 🔍 DEBUG: Waiting for first byte (EOT or SOH)`);
        const firstByte = await this.waitForByte({ signal: this.createTimeoutSignal(externalSignal) });
        console.log(`[XModemTransport:${this.config.name}] 🔍 DEBUG: Received first byte: ${firstByte} (EOT=${ControlType.EOT}, SOH=${ControlType.SOH})`);
        
        if (firstByte === ControlType.EOT) {
          console.log(`[XModemTransport:${this.config.name}] EOT Received byte: ${firstByte}`);
          await this.sendControl('ACK'); // Send final ACK for EOT
          break fragment;
        } else if (firstByte === ControlType.SOH) {
          console.log(`[XModemTransport:${this.config.name}] SOH Received byte: ${firstByte}`);
          await this.receiveAndProcessPacket(externalSignal);
        } else {
          console.log(`[XModemTransport:${this.config.name}] receiveData/received byte ignored: ${firstByte}`);
          continue; // Ignore any other byte
        }
      } catch (error) {
        console.log(`[XModemTransport:${this.config.name}] Error during receiveData: ${error}`);
        if (++this.send.retries > this.config.maxRetries) {
          throw new Error(`Receive failed after max retries: ${error}`);
        }
        // Clear receive buffer to avoid payload bytes being misinterpreted as control bytes
        this.receive.buffer = [];
        // Send NAK to request retransmission
        await this.sendControl('NAK');
      }
    }
    return this.receive.data;
  }

  private async receiveAndProcessPacket(externalSignal?: AbortSignal): Promise<void> {
    console.log(`[XModemTransport:${this.config.name}] 🔍 DEBUG: Starting receiveAndProcessPacket`);
    
    // Read packet structure: seq, nseq, len
    console.log(`[XModemTransport:${this.config.name}] 🔍 DEBUG: Waiting for 3 bytes (seq, nseq, len)`);
    const bytes = await this.waitForBytes(3, { signal: this.createTimeoutSignal(externalSignal) });
    const [seq, nseq, len] = [bytes[0], bytes[1], bytes[2]];
    
    console.log(`[XModemTransport:${this.config.name}] 🔍 DEBUG: Received header bytes: seq=${seq}, nseq=${nseq}, len=${len}`);
    
    if ((seq + nseq) !== 255) {
      console.log(`[XModemTransport:${this.config.name}] 🔍 DEBUG: Invalid sequence number check failed: ${seq} + ${nseq} = ${seq + nseq} !== 255`);
      this.statistics.packetsDropped++;
      this.emit('error', new Event({ error: 'Invalid sequence number', seq, nseq }));
      throw new Error('Invalid sequence number');
    }

    console.log(`[XModemTransport:${this.config.name}] Received packet: seq=${seq}, nseq=${nseq}, len=${len}`);

    if (seq === this.receive.expectedSequence) {
      const payloadWithCRC = await this.waitForBytes(len + 2, { signal: this.createTimeoutSignal(externalSignal) });
      this.statistics.packetsReceived++;

      const payload = payloadWithCRC.slice(0, len);
      const crc = (payloadWithCRC[len] << 8) | payloadWithCRC[len + 1];
      console.log(`[XModemTransport:${this.config.name}] Received payload with CRC: seq=${seq}, len=${len}, crc=${crc} (== ${CRC16.calculate(payload)})`);

      if (CRC16.calculate(payload) !== crc) {
        this.statistics.packetsDropped++;
        this.emit('error', new Event({ error: 'Invalid CRC', seq, crc, calculatedCrc: CRC16.calculate(payload) }));
        throw new Error('Invalid CRC');
      }
      
      this.receive.data.push(payload);

      // Emit fragment received event
      this.emit('fragmentReceived', new Event({
        seqNum: seq,
        fragment: payload,
        totalFragments: this.receive.data.length,
        totalBytesReceived: this.receive.data.reduce((sum, data) => sum + data.length, 0),
        timestamp: Date.now()
      }));

      this.receive.expectedSequence = (this.receive.expectedSequence % 255) + 1;
      this.send.retries = 0; // Reset retries after successful packet
      this.stateChanged(State.RECEIVING_SEND_ACK, `Sending ACK for sequence ${seq}`);
      console.log(`[XModemTransport:${this.config.name}] Sending ACK for seq=${seq}`);
      await this.sendControl('ACK');
      this.stateChanged(State.RECEIVING_WAIT_BLOCK, 'Waiting for next block');
    } else if (this.isPreviousSequence(seq, this.receive.expectedSequence)) {
      // Duplicate packet - read payload to consume it from stream, then ACK and ignore
      await this.waitForBytes(len + 2, { signal: this.createTimeoutSignal(externalSignal) }); // Skip payload+CRC
      this.statistics.packetsDropped++;
      console.log(`[XModemTransport:${this.config.name}] Duplicate packet ignored: seq=${seq} (expected=${this.receive.expectedSequence})`);
      await this.sendControl('ACK');
    } else {
      // Unexpected sequence - cannot recover
      this.statistics.packetsDropped++;
      this.emit('error', new Event({ error: 'Unexpected sequence number', expected: this.receive.expectedSequence, received: seq }));
      throw new Error(`Unexpected sequence number: expected ${this.receive.expectedSequence}, got ${seq}`);
    }
  }

  private assembleData(packets: Uint8Array[]): Uint8Array {
    const totalLength = packets.reduce((sum, d) => sum + d.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    
    for (const data of packets) {
      result.set(data, offset);
      offset += data.length;
    }

    console.log(`[XModemTransport:${this.config.name}] Received total data length: ${result.length} bytes`);
    return result;
  }
  
  async sendControl(command: string): Promise<void> {
    // Check if current operation is aborted
    if (this.operation.controller?.signal.aborted) {
      throw new Error('Operation aborted at sendControl');
    }
    
    const controlType = this.parseControlCommand(command);
    const serialized = XModemPacket.serializeControl(controlType);
    
    // Only proceed if not aborted
    if (this.operation.controller?.signal.aborted) {
      throw new Error('Operation aborted at sendControl');
    }
    
    await this.dataChannel.modulate(serialized);
    
    // Only update statistics if operation is still not aborted
    if (!this.operation.controller?.signal.aborted) {
      this.statistics.packetsSent++;
    }
  }

  isReady(): boolean {
    return this.protocol.state === State.IDLE;
  }
  
  /**
   * Get current state as human-readable string
   */
  getCurrentState(): string {
    return State[this.protocol.state];
  }

  reset(): void {
    // Abort any ongoing operation first
    if (this.operation.controller) {
      this.operation.controller.abort();
      this.operation.controller = undefined;
    }
    
    // Clear statistics after abort to prevent further updates
    super.reset();
    
    this.stateChanged(State.IDLE, 'Reset called - clearing all state');
    Object.assign(this.send, { sequence: 1, fragmentIndex: 0, retries: 0, fragments: [] });
    Object.assign(this.receive, { expectedSequence: 1, data: [], buffer: [] });
  }

  dispose(): void {
    this.removeAllListeners();
  }

  private async waitAndSkipForControl(controlType: ControlType, options: {signal: AbortSignal }): Promise<void> {
    for (;;) {
      if (options.signal.aborted) throw new Error('Operation aborted at waitForControl');
      try {
        const byte = await this.waitForControlByte(options);
        if (byte === controlType)
          return;
      } catch (error) {
        // Propagate abort errors immediately
        if (error instanceof Error && this.isAbortError(error)) {
          throw new Error('Operation aborted at waitAndSkipForControl');
        }
        // For other errors, re-throw to let caller handle
        throw error;
      }
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
            console.log(`[XModemTransport:${this.config.name}] Control byte received: ${byte}`);
            return byte;
          } else {
            console.log(`[XModemTransport:${this.config.name}] Non-control byte ignored: ${byte}`);
            // Ignore non-control bytes (like SOH, data bytes from self-transmission)
          }
        }
      } catch (error) {
        // Handle demodulate() timeout/error - check AbortSignal to prevent infinite retry
        if (options.signal.aborted) {
          throw new Error('Operation aborted at waitForControlByte');
        }
        // Handle abort exceptions from demodulate()
        if (error instanceof Error && this.isAbortError(error)) {
          throw new Error('Operation aborted at waitForControlByte');
        }
        // For other errors, continue the loop (but this might lead to infinite retry)
        console.warn(`[XModemTransport:${this.config.name}] demodulate() error in waitForControlByte: ${error}`);
      }
    }
  }

  /**
   * Wait specifically for ACK, ignoring echo-back of our own transmissions
   * This prevents the sender from receiving its own EOT when waiting for final ACK
   */
  private async waitForACK(options: {signal: AbortSignal}): Promise<void> {
    for (;;) {
      if (options.signal.aborted) throw new Error('Operation aborted at waitForACK');
      
      try {
        const data = await this.dataChannel.demodulate({ signal: options.signal });
        for (const byte of data) {
          if (byte === ControlType.ACK) {
            console.log(`[XModemTransport:${this.config.name}] ACK received: ${byte}`);
            return; // Success - ACK received
          } else {
            // Ignore all other bytes including our own EOT echo-back
            console.log(`[XModemTransport:${this.config.name}] Non-ACK byte ignored while waiting for ACK: ${byte}`);
          }
        }
      } catch (error) {
        // Handle demodulate() timeout/error - check AbortSignal to prevent infinite retry
        if (options.signal.aborted) {
          throw new Error('Operation aborted at waitForACK');
        }
        // Handle abort exceptions from demodulate()
        if (error instanceof Error && this.isAbortError(error)) {
          throw new Error('Operation aborted at waitForACK');
        }
        // For other errors, continue the loop (but this might lead to infinite retry)
        console.warn(`[XModemTransport:${this.config.name}] demodulate() error in waitForACK: ${error}`);
      }
    }
  }

  private async waitForByte(options: {signal: AbortSignal }): Promise<number> {
    const bytes = await this.waitForBytes(1, options);
    return bytes[0];
  }

  private async waitForBytes(count: number, options: {signal: AbortSignal }): Promise<Uint8Array> {
    while (this.receive.buffer.length < count) {
      try {
        const data = await this.dataChannel.demodulate({ signal: options.signal });
        if (options.signal.aborted) throw new Error('Operation aborted at waitForBytes');
        for (const byte of data) {
          this.receive.buffer.push(byte);
        }
      } catch (error) {
        // Handle demodulate() timeout/error - check AbortSignal to prevent infinite retry
        if (options.signal.aborted) {
          throw new Error('Operation aborted at waitForBytes');
        }
        // Handle abort exceptions from demodulate()
        if (error instanceof Error && this.isAbortError(error)) {
          throw new Error('Operation aborted at waitForBytes');
        }
        // For other errors, continue the loop (but this might lead to infinite retry)
        console.warn(`[XModemTransport] demodulate() error in waitForBytes: ${error}`);
        throw error; // Propagate non-abort errors
      }
    }
    const result = this.receive.buffer.slice(0, count);
    this.receive.buffer = this.receive.buffer.slice(count);
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
    const signals = [timeoutSignal];
    
    if (externalSignal) signals.push(externalSignal);
    if (this.operation.controller) signals.push(this.operation.controller.signal);
    
    return signals.length > 1 ? AbortSignal.any(signals) : timeoutSignal;
  }
  
  /**
   * Centralized state change management with logging and events
   */
  private stateChanged(newState: State, context?: string): void {
    const oldState = this.protocol.state;
    this.protocol.state = newState;
    
    // Create state change event
    const stateEvent = new Event({
      oldState: State[oldState],
      newState: State[newState],
      context: context || '',
      timestamp: Date.now()
    } as StateChangeEvent);
    
    // Unified logging format
    const contextStr = context ? ` (${context})` : '';
    console.log(`[XModemTransport:${this.config.name}] State: ${State[oldState]} -> ${State[newState]}${contextStr}`);

    // Emit state change event for debugging and testing
    this.emit('statechange', stateEvent);
  }
  
  /**
   * Ensure transport is in IDLE state before starting new operation
   */
  private ensureIdle(operation: string): void {
    if (this.protocol.state !== State.IDLE) {
      throw new Error(`Transport busy: ${operation} cannot start while in ${State[this.protocol.state]} state`);
    }
  }

  /**
   * Check if an error is an abort-related error
   */
  private isAbortError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('aborted') ||
      message.includes('abort') ||
      error.name === 'AbortError' ||
      error.name === 'DOMException'
    );
  }

  /**
   * Unified abort checking
   */
  private checkAbort(externalSignal?: AbortSignal): void {
    if (externalSignal?.aborted || this.operation.controller?.signal.aborted) {
      throw new Error('Operation aborted');
    }
  }

  /**
   * Execute operation with retry logic and abort checking
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number,
    onRetry?: (_retryCount: number) => void,
    externalSignal?: AbortSignal
  ): Promise<T> {
    let retries = 0;
    
    for (;;) {
      this.checkAbort(externalSignal);
      
      try {
        return await operation();
      } catch (error) {
        // Check if it's an abort error - don't retry abort errors
        if (error instanceof Error && this.isAbortError(error)) {
          throw new Error('Operation aborted');
        }
        
        if (++retries > maxRetries) {
          throw new Error('Timeout - max retries exceeded');
        }
        
        onRetry?.(retries);
      }
    }
  }


}
