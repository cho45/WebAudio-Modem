# Phase2 パケットプロトコル設計仕様書

## 概要

WebAudio-Modem Phase2では、バイトフレーミング層の上にパケットプロトコル層を実装し、信頼性の高いデータ伝送を実現する。既存の標準プロトコルを参考に、Web Audio環境に最適化された軽量なパケットプロトコルを設計する。

## 設計方針

### 1. 既存標準プロトコルの分析

#### XMODEM系プロトコル
- **XMODEM-CRC**: 128バイト固定長 + CRC-16
- **利点**: シンプル、モデム伝送での実績
- **課題**: 固定長による効率性の問題

#### HDLC (High-Level Data Link Control)
- **RFC 1662**: バイト詰め込み、可変長フレーム
- **利点**: 業界標準、データ透過性
- **課題**: バイト詰め込みのオーバーヘッド

#### ITU-T V.42 (LAPM)
- **利点**: モデム専用エラー制御プロトコル
- **課題**: 実装が複雑

### 2. WebAudio-Modem向け最適化

#### 設計制約
- **実行環境**: ブラウザ、TypeScript、AudioWorklet
- **伝送路**: 音声チャネル、ノイズ・歪みが多い
- **用途**: ファイル転送、リアルタイム通信
- **パフォーマンス**: 低遅延、低CPU使用率

#### 選択した基本方式
**Enhanced XMODEM-CRC**をベースとし、以下の拡張を行う：
- CRC-16による強力なエラー検出
- 可変長ペイロード対応
- シーケンス番号による順序制御
- 適応的再送制御

## プロトコル仕様

### 1. パケット構造

```
┌──────────┬──────────┬──────────┬──────────┬──────────────┬──────────┐
│   SOH    │   SEQ    │  ~SEQ    │   LEN    │   PAYLOAD    │  CRC-16  │
│  (1byte) │ (1byte)  │ (1byte)  │ (1byte)  │  (0-255byte) │ (2byte)  │
└──────────┴──────────┴──────────┴──────────┴──────────────┴──────────┘
```

#### フィールド詳細

| フィールド | サイズ | 値 | 説明 |
|------------|--------|-----|------|
| SOH | 1byte | 0x01 | Start of Header - パケット開始マーカー |
| SEQ | 1byte | 0x00-0xFF | シーケンス番号 (循環) |
| ~SEQ | 1byte | ~SEQ | SEQのビット補数 (エラー検出) |
| LEN | 1byte | 0x00-0xFF | ペイロード長 (バイト数) |
| PAYLOAD | 0-255byte | データ | 実際のペイロードデータ |
| CRC-16 | 2byte | CRC値 | CRC-16-CCITT (多項式: 0x1021) |

### 2. パケット種別

#### データパケット (Data Packet)
```typescript
interface DataPacket {
  soh: 0x01;
  sequence: number;    // 0x01-0xFF (0x00は制御用に予約)
  invSequence: number; // ~sequence
  length: number;      // ペイロード長 (0-255)
  payload: Uint8Array; // 実データ (0-255byte)
  crc16: number;       // CRC-16-CCITT
}
```

#### 制御パケット (Control Packet)
```typescript
interface ControlPacket {
  soh: 0x01;
  sequence: 0x00;     // 制御パケット識別子
  invSequence: 0xFF;  // 0x00の補数
  length: 0x01;       // 制御データ長(固定1byte)
  control: ControlType;
  crc16: number;
}

enum ControlType {
  ACK = 0x06,         // Acknowledge
  NAK = 0x15,         // Negative Acknowledge  
  EOT = 0x04,         // End of Transmission
  ENQ = 0x05,         // Enquiry
  CAN = 0x18          // Cancel
}
```

### 3. エラー検出・訂正方式

#### CRC-16-CCITT
- **多項式**: 0x1021 (x^16 + x^12 + x^5 + 1)
- **初期値**: 0xFFFF
- **最終XOR**: 0x0000
- **検出能力**: 2ビットエラーまで確実に検出

```typescript
class CRC16 {
  private static readonly POLYNOMIAL = 0x1021;
  private static readonly INITIAL_VALUE = 0xFFFF;
  
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
        crc &= 0xFFFF;
      }
    }
    
    return crc;
  }
}
```

#### Forward Error Correction (将来拡張)
Phase3以降で以下のFEC方式を検討：
- **Reed-Solomon符号**: ブロック符号、強力な誤り訂正
- **Hamming符号**: 軽量、1ビット誤り訂正
- **BCH符号**: 設計の柔軟性、効率的な実装

### 4. フロー制御・再送制御

#### Stop-and-Wait ARQ
Phase2では最もシンプルなStop-and-Wait方式を採用：

```typescript
class StopAndWaitProtocol {
  private currentSequence = 1;
  private retryCount = 0;
  private readonly maxRetries = 5;
  private readonly timeoutMs = 1000;
  
  async sendPacket(data: Uint8Array): Promise<void> {
    const packet = this.createDataPacket(data);
    
    while (this.retryCount <= this.maxRetries) {
      await this.transmitPacket(packet);
      
      const response = await this.waitForResponse(this.timeoutMs);
      
      if (response?.type === 'ACK' && response.sequence === this.currentSequence) {
        this.currentSequence = (this.currentSequence + 1) % 256;
        this.retryCount = 0;
        return;
      }
      
      if (response?.type === 'NAK') {
        this.retryCount++;
        continue; // 再送
      }
      
      // タイムアウト
      this.retryCount++;
    }
    
    throw new Error('Max retries exceeded');
  }
}
```

#### 適応的タイムアウト
ボーレートとパケットサイズに基づく動的タイムアウト計算：

```typescript
class AdaptiveTimeout {
  calculateTimeout(baudRate: number, packetSize: number): number {
    const transmissionTime = (packetSize * 8) / baudRate * 1000; // ms
    const processingDelay = 100; // 処理遅延
    const networkJitter = 200;   // ネットワーク揺らぎ
    
    return transmissionTime * 2 + processingDelay + networkJitter;
  }
}
```

### 5. データ分割・再構築

#### チャンキング戦略
大容量データを効率的に分割送信：

```typescript
interface ChunkingStrategy {
  readonly chunkSize: number;
  readonly maxChunks: number;
  
  splitData(data: Uint8Array): Uint8Array[];
  reassembleData(chunks: Map<number, Uint8Array>): Uint8Array;
}

class FixedSizeChunking implements ChunkingStrategy {
  readonly chunkSize = 128;     // バイト
  readonly maxChunks = 255;     // シーケンス番号の制限
  
  splitData(data: Uint8Array): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    
    for (let i = 0; i < data.length; i += this.chunkSize) {
      const chunk = data.slice(i, i + this.chunkSize);
      chunks.push(chunk);
    }
    
    return chunks;
  }
  
  reassembleData(chunks: Map<number, Uint8Array>): Uint8Array {
    const sortedChunks = Array.from(chunks.entries())
      .sort(([a], [b]) => a - b)
      .map(([, chunk]) => chunk);
      
    const totalLength = sortedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    
    let offset = 0;
    for (const chunk of sortedChunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    
    return result;
  }
}
```

## 実装アーキテクチャ

### 1. クラス設計

```typescript
// src/protocols/packet-protocol.ts
export interface IPacketProtocol {
  sendData(data: Uint8Array): Promise<void>;
  receiveData(): Promise<Uint8Array>;
  configure(config: PacketProtocolConfig): void;
  getStatistics(): ProtocolStatistics;
}

export class XModemProtocol implements IPacketProtocol {
  private fskModulator: IModulator<FSKConfig>;
  private chunkingStrategy: ChunkingStrategy;
  private timeoutStrategy: AdaptiveTimeout;
  
  constructor(modulator: IModulator<FSKConfig>) {
    this.fskModulator = modulator;
    this.chunkingStrategy = new FixedSizeChunking();
    this.timeoutStrategy = new AdaptiveTimeout();
  }
  
  async sendData(data: Uint8Array): Promise<void> {
    const chunks = this.chunkingStrategy.splitData(data);
    
    for (const [index, chunk] of chunks.entries()) {
      const packet = this.createDataPacket(index + 1, chunk);
      await this.sendPacketWithRetry(packet);
    }
    
    await this.sendEOT();
  }
  
  private createDataPacket(sequence: number, data: Uint8Array): DataPacket {
    const totalLength = 4 + data.length + 2; // SOH+SEQ+~SEQ+LEN+PAYLOAD+CRC
    const packet = new Uint8Array(totalLength);
    
    packet[0] = 0x01;                    // SOH
    packet[1] = sequence & 0xFF;         // SEQ
    packet[2] = (~sequence) & 0xFF;      // ~SEQ
    packet[3] = data.length & 0xFF;      // LEN (ペイロード長)
    packet.set(data, 4);                 // PAYLOAD
    
    const crc = CRC16.calculate(packet.slice(0, -2));
    packet[packet.length - 2] = (crc >> 8) & 0xFF;    // CRC高位
    packet[packet.length - 1] = crc & 0xFF;           // CRC低位
    
    return {
      soh: 0x01,
      sequence,
      invSequence: (~sequence) & 0xFF,
      length: data.length,
      payload: data,
      crc16: crc
    };
  }
}
```

## クラス責任設計

### 責任分離の原則

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                        │
│  ProtocolBridge: アプリケーション I/F、高レベル操作        │
└─────────────────┬───────────────────────────────────────────┘
                  │ File, Blob, Stream
┌─────────────────▼───────────────────────────────────────────┐
│                    Protocol Layer                           │
│  XModemProtocol: パケット化、エラー制御、フロー制御         │
└─────────────────┬───────────────────────────────────────────┘
                  │ Uint8Array (raw packets)
┌─────────────────▼───────────────────────────────────────────┐
│                     FSK Layer                               │
│  FSKModulator: FSK変調/復調、バイトフレーミング            │
└─────────────────┬───────────────────────────────────────────┘
                  │ Float32Array (audio samples)
┌─────────────────▼───────────────────────────────────────────┐
│                   WebAudio Layer                            │
│  AudioWorklet: 音声入出力、リアルタイム処理                │
└─────────────────────────────────────────────────────────────┘
```

### 1. ProtocolBridge (Application Interface Layer)

**責任**:
- **アプリケーション向けAPI提供** - 高レベルな操作インターフェース
- **データ形式変換** - File/Blob ↔ Uint8Array
- **非同期処理管理** - Promise/async-await による統一的な非同期API
- **エラーハンドリング** - アプリケーション向けエラーの統一化
- **進捗報告** - ファイル転送進捗のイベント発行

```typescript
// src/protocols/protocol-bridge.ts
export interface TransferProgress {
  totalBytes: number;
  transferredBytes: number;
  progress: number; // 0.0 - 1.0
  estimatedTimeRemaining: number; // seconds
}

export interface ProtocolBridgeEvents {
  'progress': (progress: TransferProgress) => void;
  'error': (error: Error) => void;
  'transfer-complete': () => void;
  'connection-established': () => void;
  'connection-lost': () => void;
}

export class ProtocolBridge extends EventTarget {
  private packetProtocol: XModemProtocol;
  
  constructor(fskModulator: FSKModulator) {
    super();
    this.packetProtocol = new XModemProtocol(fskModulator);
    this.setupEventForwarding();
  }
  
  // === High-level Application APIs ===
  
  /**
   * ファイル転送 - アプリケーション向けAPI
   */
  async transmitFile(file: File): Promise<void> {
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      await this.transmitData(data, file.name);
    } catch (error) {
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
      throw error;
    }
  }
  
  /**
   * バイナリデータ転送
   */
  async transmitData(data: Uint8Array, filename?: string): Promise<void> {
    const metadata = this.createMetadata(data.length, filename);
    
    // 1. メタデータ送信
    await this.packetProtocol.sendData(metadata);
    
    // 2. 実データ送信（進捗監視付き）
    await this.sendDataWithProgress(data);
    
    this.dispatchEvent(new CustomEvent('transfer-complete'));
  }
  
  /**
   * ファイル受信
   */
  async receiveFile(): Promise<{ file: Blob; filename: string }> {
    // 1. メタデータ受信
    const metadataBytes = await this.packetProtocol.receiveData();
    const metadata = this.parseMetadata(metadataBytes);
    
    // 2. 実データ受信（進捗監視付き）
    const data = await this.receiveDataWithProgress(metadata.fileSize);
    
    return {
      file: new Blob([data]),
      filename: metadata.filename
    };
  }
  
  /**
   * テキストメッセージ送信
   */
  async sendMessage(message: string): Promise<void> {
    const data = new TextEncoder().encode(message);
    await this.packetProtocol.sendData(data);
  }
  
  /**
   * テキストメッセージ受信
   */
  async receiveMessage(): Promise<string> {
    const data = await this.packetProtocol.receiveData();
    return new TextDecoder().decode(data);
  }
  
  // === Private Helper Methods ===
  
  private async sendDataWithProgress(data: Uint8Array): Promise<void> {
    // プロトコル層のイベントを監視して進捗を計算
    // 詳細実装は省略
  }
  
  private createMetadata(fileSize: number, filename?: string): Uint8Array {
    // メタデータフォーマット作成
    // 詳細実装は省略
  }
}
```

### 2. XModemProtocol (Packet Protocol Layer)

**責任**:
- **パケット化** - データをパケット単位に分割・再構築
- **エラー制御** - CRC検証、ACK/NAK、再送制御
- **フロー制御** - Stop-and-Wait ARQ、タイムアウト管理
- **シーケンス管理** - パケット順序制御
- **統計情報** - プロトコルレベルの品質監視

```typescript
// src/protocols/xmodem-protocol.ts
export interface XModemProtocolEvents {
  'packet-sent': (sequence: number, retryCount: number) => void;
  'packet-received': (sequence: number) => void;
  'packet-retry': (sequence: number, retryCount: number) => void;
  'crc-error': (sequence: number) => void;
  'timeout': (sequence: number) => void;
}

export class XModemProtocol extends EventTarget {
  private fskModulator: IModulator<FSKConfig>;
  private chunkingStrategy: ChunkingStrategy;
  private statistics: ProtocolStatistics;
  
  constructor(fskModulator: IModulator<FSKConfig>) {
    super();
    this.fskModulator = fskModulator;
    this.chunkingStrategy = new FixedSizeChunking();
    this.statistics = new ProtocolStatistics();
  }
  
  // === Core Protocol Operations ===
  
  /**
   * データ送信 - パケット分割と確実配送
   */
  async sendData(data: Uint8Array): Promise<void> {
    const chunks = this.chunkingStrategy.splitData(data);
    
    for (const [index, chunk] of chunks.entries()) {
      const sequence = (index + 1) % 256;
      await this.sendPacketWithRetry(sequence, chunk);
    }
    
    await this.sendEOT();
  }
  
  /**
   * データ受信 - パケット受信と再構築
   */
  async receiveData(): Promise<Uint8Array> {
    const receivedChunks = new Map<number, Uint8Array>();
    let expectedSequence = 1;
    
    while (true) {
      const packet = await this.receivePacket();
      
      if (packet.type === 'EOT') break;
      if (packet.type !== 'DATA') continue;
      
      if (this.validatePacket(packet, expectedSequence)) {
        receivedChunks.set(packet.sequence, packet.payload);
        await this.sendACK(packet.sequence);
        expectedSequence = (expectedSequence + 1) % 256;
      } else {
        await this.sendNAK(packet.sequence);
      }
    }
    
    return this.chunkingStrategy.reassembleData(receivedChunks);
  }
  
  // === Packet-level Operations ===
  
  private async sendPacketWithRetry(sequence: number, data: Uint8Array): Promise<void> {
    let retryCount = 0;
    const maxRetries = 5;
    
    while (retryCount <= maxRetries) {
      const packet = this.createDataPacket(sequence, data);
      await this.transmitRawPacket(packet);
      
      this.dispatchEvent(new CustomEvent('packet-sent', { 
        detail: { sequence, retryCount } 
      }));
      
      const response = await this.waitForResponse(this.calculateTimeout());
      
      if (response?.type === 'ACK' && response.sequence === sequence) {
        this.statistics.recordSuccessfulTransmission(sequence, retryCount);
        return;
      }
      
      retryCount++;
      this.dispatchEvent(new CustomEvent('packet-retry', { 
        detail: { sequence, retryCount } 
      }));
    }
    
    throw new ProtocolError(`Max retries exceeded for sequence ${sequence}`);
  }
  
  // フロー制御、エラー制御の詳細メソッド...
}
```

### 3. FSKModulator (Physical Layer Interface)

**責任**:
- **FSK変調/復調** - デジタルデータ ↔ アナログ音声信号
- **バイトフレーミング** - start/stop bits、パリティ
- **信号品質監視** - SNR、BER測定
- **同期処理** - ビット同期、フレーム同期

```typescript
// src/modulators/fsk.ts (既存実装)
export class FSKModulator implements IModulator<FSKConfig> {
  // === IModulator Interface Implementation ===
  
  /**
   * バイト配列をFSK変調してオーディオサンプルに変換
   * - プロトコル層から受け取った生のパケットバイトを処理
   * - フレーミング（start/stop bits）を追加
   * - FSK変調を適用
   */
  modulateData(data: Uint8Array): Float32Array {
    // フレーミング + FSK変調の実装
  }
  
  /**
   * オーディオサンプルをFSK復調してバイト配列に変換
   * - 音声信号からFSK復調
   * - フレーム同期とビット判定
   * - バイト境界でデータを復元
   */
  demodulateData(samples: Float32Array): Uint8Array {
    // FSK復調 + フレーム解析の実装
  }
  
  /**
   * 信号品質情報を取得
   * - プロトコル層の適応制御に使用
   */
  getSignalQuality(): SignalQuality {
    return {
      snr: this.measureSNR(),
      ber: this.estimateBER(),
      eyeOpening: this.measureEyeOpening(),
      frequencyOffset: this.measureFrequencyOffset()
    };
  }
}
```

### 4. レイヤー間データフロー

```typescript
// データ送信フロー
const bridgeToProtocol = {
  input: File,           // ProtocolBridge入力
  output: Uint8Array     // XModemProtocol入力（メタデータ＋データ）
};

const protocolToFSK = {
  input: Uint8Array,     // XModemProtocol出力（パケット）
  output: Uint8Array     // FSKModulator入力（生パケット）
};

const fskToAudio = {
  input: Uint8Array,     // FSKModulator入力
  output: Float32Array   // AudioWorklet入力（音声サンプル）
};
```

### 5. エラー処理の責任分離

```typescript
// エラータイプの階層化
export class ProtocolBridgeError extends Error {
  constructor(message: string, public cause?: Error) {
    super(message);
    this.name = 'ProtocolBridgeError';
  }
}

export class PacketProtocolError extends Error {
  constructor(message: string, public sequence?: number) {
    super(message);
    this.name = 'PacketProtocolError';
  }
}

export class FSKModulationError extends Error {
  constructor(message: string, public signalQuality?: SignalQuality) {
    super(message);
    this.name = 'FSKModulationError';
  }
}

// 各層でのエラーハンドリング
class ProtocolBridge {
  private handleProtocolError(error: PacketProtocolError): void {
    // プロトコルエラーをアプリケーション向けエラーに変換
    const appError = new ProtocolBridgeError(
      'File transfer failed due to communication error',
      error
    );
    this.dispatchEvent(new CustomEvent('error', { detail: appError }));
  }
}
```

### 3. 統計・監視

```typescript
interface ProtocolStatistics {
  totalPacketsSent: number;
  totalPacketsReceived: number;
  retransmissionCount: number;
  crcErrorCount: number;
  timeoutCount: number;
  averageRoundTripTime: number;
  throughput: number; // bps
  efficiency: number; // 有効データ率
}

class ProtocolMonitor {
  private stats: ProtocolStatistics = {
    totalPacketsSent: 0,
    totalPacketsReceived: 0,
    retransmissionCount: 0,
    crcErrorCount: 0,
    timeoutCount: 0,
    averageRoundTripTime: 0,
    throughput: 0,
    efficiency: 0
  };
  
  updateStatistics(event: ProtocolEvent): void {
    switch (event.type) {
      case 'packet_sent':
        this.stats.totalPacketsSent++;
        break;
      case 'packet_received':
        this.stats.totalPacketsReceived++;
        break;
      case 'retransmission':
        this.stats.retransmissionCount++;
        break;
      case 'crc_error':
        this.stats.crcErrorCount++;
        break;
    }
    
    this.calculateEfficiency();
  }
  
  private calculateEfficiency(): void {
    const totalTransmissions = this.stats.totalPacketsSent + this.stats.retransmissionCount;
    this.stats.efficiency = totalTransmissions > 0 
      ? this.stats.totalPacketsSent / totalTransmissions 
      : 0;
  }
}
```

## テスト戦略

### 1. 単体テスト

```typescript
// tests/protocols/packet-protocol.test.ts
describe('XModem Protocol', () => {
  let protocol: XModemProtocol;
  let mockModulator: jest.Mocked<IModulator<FSKConfig>>;
  
  beforeEach(() => {
    mockModulator = createMockModulator();
    protocol = new XModemProtocol(mockModulator);
  });
  
  test('CRC計算の正確性', () => {
    const testData = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
    const expectedCRC = 0x9479; // 事前計算値
    
    const actualCRC = CRC16.calculate(testData);
    expect(actualCRC).toBe(expectedCRC);
  });
  
  test('パケット作成と解析', () => {
    const data = new Uint8Array([0x01, 0x02, 0x03]);
    const packet = protocol.createDataPacket(1, data);
    
    expect(packet.soh).toBe(0x01);
    expect(packet.sequence).toBe(1);
    expect(packet.invSequence).toBe(0xFE);
    expect(packet.length).toBe(3);
    expect(packet.payload).toEqual(data);
  });
  
  test('再送制御のテスト', async () => {
    mockModulator.demodulateData.mockResolvedValueOnce(new Uint8Array()); // タイムアウト
    mockModulator.demodulateData.mockResolvedValueOnce(createNAKResponse());
    mockModulator.demodulateData.mockResolvedValueOnce(createACKResponse());
    
    const data = new Uint8Array([0xFF]);
    await expect(protocol.sendPacketWithRetry(data)).resolves.not.toThrow();
  });
});
```

### 2. 統合テスト

```typescript
// tests/integration/protocol-integration.test.ts
describe('Protocol Integration', () => {
  test('ファイル転送の完全なラウンドトリップ', async () => {
    const testFile = new Uint8Array(1024).fill(0xAA); // 1KB テストデータ
    
    const transmitter = new ProtocolBridge(createFSKModulator());
    const receiver = new ProtocolBridge(createFSKModulator());
    
    // 送信
    const transmitPromise = transmitter.transmitData(testFile);
    
    // 受信
    const receivePromise = receiver.receiveData();
    
    // 結果検証
    const [, receivedData] = await Promise.all([transmitPromise, receivePromise]);
    expect(receivedData).toEqual(testFile);
  });
  
  test('ノイズ環境での信頼性テスト', async () => {
    const noisyChannel = new NoisyAudioChannel(0.1); // 10% ノイズ
    const protocol = new XModemProtocol(new FSKModulator());
    
    protocol.setChannel(noisyChannel);
    
    const testData = generateRandomData(512);
    const receivedData = await protocol.sendAndReceive(testData);
    
    expect(receivedData).toEqual(testData);
    
    const stats = protocol.getStatistics();
    expect(stats.retransmissionCount).toBeGreaterThan(0);
    expect(stats.efficiency).toBeGreaterThan(0.8); // 80%以上の効率
  });
});
```

## 実装計画

### Phase 2.1: 基本パケット機能 (Week 3前半)
- [x] CRC-16計算実装
- [ ] パケット構造定義
- [ ] 基本的な送受信機能
- [ ] 単体テスト作成

### Phase 2.2: エラー制御機能 (Week 3後半)  
- [ ] Stop-and-Wait ARQ実装
- [ ] 適応的タイムアウト
- [ ] 再送制御ロジック
- [ ] 統合テスト作成

### Phase 2.3: 最適化・監視機能 (Week 4前半)
- [ ] プロトコル統計機能
- [ ] 性能監視
- [ ] エラー処理強化
- [ ] ドキュメント作成

### Phase 2.4: FSK層統合 (Week 4後半)
- [ ] ProtocolBridge実装
- [ ] WebAudio統合テスト
- [ ] エンドツーエンドテスト
- [ ] 性能評価

## 将来拡張計画

### Phase 3: 高度なプロトコル機能
- **Sliding Window ARQ**: 高スループット化
- **HDLC framing**: データ透過性向上
- **Forward Error Correction**: Reed-Solomon符号
- **Adaptive packet size**: 回線品質に応じた最適化

### Phase 4: 標準プロトコル対応
- **PPP over Audio**: インターネットプロトコル対応
- **TCP/IP tunneling**: 完全なネットワーク機能
- **暗号化機能**: AES-128によるセキュリティ
- **圧縮機能**: LZ77による効率化

この設計により、シンプルで実装しやすく、かつ将来拡張可能なパケットプロトコル層を構築できます。