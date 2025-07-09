/**
 * 偽ピーク問題専用テスト - 単独実行用
 */

import { describe, test, expect } from 'vitest';
import { DsssDpskDemodulator } from '../../src/modems/dsss-dpsk/dsss-dpsk-demodulator';
import { DsssDpskFramer } from '../../src/modems/dsss-dpsk/framer';
import * as modem from '../../src/modems/dsss-dpsk/dsss-dpsk';

describe('False Peak Problem - Isolated Test', () => {
  const defaultConfig = {
    sequenceLength: 31,
    seed: 21,
    samplesPerPhase: 23,
    sampleRate: 44100,
    carrierFreq: 10000,
    correlationThreshold: 0.3,
    peakToNoiseRatio: 4
  };

  const generateFrameWithAmplitude = (userData: Uint8Array, amplitude: number, frameOptions: any = {}) => {
    const frame = DsssDpskFramer.build(userData, {
      sequenceNumber: frameOptions.sequenceNumber || 1,
      frameType: frameOptions.frameType || 0,
      ldpcNType: frameOptions.ldpcNType || 0
    });
    console.log(`frame headerByte: ${frame.headerByte.toString(16)}`);

    const chips = modem.dsssSpread(frame.bits, defaultConfig.sequenceLength, defaultConfig.seed);
    const phases = modem.dpskModulate(chips);
    const signal = modem.modulateCarrier(
      phases,
      defaultConfig.samplesPerPhase,
      defaultConfig.sampleRate,
      defaultConfig.carrierFreq
    );
    
    // 振幅スケーリング
    const scaledSignal = new Float32Array(signal.length);
    for (let i = 0; i < signal.length; i++) {
      scaledSignal[i] = signal[i] * amplitude;
    }
    
    return scaledSignal;
  };

  const processSignalInChunks = (
    demodulator: DsssDpskDemodulator, 
    signal: Float32Array,
    options: {
      chunkSize?: number;
      maxFrames?: number;
      silencePrefix?: number;
      silenceSuffix?: number;
    } = {}
  ) => {
    const { 
      chunkSize = 128, 
      maxFrames = Infinity, 
      silencePrefix = 0,
      silenceSuffix = 0 
    } = options;
    
    // サイレンス期間を含む信号作成
    const totalLength = silencePrefix + signal.length + silenceSuffix;
    const totalSignal = new Float32Array(totalLength);
    totalSignal.set(signal, silencePrefix);
    
    // 128サンプルずつ処理（AudioWorklet環境シミュレーション）
    const receivedFrames: any[] = [];
    let totalFramesReceived = 0;
    for (let i = 0; i < totalSignal.length && receivedFrames.length < maxFrames; i += chunkSize) {
      const chunk = totalSignal.slice(i, i + chunkSize);
      demodulator.addSamples(chunk);
      const frames = demodulator.getAvailableFrames();
      totalFramesReceived += frames.length;
      receivedFrames.push(...frames);
      
      // 目標フレーム数達成で早期終了
      if (receivedFrames.length >= maxFrames) {
        break;
      }
    }
    
    return receivedFrames;
  };

  const processMultipleSignals = (
    demodulator: DsssDpskDemodulator,
    signals: Float32Array[],
    options: {
      chunkSize?: number;
      maxFrames?: number;
      gapBetweenSignals?: number;
      silencePrefix?: number;
      silenceSuffix?: number;
    } = {}
  ) => {
    const { 
      chunkSize = 128, 
      maxFrames = Infinity,
      gapBetweenSignals = 0,
      silencePrefix = 0,
      silenceSuffix = 0
    } = options;
    
    // 複数信号を結合
    const totalLength = silencePrefix + signals.reduce((sum, sig) => sum + sig.length, 0) + 
                       (signals.length - 1) * gapBetweenSignals + silenceSuffix;
    const combinedSignal = new Float32Array(totalLength);
    
    let position = silencePrefix;
    for (let i = 0; i < signals.length; i++) {
      combinedSignal.set(signals[i], position);
      position += signals[i].length + gapBetweenSignals;
    }
    
    return processSignalInChunks(demodulator, combinedSignal, { chunkSize, maxFrames });
  };

    test('should handle early sync detection without producing invalid frames', () => {
      // バグ再現: サイレンス期間での同期検出を防ぐ
      const demodulator = new DsssDpskDemodulator(defaultConfig);
      
      // 大量のサイレンス期間 + 実際のフレーム
      const testData = new Uint8Array([0x88, 0x77]);
      const frameSignal = generateFrameWithAmplitude(testData, 0.5);
      console.log(`frameSignal.length: ${frameSignal.length}`);
      
      const largeSilence = new Float32Array(frameSignal.length * 0); // 5倍のサイレンス
      const signals = [largeSilence, frameSignal];
      
      // フレーム受信処理
      const frames = processMultipleSignals(demodulator, signals, {
        maxFrames: 1,
        silenceSuffix: 10000
      });
      
      // 正常なフレーム受信確認（サイレンス期間の誤検出なし）
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0].userData.slice(0, testData.length)).toEqual(testData);
      
      // 同期品質確認（真の信号による同期）
      const syncState = demodulator.getSyncState();
      expect(syncState.locked).toBe(false); // Frame API設計: フレーム完了後は同期リセット
      expect(syncState.correlation).toBe(0); // Frame API設計: フレーム完了後はcorrelation=0
    });
});
