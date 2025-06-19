# WebAudio Integration Design

## 概要

WebAudio-ModemのFSKモデムとXModem transportをWebAudio APIのAudioWorkletと統合するための設計ドキュメント。

## アーキテクチャ原則

### 1. 責任の分離
- **メインスレッド**: Transport層 (XModem protocol, packet management, error handling)
- **AudioWorkletスレッド**: Physical層 (FSK modulation/demodulation, real-time audio processing)
- **疎結合**: EventベースまたはMessageベースの通信

### 2. 既存コンポーネントの再利用
- `src/modems/fsk.ts` - ブラウザ非依存のピュアなFSKCore実装を維持
- `src/transports/xmodem/` - メインスレッドでの実行を継続
- `src/webaudio/` - AudioWorklet関連の薄いラッパーとして新規作成

## コンポーネント設計

### 1. Modulator-specific AudioWorklet Processor (`src/webaudio/processors/fsk-processor.ts`)

```typescript
import { FSKCore } from '../../modems/fsk.js';
import { RingBuffer } from '../../utils.js';

class FSKProcessor extends AudioWorkletProcessor {
  private fskCore: FSKCore;
  private outputBuffer: RingBuffer<Float32Array>;
  private pendingData: { id: string, data: Uint8Array, position: number } | null;
  private chunkSize: number;
  
  constructor() {
    super();
    this.fskCore = new FSKCore();
    this.outputBuffer = new RingBuffer(8192); // 8K samples buffer
    this.pendingData = null;
    this.chunkSize = 32; // Process 32 bytes at a time
    this.port.onmessage = this.handleMessage.bind(this);
  }
  
  private async handleMessage(event: MessageEvent) {
    const { id, type, data } = event.data;
    
    try {
      switch (type) {
        case 'configure':
          await this.fskCore.configure(data.config);
          this.port.postMessage({ id, type: 'result', data: { success: true } });
          break;
          
        case 'modulate':
          // Queue data for progressive modulation
          this.pendingData = { id, data: data.bytes, position: 0 };
          break;
          
        case 'demodulate':
          // Demodulation happens in process() from input
          const bytes = await this.fskCore.demodulateData(data.samples);
          this.port.postMessage({ id, type: 'result', data: { bytes } });
          break;
      }
    } catch (error) {
      this.port.postMessage({ id, type: 'error', data: { message: error.message } });
    }
  }
  
  private async processChunk(): Promise<void> {
    if (!this.pendingData) return;
    
    const { id, data, position } = this.pendingData;
    const remaining = data.length - position;
    const chunkSize = Math.min(this.chunkSize, remaining);
    
    if (chunkSize > 0) {
      // Process small chunk
      const chunk = data.subarray(position, position + chunkSize);
      const signal = await this.fskCore.modulateData(chunk);
      
      // Add to ring buffer
      for (let i = 0; i < signal.length; i++) {
        this.outputBuffer.write(signal[i]);
      }
      
      this.pendingData.position += chunkSize;
    }
    
    // Check if complete
    if (this.pendingData.position >= data.length) {
      this.port.postMessage({ id, type: 'result', data: { success: true } });
      this.pendingData = null;
    }
  }
  
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const input = inputs[0];
    
    // Process pending modulation chunk if buffer has space
    if (this.pendingData && this.outputBuffer.availableWrite() > 1000) {
      this.processChunk();
    }
    
    if (output && output[0]) {
      const outputChannel = output[0];
      
      // Read from ring buffer to output
      for (let i = 0; i < outputChannel.length; i++) {
        outputChannel[i] = this.outputBuffer.availableRead() > 0 ? this.outputBuffer.read() : 0;
      }
    }
    
    if (input && input[0]) {
      // Handle demodulation from audio input
      this.processDemodulation(input[0]);
    }
    
    return true;
  }
}

// Register the processor with a specific name
registerProcessor('fsk-processor', FSKProcessor);
```

**設計要件:**

1. **リングバッファによる音声出力管理**
   - **理由**: AudioWorkletの`process()`は固定長（128サンプル）出力を要求するが、FSK変調結果は任意長のため
   - **実装**: RingBufferクラスを使用して変調結果を一時保存し、`process()`呼び出しごとに消費
   - **バッファサイズ**: 8192サンプル程度（約185ms @ 44.1kHz）でレイテンシとメモリのバランス

2. **段階的変調処理（Chunked Modulation）**
   - **理由**: 大きなデータを一度に変調するとAudioWorkletスレッドをブロックし、音声途切れの原因になる
   - **実装**: データを小さなチャンク（32バイト程度）に分割し、`process()`呼び出しごとに少しずつ処理
   - **制御**: リングバッファの残容量をチェックし、余裕があるときのみ次のチャンクを処理

3. **バックプレッシャー制御**
   - **理由**: 変調速度と音声出力速度のバランスを取り、バッファオーバーフローを防ぐ
   - **実装**: `availableWrite()`で残容量を監視し、閾値（1000サンプル程度）以下のときのみ変調続行
   - **効果**: メモリ使用量の制限とGC圧の軽減

4. **非同期完了通知**
   - **理由**: Transport層は変調完了を知る必要があるが、段階的処理のため即座には完了しない
   - **実装**: 全データの変調が完了した時点で`postMessage`により完了通知
   - **状態管理**: `pendingData`オブジェクトで現在の処理状況（データ、位置）を追跡

**責任:**
- 特定の変調器（FSKCore）の専用ラッパー
- リアルタイム制約下での効率的な変調処理
- メインスレッドとのメッセージ通信
- 音声バッファの適切な管理

### 2. Generic WebAudio Modulator Node (`src/webaudio/webaudio-modulator-node.ts`)

```typescript
interface ModulatorDescriptor {
  processorUrl: string;      // './processors/fsk-processor.js' - AudioWorklet processor module
  processorName: string;     // 'fsk-processor' - registered processor name
}

class WebAudioModulatorNode extends EventEmitter implements IModulator {
  private audioContext: AudioContext;
  private workletNode: AudioWorkletNode;
  private pendingOperations: Map<string, { resolve: Function, reject: Function }>;
  private operationCounter: number;
  
  constructor(audioContext: AudioContext, private descriptor: ModulatorDescriptor) {
    super();
    this.audioContext = audioContext;
    this.pendingOperations = new Map();
    this.operationCounter = 0;
  }
  
  async initialize(): Promise<void> {
    // Load the specific processor module
    await this.audioContext.audioWorklet.addModule(this.descriptor.processorUrl);
    
    // Create worklet node using the registered processor name
    this.workletNode = new AudioWorkletNode(this.audioContext, this.descriptor.processorName);
    
    // Setup message handling
    this.workletNode.port.onmessage = this.handleMessage.bind(this);
  }
  
  private handleMessage(event: MessageEvent) {
    const { id, type, data } = event.data;
    const operation = this.pendingOperations.get(id);
    
    if (!operation) return;
    
    this.pendingOperations.delete(id);
    
    if (type === 'result') {
      operation.resolve(data);
    } else if (type === 'error') {
      operation.reject(new Error(data.message));
    }
  }
  
  private sendMessage(type: string, data: any): Promise<any> {
    const id = `op_${++this.operationCounter}`;
    
    return new Promise((resolve, reject) => {
      this.pendingOperations.set(id, { resolve, reject });
      this.workletNode.port.postMessage({ id, type, data });
    });
  }
  
  async configure(config: any): Promise<void> {
    await this.sendMessage('configure', { config });
  }
  
  async modulateData(data: Uint8Array): Promise<Float32Array> {
    const result = await this.sendMessage('modulate', { bytes: data });
    return result.signal;
  }
  
  async demodulateData(samples: Float32Array): Promise<Uint8Array> {
    const result = await this.sendMessage('demodulate', { samples });
    return result.bytes;
  }
  
  // IModulator interface implementation
  readonly name: string = 'WebAudioModulator';
  readonly type = 'WebAudio' as const;
  
  reset(): void {
    // Clear pending operations
    for (const [id, operation] of this.pendingOperations) {
      operation.reject(new Error('Modulator reset'));
    }
    this.pendingOperations.clear();
  }
  
  isReady(): boolean {
    return !!this.workletNode;
  }
  
  getConfig(): any {
    // Config is managed by the processor
    return {};
  }
  
  getSignalQuality(): SignalQuality {
    // Would need to be implemented via message passing
    return { snr: 0, ber: 0, eyeOpening: 0, phaseJitter: 0, frequencyOffset: 0 };
  }
}
```

**責任:**
- 汎用的なAudioWorkletNode管理
- Promise-based非同期API提供
- IModulatorインターフェース実装
- メッセージパッシングの抽象化

### 4. Message Protocol

AudioWorkletとメインスレッド間の通信プロトコル:

```typescript
interface WorkletMessage {
  id: string;           // Unique operation ID
  type: 'modulate' | 'demodulate' | 'configure' | 'result' | 'error';
  data?: any;           // Operation-specific data
}

// Modulation request
{
  id: '12345',
  type: 'modulate',
  data: { bytes: Uint8Array }
}

// Demodulation result
{
  id: '12345',
  type: 'result',
  data: { bytes: Uint8Array }
}
```

## データフローと使用パターン

### パターン1: XModem Transport での使用（送信）
```
アプリケーション: "Hello"というテキストを送信したい
     ↓
XModemTransport: XModemパケット作成 [SOH|SEQ|~SEQ|LEN|"Hello"|CRC]
     ↓
WebAudioModulatorNode.modulateData(packet) 呼び出し
     ↓
FSKProcessor: パケットを少しずつFSK変調してリングバッファに保存
     ↓
AudioWorklet.process(): リングバッファから128サンプルずつスピーカーに出力
     ↓
音声として"Hello"パケットが送信される
```

### パターン2: リアルタイム受信
```
マイク → AudioContext → FSKProcessor.process()
     ↓
FSKProcessor: 音声サンプルをFSK復調してバイト列に変換
     ↓
WebAudioModulatorNode: 'dataReceived' イベント発火
     ↓
XModemTransport: パケット解析、ACK/NAK送信、データ組み立て
     ↓
アプリケーション: "Hello"テキストを受信
```

### 技術的な違い

**Transport層でのバッチ処理:**
- **用途**: XModemパケット送信（数十〜数百バイト）
- **処理**: `modulateData()`でPromise返却、内部では段階的変調
- **出力**: AudioWorkletのprocess()でリアルタイム音声出力

**リアルタイム処理:**
- **用途**: 連続音声ストリーム処理
- **処理**: process()で128サンプル単位のリアルタイム復調
- **出力**: イベント駆動でのデータ通知

### 実装上の分離
- **FSKProcessor**: AudioWorkletスレッドでの変調/復調
- **WebAudioModulatorNode**: メインスレッドでのPromise/Event管理
- **XModemTransport**: アプリケーションロジック（パケット化、エラー処理）

## 実装フェーズ

### Phase 1: AudioWorklet Processor
1. `src/webaudio/fsk-processor.ts` - AudioWorkletProcessor実装
2. FSKCoreのimportとWorklet内での実行確認
3. 基本的なメッセージハンドリング

### Phase 2: WebAudio Modulator
1. `src/webaudio/fsk-webaudio-modulator.ts` - IModulator実装
2. AudioWorkletNodeの作成と管理
3. Promise-based非同期API

### Phase 3: Transport Integration
1. XModemTransportでの使用テスト
2. エラーハンドリングとタイムアウト処理
3. パフォーマンス最適化

### Phase 4: Real-time Audio
1. AudioContext input/output接続
2. リアルタイム音声ストリーミング
3. レイテンシ最適化

## 設計上の考慮事項

### 1. Thread Communication
- **非同期性**: AudioWorkletは独立スレッドで実行
- **メッセージパッシング**: 構造化複製による データ転送
- **バックプレッシャー**: バッファリングとフロー制御

### 2. Error Handling
- **WorkletNode errors**: AudioWorklet内でのエラー処理
- **Timeout handling**: 応答なし操作のタイムアウト
- **Recovery strategies**: 接続切断時の復旧処理

### 3. Performance
- **Buffer management**: リアルタイム制約下でのバッファサイズ最適化
- **GC pressure**: メモリ割り当ての最小化
- **Latency optimization**: 処理遅延の最小化

### 4. Browser Compatibility
- **AudioWorklet support**: Chrome 66+, Firefox 76+, Safari 14.1+
- **Fallback strategy**: ScriptProcessorNode代替案
- **Progressive enhancement**: 機能検出とグレースフルデグラデーション

## テスト戦略

### 1. Unit Tests
- AudioWorkletProcessor のmock環境でのテスト
- FSKWebAudioModulator の単体テスト
- Message protocol の検証

### 2. Integration Tests
- XModemTransport + FSKWebAudioModulator 結合テスト
- オーディオループバックテスト
- エラー条件でのrobustness テスト

### 3. End-to-End Tests
- 実際のaudio input/output を使った通信テスト
- パフォーマンステスト（レイテンシ、スループット）
- 異なるブラウザでの互換性テスト

## アプリケーション開発者向けユースケース

### Use Case 1: シンプルなP2P通信アプリ

```typescript
// アプリ初期化
class SimpleDataExchange {
  private modem: AudioModem;
  
  async initialize() {
    this.modem = new AudioModem();
    await this.modem.start();
    
    // 受信リスナー設定
    this.modem.on('dataReceived', (data) => {
      this.onMessageReceived(new TextDecoder().decode(data));
    });
  }
  
  async sendMessage(text: string) {
    const data = new TextEncoder().encode(text);
    await this.modem.sendData(data);
  }
  
  onMessageReceived(message: string) {
    document.getElementById('messages').innerHTML += `<div>受信: ${message}</div>`;
  }
}

// 使用例
const app = new SimpleDataExchange();
await app.initialize();
await app.sendMessage("Hello from browser!");
```

### Use Case 2: ファイル転送アプリ

```typescript
class FileTransferApp {
  private modem: AudioModem;
  
  async sendFile(file: File) {
    const arrayBuffer = await file.arrayBuffer();
    const fileData = new Uint8Array(arrayBuffer);
    
    // プログレス表示
    this.modem.on('progress', (sent, total) => {
      this.updateProgress(sent / total * 100);
    });
    
    try {
      await this.modem.sendData(fileData);
      this.showSuccess(`${file.name} 送信完了`);
    } catch (error) {
      this.showError(`送信失敗: ${error.message}`);
    }
  }
  
  async receiveFile() {
    try {
      const data = await this.modem.receiveData();
      const blob = new Blob([data]);
      this.downloadFile(blob, 'received_file.bin');
    } catch (error) {
      this.showError(`受信失敗: ${error.message}`);
    }
  }
}
```

### Use Case 3: IoTデバイス連携

```typescript
class IoTController {
  private modem: AudioModem;
  
  async sendCommand(deviceId: string, command: string, params: any) {
    const message = {
      deviceId,
      command,
      params,
      timestamp: Date.now()
    };
    
    const data = new TextEncoder().encode(JSON.stringify(message));
    await this.modem.sendData(data);
  }
  
  async pollSensorData() {
    this.modem.on('dataReceived', (data) => {
      const response = JSON.parse(new TextDecoder().decode(data));
      this.updateSensorDisplay(response);
    });
    
    // センサーデータ要求
    await this.sendCommand('sensor01', 'readAll', {});
  }
}
```

### Use Case 4: ゲーム用リアルタイム通信

```typescript
class GameSync {
  private modem: AudioModem;
  private gameState: any;
  
  async synchronizeGameState() {
    // 自分の状態を送信
    const myState = this.getMyGameState();
    await this.modem.sendData(this.serialize(myState));
    
    // 相手の状態を受信
    const theirData = await this.modem.receiveData();
    const theirState = this.deserialize(theirData);
    this.mergeGameState(theirState);
  }
  
  async sendAction(action: GameAction) {
    const actionData = {
      type: 'action',
      action: action,
      playerId: this.playerId
    };
    
    await this.modem.sendData(this.serialize(actionData));
  }
}
```

## 開発者が期待するAPI設計

### 高レベルAPI (推奨)

```typescript
// シンプルな使用パターン (FSKをデフォルトで使用)
const modem = new AudioModem({
  modulatorType: 'FSK',  // 'PSK', 'QAM' etc. も将来サポート
  baudRate: 300,
  autoStart: true,
  errorRecovery: true
});

// 内部的にはWebAudioModulatorAdapterを使用
// const descriptor = { modulePath: './modems/fsk.js', className: 'FSKCore' };
// const adapter = new WebAudioModulatorAdapter(audioContext, descriptor);

// Promise-based API
await modem.send("Hello World");
const response = await modem.receive(5000); // 5秒タイムアウト

// Event-based API
modem.on('received', (data) => console.log('Data:', data));
modem.on('error', (error) => console.error('Error:', error));
modem.on('connected', () => console.log('Connection established'));

// カスタム変調方式の使用
const customModem = new AudioModem({
  modulatorDescriptor: {
    modulePath: './custom/my-modulator.js',
    className: 'MyCustomModulator'
  }
});
```

### 中レベルAPI (詳細制御)

```typescript
// FSK変調器を直接作成
const audioContext = new AudioContext();
const fskModulator = new WebAudioModulatorNode(audioContext, {
  processorUrl: './processors/fsk-processor.js',
  processorName: 'fsk-processor'
});
await fskModulator.initialize();

const transport = new XModemTransport(fskModulator);

// 設定のカスタマイズ
await fskModulator.configure({
  markFrequency: 1650,
  spaceFrequency: 1850,
  baudRate: 1200
});

transport.configure({
  maxRetries: 5,
  timeoutMs: 2000
});

// データ送信
await transport.sendData(new Uint8Array([1, 2, 3, 4]));

// カスタム変調器の使用
const customModulator = new WebAudioModulatorNode(audioContext, {
  processorUrl: './processors/my-custom-processor.js',
  processorName: 'my-custom-processor'
});
await customModulator.initialize();

// 同じTransportで異なる変調方式を使用可能
const newTransport = new XModemTransport(customModulator);
```

### 低レベルAPI (専門開発者向け)

```typescript
// 直接FSKCore操作
const fskCore = new FSKCore();
fskCore.configure(config);

const signal = await fskCore.modulateData(data);
const demodulated = await fskCore.demodulateData(signal);
```

## 想定される開発シナリオ

### 1. 教育アプリ開発者
- **ニーズ**: 音響通信の学習教材
- **要求**: 視覚的なスペクトラム表示、段階的な難易度設定
- **API**: 中レベル（設定変更可能）+ デバッグ情報

### 2. エンタープライズ開発者
- **ニーズ**: 既存システムとの統合
- **要求**: 信頼性、エラーハンドリング、ログ出力
- **API**: 高レベル（安定性重視）+ エラー詳細

### 3. 研究者・実験者
- **ニーズ**: プロトコルの改良、新しい変調方式の実験
- **要求**: 低レベルアクセス、パラメータ調整、測定機能
- **API**: 低レベル（全てのパラメータアクセス可能）

### 4. ホビー開発者
- **ニーズ**: 面白いデモ、プロトタイプ作成
- **要求**: 簡単なセットアップ、すぐに動作
- **API**: 高レベル（デフォルト設定で即動作）

## 期待される開発体験

```typescript
// 1行でセットアップ
const modem = new AudioModem();

// 自動的にマイク・スピーカー許可要求
// 自動的に最適なパラメータ設定
// 自動的にエラー回復

// データ送受信も簡潔に
await modem.send("test message");
const reply = await modem.receive();
```

この設計により、初心者から専門家まで、用途に応じたレベルでAPIを活用できるモジュラー構成を目指します。

## WebAudioModulatorNodeアーキテクチャの利点

### 1. 変調方式の拡張性
```typescript
// 新しい変調方式の追加手順:
// 1. OFDMCoreクラスを実装
// 2. OFDMProcessorを作成して registerProcessor('ofdm-processor', OFDMProcessor)

// 使用は直接的
const ofdmModulator = new WebAudioModulatorNode(audioContext, {
  processorUrl: './processors/ofdm-processor.js',
  processorName: 'ofdm-processor'
});

// 既存のTransport層をそのまま使用可能
const transport = new XModemTransport(ofdmModulator);
```

### 2. サードパーティ変調器のサポート
```typescript
// サードパーティライブラリの変調器も統合可能
// npm package が processor を提供すれば即利用可能
const thirdPartyModulator = new WebAudioModulatorNode(audioContext, {
  processorUrl: './node_modules/advanced-modem/dist/advanced-processor.js',
  processorName: 'advanced-processor'
});
```

### 3. テストとモック化の簡素化
```typescript
// テスト用モック変調器
const mockModulator = new WebAudioModulatorNode(audioContext, {
  processorUrl: './test/processors/mock-processor.js',
  processorName: 'mock-processor'
});

// 同じインターフェースでテスト実行
const testTransport = new XModemTransport(mockModulator);
```

### 4. 動的な変調方式切り替え
```typescript
class AdaptiveModem {
  private currentAdapter: WebAudioModulatorAdapter;
  
  async switchToModulator(descriptor: ModulatorDescriptor) {
    // 条件に応じて最適な変調方式に動的切り替え
    this.currentAdapter = new WebAudioModulatorAdapter(this.audioContext, descriptor);
    await this.currentAdapter.initialize();
    
    // Transportの変調器を更新
    this.transport.setModulator(this.currentAdapter);
  }
}
```

### 5. 開発者エコシステム
- **プラグインアーキテクチャ**: 新しい変調器を簡単に追加
- **標準インターフェース**: IModulatorに準拠すれば自動的に統合
- **バージョン管理**: 変調器ごとに独立したアップデート
- **パフォーマンス最適化**: 特定用途向けの専用変調器開発

## 実装上の制約

### 1. AudioWorklet制約
- Transferable Objectsのみ転送可能
- 同期APIの制限
- デバッグツールの制限

### 2. Real-time制約
- 128サンプルブロック処理
- GC停止の回避
- 一定レイテンシ要件

### 3. ブラウザセキュリティ
- HTTPS必須 (getUserMedia)
- User activation required
- CORS制約

この設計により、既存のFSKCoreとXModemTransportの実装を最大限活用しながら、WebAudio APIによるリアルタイム音声処理を実現します。