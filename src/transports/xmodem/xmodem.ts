/**
 * XModem transport protocol implementation
 * 
 * Implements ITransport interface with Stop-and-Wait ARQ,
 * data fragmentation, and error recovery.
 */

import { BaseTransport, Event, IModulator } from '../../core';
import { XModemPacket } from './packet';
import { DataPacket, ControlPacket, ControlType } from './types';

/**
 * XModem transport configuration
 */
export interface XModemConfig {
  timeoutMs: number;        // Timeout for acknowledgment (default: 3000ms)
  maxRetries: number;       // Maximum retransmission attempts (default: 10)
  maxPayloadSize: number;   // Maximum payload per packet (default: 128)
}

/**
 * XModem transport state
 */
enum XModemState {
  IDLE = 'idle',
  SENDING = 'sending',
  RECEIVING = 'receiving',
  WAITING_ACK = 'waiting_ack',
  ERROR = 'error'
}

/**
 * XModem transport implementation
 * 
 * Provides reliable data transmission using XModem protocol with:
 * - Stop-and-Wait ARQ for error recovery
 * - Automatic data fragmentation and reassembly
 * - Configurable timeouts and retry limits
 * - Full duplex communication support
 */
export class XModemTransport extends BaseTransport {
  readonly transportName = 'XModem';

  private config: XModemConfig = {
    timeoutMs: 3000,
    maxRetries: 10,
    maxPayloadSize: 128
  };

  private state = XModemState.IDLE;
  private currentSequence = 1;
  private expectedSequence = 1;
  private timeoutHandle?: NodeJS.Timeout;
  private retryCount = 0;

  // Buffers for fragmentation/reassembly
  private sendBuffer: Uint8Array[] = [];
  private receiveBuffer: Uint8Array[] = [];
  private currentSendIndex = 0;

  // Promise resolvers for async operations
  private sendResolve?: (value: void) => void;
  private sendReject?: (reason?: Error) => void;
  private receiveResolve?: (value: Uint8Array) => void;
  private receiveReject?: (reason?: Error) => void;

  constructor(modulator: IModulator) {
    super(modulator);
    this.setupModulatorEvents();
  }

  private setupModulatorEvents(): void {
    // Listen for incoming data from modulator
    this.modulator.on('data', (event: Event) => {
      this.handleIncomingPacket(event.data as Uint8Array);
    });
  }

  /**
   * Configure transport parameters
   */
  configure(config: Partial<XModemConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): XModemConfig {
    return { ...this.config };
  }

  /**
   * Handle incoming packet from modulator
   */
  private async handleIncomingPacket(data: Uint8Array): Promise<void> {
    try {
      const packet = XModemPacket.parse(data);
      
      if (packet.type === 'data') {
        await this.handleDataPacket(packet as DataPacket);
      } else if (packet.type === 'control') {
        await this.handleControlPacket(packet as ControlPacket);
      }
    } catch (error) {
      // Invalid packet, ignore or send NAK
      console.warn('Invalid packet received:', error);
    }
  }

  /**
   * Send data reliably with fragmentation and retransmission
   */
  async sendData(data: Uint8Array): Promise<void> {
    if (this.state !== XModemState.IDLE) {
      throw new Error(`Cannot send: transport busy (${this.state})`);
    }

    return new Promise<void>((resolve, reject) => {
      this.sendResolve = resolve;
      this.sendReject = reject;
      
      try {
        this.startSendOperation(data);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Receive data with reassembly
   */
  async receiveData(): Promise<Uint8Array> {
    if (this.state !== XModemState.IDLE) {
      throw new Error(`Cannot receive: transport busy (${this.state})`);
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      this.receiveResolve = resolve;
      this.receiveReject = reject;
      
      this.startReceiveOperation();
    });
  }

  /**
   * Send control command
   */
  async sendControl(command: string): Promise<void> {
    let controlType: ControlType;
    switch (command.toUpperCase()) {
      case 'ACK': controlType = ControlType.ACK; break;
      case 'NAK': controlType = ControlType.NAK; break;
      case 'EOT': controlType = ControlType.EOT; break;
      case 'ENQ': controlType = ControlType.ENQ; break;
      case 'CAN': controlType = ControlType.CAN; break;
      default:
        throw new Error(`Unknown control command: ${command}`);
    }

    const packet = XModemPacket.createControl(controlType);
    const serialized = XModemPacket.serialize(packet);
    await this.modulator.modulateData(serialized);
    
    this.statistics.packetsSent++;
  }

  /**
   * Check if transport is ready
   */
  isReady(): boolean {
    return this.state === XModemState.IDLE && this.modulator.isReady();
  }

  /**
   * Reset transport state
   */
  reset(): void {
    this.clearTimeout();
    
    // Store reject functions before clearing state
    const sendReject = this.sendReject;
    const receiveReject = this.receiveReject;
    
    // Clear state and promise handlers immediately to prevent future timeout issues
    this.state = XModemState.IDLE;
    this.currentSequence = 1;
    this.expectedSequence = 1;
    this.retryCount = 0;
    this.sendBuffer = [];
    this.receiveBuffer = [];
    this.currentSendIndex = 0;
    this.sendResolve = undefined;
    this.sendReject = undefined;
    this.receiveResolve = undefined;
    this.receiveReject = undefined;
    
    // Reject pending operations only if there were active promises
    if (sendReject) {
      sendReject(new Error('Transport reset'));
    }
    if (receiveReject) {
      receiveReject(new Error('Transport reset'));
    }
    
    super.reset();
  }
  
  /**
   * Dispose transport and cleanup resources
   */
  dispose(): void {
    this.clearTimeout();
    
    // Clear all state without rejecting promises to avoid unhandled rejections
    this.state = XModemState.IDLE;
    this.sendResolve = undefined;
    this.sendReject = undefined;
    this.receiveResolve = undefined;
    this.receiveReject = undefined;
    
    this.removeAllListeners();
  }

  /**
   * Process incoming packet data
   */
  async processIncomingData(data: Uint8Array): Promise<void> {
    const result = XModemPacket.parse(data);
    
    if (result.error) {
      this.emit('error', new Event(`Packet parse error: ${result.error}`));
      return;
    }

    const packet = result.packet!;
    
    if (packet.sequence === 0) {
      // Control packet
      await this.handleControlPacket(packet as ControlPacket);
    } else {
      // Data packet
      await this.handleDataPacket(packet as DataPacket);
    }
  }

  // Private methods

  private startSendOperation(data: Uint8Array): void {
    this.state = XModemState.SENDING;
    this.sendBuffer = this.fragmentData(data);
    this.currentSendIndex = 0;
    this.sendNextFragment();
  }

  private startReceiveOperation(): void {
    this.state = XModemState.RECEIVING;
    this.receiveBuffer = [];
    this.expectedSequence = 1;
  }

  private fragmentData(data: Uint8Array): Uint8Array[] {
    const fragments: Uint8Array[] = [];
    const { maxPayloadSize } = this.config;
    
    for (let offset = 0; offset < data.length; offset += maxPayloadSize) {
      const fragmentSize = Math.min(maxPayloadSize, data.length - offset);
      const fragment = data.slice(offset, offset + fragmentSize);
      fragments.push(fragment);
    }
    
    return fragments.length > 0 ? fragments : [new Uint8Array(0)];
  }

  private async sendNextFragment(): Promise<void> {
    if (this.currentSendIndex >= this.sendBuffer.length) {
      // All fragments sent, send EOT
      await this.sendControl('EOT');
      this.completeSendOperation();
      return;
    }

    const fragment = this.sendBuffer[this.currentSendIndex];
    const packet = XModemPacket.createData(this.currentSequence, fragment);
    const serialized = XModemPacket.serialize(packet);
    
    this.state = XModemState.WAITING_ACK;
    this.retryCount = 0;
    
    await this.sendPacketWithTimeout(serialized);
  }

  private async sendPacketWithTimeout(serialized: Uint8Array): Promise<void> {
    // Only proceed if we're still in valid state
    if (this.state !== XModemState.SENDING && this.state !== XModemState.WAITING_ACK) {
      return;
    }
    
    try {
      await this.modulator.modulateData(serialized);
      this.statistics.packetsSent++;
      
      // Clear any existing timeout first
      this.clearTimeout();
      
      // Start timeout for ACK only if still in valid state
      if (this.state === XModemState.WAITING_ACK && this.sendReject) {
        this.timeoutHandle = setTimeout(() => {
          this.handleTimeout();
        }, this.config.timeoutMs);
      }
      
    } catch (error) {
      // Only fail if we're still in valid state
      if (this.sendReject) {
        this.failSendOperation(new Error(`Send failed: ${error}`));
      }
    }
  }

  private handleTimeout(): void {
    // Check if we're still in a valid state for timeout handling
    if (this.state !== XModemState.WAITING_ACK || !this.sendReject) {
      return;
    }
    
    if (this.retryCount >= this.config.maxRetries) {
      this.failSendOperation(new Error('Max retries exceeded'));
      return;
    }
    
    this.retryCount++;
    this.statistics.packetsRetransmitted++;
    
    // Resend current packet
    if (this.currentSendIndex < this.sendBuffer.length) {
      const fragment = this.sendBuffer[this.currentSendIndex];
      const packet = XModemPacket.createData(this.currentSequence, fragment);
      const serialized = XModemPacket.serialize(packet);
      // Don't use async here - just schedule the packet send
      this.sendPacketWithTimeout(serialized);
    }
  }

  private async handleControlPacket(packet: ControlPacket): Promise<void> {
    switch (packet.control) {
      case ControlType.ACK:
        if (this.state === XModemState.WAITING_ACK) {
          this.clearTimeout();
          this.currentSequence = (this.currentSequence % 255) + 1;
          this.currentSendIndex++;
          this.state = XModemState.SENDING;
          await this.sendNextFragment();
        }
        break;
        
      case ControlType.NAK:
        if (this.state === XModemState.WAITING_ACK) {
          this.clearTimeout();
          this.statistics.packetsRetransmitted++;
          // Resend current packet
          const fragment = this.sendBuffer[this.currentSendIndex];
          const dataPacket = XModemPacket.createData(this.currentSequence, fragment);
          const serialized = XModemPacket.serialize(dataPacket);
          await this.sendPacketWithTimeout(serialized);
        }
        break;
        
      case ControlType.EOT:
        if (this.state === XModemState.RECEIVING) {
          this.completeReceiveOperation();
        }
        break;
        
      default:
        this.emit('control', new Event({ type: packet.control }));
    }
  }

  private async handleDataPacket(packet: DataPacket): Promise<void> {
    if (this.state !== XModemState.RECEIVING) {
      return;
    }

    this.statistics.packetsReceived++;

    if (packet.sequence === this.expectedSequence) {
      // Expected packet
      this.receiveBuffer.push(packet.payload);
      this.expectedSequence = (this.expectedSequence % 255) + 1;
      await this.sendControl('ACK');
      this.statistics.bytesTransferred += packet.payload.length;
    } else {
      // Unexpected sequence - request retransmission
      await this.sendControl('NAK');
      this.statistics.packetsDropped++;
    }
  }

  private completeSendOperation(): void {
    this.clearTimeout();
    this.state = XModemState.IDLE;
    this.statistics.bytesTransferred += this.sendBuffer.reduce((sum, buf) => sum + buf.length, 0);
    
    if (this.sendResolve) {
      const resolve = this.sendResolve;
      this.sendResolve = undefined;
      this.sendReject = undefined;
      resolve();
    }
    
    this.emit('sendComplete');
  }

  private completeReceiveOperation(): void {
    this.state = XModemState.IDLE;
    
    // Reassemble received data
    const totalLength = this.receiveBuffer.reduce((sum, buf) => sum + buf.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    
    for (const buffer of this.receiveBuffer) {
      result.set(buffer, offset);
      offset += buffer.length;
    }
    
    if (this.receiveResolve) {
      this.receiveResolve(result);
      this.receiveResolve = undefined;
      this.receiveReject = undefined;
    }
    
    this.emit('receiveComplete');
  }

  private failSendOperation(error: Error): void {
    this.clearTimeout();
    
    // Only process if we have a valid reject function
    if (this.sendReject) {
      const reject = this.sendReject;
      // Clear the promise handlers before calling reject
      this.sendResolve = undefined;
      this.sendReject = undefined;
      this.state = XModemState.IDLE;
      
      // Call reject immediately - the caller should handle it
      reject(error);
      this.emit('error', new Event(error));
    }
  }

  private clearTimeout(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
  }
}