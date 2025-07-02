import * as modem from '../src/modems/dsss-dpsk.js';
import {AGCProcessor} from '../src/dsp/agc.js';

// AudioWorkletGlobalScope
class TestProcessor extends AudioWorkletProcessor {
	constructor(opts) {
		super();
		this.params = opts.processorOptions;
		console.log('TestProcessor initialized with options:', this.params);
		
		// Updated to use Float32Array for current API compatibility
		this.buffer = new Float32Array(sampleRate * 1);
		this.bufferIndex = 0;

		// Generate sync reference using current API
		this.reference = modem.generateSyncReference(this.params.sequenceLength || 31);
		this.startSample = 0;
		console.log('Sync reference generated:', this.reference);

		// Modulation parameters required by current API
		this.modulationParams = {
			sampleRate: sampleRate,
			samplesPerPhase: this.params.samplesPerPhase || 23,
			carrierFreq: this.params.carrierFreq || 10000
		};

		this.estimatedSnrDb = 10.0; // Initial estimated SNR in dB

		this.agc = new AGCProcessor(sampleRate);

		// Synchronization state management
		this.syncState = {
			locked: false,              // 同期確立フラグ
			mode: 'SEARCH',             // 'SEARCH', 'TRACK', 'VERIFY'
			offset: 0,                  // 同期オフセット（サンプル単位）
			chipPosition: 0,           // 現在のチップ位置
			bitPosition: 0,            // 現在のビット位置
			lastLLRs: [],              // 直近のLLR履歴
			consecutiveWeakBits: 0,    // 連続する弱いLLRのカウント
			framesSinceLastCheck: 0,   // 最後の同期確認からのフレーム数
			lastSyncTime: 0,           // 最後の同期確立時刻
			processedBits: 0           // 処理済みビット数
		};

		// 同期維持のための設定
		this.WEAK_LLR_THRESHOLD = 50;     // 弱いLLRの閾値（LLR=127なので50は適切）
		this.MAX_CONSECUTIVE_WEAK = 5;    // 連続する弱いビットの最大数（元に戻す）
		this.VERIFY_INTERVAL_FRAMES = 100; // 同期確認の間隔（元に戻す）
		this.MIN_SYNC_INTERVAL_MS = 1000;  // 同期確立の最小間隔
		
		// 適応的同期追跡のための設定
		this.QUALITY_DEGRADATION_THRESHOLD = 80; // 品質劣化検出の閾値
		this.RESYNC_THRESHOLD = 30;             // 再同期実行の閾値
		
		// ビット出力用
		this.currentByte = '';
	}

	process(inputs, _outputs, _parameters) {
		const input = inputs[0];
		if (!input || !input[0]) return true;

		const inputSamples = input[0];
		this.agc.process(inputSamples);

		// 状態管理のため変数は削除

		// バッファにサンプルを追加
		this._appendToBuffer(inputSamples);

		// 現在時刻を取得
		const currentTime = Date.now();

		// 同期状態に応じた処理
		switch (this.syncState.mode) {
			case 'SEARCH':
				this._searchMode(currentTime);
				break;
			case 'TRACK':
				this._trackMode();
				break;
			case 'VERIFY':
				this._verifyMode();
				break;
		}

		return true;
	}

	// バッファ管理メソッド
	_appendToBuffer(inputSamples) {
		const remainingSpace = this.buffer.length - this.bufferIndex;
		if (inputSamples.length <= remainingSpace) {
			this.buffer.set(inputSamples, this.bufferIndex);
			this.bufferIndex += inputSamples.length;
		} else {
			// バッファがフルの場合、古いデータを左にシフト
			const keepSamples = this.buffer.length - inputSamples.length;
			this.buffer.set(this.buffer.subarray(this.buffer.length - keepSamples), 0);
			this.buffer.set(inputSamples, keepSamples);
			this.bufferIndex = this.buffer.length;
			
			// 同期オフセットも調整
			if (this.syncState.locked) {
				this.syncState.offset = Math.max(0, this.syncState.offset - inputSamples.length);
			}
		}
	}

	// SEARCH モード: 初期同期検索
	_searchMode(currentTime) {
		// 最小間隔での同期検索制限
		if (currentTime - this.syncState.lastSyncTime < this.MIN_SYNC_INTERVAL_MS) {
			return;
		}

		// 十分なデータがあるかチェック
		const minSamplesNeeded = this.reference.length * this.modulationParams.samplesPerPhase * 2;
		if (this.bufferIndex < minSamplesNeeded) {
			return;
		}

		const maxChipOffset = 50; // 検索範囲を制限
		const result = modem.findSyncOffset(
			this.buffer.subarray(0, this.bufferIndex),
			this.reference,
			this.modulationParams,
			maxChipOffset,
			{ correlationThreshold: 0.5, peakToNoiseRatio: 4.0 } // より厳しい閾値
		);

		if (result.isFound) {
			// 同期確立
			this.syncState.locked = true;
			this.syncState.mode = 'TRACK';
			this.syncState.offset = result.bestSampleOffset;
			this.syncState.chipPosition = 0;
			this.syncState.bitPosition = 0;
			this.syncState.lastLLRs = [];
			this.syncState.consecutiveWeakBits = 0;
			this.syncState.lastSyncTime = currentTime;
			this.syncState.processedBits = 0;

			// SNR推定を更新（相関の絶対値を使用）
			this._updateSNREstimate(Math.abs(result.peakCorrelation));

			console.log(`[SYNC] 🎯 Synchronized! Offset: ${result.bestSampleOffset} samples (${result.bestChipOffset} chips)`);
			console.log(`[SYNC] 📊 Peak: ${result.peakCorrelation.toFixed(3)}, Ratio: ${result.peakRatio.toFixed(1)}, SNR: ${this.estimatedSnrDb.toFixed(1)}dB`);
			console.log(`[SYNC] 🔄 Switching to TRACK mode for continuous demodulation`);
		}
	}

	// TRACK モード: 同期維持での連続復調
	_trackMode() {
		const sequenceLength = this.reference.length;
		const samplesPerBit = sequenceLength * this.modulationParams.samplesPerPhase;
		
		// 現在の同期位置から1ビット分のデータがあるかチェック
		const availableSamples = this.bufferIndex - this.syncState.offset;
		
		// デバッグ情報（最初の数回のみ）
		if (this.syncState.processedBits < 2) {
			console.log(`[TRACK] Buffer: ${this.bufferIndex}, Offset: ${this.syncState.offset}, Available: ${availableSamples}, Need: ${samplesPerBit}`);
		}
		
		if (availableSamples < samplesPerBit) {
			return; // データ不足
		}

		// 1ビット分のサンプルを抽出
		const bitSamples = this.buffer.subarray(
			this.syncState.offset,
			this.syncState.offset + samplesPerBit
		);

		// 復調処理
		const demodResult = this._demodulateOneBit(bitSamples);
		
		// デバッグ情報（最初の数回のみ）
		if (this.syncState.processedBits < 2) {
			console.log(`[TRACK] Demod result:`, demodResult);
		}
		
		if (demodResult) {
			const { llr, bit } = demodResult;
			
			// LLR履歴を更新
			this.syncState.lastLLRs.push(Math.abs(llr));
			if (this.syncState.lastLLRs.length > 10) {
				this.syncState.lastLLRs.shift();
			}

			// 品質劣化の早期検出と適応的再同期
			const llrAbs = Math.abs(llr);
			const recentAvgLLR = this.syncState.lastLLRs.length > 0 ?
				this.syncState.lastLLRs.reduce((a, b) => a + b, 0) / this.syncState.lastLLRs.length : 127;

			// 急激な品質劣化を検出
			if (recentAvgLLR > this.QUALITY_DEGRADATION_THRESHOLD && llrAbs < this.RESYNC_THRESHOLD) {
				console.log(`[SYNC] 🔄 Quality degradation detected: avg=${recentAvgLLR.toFixed(1)} → current=${llrAbs}, attempting re-sync...`);
				this._attemptLocalResync();
				return;
			}

			// 弱いLLRのカウント
			if (llrAbs < this.WEAK_LLR_THRESHOLD) {
				this.syncState.consecutiveWeakBits++;
				console.log(`[TRACK] Weak bit detected: LLR=${llr} (abs=${llrAbs}) < threshold=${this.WEAK_LLR_THRESHOLD}, count=${this.syncState.consecutiveWeakBits}`);
			} else {
				this.syncState.consecutiveWeakBits = 0;
			}

			// 同期喪失判定
			if (this.syncState.consecutiveWeakBits >= this.MAX_CONSECUTIVE_WEAK) {
				console.log(`[SYNC] ⚠️  Sync lost: ${this.syncState.consecutiveWeakBits} consecutive weak bits (last LLR: ${llr})`);
				console.log(`[SYNC] LLR history:`, this.syncState.lastLLRs.slice(-10));
				this._resetSyncState();
				return;
			}

			// ビット出力（簡潔なログ）
			this.syncState.processedBits++;
			
			// 8ビットごとにまとめて出力
			if (this.syncState.processedBits % 8 === 1) {
				this.currentByte = bit.toString();
			} else {
				this.currentByte += bit.toString();
			}

			this.port.postMessage({
				type: 'bit',
				llr,
				bit
			});
			
			if (this.syncState.processedBits % 8 === 0) {
				const avgLLR = this.syncState.lastLLRs.reduce((a, b) => a + b, 0) / this.syncState.lastLLRs.length;
				console.log(`[TRACK] Byte ${Math.floor(this.syncState.processedBits / 8)}: ${this.currentByte} (avg LLR: ${avgLLR.toFixed(1)})`);
			}

			// 復調失敗カウンターをリセット
			this.syncState.consecutiveFailures = 0;

			// 次のビット位置に進む
			this.syncState.offset += samplesPerBit;
			this.syncState.bitPosition++;

			// 定期的な同期検証への移行
			this.syncState.framesSinceLastCheck++;
			if (this.syncState.framesSinceLastCheck >= this.VERIFY_INTERVAL_FRAMES) {
				console.log(`[TRACK] Switching to VERIFY mode after ${this.VERIFY_INTERVAL_FRAMES} frames (${this.syncState.processedBits} bits processed)`);
				this.syncState.mode = 'VERIFY';
				this.syncState.framesSinceLastCheck = 0;
			}
		} else {
			// 復調失敗時の処理
			this.syncState.consecutiveFailures = (this.syncState.consecutiveFailures || 0) + 1;
			
			if (this.syncState.consecutiveFailures >= 10) {
				console.log(`[SYNC] ⚠️  Too many demod failures (${this.syncState.consecutiveFailures}), re-searching...`);
				this._resetSyncState();
				return;
			}
			
			// 復調失敗時も少しオフセットを進めて無限ループを回避
			const skipSamples = Math.floor(samplesPerBit / 4); // 1/4ビット分スキップ
			this.syncState.offset += skipSamples;
			
			if (this.syncState.consecutiveFailures <= 3) {
				console.log(`[TRACK] Demod failed (${this.syncState.consecutiveFailures}), skipping ${skipSamples} samples`);
			}
		}
	}

	// VERIFY モード: 定期的同期品質確認
	_verifyMode() {
		// 軽量な同期品質チェック
		const recentAvgLLR = this.syncState.lastLLRs.length > 0 ?
			this.syncState.lastLLRs.reduce((a, b) => a + b, 0) / this.syncState.lastLLRs.length : 0;

		console.log(`[VERIFY] Checking quality: avg LLR=${recentAvgLLR.toFixed(1)}, threshold=${this.WEAK_LLR_THRESHOLD}, history length=${this.syncState.lastLLRs.length}`);

		if (recentAvgLLR < this.WEAK_LLR_THRESHOLD) {
			// 品質が低下している場合は再検索
			console.log(`[SYNC] 🔄 Quality degraded (avg LLR: ${recentAvgLLR.toFixed(1)}), re-searching...`);
			this._resetSyncState();
		} else {
			// 品質が良好な場合はTRACKモードに戻る
			this.syncState.mode = 'TRACK';
			console.log(`[SYNC] ✅ Quality verified (avg LLR: ${recentAvgLLR.toFixed(1)}), continuing tracking`);
		}
	}

	// 1ビット復調処理
	_demodulateOneBit(bitSamples) {
		try {
			// デバッグ情報
			if (this.syncState.processedBits < 1) {
				console.log(`[DEBUG] BitSamples length: ${bitSamples.length}, Expected: ${this.reference.length * this.modulationParams.samplesPerPhase}`);
			}

			// キャリア復調
			const phases = modem.demodulateCarrier(
				bitSamples,
				this.modulationParams.samplesPerPhase,
				this.modulationParams.sampleRate,
				this.modulationParams.carrierFreq
			);

			if (phases.length === 0) {
				console.log(`[ERROR] No phases from carrier demod`);
				return null;
			}

			if (this.syncState.processedBits < 1) {
				console.log(`[DEBUG] Phases length: ${phases.length}, Expected: ${this.reference.length}`);
			}

			// DPSK復調
			const chipLlrs = modem.dpskDemodulate(phases);
			if (chipLlrs.length === 0) {
				console.log(`[ERROR] No chip LLRs from DPSK demod`);
				return null;
			}

			if (this.syncState.processedBits < 1) {
				console.log(`[DEBUG] ChipLlrs length: ${chipLlrs.length}, Expected: ${this.reference.length - 1}`);
			}

			// DPSK復調は位相差を計算するため、N位相からN-1チップLLRが生成される
			// しかしDSSS逆拡散はNチップを期待する場合があるため、長さを調整
			let adjustedChipLlrs = chipLlrs;
			if (chipLlrs.length === this.reference.length - 1) {
				// 最初のチップLLRを複製して長さを合わせる（簡易的な処理）
				adjustedChipLlrs = new Float32Array(this.reference.length);
				adjustedChipLlrs.set(chipLlrs, 0);
				adjustedChipLlrs[adjustedChipLlrs.length - 1] = chipLlrs[chipLlrs.length - 1]; // 最後を複製
			}

			// ノイズ分散の計算
			const snrLinear = Math.pow(10, this.estimatedSnrDb / 10);
			const noiseVariance = 1.0 / snrLinear;

			// DSSS逆拡散（1ビット）
			if (this.syncState.processedBits === 0) {
				console.log(`[DEBUG] DSSS params: adjustedChipLlrs.length=${adjustedChipLlrs.length}, sequenceLength=${this.reference.length}, seed=${this.params.seed}, noiseVariance=${noiseVariance.toFixed(6)}`);
				console.log(`[DEBUG] ChipLlrs sample:`, Array.from(adjustedChipLlrs.slice(0, 5)));
			}
			
			let llrs;
			try {
				llrs = modem.dsssDespread(adjustedChipLlrs, this.reference.length, this.params.seed, noiseVariance);
			} catch (despreadError) {
				console.log(`[ERROR] DSSS despread threw exception: ${despreadError.message}`);
				if (this.syncState.processedBits === 0) {
					console.log(`[ERROR] DSSS error stack: ${despreadError.stack}`);
				}
				return null;
			}
			
			if (this.syncState.processedBits === 0) {
				console.log(`[DEBUG] DSSS result: llrs.length=${llrs?.length || 'undefined'}`);
			}
			
			if (!llrs || llrs.length === 0) {
				console.log(`[ERROR] No LLRs from DSSS despread (result: ${llrs})`);
				return null;
			}

			if (this.syncState.processedBits === 0) {
				console.log(`[DEBUG] Final LLRs:`, Array.from(llrs));
			}

			// 最初のLLRを使用（1ビット分）
			const llr = llrs[0];
			const bit = llr >= 0 ? 0 : 1;

			return { llr, bit };
		} catch (error) {
			console.log(`[ERROR] Demodulation failed: ${error.message}`);
			console.log(`[ERROR] Stack: ${error.stack}`);
			return null;
		}
	}

	// SNR推定更新
	_updateSNREstimate(peakCorrelation) {
		const minCorr = 0.3;
		const maxCorr = 1.0;
		const snrRange = 20.0;

		if (peakCorrelation > minCorr) {
			const normalizedCorr = (peakCorrelation - minCorr) / (maxCorr - minCorr);
			this.estimatedSnrDb = Math.max(0, Math.min(snrRange, normalizedCorr * snrRange));
		}
	}

	// ローカル再同期の試行
	_attemptLocalResync() {
		console.log(`[SYNC] 🔍 Attempting local re-synchronization around current offset ${this.syncState.offset}`);
		
		const searchRange = 200; // ±200サンプルの範囲で検索
		const startOffset = Math.max(0, this.syncState.offset - searchRange);
		const endOffset = Math.min(this.bufferIndex - this.reference.length * this.modulationParams.samplesPerPhase, 
									this.syncState.offset + searchRange);
		
		if (startOffset >= endOffset) {
			console.log(`[SYNC] ❌ Local resync failed: insufficient buffer data`);
			this._resetSyncState();
			return;
		}
		
		// 限定範囲で同期検索
		const searchSamples = this.buffer.subarray(startOffset, endOffset + this.reference.length * this.modulationParams.samplesPerPhase);
		const maxChipOffset = Math.floor((endOffset - startOffset) / this.modulationParams.samplesPerPhase);
		
		try {
			const result = modem.findSyncOffset(
				searchSamples,
				this.reference,
				this.modulationParams,
				maxChipOffset,
				{ correlationThreshold: 0.3, peakToNoiseRatio: 2.0 } // より緩い閾値
			);
			
			if (result.isFound) {
				const newOffset = startOffset + result.bestSampleOffset;
				const offsetAdjustment = newOffset - this.syncState.offset;
				
				console.log(`[SYNC] ✅ Local resync successful: offset ${this.syncState.offset} → ${newOffset} (${offsetAdjustment} samples)`);
				console.log(`[SYNC] 📊 New peak: ${result.peakCorrelation.toFixed(3)}, ratio: ${result.peakRatio.toFixed(1)}`);
				
				// 同期位置を更新
				this.syncState.offset = newOffset;
				this.syncState.consecutiveWeakBits = 0;
				this.syncState.lastLLRs = []; // LLR履歴をリセット
				
				// SNR推定を更新
				this._updateSNREstimate(Math.abs(result.peakCorrelation));
				
			} else {
				console.log(`[SYNC] ❌ Local resync failed: no sync found in range`);
				this._resetSyncState();
			}
		} catch (error) {
			console.log(`[SYNC] ❌ Local resync failed: ${error.message}`);
			this._resetSyncState();
		}
	}

	// 同期状態リセット
	_resetSyncState() {
		this.syncState.locked = false;
		this.syncState.mode = 'SEARCH';
		this.syncState.offset = 0;
		this.syncState.chipPosition = 0;
		this.syncState.bitPosition = 0;
		this.syncState.lastLLRs = [];
		this.syncState.consecutiveWeakBits = 0;
		this.syncState.framesSinceLastCheck = 0;
		this.syncState.processedBits = 0;
		this.syncState.consecutiveFailures = 0;
	}
}

registerProcessor('test-processor', TestProcessor);
