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
			samplesPerPhase: this.params.samplesPerPhase || 8,
			carrierFreq: this.params.carrierFreq || 10000
		};

		this.estimatedSnrDb = 10.0; // Initial estimated SNR in dB

		this.agc = new AGCProcessor(sampleRate);
	}

	process(inputs, _outputs, _parameters) {
		const input = inputs[0];
		if (!input || !input[0]) return true;

		const inputSamples = input[0];
		this.agc.process(inputSamples);

		const { reference, modulationParams, estimatedSnrDb } = this;

		// Append new samples to circular buffer
		const remainingSpace = this.buffer.length - this.bufferIndex;
		if (inputSamples.length <= remainingSpace) {
			this.buffer.set(inputSamples, this.bufferIndex);
			this.bufferIndex += inputSamples.length;
		} else {
			// Shift buffer left and add new samples
			const keepSamples = this.buffer.length - inputSamples.length;
			this.buffer.set(this.buffer.subarray(this.buffer.length - keepSamples), 0);
			this.buffer.set(inputSamples, keepSamples);
			this.bufferIndex = this.buffer.length;
		}

		// Try to find synchronization using updated API
		const maxChipOffset = Math.floor(this.buffer.length / modulationParams.samplesPerPhase) - reference.length;
		if (maxChipOffset > 0) {
			const result = modem.findSyncOffset(
				this.buffer, 
				reference, 
				modulationParams,
				maxChipOffset
			);
			
			if (result.isFound) {
				console.log(`Sync found at chip offset ${result.bestChipOffset}, sample offset ${result.bestSampleOffset}`);
				console.log(`Peak correlation: ${result.peakCorrelation.toFixed(3)}, ratio: ${result.peakRatio.toFixed(3)}`);
				
				// Estimate SNR based on peak correlation. This is a simplified heuristic.
				// A higher correlation generally means higher SNR.
				// Map correlation [0.3, 1.0] to SNR [0dB, 20dB] roughly.
				const minCorr = 0.3; // Minimum correlation for reliable detection
				const maxCorr = 1.0; // Maximum possible correlation
				const snrRange = 20.0; // Max SNR to estimate

				if (result.peakCorrelation > minCorr) {
					const normalizedCorr = (result.peakCorrelation - minCorr) / (maxCorr - minCorr);
					this.estimatedSnrDb = Math.max(0, Math.min(snrRange, normalizedCorr * snrRange));
					console.log(`Estimated SNR: ${this.estimatedSnrDb.toFixed(2)} dB`);
				}
				
				// Extract synchronized signal for demodulation
				const syncedSamples = this.buffer.slice(result.bestSampleOffset);
				if (syncedSamples.length >= reference.length * modulationParams.samplesPerPhase) {
					// Demodulate carrier to extract phases
					const demodPhases = modem.demodulateCarrier(
						syncedSamples,
						modulationParams.samplesPerPhase,
						modulationParams.sampleRate,
						modulationParams.carrierFreq
					);
					
					// DPSK demodulate phases to get LLRs for chips
					const chipLlrs = modem.dpskDemodulate(demodPhases);
					
					// DSSS despread soft chips to get LLRs for original bits
					const llr = modem.dsssDespread(chipLlrs, reference.length, this.params.seed, estimatedSnrDb);
					
					// Convert LLR to bits (positive LLR = bit 0, negative LLR = bit 1)
					const demodBits = Array.from(llr).map(l => l >= 0 ? 0 : 1);
					console.log(`Demodulated bits:`, demodBits.join(''));
				}
			}
		}

		return true;
	}
}

registerProcessor('test-processor', TestProcessor);
