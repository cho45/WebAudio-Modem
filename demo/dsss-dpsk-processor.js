import * as modem from '../src/modems/dsss-dpsk.js';

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
			samplesPerPhase: this.params.samplesPerPhase || 240,
			sampleRate: sampleRate,
			carrierFreq: this.params.carrierFreq || 10000
		};
	}

	process(inputs, _outputs, _parameters) {
		const input = inputs[0];
		if (!input || !input[0]) return true;

		const inputSamples = input[0];
		const { reference, modulationParams } = this;

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
				
				// Extract synchronized signal for demodulation
				const syncedSamples = this.buffer.slice(result.bestSampleOffset);
				if (syncedSamples.length >= reference.length * modulationParams.samplesPerPhase) {
					// Use integrated demodulation function
					const llr = modem.dsssDpskDemodulateWithLlr(
						syncedSamples, 
						reference, 
						modulationParams,
						10.0 // Es/N0 in dB
					);
					
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