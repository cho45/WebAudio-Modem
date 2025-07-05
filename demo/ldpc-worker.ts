import { LDPC, type HMatrixData } from '../src/fec/ldpc';

let ldpc: LDPC | null = null; // Initialize as null

// Listen for messages from the main thread
self.onmessage = (e: MessageEvent) => {
    const { type, hMatrix, noisyLlr, maxIterations, chunkIndex } = e.data;

    if (type === 'init') {
        // Initialize LDPC instance with the provided hMatrix
        console.log('Worker: Initializing LDPC with H-Matrix...');
        ldpc = new LDPC(hMatrix as HMatrixData);
        self.postMessage({ type: 'init_complete' });
    } else if (type === 'decode') {
        if (!ldpc) {
            console.error('Worker: LDPC not initialized. Cannot decode.');
            return;
        }
        // Perform the heavy decoding task
        const { decodedMessage, iterations, converged } = ldpc.decode(noisyLlr, maxIterations);

        // Send the result back to the main thread
        self.postMessage({
            type: 'decode_result',
            decodedMessage,
            iterations,
            converged,
            chunkIndex
        });
    }
};
