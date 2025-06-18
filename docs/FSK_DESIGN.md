# FSK Modem Design Document

## アーキテクチャ概要

本設計では、**バイト境界レイヤー分離**を採用し、責任を明確に分担することで高性能かつ保守性の高いFSKモデムを実現する。

## レイヤー構成

```
┌─────────────────────────────────────────────────────┐
│                Application Layer                    │
│  - ファイル転送、チャット、プロトコル実装           │
└─────────────────┬───────────────────────────────────┘
                  │ Uint8Array
┌─────────────────▼───────────────────────────────────┐
│                Protocol Layer                       │
│  - パケット化、エラー訂正、フロー制御               │
│  - ACK/NAK、再送制御、チャンキング                  │
└─────────────────┬───────────────────────────────────┘
                  │ Uint8Array  
┌─────────────────▼───────────────────────────────────┐
│                FSK Core Layer                       │
│  - FSK変調/復調、フレーミング、同期                 │
│  - バイト境界での入出力                             │
└─────────────────┬───────────────────────────────────┘
                  │ Float32Array
┌─────────────────▼───────────────────────────────────┐
│             WebAudio Layer                          │
│  - AudioWorklet、リアルタイム処理                   │
│  - マイク入力、スピーカー出力                       │
└─────────────────────────────────────────────────────┘
```

---

## Layer 1: FSK Core Layer

### 責任範囲
- **FSK変調/復調の核心処理**
- **バイトレベルのフレーミング** (start/stop bits)
- **同期とビット判定**
- **信号品質監視**

### 入出力インターフェース
```typescript
// core.ts の BaseModulator を継承
export class FSKCore extends BaseModulator<FSKConfig> {
  readonly name = 'FSK';
  readonly type = 'FSK';
  
  // core.ts IModulator インターフェース実装
  modulateData(data: Uint8Array): Float32Array;  // バイト → 音声信号
  demodulateData(samples: Float32Array): Uint8Array; // 音声信号 → バイト
  configure(config: FSKConfig): void;            // 設定管理
  getConfig(): FSKConfig;                        // 設定取得
  getSignalQuality(): SignalQuality;             // 品質監視
  
  // 継承必須メソッド
  reset(): void;
  isReady(): boolean;
}
```

### 内部処理詳細

#### 変調処理 (modulate)
```typescript
modulate(data: Uint8Array): Float32Array {
  // 1. バイト → フレームビット変換
  //    - Start bits (通常1bit: space frequency)
  //    - Data bits (8bit: LSB first)  
  //    - Parity bit (オプション)
  //    - Stop bits (通常1-1.5bit: mark frequency)
  
  // 2. 位相連続FSK変調
  //    - Mark frequency (1650Hz) = bit 1
  //    - Space frequency (1850Hz) = bit 0
  //    - 位相連続性保持でスペクトラム効率向上
  
  // 3. 音声サンプル生成
  //    - サンプリングレート44.1kHz
  //    - ボーレート300-2400bps対応
}
```

#### 復調処理 (demodulate)  
```typescript
demodulate(samples: Float32Array): Uint8Array {
  // 1. 前処理フィルタリング
  //    - バンドパスフィルタ (mark/space中心周波数)
  //    - AGC (自動ゲイン制御)
  
  // 2. I/Q復調 (コヒーレント検波)
  //    - 中心周波数での直交復調
  //    - I = signal * cos(ωt)
  //    - Q = signal * sin(ωt)
  
  // 3. エンベロープ検波 + 位相微分
  //    - 振幅: sqrt(I² + Q²)  
  //    - 位相: atan2(Q, I)
  //    - 周波数: d(phase)/dt
  
  // 4. ポストフィルタリング
  //    - ローパスフィルタ (ボーレート周波数)
  //    - 適応的閾値調整
  
  // 5. フレーム同期とビット判定
  //    - スタートビット検出
  //    - ビット境界サンプリング
  //    - パリティチェック
  //    - ストップビット検証
  
  // 6. バイト復元
  //    - LSBファースト → MSBファースト変換
  //    - フレーミングエラー処理
}
```

### 設定パラメータ
```typescript
interface FSKConfig extends BaseModulatorConfig {
  // 周波数設定
  markFrequency: number;      // 1650Hz (bit 1)
  spaceFrequency: number;     // 1850Hz (bit 0)
  baudRate: number;           // 300, 1200, 2400 bps
  
  // フレーミング設定  
  startBits: number;          // 1 (通常)
  stopBits: number;           // 1 or 1.5
  parity: 'none' | 'even' | 'odd';
  
  // DSP設定
  preFilterBandwidth: number; // バンドパス幅 (Hz)
  adaptiveThreshold: boolean; // 適応閾値 ON/OFF
  agcEnabled: boolean;        // AGC ON/OFF
  
  // 品質設定
  carrierDetectThreshold: number; // キャリア検出閾値
  syncTimeout: number;            // 同期タイムアウト (ms)
}
```

---

## Layer 2: Protocol Layer  

### 責任範囲
- **高レベル通信プロトコル**
- **パケット化とチャンキング**
- **エラー検出・訂正**
- **フロー制御・再送制御**

### 入出力インターフェース
```typescript
// core.ts の BaseProtocol を継承
export class FSKProtocol extends BaseProtocol {
  readonly name = 'FSK-Protocol';
  
  // core.ts IProtocol インターフェース実装
  encodeFrame(data: Uint8Array): Uint8Array;    // フレーム符号化
  decodeFrame(frame: Uint8Array): Uint8Array | null; // フレーム復号化
  addErrorControl(data: Uint8Array): Uint8Array; // エラー制御追加
  checkErrorControl(data: Uint8Array): boolean;  // エラー検証
  
  // 高レベルプロトコル機能
  sendPacket(data: Uint8Array): Promise<void>;
  receivePacket(): Promise<Uint8Array>;
  sendStream(stream: ReadableStream<Uint8Array>): Promise<void>;
  sendFile(file: File): Promise<void>;
  receiveFile(): Promise<Blob>;
}
```

### パケット構造
```
┌─────────┬─────────┬──────────┬─────────┬─────────┐
│ HEADER  │  SEQ#   │ PAYLOAD  │   CRC   │  TAIL   │
│ (2byte) │ (1byte) │ (N byte) │ (2byte) │ (1byte) │
└─────────┴─────────┴──────────┴─────────┴─────────┘

HEADER: 0x5A5A (sync pattern)
SEQ#:   シーケンス番号 (0-255)
PAYLOAD: データ本体 (最大128byte)
CRC:    CRC-16チェックサム
TAIL:   0xA5 (end marker)
```

### プロトコル機能
- **ARQ (Automatic Repeat reQuest)**: 自動再送
- **フロー制御**: 送信レート調整
- **チャンキング**: 大容量データの分割送信
- **デュプレックス**: 全二重通信対応

---

## Layer 3: WebAudio Layer

### 責任範囲
- **AudioWorkletとの統合**
- **リアルタイム音声処理**
- **入出力デバイス管理**
- **バッファリング制御**

### 入出力インターフェース
```typescript
// core.ts の WebAudioModulator を継承
export class FSKWebAudio extends WebAudioModulator<FSKConfig> {
  private fskCore: FSKCore;
  
  constructor(audioContext: AudioContext) {
    super(audioContext);
    this.fskCore = new FSKCore();
  }
  
  // core.ts WebAudioModulator インターフェース実装
  modulateData(data: Uint8Array): Float32Array;     // FSKCoreに委譲
  demodulateData(samples: Float32Array): Uint8Array; // FSKCoreに委譲
  configure(config: FSKConfig): void;               // 設定管理
  protected setupAudioWorklet(): Promise<void>;    // AudioWorklet初期化
  
  // 追加機能
  playBuffer(buffer: AudioBuffer): Promise<void>;
  startRecording(): Promise<void>;
  stopRecording(): Promise<Uint8Array>;
  setupDuplexCommunication(): Promise<void>;
  selectInputDevice(deviceId: string): Promise<void>;
  selectOutputDevice(deviceId: string): Promise<void>;
}
```

---

## Layer 4: Application Layer

### 責任範囲
- **ユーザーインターフェース**
- **ファイル転送UI**  
- **チャットアプリケーション**
- **設定管理**

---

## データフロー

### 送信フロー
```
Application: File/Text
      ↓ (Uint8Array)
Protocol:    Packetize + Error Control  
      ↓ (Uint8Array)
FSK Core:    Framing + FSK Modulation
      ↓ (Float32Array)  
WebAudio:    AudioWorklet + Speaker Output
```

### 受信フロー
```
WebAudio:    Microphone + AudioWorklet
      ↓ (Float32Array)
FSK Core:    FSK Demodulation + Frame Sync
      ↓ (Uint8Array)
Protocol:    Error Check + Depacketize
      ↓ (Uint8Array)  
Application: File/Text Reconstruction
```

---

## パフォーマンス最適化

### FSK Core最適化
- **ビットパック表現**: メモリ効率98%改善
- **バッチ処理**: バイト単位での高速変調
- **円形バッファ**: リアルタイム処理対応
- **SIMD最適化**: 並列信号処理 (将来実装)

### プロトコル最適化  
- **パイプライン処理**: 送受信並行実行
- **適応的パケットサイズ**: 回線品質に応じた調整
- **前方誤り訂正**: Reed-Solomon符号 (オプション)

### WebAudio最適化
- **低遅延バッファリング**: <50ms目標
- **AudioWorklet**: メインスレッド非ブロッキング
- **デバイス最適化**: 各音声デバイス特性対応

---

## テスト戦略

### 単体テスト (Node.js)
```typescript
// FSK Core
describe('FSK Core', () => {
  test('modulation-demodulation roundtrip', () => {
    const input = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]);
    const modulated = fskCore.modulate(input);
    const demodulated = fskCore.demodulate(modulated);
    expect(demodulated).toEqual(input);
  });
  
  test('frequency accuracy', () => {
    const signal = fskCore.modulate(new Uint8Array([0xFF])); // all 1s
    const spectrum = calculateFFT(signal);
    const peakFreq = findPeakFrequency(spectrum);
    expect(peakFreq).toBeCloseTo(1650, 10); // mark frequency
  });
});
```

### 統合テスト (ブラウザ)
```typescript
// Protocol Layer  
describe('FSK Protocol', () => {
  test('packet transmission with errors', async () => {
    const data = generateRandomData(1024);
    const noiseLevel = 0.1;
    
    const transmitted = await protocol.sendPacket(data);
    const noisySignal = addNoise(transmitted, noiseLevel);
    const received = await protocol.receivePacket(noisySignal);
    
    expect(received).toEqual(data);
  });
});
```

### 性能テスト
- **BER vs SNR曲線**: ビット誤り率特性
- **周波数オフセット耐性**: ±50Hz範囲
- **遅延測定**: エンドツーエンド<100ms
- **メモリ使用量**: 長時間動作での安定性

---

## 実装優先順位

### Phase 1: Core DSP (Week 1-2)
1. FSKCore基本実装
2. 変調器 (位相連続FSK)
3. 復調器 (I/Q + 位相微分)
4. フレーミング処理

### Phase 2: Protocol Integration (Week 3)
1. パケット構造定義
2. エラー検出実装
3. 基本ARQ実装

### Phase 3: WebAudio Integration (Week 4)
1. AudioWorklet統合
2. リアルタイム処理
3. デバイス管理

### Phase 4: Application & UI (Week 5-6)
1. ファイル転送UI
2. チャット機能
3. 設定管理画面

この設計に基づいて実装を進めることで、高性能かつ拡張性の高いFSKモデムシステムを構築できます。