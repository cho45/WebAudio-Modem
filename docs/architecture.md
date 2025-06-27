# WebAudio-Modem Architecture

## Overview

WebAudio-Modemは音声通信モデムライブラリで、3つの重要な抽象化レイヤーと適切なアダプターパターンによる設計を採用しています。各レイヤーは明確な責務を持ち、WebAudio APIの制約に最適化された構造となっています。

## Core Architecture

### 3つの重要なインターフェース

WebAudio-Modemの設計は以下の3つの重要なインターフェースを中心に構築されています：

1. **IModulator** - 復調変調インターフェース（純粋な信号処理）
2. **ITransport** - データフレーム化インターフェース（プロトコル処理）  
3. **IDataChannel** - バイト⇔変調・復調インターフェース（音声通信抽象化）

### レイヤー構造

```
┌─────────────────────────────────────┐
│         Application Layer           │
│    ┌───────────┐ ┌───────────────┐  │
│    │  Demo UI  │ │  Other Apps   │  │
│    └───────────┘ └───────────────┘  │
└─────────────────┬───────────────────┘
                  │ ITransport
┌─────────────────▼───────────────────┐
│         Transport Layer             │
│  ┌─────────────────────────────────┐│
│  │       XModemTransport           ││  ← プロトコル制御・ARQ・CRC
│  │    implements ITransport        ││
│  └─────────────────────────────────┘│
└─────────────────┬───────────────────┘
                  │ IDataChannel
┌─────────────────▼───────────────────┐
│       Data Channel Layer            │
│  ┌─────────────────────────────────┐│
│  │     WebAudioDataChannel         ││  ← AudioWorkletNodeアダプター
│  │    (FSKProcessor adapter)       ││  ← postMessage通信
│  │    implements IDataChannel      ││
│  └─────────────────────────────────┘│
└─────────────────┬───────────────────┘
                  │ AudioWorklet postMessage
┌─────────────────▼───────────────────┐
│    Audio Processing Layer           │
│  ┌─────────────────────────────────┐│
│  │        FSKProcessor             ││  ← AudioWorkletProcessor
│  │  ┌───────────────────────────┐  ││  ← リアルタイム音声処理
│  │  │       FSKCore             │  ││
│  │  │  implements IModulator    │  ││  ← 純粋な変復調計算
│  │  └───────────────────────────┘  ││
│  └─────────────────────────────────┘│
└─────────────────┬───────────────────┘
                  │ process(inputs, outputs)
┌─────────────────▼───────────────────┐
│        Audio Hardware Layer         │
│      (Web Audio API / 実際の音声)    │
└─────────────────────────────────────┘
```

## Key Principles

### 1. WebAudio Adapter Pattern

**重要な設計原則**: WebAudioDataChannel は FSKProcessor のアダプターとして機能し、postMessage による通信でスレッド間のデータ交換を実現しています。

```typescript
// メインスレッド側（WebAudioDataChannel）
class WebAudioDataChannel extends AudioWorkletNode implements IDataChannel {
  async modulate(data: Uint8Array): Promise<void> {
    return this.sendMessage('modulate', data); // postMessage
  }
  
  async demodulate(): Promise<Uint8Array> {
    return this.sendMessage('demodulate'); // postMessage
  }
}

// ワーカースレッド側（FSKProcessor）
class FSKProcessor extends AudioWorkletProcessor {
  private fskCore: FSKCore; // IModulator実装
  
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // リアルタイム音声処理
    const samples = inputs[0][0];
    const demodulated = this.fskCore.demodulateData(samples);
    // バッファリング処理...
    return true;
  }
}
```

### 2. 3層の責務分離

各レイヤーは異なるドメインを担当し、適切な抽象化によって分離されています：

#### Transport Layer (ITransport)
- **責務**: プロトコル制御・パケット処理・再送制御
- **実装**: XModemTransport
- **依存**: IDataChannel インターフェースのみ
- **知らないこと**: 音声処理・サンプル・WebAudio API

#### Data Channel Layer (IDataChannel)  
- **責務**: バイト⇔変調・復調の抽象化・スレッド間通信
- **実装**: WebAudioDataChannel（AudioWorkletNodeアダプター）
- **特徴**: FSKProcessor との postMessage 通信
- **知らないこと**: プロトコル詳細・パケット構造

#### Modulator Layer (IModulator)
- **責務**: 純粋な信号処理・変復調計算
- **実装**: FSKCore
- **特徴**: 環境非依存・テスト容易
- **知らないこと**: WebAudio制約・プロトコル・スレッド

### 3. postMessage通信の重要性

WebAudio APIの制約により、音声処理はワーカースレッドで実行する必要があります：

```
┌─────────────────┐    postMessage    ┌─────────────────┐
│   Main Thread   │ ←─────────────→ │ AudioWorklet    │
│                 │                  │   Thread        │
│ XModemTransport │                  │  FSKProcessor   │
│       ↓         │                  │       ↓         │
│WebAudioDataChannel│                │    FSKCore      │
└─────────────────┘                  └─────────────────┘
```

**通信フロー**:
1. **送信**: Transport → WebAudioDataChannel → postMessage → FSKProcessor → FSKCore
2. **受信**: FSKCore → FSKProcessor → postMessage → WebAudioDataChannel → Transport

## Data Flow Architecture

### 送信フロー (Modulation Flow)

```
Application Data
      ↓
┌─────────────────────────────────────┐
│        XModemTransport              │ ← ITransport実装
│  • パケット作成 (SOH|SEQ|~SEQ|LEN|DATA|CRC)
│  • シーケンス番号管理
│  • 再送制御
└─────────────┬───────────────────────┘
              ↓ sendData(packetBytes)
┌─────────────────────────────────────┐
│     WebAudioDataChannel             │ ← IDataChannel実装
│  • AudioWorkletNodeアダプター
│  • postMessage送信
└─────────────┬───────────────────────┘
              ↓ postMessage('modulate', data)
┌─────────────────────────────────────┐
│        FSKProcessor                 │ ← AudioWorkletProcessor
│  • メッセージハンドリング               │ ← ワーカースレッド
│  • 送信キュー管理                     │
└─────────────┬───────────────────────┘
              ↓ modulateData(data)
┌─────────────────────────────────────┐
│          FSKCore                    │ ← IModulator実装
│  • 純粋な変調計算                     │ ← 環境非依存
│  • データ → 音声信号変換               │
└─────────────┬───────────────────────┘
              ↓ Float32Array signal
              AudioContext Output
```

### 受信フロー (Demodulation Flow)

```
AudioContext Input
      ↓ Float32Array samples
┌─────────────────────────────────────┐
│          FSKCore                    │ ← IModulator実装
│  • 純粋な復調計算                     │
│  • 音声信号 → データ変換               │
└─────────────┬───────────────────────┘
              ↓ demodulateData(samples)
┌─────────────────────────────────────┐
│        FSKProcessor                 │ ← AudioWorkletProcessor
│  • 受信バッファ管理                   │ ← process()内で継続実行
│  • postMessage応答                   │
└─────────────┬───────────────────────┘
              ↓ postMessage('result', demodulatedData)
┌─────────────────────────────────────┐
│     WebAudioDataChannel             │ ← IDataChannel実装
│  • AudioWorkletNodeアダプター
│  • Promise解決
└─────────────┬───────────────────────┘
              ↓ receiveData() returns
┌─────────────────────────────────────┐
│        XModemTransport              │ ← ITransport実装
│  • パケット解析 (CRC検証)              │
│  • ACK/NAK送信
│  • データ再構築
└─────────────┬───────────────────────┘
              ↓
        Application Data
```

## Interface Definitions

### IModulator - 純粋な信号処理層

```typescript
interface IModulator {
  // データ → 音声信号変換（純粋計算）
  modulateData(data: Uint8Array): Promise<Float32Array>;
  
  // 音声信号 → データ変換（ストリーム処理）
  demodulateData(samples: Float32Array): Promise<Uint8Array>;
  
  // 設定管理・状態管理
  configure(config: ModulatorConfig): void;
  reset(): void;
  isReady(): boolean;
  
  // 信号品質監視
  getSignalQuality(): SignalQuality;
}
```

### IDataChannel - スレッド間通信抽象化

```typescript
interface IDataChannel {
  // アプリケーション → 音声出力（非同期・完了待機）
  modulate(data: Uint8Array, options?: {signal?: AbortSignal}): Promise<void>;
  
  // 音声入力 → アプリケーション（非同期・データ待機）
  demodulate(options?: {signal?: AbortSignal}): Promise<Uint8Array>;
  
  // 状態リセット
  reset(): Promise<void>;
}
```

### ITransport - プロトコル制御層

```typescript
interface ITransport {
  // 信頼性のあるデータ送信（パケット化・再送制御）
  sendData(data: Uint8Array, options?: {signal?: AbortSignal}): Promise<void>;
  
  // 信頼性のあるデータ受信（パケット解析・重複排除）
  receiveData(options?: {signal?: AbortSignal}): Promise<Uint8Array>;
  
  // プロトコル制御・状態管理
  sendControl(command: string): Promise<void>;
  isReady(): boolean;
  getStatistics(): TransportStatistics;
  reset(): void;
}
```

## Key Architecture Benefits

### 1. WebAudio最適化設計

- **AudioWorkletProcessor**: リアルタイム音声処理に最適化
- **postMessage通信**: メインスレッドをブロックしない非同期通信
- **適切なバッファリング**: 128サンプル/チャンクに最適化されたキューイング

### 2. テスタビリティ

```typescript
// 各レイヤーが独立してテスト可能
describe('FSKCore (IModulator)', () => {
  // 純粋な信号処理テスト - Node.jsで実行可能
});

describe('XModemTransport (ITransport)', () => {
  // MockDataChannelを使用したプロトコルテスト
});

describe('WebAudioDataChannel (IDataChannel)', () => {
  // ブラウザ環境でのpostMessage通信テスト
});
```

### 3. 拡張性

**新しい変調方式の追加**:
```typescript
class PSKCore implements IModulator {
  // PSK変調・復調の実装
}

class PSKProcessor extends AudioWorkletProcessor {
  private pskCore = new PSKCore();
  // PSK用のAudioWorkletProcessor実装
}

// 既存のXModemTransportをそのまま使用可能
const transport = new XModemTransport(new WebAudioDataChannel(pskProcessor));
```

### 4. 環境非依存性

- **FSKCore (IModulator)**: 純粋計算のため完全に環境非依存
- **XModemTransport (ITransport)**: IDataChannelに依存するため異なる環境で使用可能
- **WebAudioDataChannel**: ブラウザ専用だが、Node.js用の代替実装が可能

## 実装ガイドライン

### ✅ DO

1. **インターフェース依存**: 具象クラスではなく抽象インターフェースに依存
2. **適切な非同期処理**: AbortSignalによるキャンセル対応
3. **レイヤー境界の尊重**: 上位レイヤーは下位の実装詳細を知らない
4. **WebAudio制約の考慮**: リアルタイム処理とアプリケーション処理の分離

### ❌ DON'T

1. **レイヤー跨ぎ**: Transport層で音声サンプルを直接処理
2. **責務の混在**: IModulator内でプロトコル処理
3. **同期処理**: リアルタイム制約を無視したブロッキング処理
4. **環境依存**: 純粋計算レイヤーでWebAudio APIを使用

## Current Implementation Status

### ✅ 完全実装済み

- **FSKCore**: IModulator完全実装、包括的テスト済み
- **XModemTransport**: ITransport完全実装、ARQ・CRC対応
- **WebAudioDataChannel**: IDataChannel完全実装、postMessage通信
- **FSKProcessor**: AudioWorkletProcessor実装、リアルタイム処理

### 🔄 実装中・改善中

- **AbortSignal対応**: 全レイヤーでのキャンセル機能強化
- **エラーハンドリング**: より堅牢なエラー処理とリカバリ
- **パフォーマンス最適化**: バッファリング効率の改善

### 📊 テスト状況

- **Node.jsテスト**: FSKCore、XModem、DSPフィルター、ユーティリティ
- **ブラウザテスト**: WebAudioDataChannel、FSKProcessor統合

### 🔮 将来の拡張計画

- **PSK/QAM変調**: 新しい変調方式の追加
- **エラー訂正**: Reed-Solomon符号の実装
- **マルチチャンネル**: 複数チャンネル同時通信

## Architecture Philosophy

この設計は以下の哲学に基づいています：

1. **WebAudio First**: WebAudio APIの制約を設計の中心に据える
2. **適切な抽象化**: 過度に細分化せず、実用的な単位での抽象化
3. **テスタビリティ**: 各レイヤーが独立してテスト可能
4. **拡張性**: 新しい変調方式・プロトコルの追加が容易
5. **責務の明確化**: 各レイヤーが単一の明確な責務を持つ

この設計により、WebAudio APIの複雑性を適切に抽象化し、音声通信アプリケーションの開発を大幅に簡素化することができます。
