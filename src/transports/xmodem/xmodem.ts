/**
 * XModem transport protocol implementation - Simple state machine
 * 
 * ## State Transition Diagram
 * 
 * ```
 * IDLE
 *   ├─ sendData() ──┐
 *   │               ├── Start processing loop
 *   │               └── Send first packet
 *   │                   └─ SENDING ──────┐
 *   │                                    │
 *   └─ receiveData() ────────────────────┼── Start processing loop
 *                                        │   └─ RECEIVING
 *                                        │
 * Processing Loop (single demodulate point):                                      
 *   ┌─ while (loopRunning && state !== IDLE) ──┐
 *   │     │                                    │
 *   │     ├─ data = await demodulate()         │
 *   │     └─ processIncomingData(data) ────────┼─ handleControlPacket()
 *   │                                          │   │
 *   │  SENDING state:                          │   ├─ ACK → fragmentIndex++
 *   │    ├─ Timeout → retransmit               │   │         ├─ More fragments? → Send next
 *   │    ├─ ACK → next fragment or EOT        │   │         └─ All done? → Send EOT → completeSend() → IDLE
 *   │    ├─ NAK → retransmit                  │   │
 *   │    └─ Max retries → failSend() → IDLE   │   └─ NAK → retransmit
 *   │                                          │
 *   │  RECEIVING state:                        │   ├─ EOT → completeReceive() → IDLE
 *   │    ├─ Expected sequence → ACK            │   │
 *   │    └─ Wrong sequence → NAK               └─ handleDataPacket()
 *   │                                              │
 *   └─ Loop exits when state = IDLE               ├─ Correct sequence → save data, send ACK
 *                                                  └─ Wrong sequence → send NAK
 * 
 * ## Key Design Principles:
 * 1. Single demodulate() call point - eliminates race conditions
 * 2. Simple 3-state machine: IDLE/SENDING/RECEIVING  
 * 3. Processing loop handles all incoming data
 * 4. Timeouts only for ACK waiting during send
 * 5. Clean state transitions with loopRunning control
 * ```
 */

import { BaseTransport, IDataChannel, Event } from '../../core';
import { XModemPacket } from './packet';
import { DataPacket, ControlPacket, ControlType } from './types';

export interface XModemConfig {
  timeoutMs: number;
  maxRetries: number;
  maxPayloadSize: number;
}

enum State {
  IDLE,
  SENDING,
  RECEIVING
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
      this.state = State.SENDING;
      this.sequence = 1;
      this.fragmentIndex = 0;
      this.retries = 0;
      this.fragments = this.createFragments(data);
      
      // Start processing loop first, then send packet
      this.ensureProcessingLoop();
      
      // Send first packet
      this.sendCurrentFragment();
    });
  }

  async receiveData(): Promise<Uint8Array> {
    if (this.state !== State.IDLE) {
      throw new Error('Transport busy');
    }

    return new Promise((resolve, reject) => {
      this.receiveResolve = resolve;
      this.receiveReject = reject;
      
      // Setup receive state
      this.state = State.RECEIVING;
      this.expectedSequence = 1;
      this.receivedData = [];
      
      // Start processing loop to wait for incoming data
      this.ensureProcessingLoop();
    });
  }

  async sendControl(command: string): Promise<void> {
    const controlType = this.parseControlCommand(command);
    const packet = XModemPacket.createControl(controlType);
    const serialized = XModemPacket.serialize(packet);
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
        if (this.state === State.SENDING && this.sendReject) {
          this.sendReject(new Error(`Demodulation failed: ${error}`));
          this.state = State.IDLE;
        } else if (this.state === State.RECEIVING && this.receiveReject) {
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
      return; // 空データはスキップ
    }
    
    const result = XModemPacket.parse(data);
    if (result.error || !result.packet) {
      // Emit error event for invalid packets
      this.emit('error', new Event(result.error || 'Invalid packet data'));
      return;
    }

    const packet = result.packet;
    
    if (packet.sequence === 0) {
      // Control packet
      await this.handleControlPacket(packet as ControlPacket);
    } else {
      // Data packet
      await this.handleDataPacket(packet as DataPacket);
    }
  }

  private async handleControlPacket(packet: ControlPacket): Promise<void> {
    if (this.state === State.SENDING) {
      switch (packet.control) {
        case ControlType.ACK:
          this.fragmentIndex++;
          this.sequence = (this.sequence % 255) + 1;
          this.retries = 0;
          
          if (this.fragmentIndex >= this.fragments.length) {
            // All fragments sent, send EOT and complete
            await this.sendControl('EOT');
            this.completeSend();
          } else {
            // Send next fragment
            await this.sendCurrentFragment();
          }
          break;
          
        case ControlType.NAK:
          this.retries++;
          if (this.retries > this.config.maxRetries) {
            this.failSend(new Error('Max retries exceeded'));
          } else {
            await this.sendCurrentFragment();
            this.statistics.packetsRetransmitted++;
          }
          break;
      }
    } else if (this.state === State.RECEIVING) {
      switch (packet.control) {
        case ControlType.EOT:
          this.completeReceive();
          break;
      }
    }
  }

  private async handleDataPacket(packet: DataPacket): Promise<void> {
    if (this.state !== State.RECEIVING) {
      return;
    }

    this.statistics.packetsReceived++;

    if (packet.sequence === this.expectedSequence) {
      // Expected packet - accept it
      this.receivedData.push(packet.payload);
      this.expectedSequence = (this.expectedSequence % 255) + 1;
      await this.sendControl('ACK');
      this.statistics.bytesTransferred += packet.payload.length;
    } else {
      // Unexpected sequence - reject it
      await this.sendControl('NAK');
      this.statistics.packetsDropped++;
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
      
      await this.dataChannel.modulate(serialized);
      this.statistics.packetsSent++;
      
      // Set timeout for ACK
      setTimeout(() => {
        if (this.state === State.SENDING && this.fragmentIndex < this.fragments.length) {
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
      case 'ENQ': return ControlType.ENQ;
      case 'CAN': return ControlType.CAN;
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
