# WebAudio-Modem Architecture

## Overview

WebAudio-Modemは音声通信モデムライブラリで、複数のレイヤーに分離された設計を採用しています。各レイヤーは明確な責務を持ち、適切な抽象化によって疎結合を実現しています。

## Layer Architecture

```
┌─────────────────────────────────────┐
│         Application Layer           │
│  ┌─────────────┐ ┌─────────────────┐│
│  │   Demo UI   │ │ Other Apps      ││
│  └─────────────┘ └─────────────────┘│
└─────────────────┬───────────────────┘
                  │
┌─────────────────▼───────────────────┐
│         Transport Layer             │
│  ┌─────────────────────────────────┐│
│  │        XModemTransport          ││  ← パケット処理・フロー制御
│  │    (Protocol Implementation)   ││
│  └─────────────────────────────────┘│
└─────────────────┬───────────────────┘
                  │ IDataChannel
┌─────────────────▼───────────────────┐
│       Data Channel Layer            │
│  ┌─────────────────────────────────┐│
│  │     WebAudioDataChannel         ││  ← 送受信の抽象化
│  │   (Channel Implementation)     ││
│  └─────────────────────────────────┘│
└─────────────────┬───────────────────┘
                  │
┌─────────────────▼───────────────────┐
│      WebAudio Implementation        │
│  ┌─────────────────────────────────┐│
│  │    WebAudioModulatorNode        ││  ← WebAudio APIラッパー
│  │      (AudioWorklet管理)         ││
│  └─────────────────────────────────┘│
└─────────────────┬───────────────────┘
                  │ postMessage/onmessage
┌─────────────────▼───────────────────┐
│     Audio Processing Layer          │
│  ┌─────────────────────────────────┐│
│  │        FSKProcessor             ││  ← AudioWorkletProcessor
│  │   ┌─────────────────────────┐   ││
│  │   │       FSKCore           │   ││  ← 実際の変復調アルゴリズム
│  │   └─────────────────────────┘   ││
│  └─────────────────────────────────┘│
└─────────────────┬───────────────────┘
                  │
┌─────────────────▼───────────────────┐
│        Audio Hardware Layer         │
│           (Web Audio API)           │
└─────────────────────────────────────┘
```

## Key Principles

### 1. Domain Separation

各レイヤーは異なるドメインを担当し、詳細を隠蔽します：

- **Transport Layer**: パケット通信プロトコル（XModem）
- **Data Channel Layer**: 抽象的なデータ送受信
- **Audio Processing Layer**: 音声信号処理（FSK変復調）

### 2. Interface Segregation

各レイヤーは必要最小限のインターフェースのみに依存します：

```typescript
// Transport層は音声処理の詳細を知らない
interface IDataChannel {
  send(data: Uint8Array): Promise<void>;
  receive(): Promise<Uint8Array>;
  close(): void;
}

// Audio処理層は通信プロトコルを知らない  
interface IModulator {
  modulateData(data: Uint8Array): Promise<Float32Array>;
  demodulateData(samples: Float32Array): Promise<Uint8Array>;
}
```

### 3. Async Data Flow

データの流れは非同期で、各レイヤーで適切に待機・バッファリングされます：

```
Send Flow:
App → Transport → DataChannel → AudioNode → FSKProcessor → AudioHW

Receive Flow:  
AudioHW → FSKProcessor → AudioNode → DataChannel → Transport → App
```

## Layer Responsibilities

### Application Layer
- ユーザーインターフェース
- ファイル送受信ロジック
- エラーハンドリング・表示

### Transport Layer (XModemTransport)
- **責務**: 
  - パケットの組み立て・分解
  - ACK/NAK処理
  - 再送制御
  - フロー制御
- **依存**: IDataChannel のみ
- **知らないこと**: 音声処理、サンプルレート、変調方式

### Data Channel Layer
- **責務**:
  - データの送受信抽象化
  - Transport層と音声処理層の橋渡し
  - バッファリング・同期処理
- **実装例**: WebAudioDataChannel, SerialDataChannel, TCPDataChannel

### WebAudio Implementation
- **責務**:
  - AudioWorkletNode の管理
  - メインスレッドとワーカースレッドの通信
  - WebAudio API との統合
- **知らないこと**: パケット構造、プロトコル詳細

### Audio Processing Layer
- **責務**:
  - 実際の変復調処理
  - 信号品質監視
  - ビット同期・フレーム同期
- **実行環境**: AudioWorkletProcessor (ワーカースレッド)

## Benefits

### 1. Testability
各レイヤーが独立してテスト可能：
- Transport層: モックDataChannelでテスト
- Audio層: 純粋な信号処理テスト

### 2. Extensibility
新しい実装を容易に追加可能：
- 新しい変調方式（PSK、QAM）
- 新しい通信チャネル（Serial、TCP）
- 新しいプロトコル（Zmodem、Kermit）

### 3. Platform Independence
Transport層はプラットフォーム非依存：
- 同じXModemTransportをNode.js、Browser、モバイルで使用可能

### 4. Performance
適切なレイヤー分離により：
- 音声処理はワーカースレッドで実行
- UI は音声処理に影響されない
- 各レイヤーで最適なバッファリング

## Implementation Guidelines

### DO
- 各レイヤーは抽象インターフェースに依存する
- 下位レイヤーの詳細を上位レイヤーに漏らさない
- 適切な非同期処理でデータフローを管理する

### DON'T  
- Transport層で音声サンプルを直接処理しない
- Audio層でパケット構造を意識しない
- レイヤーを跨いだ直接的な依存関係を作らない

## Current Status

- ✅ FSKCore: 完全実装済み
- ✅ XModemTransport: 完全実装済み
- ⚠️ IDataChannel: インターフェース設計が必要
- ⚠️ WebAudioDataChannel: 実装が必要
- ⚠️ レイヤー間の適切な統合が必要