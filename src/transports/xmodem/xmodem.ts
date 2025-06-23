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
  private ackTimeout?: ReturnType<typeof setTimeout>;
  
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

    return new Promise((resolve, reject) => {
      this.sendResolve = resolve;
      this.sendReject = reject;
      
      // Setup send state
      this.state = State.SENDING_WAIT_NAK;
      this.sequence = 1;
      this.fragmentIndex = 0;
      this.retries = 0;
      this.fragments = this.createFragments(data);
      
      // Start processing loop and wait for NAK from receiver
      this.ensureProcessingLoop();
    });
  }

  async receiveData(): Promise<Uint8Array> {
    if (this.state !== State.IDLE) {
      throw new Error('Transport busy');
    }

    return new Promise((resolve, reject) => {
      this.receiveResolve = resolve;
      this.receiveReject = reject;
      
      // Setup receive state and send initial NAK
      this.state = State.RECEIVING_SEND_NAK;
      this.expectedSequence = 1;
      this.receivedData = [];
      this.receiveBuffer = [];
      
      // Start processing loop and send NAK to initiate transfer
      this.ensureProcessingLoop();
      this.sendNAKToInitiate();
    });
  }
  
  private async sendNAKToInitiate(): Promise<void> {
    try {
      await this.sendControl('NAK');
      this.state = State.RECEIVING_WAIT_BLOCK;
    } catch (error) {
      this.failReceive(new Error(`Failed to send initial NAK: ${error}`));
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

  // Ensure processing loop is running
  private ensureProcessingLoop(): void {
    if (!this.loopRunning) {
      this.loopRunning = true;
      this.startProcessingLoop();
    }
  }

  // Core processing loop - single demodulate point
  private async startProcessingLoop(): Promise<void> {
    while (this.loopRunning && this.state !== State.IDLE) {
      try {
        const data = await this.dataChannel.demodulate();
        await this.processIncomingData(data);
      } catch (error) {
        // Handle errors based on current state
        if ((this.state === State.SENDING_WAIT_NAK || this.state === State.SENDING_WAIT_ACK || this.state === State.SENDING_WAIT_FINAL_ACK) && this.sendReject) {
          this.sendReject(new Error(`Demodulation failed: ${error}`));
          this.state = State.IDLE;
        } else if ((this.state === State.RECEIVING_SEND_NAK || this.state === State.RECEIVING_WAIT_BLOCK || this.state === State.RECEIVING_SEND_ACK) && this.receiveReject) {
          this.receiveReject(new Error(`Demodulation failed: ${error}`));
          this.state = State.IDLE;
        }
        break;
      }
    }
    this.loopRunning = false;
  }

  private async processIncomingData(data: Uint8Array): Promise<void> {
    if (data.length === 0) {
      return;
    }
    
    // Add all bytes to receive buffer
    for (const byte of data) {
      this.receiveBuffer.push(byte);
      
      // Check for complete packet or control command
      await this.processReceiveBuffer();
    }
  }
  
  private async processReceiveBuffer(): Promise<void> {
    // Check for control commands first (single byte)
    if (this.receiveBuffer.length === 1) {
      const byte = this.receiveBuffer[0];
      if (this.isControlByte(byte)) {
        this.receiveBuffer = []; // Clear buffer
        await this.handleControlCommand(byte as ControlType);
        return;
      }
    }
    
    // Check for complete data packet
    const completePacket = this.extractCompletePacket();
    if (completePacket) {
      const result = XModemPacket.parse(completePacket);
      console.log(`[XModemTransport] Received packet:`, result);
      if (result.error || !result.packet) {
        this.emit('error', new Event(result.error || 'Invalid packet data'));
        return;
      }
      await this.handleDataPacket(result.packet);
    }
  }
  
  private extractCompletePacket(): Uint8Array | null {
    if (this.receiveBuffer.length < 6) {
      return null; // Minimum packet size
    }
    
    // Check if starts with SOH
    if (this.receiveBuffer[0] !== 0x01) {
      // Invalid start, clear buffer
      this.receiveBuffer = [];
      return null;
    }
    
    // Get expected packet length
    if (this.receiveBuffer.length < 4) {
      return null; // Need LEN field
    }
    
    const len = this.receiveBuffer[3];
    const expectedLength = 1 + 1 + 1 + 1 + len + 2; // SOH+SEQ+~SEQ+LEN+PAYLOAD+CRC
    
    if (this.receiveBuffer.length < expectedLength) {
      return null; // Incomplete packet
    }
    
    // Extract complete packet
    const packetBytes = this.receiveBuffer.slice(0, expectedLength);
    this.receiveBuffer = this.receiveBuffer.slice(expectedLength);
    
    // Validate packet structure
    if (!this.validatePacketStructure(packetBytes)) {
      return null;
    }
    
    return new Uint8Array(packetBytes);
  }
  
  private validatePacketStructure(packetBytes: number[]): boolean {
    if (packetBytes.length < 6) return false;
    
    // Check SEQ + ~SEQ = 255
    if ((packetBytes[1] + packetBytes[2]) !== 255) {
      return false;
    }
    
    // CRC validation will be done by XModemPacket.parse()
    return true;
  }
  
  private isControlByte(byte: number): boolean {
    return byte === ControlType.ACK || byte === ControlType.NAK || byte === ControlType.EOT;
  }

  private async handleControlCommand(controlType: ControlType): Promise<void> {
    switch (this.state) {
      case State.SENDING_WAIT_NAK:
        if (controlType === ControlType.NAK) {
          // Receiver is ready, start sending
          this.state = State.SENDING_WAIT_ACK;
          await this.sendCurrentFragment();
        }
        break;
        
      case State.SENDING_WAIT_ACK:
        if (controlType === ControlType.ACK) {
          // Block acknowledged, send next or complete
          this.fragmentIndex++;
          this.sequence = (this.sequence % 255) + 1;
          this.retries = 0;
          
          if (this.fragmentIndex >= this.fragments.length) {
            // All fragments sent, send EOT
            this.state = State.SENDING_WAIT_FINAL_ACK;
            await this.sendControl('EOT');
          } else {
            // Send next fragment
            await this.sendCurrentFragment();
          }
        } else if (controlType === ControlType.NAK) {
          // Block rejected, retransmit
          this.retries++;
          if (this.retries > this.config.maxRetries) {
            this.failSend(new Error('Max retries exceeded'));
          } else {
            await this.sendCurrentFragment();
            this.statistics.packetsRetransmitted++;
          }
        }
        break;
        
      case State.SENDING_WAIT_FINAL_ACK:
        if (controlType === ControlType.ACK) {
          // Transfer complete
          this.completeSend();
        }
        break;
        
      case State.RECEIVING_WAIT_BLOCK:
      case State.RECEIVING_SEND_ACK:
        if (controlType === ControlType.EOT) {
          // Transfer complete, send final ACK
          await this.sendControl('ACK');
          this.completeReceive();
        }
        break;
    }
  }

  private async handleDataPacket(packet: DataPacket): Promise<void> {
    if (this.state !== State.RECEIVING_WAIT_BLOCK && this.state !== State.RECEIVING_SEND_ACK) {
      return;
    }

    if (packet.sequence === this.expectedSequence) {
      // Expected packet - accept it
      this.statistics.packetsReceived++;
      this.receivedData.push(packet.payload);
      this.expectedSequence = (this.expectedSequence % 255) + 1;
      this.state = State.RECEIVING_SEND_ACK;
      await this.sendControl('ACK');
      this.state = State.RECEIVING_WAIT_BLOCK; // Wait for next block
      this.statistics.bytesTransferred += packet.payload.length;
    } else {
      // Unexpected sequence - reject it
      this.statistics.packetsDropped++;
      this.state = State.RECEIVING_SEND_ACK;
      await this.sendControl('NAK');
      this.state = State.RECEIVING_WAIT_BLOCK; // Wait for retransmission
    }
  }

  private async sendCurrentFragment(): Promise<void> {
    if (this.fragmentIndex >= this.fragments.length) {
      return;
    }

    try {
      const fragment = this.fragments[this.fragmentIndex];
      const packet = XModemPacket.createData(this.sequence, fragment);
      const serialized = XModemPacket.serialize(packet);
      
      console.log(`[XModemTransport] Sending fragment ${this.fragmentIndex + 1}/${this.fragments.length}, sequence: ${this.sequence}`);
      await this.dataChannel.modulate(serialized);
      this.statistics.packetsSent++;
      
      // Set timeout for ACK
      if (this.ackTimeout) {
        clearTimeout(this.ackTimeout);
      }
      this.ackTimeout = setTimeout(() => {
        if (this.state === State.SENDING_WAIT_ACK && this.fragmentIndex < this.fragments.length) {
          console.warn(`[XModemTransport] Timeout waiting for ACK for fragment ${this.fragmentIndex + 1}`);
          this.retries++;
          if (this.retries > this.config.maxRetries) {
            this.failSend(new Error('Timeout - max retries exceeded'));
          } else {
            this.sendCurrentFragment();
            this.statistics.packetsRetransmitted++;
          }
        }
      }, this.config.timeoutMs);
    } catch (error) {
      // Handle modulation errors
      this.failSend(new Error(`Send failed: ${error}`));
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

  private completeSend(): void {
    this.state = State.IDLE;
    this.statistics.bytesTransferred += this.fragments.reduce((sum, f) => sum + f.length, 0);
    if (this.sendResolve) {
      this.sendResolve();
      this.sendResolve = undefined;
      this.sendReject = undefined;
    }
    this.loopRunning = false;
  }

  private failSend(error: Error): void {
    this.state = State.IDLE;
    if (this.sendReject) {
      this.sendReject(error);
      this.sendResolve = undefined;
      this.sendReject = undefined;
    }
    this.loopRunning = false;
  }
  
  private failReceive(error: Error): void {
    this.state = State.IDLE;
    if (this.receiveReject) {
      this.receiveReject(error);
      this.receiveResolve = undefined;
      this.receiveReject = undefined;
    }
    this.loopRunning = false;
  }

  private completeReceive(): void {
    this.state = State.IDLE;
    
    // Reassemble data
    const totalLength = this.receivedData.reduce((sum, d) => sum + d.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    
    for (const data of this.receivedData) {
      result.set(data, offset);
      offset += data.length;
    }
    
    if (this.receiveResolve) {
      this.receiveResolve(result);
      this.receiveResolve = undefined;
      this.receiveReject = undefined;
    }
    this.loopRunning = false;
  }
}
