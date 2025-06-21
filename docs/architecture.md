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
                  │ IAudioProcessor
┌─────────────────▼───────────────────┐
│     Audio Processing Layer          │
│  ┌─────────────────────────────────┐│
│  │        FSKProcessor             ││  ← リアルタイム処理 + バッファリング
│  │   ┌─────────────────────────┐   ││  ← process() + modulate/demodulate()
│  │   │       FSKCore           │   ││
│  │   │   (IModulator実装)      │   ││  ← 純粋な変復調計算
│  │   └─────────────────────────┘   ││
│  └─────────────────────────────────┘│
└─────────────────┬───────────────────┘
                  │ AudioWorkletProcessor.process()
┌─────────────────▼───────────────────┐
│        Audio Hardware Layer         │
│      (Web Audio API / 実際の音声)    │
└─────────────────────────────────────┘
```

## Key Principles

### 1. Domain Separation

各レイヤーは異なるドメインを担当し、詳細を隠蔽します：

- **Transport Layer**: パケット通信プロトコル（XModem）
- **Data Channel Layer**: 抽象的なデータ送受信
- **Audio Processing Layer**: 音声信号処理（FSK変復調）

### 2. 重要な新インターフェース: IAudioProcessor

音声通信において最も重要な発見は、**AudioWorkletProcessorレベルでの抽象化**が必要だということです：

```typescript
interface IAudioProcessor {
  // リアルタイム音声処理（AudioWorkletProcessor.process()相当）
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  
  // アプリケーションレベルの変調要求（非同期）
  modulate(data: Uint8Array): Promise<void>;
  
  // アプリケーションレベルの復調データ取得（非同期・待機付き）
  demodulate(): Promise<Uint8Array>;
}
```

#### なぜIAudioProcessorが重要なのか

**リアルタイム処理とアプリケーション処理の橋渡し**：
```typescript
class FSKProcessor implements IAudioProcessor {
  private fskCore: IModulator; // 純粋な変復調計算
  private outputQueue: Float32Array[] = []; // 送信待ちキュー
  private demodulatedBuffer: Uint8Array[] = []; // 受信バッファ
  
  // 128サンプル/チャンクのリアルタイム処理
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // 継続的な復調 + キューされた変調信号の出力
    const samples = inputs[0][0];
    const demodulated = this.fskCore.demodulateData(samples);
    if (demodulated.length > 0) {
      this.demodulatedBuffer.push(demodulated);
    }
    
    if (this.outputQueue.length > 0) {
      outputs[0][0].set(this.outputQueue.shift()!);
    }
    return true;
  }
  
  // アプリケーションからの変調要求
  async modulate(data: Uint8Array): Promise<void> {
    const signal = await this.fskCore.modulateData(data);
    this.chunkAndQueue(signal); // 128サンプル単位に分割してキュー
  }
  
  // アプリケーションへの復調データ提供
  async demodulate(): Promise<Uint8Array> {
    return await this.waitForBufferedData();
  }
}
```

### 3. シンプルな責務分離

新しい設計では、各インターフェースが明確な責務を持ちます：

```typescript
// Transport層 - プロトコル処理のみ
class XModemTransport {
  constructor(private audioProcessor: IAudioProcessor) {}
  
  async receiveData(): Promise<Uint8Array> {
    return await this.audioProcessor.demodulate(); // 音声詳細を知らない
  }
}

// FSKCore - 純粋な変復調計算のみ
class FSKCore implements IModulator {
  modulateData(data: Uint8Array): Promise<Float32Array> { /* 純粋計算 */ }
  demodulateData(samples: Float32Array): Promise<Uint8Array> { /* 純粋計算 */ }
}

// FSKProcessor - リアルタイム処理 + バッファリング
class FSKProcessor implements IAudioProcessor {
  // process() + modulate() + demodulate()の統合
}
```

**Design Rationale**: この設計により、**WebAudioの制約**（リアルタイム処理）と**アプリケーションの要求**（非同期データ送受信）を自然に両立できます。

### 4. Simplified Data Flow

新しい設計では、データフローが大幅にシンプルになります：

```
Send Flow:
App → Transport → FSKProcessor.modulate() → outputQueue → process() → AudioHW

Receive Flow:  
AudioHW → process() → demodulatedBuffer → FSKProcessor.demodulate() → Transport → App
```

**重要な特徴**:
- **IDataChannelレイヤーが削除**され、Transport層がFSKProcessorと直接通信
- **FSKProcessor内でリアルタイム処理とバッファリングが統合**
- **WebAudioの制約に最適化**された設計

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
- **依存**: IAudioProcessor のみ
- **知らないこと**: 音声処理、サンプル処理、リアルタイム制約

### Audio Processing Layer (FSKProcessor)
- **責務**:
  - **二重責務の統合**:
    1. リアルタイム音声処理（process()）
    2. アプリケーション通信（modulate()/demodulate()）
  - 送信データのキューイング・チャンク分割
  - 受信データのバッファリング・待機制御
  - WebAudio制約への適合
- **実行環境**: AudioWorkletProcessor (ワーカースレッド)
- **内部依存**: IModulator (純粋計算)

### Signal Processing Layer (FSKCore)
- **責務**:
  - **純粋な変復調計算**のみ
  - データ → 音声信号変換
  - 音声信号 → データ変換
  - アルゴリズムの実装
- **特徴**: 
  - 環境非依存
  - 状態を持つストリーム処理
  - テスト容易性

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

## Architecture Evolution

### 設計議論の記録

この設計に至るまでの重要な議論と決定事項：

#### 1. Transport層とModulator層の分離

**課題**: XModemTransportがIModulatorに直接依存し、音声samplesを知る必要が生じていた
```typescript
// 問題のあった設計
class XModemTransport {
  async receiveData() {
    const samples = ???; // Transportはsamplesをどこから得るのか？
    const data = await this.modulator.demodulateData(samples);
  }
}
```

**解決**: IDataChannelレイヤーの導入により、Transport層は音声詳細を知らなくて済むように

#### 2. IDataChannel は必要か？

**議論**: 
- Option A: Transport → IDataChannel → IModulator (抽象化レイヤー追加)
- Option B: Transport → IModulator (with receive()) (シンプル設計)

**結論**: IModulatorに`receive()`を追加するだけでは不十分。FSKCoreの2面性を活かすためにIDataChannelは有効。

#### 3. BasicDataChannelの実装問題

**課題**: BasicDataChannelでsamplesの提供者が不明確
```typescript
// 問題: samplesをどこから得るのか？
const emptySignal = new Float32Array(0); // 意味がない
const demodulated = await this.modulator.demodulateData(emptySignal);
```

**議論の結果**: BasicDataChannelは音声処理を含むべきではなく、FSKCore自体が2面性を持つことで解決

#### 4. IDataChannelの再評価

**課題**: IDataChannelレイヤーが実際には必要ない可能性
```typescript
// 問題: IDataChannelは単なる転送レイヤーになってしまう
class WebAudioDataChannel implements IDataChannel {
  async send(data: Uint8Array): Promise<void> {
    return await this.audioProcessor.modulate(data); // 単純な転送
  }
  
  async receive(): Promise<Uint8Array> {
    return await this.audioProcessor.demodulate(); // 単純な転送
  }
}
```

**最終決定**: IDataChannelを削除し、Transport層がFSKProcessorと直接通信

#### 5. IAudioProcessorの発見

**重要な気づき**: 「誰がsamplesを与えるか」「誰が変調済みsamplesを出力するか」の分析により、**FSKProcessorレベルでの抽象化**が最も重要であることが判明

**根拠**:
1. WebAudioの制約（リアルタイム処理）に対応
2. アプリケーション要求（非同期通信）に対応
3. 責務の適切な統合（過度な分離を避ける）
4. テスタビリティの確保

### 設計原則の確立

この議論を通じて確立された原則：

1. **WebAudio First Design**: WebAudioの制約を設計の中心に据える
2. **適切な抽象化レベル**: 過度に細分化せず、実用的な単位で抽象化
3. **責務の統合**: 密結合な要素は無理に分離しない（FSKProcessorの二重責務）
4. **環境依存性の明確化**: 環境固有部分と汎用部分を明確に分離

## Current Status

- ✅ FSKCore: 完全実装済み（IModulator）
- ✅ XModemTransport: 完全実装済み（従来版）
- 🔄 IAudioProcessor: インターフェース定義が必要
- 🔄 FSKProcessor: IAudioProcessor実装への拡張が必要
- 🔄 XModemTransport: IAudioProcessor依存への移行が必要
- ⚠️ テスト: 新アーキテクチャのテスト実装が必要
- ❌ IDataChannel: 削除予定（不要と判断）